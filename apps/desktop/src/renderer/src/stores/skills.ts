import type { SkillCommit, SkillCompareFile, SkillCreateInput, SkillEntry, SkillFileInfo, SkillLibraryState } from '@workbench/skills'
import type { Result } from '@/types'
import { noteNameProblem, noteRootName, sanitizeNoteName, sanitizeNoteRoot } from '@workbench/notes'
import { SKILL_FILE, skillFileRel, skillRel } from '@workbench/skills'
import { defineStore } from 'pinia'
/**
 * 技能：列表、当前打开的那一篇、增删改、版本历史与安装的编排。
 *
 * 与笔记 store 同一个思路：技能就是磁盘上的文件（笔记仓库里的一层），这里没有内存副本
 * ——「列表」是扫出来的、「正文」是读出来的，落盘就是写文件本身。这一层负责的是编排：
 * 每次改动之后列表要重扫一遍（名字与描述是从 frontmatter 里解析出来的，改了正文它们就变了）、
 * 打开着的技能在删除 / 换库之后要收起来、同步走的是笔记同步那条通道（同一个仓库）。
 *
 * 「版本」不是这里的状态：每次增删改都在适配层提交一次（见 workbench/skill.ts），
 * 历史与恢复直接问 git（skillHistory / restoreSkill），没有需要缓存的中间态。
 *
 * **同步是自动的**（与笔记页同一套拉推分离）：进技能页 / 窗口聚焦只拉（`pullSkills`，不提交不推），
 * 保存 / 删改 / 导入 / 恢复之后自动推（`skillSync`：只提交技能库那一层，再拉、再推）。
 * 后台失败只写 `syncError` 那一行，不弹窗；编辑器里有未保存的修改时，拉回来也不换正文。
 */
import { computed, ref, watch } from 'vue'
import { confirmAction, notifyError, notifySuccess } from '@/notify'
import { useSettingsStore } from '@/stores/settings'

export const useSkillsStore = defineStore('skills', () => {
  const settings = useSettingsStore()

  /**
   * 技能库目录：**用户自己挑的一个目录**（技能就是它下面的一个个子目录，每个带一份 SKILL.md）。
   *
   * 与笔记文件夹**互不相干**：两边各自挑各自的，可以正好是同一处、也可能各有各的仓库。
   * 空串 = 还没选过，整页只给引导（笔记页那套「先选文件夹」在这里也成立）。
   */
  const root = computed(() => settings.settings.skillDir)
  /** 技能库与它的仓库：**从技能库目录往上找最近的 `.git`**（探回来的，不落盘） */
  const state = ref<SkillLibraryState | null>(null)
  /**
   * 各条技能通道用的那个「根」：**仓库根**（技能库不在任何仓库里时就是技能库目录自己）。
   * 与 `dir` 一起拼出技能库本身：`<gitRoot>/<dir>`。
   */
  const gitRoot = computed(() => state.value?.repo ?? '')
  /** 技能库在仓库里的相对路径；技能库自己就是仓库根时是空串 */
  const dir = computed(() => state.value?.libraryRel ?? '')
  /** 会不会记版本：技能库在不在 git 仓库里 —— 与「有没有远端」是两件事，别合并 */
  const hasVersions = computed(() => state.value?.hasGit === true)
  /** 同步到哪儿：那个仓库的 origin；没连远端时是空串 */
  const remoteUrl = computed(() => state.value?.origin ?? '')
  /** 能同步：有仓库、且连了远端（少哪一样都在按钮的提示里说清） */
  const canSync = computed(() => hasVersions.value && remoteUrl.value !== '')

  const skills = ref<SkillEntry[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref('')
  /** 技能库目录不可用（被删了 / 移走了）：整页给「重新选一个目录」的引导 */
  const stateError = ref('')

  /** 当前打开的技能；编辑区只认它 */
  const activeId = ref('')
  /** 当前编辑的文件（相对技能目录的路径）：一个技能往往不止 SKILL.md，附属文件也在内 */
  const activeFile = ref(SKILL_FILE)
  /** 技能目录里的文件清单（切详情 / 保存 / 刷新时重拉） */
  const files = ref<SkillFileInfo[]>([])
  const content = ref('')
  /**
   * 编辑器内容最后一次与磁盘一致时的那一份（读盘成功 / 保存成功 / 采纳别处版本各刷一次）。
   * 「有没有未保存的修改」就是 `content !== diskContent` —— 详情弹窗与自动拉取都认这一个基线，
   * 拉回来的远端改动不会把编辑器里没保存的草稿冲掉。
   */
  const diskContent = ref('')
  const contentLoading = ref(false)
  const saving = ref(false)
  const saveError = ref('')
  /** 最近一次保存的时间（毫秒）：编辑区那行「已保存」用它 */
  const savedAt = ref(0)

  const syncing = ref(false)
  const syncError = ref('')
  /** 后台拉取遇到「编辑区有未保存修改」时的一句事实（不是错误，与 syncError 分开放） */
  const syncNotice = ref('')
  /** 本地有已提交、还没推出去的改动：保存 / 删改 / 导入 / 恢复成功之后置位 */
  const needPush = ref(false)

  const activeSkill = computed(() => skills.value.find(item => item.id === activeId.value) ?? null)

  /** 库位置给人看的一句话：技能库目录那一层的名字（完整路径在悬停提示里） */
  const locationText = computed(() => noteRootName(root.value))

  /** 编辑区里的正文与磁盘上那份不一致（正文还在读时不算：那时 content 里是上一篇的旧文本） */
  const contentDirty = computed(
    () => !contentLoading.value && Boolean(activeId.value) && content.value !== diskContent.value,
  )

  function reset(): void {
    skills.value = []
    closeActive()
    loaded.value = false
    loadError.value = ''
    stateError.value = ''
    syncError.value = ''
    syncNotice.value = ''
    needPush.value = false
    cancelAutoPush()
  }

  function closeActive(): void {
    activeId.value = ''
    activeFile.value = SKILL_FILE
    files.value = []
    content.value = ''
    diskContent.value = ''
    contentLoading.value = false
    saveError.value = ''
    savedAt.value = 0
  }

  /** 拉一遍当前技能的文件清单；当前文件被外部删掉时退回 SKILL.md */
  async function loadFiles(): Promise<void> {
    const id = activeId.value
    if (!id) {
      files.value = []
      return
    }
    const result = await window.workbench.listSkillFiles(gitRoot.value, dir.value, id)
    files.value = result.ok && result.data ? result.data : []
    if (!files.value.some(file => file.rel === activeFile.value)) {
      if (files.value.some(file => file.rel === SKILL_FILE) && activeFile.value !== SKILL_FILE) {
        await openFile(SKILL_FILE)
      }
    }
  }

  /** 读技能里的一个文件到编辑区（二进制读不出文本时如实报错，留在原文件） */
  async function openFile(rel: string): Promise<void> {
    const id = activeId.value
    if (!id)
      return

    contentLoading.value = true
    const result = await window.workbench.readSkillFile(gitRoot.value, dir.value, id, rel)
    contentLoading.value = false
    if (!result.ok || result.data === undefined) {
      notifyError(result.error ?? '读取文件失败（可能是二进制文件，暂不支持在应用内编辑）')
      return
    }

    activeFile.value = rel
    content.value = result.data
    diskContent.value = result.data
    saveError.value = ''
    savedAt.value = 0
  }

  /**
   * 采纳一份已经落盘的内容（「用项目版本更新到库」那条路）：正文与基线一起换成它，
   * 这样界面上不会立刻显示成「有未保存的修改」。
   */
  function adoptContent(value: string): void {
    content.value = value
    diskContent.value = value
  }

  /**
   * 把打开着的文件按磁盘重读一份（拉取 / 同步之后远端可能改过它）。
   *
   * **编辑区有未保存的修改就不换**：那是用户刚敲、还没提交的东西，宁可留着等他自己保存，
   * 也不替他挑边。返回是否换了正文。
   */
  async function rereadActive(): Promise<boolean> {
    if (!activeId.value)
      return false
    await loadFiles()
    if (contentDirty.value)
      return false
    const rel = files.value.some(file => file.rel === activeFile.value) ? activeFile.value : SKILL_FILE
    await openFile(rel)
    return true
  }

  /**
   * 重新认一次技能库与它的仓库：从技能库目录开始看有没有 `.git`，没有就往上找（Rust 侧 `state`）。
   *
   * 必须在列技能之前跑：各条通道要的正是它给的「仓库根 + 库在仓库里的相对路径」这两个值。
   * 目录不在 / 探不出来时如实记下原因（`stateError`），界面据此提示重新选一个目录 ——
   * 而不是把整页显示成「技能库是空的」（那会让人以为技能没了，其实只是目录换了地方）。
   */
  async function probeState(): Promise<void> {
    const current = root.value
    if (!current) {
      state.value = null
      stateError.value = ''
      return
    }

    const result = await window.workbench.skillState(current)
    if (!result.ok || !result.data) {
      state.value = null
      stateError.value = result.error ?? '读取技能库失败'
      return
    }

    state.value = result.data
    stateError.value = ''
  }

  /** 重新扫一遍技能库。打开着的技能没了（同步删了它 / 换了库）就一起收起来 */
  async function reload(): Promise<void> {
    if (!root.value) {
      reset()
      return
    }

    // loading 从探测仓库那一步就置位：探测同样要走一次 IPC，慢的时候
    // 不能让页面落进「还没有技能」的空态 —— 那是在撒谎，技能只是还没扫到。
    loading.value = true
    loadError.value = ''
    await probeState()
    if (!gitRoot.value) {
      loading.value = false
      reset()
      return
    }

    const result = await window.workbench.listSkills(gitRoot.value, dir.value)
    loading.value = false

    if (!result.ok || !result.data) {
      loadError.value = result.error ?? '读取技能失败'
      return
    }

    skills.value = result.data
    loaded.value = true
    if (activeId.value && !result.data.some(item => item.id === activeId.value)) {
      closeActive()
      return
    }
    // 打开着的技能还在：文件清单跟着刷一遍（附属文件可能增删）
    if (activeId.value)
      await loadFiles()
  }

  let started = false
  let ready = false

  /** 首次进页面扫一次（KeepAlive 下来回切页不重挂载，这里挡住重复扫描） */
  async function init(): Promise<void> {
    if (started && ready)
      return
    started = true
    await reload()
  }

  // 技能库目录变了（选了新目录、别的窗口迁移）：仓库与库都重新认一遍
  watch(root, () => {
    if (!started)
      return
    ready = false
    closeActive()
    // 换了一个库：旧库那些「待推」与挂着的自动推送都不再适用
    cancelAutoPush()
    needPush.value = false
    syncNotice.value = ''
    void reload()
  })

  /**
   * 记下用户挑的技能库目录（技能页那颗「选择技能文件夹」用它）。
   *
   * 与笔记页的 `setRoot` 同一形状：落盘走设置（`skillDir`，本机一份），随后那条 watch 自己重扫。
   * **不搬动任何文件**：换目录只是换个地方看技能，磁盘上的东西一概不动。
   */
  async function setRoot(dir: string): Promise<boolean> {
    const target = sanitizeNoteRoot(dir)
    if (!target)
      return false
    return settings.updateSettings({ skillDir: target })
  }

  /**
   * 打开一个技能的 SKILL.md。慢一步回来的旧结果直接丢掉（连点两行时各回各的）。
   * 回来的是**这一枝有没有读成**：读不出来时这里就收场并提示，调用方不要再拉开详情弹窗
   * —— 弹窗内容全挂在 activeSkill 上，读失败还拉开就是一个空壳。
   */
  async function select(id: string): Promise<boolean> {
    activeId.value = id
    activeFile.value = SKILL_FILE
    saveError.value = ''
    savedAt.value = 0

    contentLoading.value = true
    const result = await window.workbench.readNote(gitRoot.value, skillFileRel(dir.value, id))
    if (activeId.value === id)
      void loadFiles()
    contentLoading.value = false
    if (activeId.value !== id)
      return false

    if (!result.ok || result.data === undefined) {
      closeActive()
      const message = result.error ?? '读取 SKILL.md 失败'
      saveError.value = message
      notifyError(message)
      return false
    }
    content.value = result.data.text
    diskContent.value = result.data.text
    return true
  }

  /**
   * 保存指定技能的指定文件（version 门槛只在 SKILL.md 上，见适配层）：编辑器的「保存」与
   * 「把项目里优化过的版本更新到库」走的是同一条路 —— 更新到库也是一次正常保存
   * （version 不合格照样被拦），成功后列表重扫（名字与描述可能变了）。
   * 失败原因留在 saveError 上，调用方（对比弹窗）拿它显示。
   */
  async function saveContent(id: string, rel: string, content: string): Promise<boolean> {
    if (saving.value)
      return false

    saving.value = true
    saveError.value = ''
    const result = await window.workbench.saveSkillFile(gitRoot.value, dir.value, id, rel, content)
    saving.value = false

    if (!result.ok) {
      saveError.value = result.error ?? '保存技能失败'
      return false
    }
    savedAt.value = Date.now()
    // 存的就是编辑器里那一份：基线跟着走，界面上不会立刻显示成「有未保存的修改」
    if (rel === activeFile.value)
      diskContent.value = content
    markLocalChange()
    // 名字与描述是从 frontmatter 里解析的，正文改了列表就可能跟着变
    await reload()
    return true
  }

  /** 保存编辑器里打开的那一个文件 */
  async function saveActive(): Promise<boolean> {
    const id = activeId.value
    if (!id)
      return false
    return saveContent(id, activeFile.value, content.value)
  }

  async function create(input: SkillCreateInput): Promise<boolean> {
    const problem = noteNameProblem(input.id)
    if (problem) {
      notifyError(problem)
      return false
    }
    const id = sanitizeNoteName(input.id)
    if (skills.value.some(item => item.id === id)) {
      notifyError(`已经有同名的技能了：${id}`)
      return false
    }

    const result = await window.workbench.createSkill(gitRoot.value, dir.value, { ...input, id })
    if (!result.ok) {
      notifyError(result.error ?? '新建技能失败')
      return false
    }

    markLocalChange()
    await reload()
    void select(id)
    return true
  }

  async function remove(id: string): Promise<boolean> {
    const result = await window.workbench.removeSkill(gitRoot.value, dir.value, id)
    if (!result.ok) {
      notifyError(result.error ?? '删除技能失败')
      return false
    }

    if (activeId.value === id)
      closeActive()
    markLocalChange()
    await reload()
    return true
  }

  async function importFrom(source: string, id: string): Promise<boolean> {
    const cleaned = sanitizeNoteName(id)
    if (noteNameProblem(cleaned)) {
      notifyError('技能名不合法')
      return false
    }
    if (skills.value.some(item => item.id === cleaned)) {
      notifyError(`已经有同名的技能了：${cleaned}`)
      return false
    }

    const result = await window.workbench.importSkill(gitRoot.value, dir.value, source, cleaned)
    if (!result.ok) {
      notifyError(result.error ?? '导入技能失败')
      return false
    }

    markLocalChange()
    await reload()
    void select(cleaned)
    return true
  }

  /** 版本历史：直接问 git（没有需要缓存的中间态），失败原因交给弹窗显示 */
  async function history(id: string): Promise<Result<SkillCommit[]>> {
    return window.workbench.skillHistory(gitRoot.value, dir.value, id)
  }

  /**
   * 某一版与现在这一份的逐文件对比（历史弹窗里的「对比」）。
   *
   * 结果的形状与「项目副本 vs 库」那条完全一样（base = 现在库里这份、incoming = 要采纳的那一版），
   * 所以对比弹窗只是换一个动作，看差异的部分一点没变。取不回来时把原因说出来并返回 null ——
   * 弹窗那边没有可显示的东西，不该打开一个空壳。
   */
  async function versionCompare(id: string, hash: string): Promise<SkillCompareFile[] | null> {
    const result = await window.workbench.compareSkillVersion(gitRoot.value, dir.value, id, hash)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '读取版本内容失败')
      return null
    }
    return result.data
  }

  /** 恢复到某个版本；成功后列表与打开着的正文都要重读（内容就是恢复回来的那份） */
  async function restore(id: string, hash: string): Promise<boolean> {
    const result = await window.workbench.restoreSkill(gitRoot.value, dir.value, id, hash)
    if (!result.ok) {
      notifyError(result.error ?? '恢复版本失败')
      return false
    }

    notifySuccess('已恢复到所选版本')
    markLocalChange()
    await reload()
    if (activeId.value === id)
      await select(id)
    return true
  }

  /**
   * 带确认的恢复 —— 历史列表的「恢复」与差异弹窗的「恢复到这个版本」两个入口共用这一句。
   *
   * 确认框里两件事必须说全：恢复替换的是**整个技能目录**（不是当前看的那一个文件），
   * 以及恢复本身也是一次提交、现在的内容留在历史里随时能回来 —— 只说「恢复？」的话，
   * 用户按下去才知道整个目录都变了。失败原因由 restore 弹出来。
   */
  async function restoreWithConfirm(id: string, hash: string): Promise<boolean> {
    const confirmed = await confirmAction(
      '这个技能的文件会变回所选版本的样子。恢复本身也是一次提交，现在的内容留在历史里，随时能再恢复回来。',
      '恢复到这个版本？',
      { confirmButtonText: '恢复' },
    )
    if (!confirmed)
      return false
    return restore(id, hash)
  }

  /**
   * 安装到项目。结果原样交回弹窗：目标已存在时 Rust 的错误是「已安装」，
   * 弹窗拿它去问「要不要覆盖」，确认后带 overwrite 重调。
   */
  async function install(
    id: string,
    projectDir: string,
    overwrite: boolean,
  ): Promise<Result<null>> {
    return window.workbench.installSkill(gitRoot.value, dir.value, id, projectDir, overwrite)
  }

  /**
   * 一次自动推送的等待时间：连着保存几处（对比弹窗一个文件一次）只推一趟。
   * 比笔记那 30 秒短得多 —— 那边的写盘是防抖自动保存，这里「保存」是用户按下的动作。
   */
  const AUTO_PUSH_DELAY_MS = 2_000
  /** 挂着的自动推送计时器 */
  let autoPushTimer: number | null = null

  /** 本地刚改过（适配层已经提交）：记下待推，等一小会儿自动推上去 */
  function markLocalChange(): void {
    needPush.value = true
    scheduleAutoPush()
  }

  /** 重置自动推送计时器：连着改几次只在最后一次之后推一趟 */
  function scheduleAutoPush(): void {
    if (!canSync.value)
      return
    if (autoPushTimer !== null)
      window.clearTimeout(autoPushTimer)
    autoPushTimer = window.setTimeout(() => {
      autoPushTimer = null
      void syncNow()
    }, AUTO_PUSH_DELAY_MS)
  }

  /** 取消挂着的自动推送（切走页面 / 换库 / 卸载前）：那一次由调用方立即补上 */
  function cancelAutoPush(): void {
    if (autoPushTimer !== null) {
      window.clearTimeout(autoPushTimer)
      autoPushTimer = null
    }
  }

  /**
   * 与远端同步一次：**技能库所在的那个仓库**（提交技能库那一层 → 拉 → 推）。
   *
   * 与笔记页那颗不是同一个入口，也不要求同一个仓库：技能库可能住在一个专门的技能仓库里，
   * 也可能正好落在笔记仓库里（那样两颗按钮推的是同一个仓库，各自的提交范围不同 ——
   * 这边只动技能库，那边提交整个笔记本）。
   * 回来后重扫列表、重读打开着的那一篇：远端可能刚改过它；编辑区有未保存的修改时不换正文。
   *
   * `force` 给手动按钮用：用户明确点了「同步」，即使本地没有待推改动也走一遍（确认对齐状态）。
   * 自动推送传 false：没有待推的就什么都不做，进页面 / 聚焦不会因此变成一次网络写。
   */
  async function syncNow(force = false): Promise<boolean> {
    cancelAutoPush()
    const current = gitRoot.value
    if (!current) {
      syncError.value = '技能库还不在 git 仓库里：改动的版本不会被记录，也没法同步'
      return false
    }
    if (syncing.value)
      return false
    if (!force && !canSync.value)
      return false
    if (!force && !needPush.value)
      return false

    syncing.value = true
    syncError.value = ''
    try {
      const result = await window.workbench.skillSync(current, dir.value)
      if (!result.ok || !result.data) {
        syncError.value = result.error ?? '同步失败'
        // 常见的一种失败是「用户刚在终端里补上 origin / init 了仓库」：再探一次，让按钮跟上
        void probeState()
        return false
      }

      needPush.value = false
      syncNotice.value = ''
      const received = result.data.received === true
      await reload()
      // 远端没带回新东西就不重读正文：那会白白刷掉「已保存 · 时间」这一行
      if (received && !(await rereadActive()) && contentDirty.value)
        syncNotice.value = '远端有更新；当前文件还有没保存的修改，编辑区没有被替换'
      return true
    }
    finally {
      syncing.value = false
    }
  }

  /**
   * 只拉不推（进技能页 / 窗口聚焦）：远端有新东西就重扫列表、重读打开着的正文。
   *
   * 不提交、不推送 —— 保存那次已经各自提交过，推送交给 `syncNow`。
   * 编辑区有未保存的修改时不换正文（只留一句 `syncNotice`）；**不清 needPush**：
   * 本地那批改动还要等自动推送那一次。
   */
  async function pullSkills(): Promise<boolean> {
    const current = gitRoot.value
    if (!current || syncing.value)
      return false

    syncing.value = true
    syncError.value = ''
    try {
      const result = await window.workbench.pullSkills(current, dir.value)
      if (!result.ok || !result.data) {
        syncError.value = result.error ?? '拉取技能失败'
        void probeState()
        return false
      }
      // 没有新东西就不重扫、不重读：省一次整棵目录的磁盘遍历
      if (!result.data.received)
        return false

      await reload()
      if (!activeId.value)
        return true
      if (contentDirty.value) {
        syncNotice.value = '远端有更新；当前文件还有没保存的修改，编辑区没有被替换'
        return true
      }
      await rereadActive()
      syncNotice.value = ''
      return true
    }
    finally {
      syncing.value = false
    }
  }

  /** 切走技能页之前把还没推的改动补推掉（后台跑，失败只写 syncError，不弹窗） */
  async function pushPending(): Promise<boolean> {
    if (!needPush.value || !canSync.value)
      return false
    return syncNow()
  }

  /**
   * 在资源管理器里显示技能（或技能库）所在的文件夹。
   *
   * 路径 = 仓库根 + 库在里面的相对路径（`gitRoot` / `dir` 都是探测回来的，可能带正斜杠）——
   * 分隔符不在这里操心：适配层交给资源管理器之前会统一成反斜杠（见 windowsPath）。
   */
  function reveal(id?: string): void {
    const rel = id ? skillRel(dir.value, id) : dir.value
    void window.workbench.reveal(`${gitRoot.value}\\${rel.replace(/\//g, '\\')}`)
  }

  return {
    root,
    dir,
    gitRoot,
    hasVersions,
    canSync,
    stateError,
    remoteUrl,
    locationText,
    skills,
    loading,
    loaded,
    loadError,
    activeId,
    activeFile,
    activeSkill,
    files,
    content,
    contentLoading,
    contentDirty,
    saving,
    saveError,
    savedAt,
    syncing,
    syncError,
    syncNotice,
    needPush,
    init,
    reload,
    setRoot,
    probeState,
    select,
    closeActive,
    openFile,
    adoptContent,
    saveActive,
    saveContent,
    create,
    remove,
    importFrom,
    history,
    versionCompare,
    restore,
    restoreWithConfirm,
    install,
    syncNow,
    pullSkills,
    pushPending,
    cancelAutoPush,
    reveal,
  }
})
