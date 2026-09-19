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
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { joinRel, noteNameProblem, sanitizeNoteName } from '@shared/note'
import {
  SKILL_FILE,
  sanitizeSkillSyncDir,
  skillFileRel,
  skillRel,
  type SkillCommit,
  type SkillCompareFile,
  type SkillCreateInput,
  type SkillEntry,
  type SkillFileInfo
} from '@shared/skills'
import type { Result } from '@/types'
import { notifyError, notifySuccess } from '@/notify'
import { useSettingsStore } from '@/stores/settings'

export const useSkillsStore = defineStore('skills', () => {
  const settings = useSettingsStore()

  /** 笔记根（技能库就住在它里面）；空串 = 还没选过文件夹，整页只给引导 */
  const root = computed(() => settings.settings.noteDir)
  /** 技能库相对路径（设置里的 `skillSyncDir`，这里取的是收敛后的值） */
  const dir = computed(() => sanitizeSkillSyncDir(settings.settings.skillSyncDir))
  /** 配了笔记仓库才有「同步」与远端那一半的版本历史；没配时技能只在本机、历史只到上次仓库状态为止 */
  const repoConfigured = computed(() => Boolean(settings.settings.noteSyncRepo))

  const skills = ref<SkillEntry[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref('')

  /** 当前打开的技能；编辑区只认它 */
  const activeId = ref('')
  /** 当前编辑的文件（相对技能目录的路径）：一个技能往往不止 SKILL.md，附属文件也在内 */
  const activeFile = ref(SKILL_FILE)
  /** 技能目录里的文件清单（切详情 / 保存 / 刷新时重拉） */
  const files = ref<SkillFileInfo[]>([])
  const content = ref('')
  const contentLoading = ref(false)
  const saving = ref(false)
  const saveError = ref('')
  /** 最近一次保存的时间（毫秒）：编辑区那行「已保存」用它 */
  const savedAt = ref(0)

  const syncing = ref(false)
  const syncError = ref('')

  const activeSkill = computed(() => skills.value.find((item) => item.id === activeId.value) ?? null)

  /** 库位置给人看的一句话：`<笔记本>/<技能库>` */
  const locationText = computed(() => {
    const parts = root.value.split(/[\\/]/).filter(Boolean)
    return `${parts[parts.length - 1] ?? root.value}/${dir.value}`
  })

  function reset(): void {
    skills.value = []
    closeActive()
    loaded.value = false
    loadError.value = ''
    syncError.value = ''
  }

  function closeActive(): void {
    activeId.value = ''
    activeFile.value = SKILL_FILE
    files.value = []
    content.value = ''
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
    const result = await window.workbench.listSkillFiles(root.value, dir.value, id)
    files.value = result.ok && result.data ? result.data : []
    if (!files.value.some((file) => file.rel === activeFile.value)) {
      if (files.value.some((file) => file.rel === SKILL_FILE) && activeFile.value !== SKILL_FILE) {
        await openFile(SKILL_FILE)
      }
    }
  }

  /** 读技能里的一个文件到编辑区（二进制读不出文本时如实报错，留在原文件） */
  async function openFile(rel: string): Promise<void> {
    const id = activeId.value
    if (!id) return

    contentLoading.value = true
    const result = await window.workbench.readSkillFile(root.value, dir.value, id, rel)
    contentLoading.value = false
    if (!result.ok || result.data === undefined) {
      notifyError(result.error ?? '读取文件失败（可能是二进制文件，暂不支持在应用内编辑）')
      return
    }

    activeFile.value = rel
    content.value = result.data
    saveError.value = ''
    savedAt.value = 0
  }

  /** 重新扫一遍技能库。打开着的技能没了（同步删了它 / 换了库）就一起收起来 */
  async function reload(): Promise<void> {
    const current = root.value
    if (!current) {
      reset()
      return
    }

    loading.value = true
    loadError.value = ''
    const result = await window.workbench.listSkills(current, dir.value)
    loading.value = false

    if (!result.ok || !result.data) {
      loadError.value = result.error ?? '读取技能失败'
      return
    }

    skills.value = result.data
    loaded.value = true
    if (activeId.value && !result.data.some((item) => item.id === activeId.value)) {
      closeActive()
      return
    }
    // 打开着的技能还在：文件清单跟着刷一遍（附属文件可能增删）
    if (activeId.value) await loadFiles()
  }

  let started = false
  let ready = false

  /** 首次进页面扫一次（KeepAlive 下来回切页不重挂载，这里挡住重复扫描） */
  async function init(): Promise<void> {
    if (started && ready) return
    started = true
    await reload()
  }

  // 笔记根或技能库路径变了（选了新文件夹、改了设置、别的窗口迁移）：全部重来
  watch([root, dir], () => {
    if (!started) return
    ready = false
    closeActive()
    void reload()
  })

  /** 打开一个技能的 SKILL.md。慢一步回来的旧结果直接丢掉（连点两行时各回各的） */
  async function select(id: string): Promise<void> {
    activeId.value = id
    activeFile.value = SKILL_FILE
    saveError.value = ''
    savedAt.value = 0

    contentLoading.value = true
    const result = await window.workbench.readNote(root.value, skillFileRel(dir.value, id))
    if (activeId.value === id) void loadFiles()
    contentLoading.value = false
    if (activeId.value !== id) return

    if (!result.ok || result.data === undefined) {
      closeActive()
      saveError.value = result.error ?? '读取 SKILL.md 失败'
      return
    }
    content.value = result.data
  }

  /**
   * 保存指定技能的指定文件（version 门槛只在 SKILL.md 上，见适配层）：编辑器的「保存」与
   * 「把项目里优化过的版本更新到库」走的是同一条路 —— 更新到库也是一次正常保存
   * （version 不合格照样被拦），成功后列表重扫（名字与描述可能变了）。
   * 失败原因留在 saveError 上，调用方（对比弹窗）拿它显示。
   */
  async function saveContent(id: string, rel: string, content: string): Promise<boolean> {
    if (saving.value) return false

    saving.value = true
    saveError.value = ''
    const result = await window.workbench.saveSkillFile(root.value, dir.value, id, rel, content)
    saving.value = false

    if (!result.ok) {
      saveError.value = result.error ?? '保存技能失败'
      return false
    }
    savedAt.value = Date.now()
    // 名字与描述是从 frontmatter 里解析的，正文改了列表就可能跟着变
    await reload()
    return true
  }

  /** 保存编辑器里打开的那一个文件 */
  async function saveActive(): Promise<boolean> {
    const id = activeId.value
    if (!id) return false
    return saveContent(id, activeFile.value, content.value)
  }

  async function create(input: SkillCreateInput): Promise<boolean> {
    const problem = noteNameProblem(input.id)
    if (problem) {
      notifyError(problem)
      return false
    }
    const id = sanitizeNoteName(input.id)
    if (skills.value.some((item) => item.id === id)) {
      notifyError(`已经有同名的技能了：${id}`)
      return false
    }

    const result = await window.workbench.createSkill(root.value, dir.value, { ...input, id })
    if (!result.ok) {
      notifyError(result.error ?? '新建技能失败')
      return false
    }

    await reload()
    void select(id)
    return true
  }

  async function remove(id: string): Promise<boolean> {
    const result = await window.workbench.removeSkill(root.value, dir.value, id)
    if (!result.ok) {
      notifyError(result.error ?? '删除技能失败')
      return false
    }

    if (activeId.value === id) closeActive()
    await reload()
    return true
  }

  async function importFrom(source: string, id: string): Promise<boolean> {
    const cleaned = sanitizeNoteName(id)
    if (noteNameProblem(cleaned)) {
      notifyError('技能名不合法')
      return false
    }
    if (skills.value.some((item) => item.id === cleaned)) {
      notifyError(`已经有同名的技能了：${cleaned}`)
      return false
    }

    const result = await window.workbench.importSkill(root.value, dir.value, source, cleaned)
    if (!result.ok) {
      notifyError(result.error ?? '导入技能失败')
      return false
    }

    await reload()
    void select(cleaned)
    return true
  }

  /** 版本历史：直接问 git（没有需要缓存的中间态），失败原因交给弹窗显示 */
  async function history(id: string): Promise<Result<SkillCommit[]>> {
    return window.workbench.skillHistory(root.value, dir.value, id)
  }

  /**
   * 某一版与现在这一份的逐文件对比（历史弹窗里的「对比」）。
   *
   * 结果的形状与「项目副本 vs 库」那条完全一样（base = 现在库里这份、incoming = 要采纳的那一版），
   * 所以对比弹窗只是换一个动作，看差异的部分一点没变。取不回来时把原因说出来并返回 null ——
   * 弹窗那边没有可显示的东西，不该打开一个空壳。
   */
  async function versionCompare(id: string, hash: string): Promise<SkillCompareFile[] | null> {
    const result = await window.workbench.compareSkillVersion(root.value, dir.value, id, hash)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '读取版本内容失败')
      return null
    }
    return result.data
  }

  /** 恢复到某个版本；成功后列表与打开着的正文都要重读（内容就是恢复回来的那份） */
  async function restore(id: string, hash: string): Promise<boolean> {
    const result = await window.workbench.restoreSkill(root.value, dir.value, id, hash)
    if (!result.ok) {
      notifyError(result.error ?? '恢复版本失败')
      return false
    }

    notifySuccess('已恢复到所选版本')
    await reload()
    if (activeId.value === id) await select(id)
    return true
  }

  /**
   * 安装到项目。结果原样交回弹窗：目标已存在时 Rust 的错误是「已安装」，
   * 弹窗拿它去问「要不要覆盖」，确认后带 overwrite 重调。
   */
  async function install(
    id: string,
    projectDir: string,
    overwrite: boolean
  ): Promise<Result<null>> {
    return window.workbench.installSkill(root.value, dir.value, id, projectDir, overwrite)
  }

  /**
   * 与远端同步一次 —— 走的就是笔记同步（技能在同一个仓库里，一次同步两者都带上）。
   * 回来后重扫列表、重读打开着的那一篇：远端可能刚改过它。
   */
  async function syncNow(): Promise<void> {
    const repo = settings.settings.noteSyncRepo
    if (!repo) {
      syncError.value = '还没有配置笔记仓库（设置 → 笔记）'
      return
    }
    if (!root.value) {
      syncError.value = '还没有选择笔记文件夹'
      return
    }

    syncing.value = true
    syncError.value = ''
    try {
      const result = await window.workbench.syncNotes({ repo, dir: root.value })
      if (!result.ok || !result.data) {
        syncError.value = result.error ?? '同步失败'
        return
      }

      await reload()
      if (activeId.value) await select(activeId.value)
      syncError.value = ''
    } finally {
      syncing.value = false
    }
  }

  /** 在资源管理器里显示技能（或技能库）所在的文件夹 */
  function reveal(id?: string): void {
    const rel = id ? skillRel(dir.value, id) : dir.value
    void window.workbench.reveal(`${root.value}\\${rel.replace(/\//g, '\\')}`)
  }

  return {
    root,
    dir,
    repoConfigured,
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
    saving,
    saveError,
    savedAt,
    syncing,
    syncError,
    init,
    reload,
    select,
    closeActive,
    openFile,
    saveActive,
    saveContent,
    create,
    remove,
    importFrom,
    history,
    versionCompare,
    restore,
    install,
    syncNow,
    reveal
  }
})
