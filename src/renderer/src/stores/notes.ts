/**
 * 笔记：一个**用户自己挑的文件夹**，以及它里面的目录树与当前打开的那一篇。
 *
 * 与别的 store 最大的不同是：这里没有内存副本。笔记就是磁盘上的 `.md` 文件
 * （见 shared/note.ts 的文件头），所以「树」是扫出来的、「正文」是读出来的，
 * 落盘就是写文件本身 —— 换台机器、拿别的编辑器改那些文件，回来刷新一下就是最新的样子。
 * 这一层只负责编排：谁被选中、什么时候读盘、改完之后把结果接到哪一步上。
 *
 * 三条不能破：
 *   - **没选文件夹就什么都不做**：`root` 空串时界面上是一句引导（NotesView），
 *     这里也不会有任何写操作的机会 —— 路径都拿不出来；
 *   - **结构改动一律用后端回来的新树**，不在本地推算。改名 / 拖动会让**当前打开的那一篇**
 *     换一个路径，所以后端把「被改动节点的新路径」一起带回来，`remapActive` 负责接着认下去；
 *   - **打开的那一篇只有一个来源**：先读盘的赢（`openJob` 令牌），慢一步回来的那份直接丢掉，
 *     否则连点两篇会让右栏显示其中一篇、正文却是另一篇的（踩过）。
 *
 * 「与远端同步」也在这里（`syncNotes`）：它是这个领域里唯一一次会把磁盘**整片换掉**的操作，
 * 所以回来之后必须重扫一遍树、并重读打开着的那一篇（远端可能刚好改过它）。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  countNotes,
  findNoteNode,
  noteChain,
  noteRootName,
  pushNoteHistory,
  removeFromNoteHistory,
  sanitizeNoteRoot,
  uniqueNoteName,
  type NoteCreateInput,
  type NoteDocument,
  type NoteNode,
  type NoteSyncSummary
} from '@shared/note'
import { notifyError } from '@/notify'
import { useSettingsStore } from '@/stores/settings'

/** 一次同步的结果：Rust 回来那份摘要 + 「打开着的那一篇要不要重新载一遍」 */
export interface NoteSyncOutcome {
  summary: NoteSyncSummary
  /**
   * 打开着的那一篇在同步之后变了（远端改过它）。
   *
   * 由界面转达给编辑器（`editorRef.reloadFromProps()`）：store 拿不到编辑器实例，
   * 而「把新正文塞进 Vditor」是编辑器自己的事。
   */
  activeChanged: boolean
}

export const useNotesStore = defineStore('notes', () => {
  const settings = useSettingsStore()

  /** 笔记文件夹；空串表示还没选过（第一次进笔记页时就是这个状态） */
  const root = computed(() => settings.settings.noteDir)
  const rootName = computed(() => noteRootName(root.value))
  /** 打开过的笔记本（最近打开的在最前面）；左栏底部那段「最近打开」就是它 */
  const recentRoots = computed(() => settings.settings.noteDirs)

  /** 目录树的顶层（文件夹与笔记，已按「文件夹在前、同层按名字」排好） */
  const nodes = ref<NoteNode[]>([])
  /** 当前选中的路径（可能是文件夹，也可能是笔记）；界面高亮的就是它 */
  const activeRel = ref('')
  /** 当前打开的那一篇的正文；选中的是文件夹（或什么都没选）时是 null */
  const active = ref<NoteDocument | null>(null)

  const loading = ref(false)
  /** 至少成功读过一次盘：工具栏的按钮据此决定给不给点 */
  const loaded = ref(false)
  /** 读盘失败与「这个文件夹里什么都没有」是两回事，不能都显示成空态 */
  const loadError = ref('')
  /** 打开某一篇失败的原因（文件被删掉、内容读不出来） */
  const openError = ref('')
  /** 最近一次正文保存失败的原因；编辑器那行状态显示它 */
  const saveError = ref('')
  /** 最近一次正文落盘成功的时间（毫秒）：右栏显示「已保存」用 */
  const savedAt = ref(0)
  /** 正在与远端同步一次（那颗按钮转圈、并挡住重复点击） */
  const syncing = ref(false)
  /** 上一次同步失败的原因；没配地址也走这里（界面拿它提示） */
  const syncError = ref('')

  /** 进过页面没有：设置是在页面之外被改的（别的窗口 / 迁移），没进过页面就不必跟着扫 */
  let started = false
  let ready = false
  let pending: Promise<void> | null = null
  /** 扫描与打开各自的令牌：慢一步回来的结果直接丢掉 */
  let scanJob = 0
  let openJob = 0
  /** 最近一次正文落盘；同步前要等它落地（见 waitForWrites） */
  let writing: Promise<void> = Promise.resolve()

  const noteCount = computed(() => countNotes(nodes.value))
  /** 选中项从最外层到自身的链；界面拿它写「它在哪一层」与面包屑 */
  const activeChain = computed(() =>
    activeRel.value ? noteChain(nodes.value, activeRel.value) : []
  )

  function reset(): void {
    nodes.value = []
    activeRel.value = ''
    active.value = null
    loaded.value = false
    loadError.value = ''
    openError.value = ''
    saveError.value = ''
  }

  /**
   * 重新扫一遍文件夹。
   *
   * 扫完顺手核一遍「打开的那一篇还在不在」：在应用外面把它删掉 / 改名之后，
   * 编辑器不该继续对着一个不存在的路径自动保存 —— 那会把它重新创建出来。
   */
  async function reload(): Promise<void> {
    const current = root.value
    if (!current) {
      reset()
      return
    }

    const job = (scanJob += 1)
    loading.value = true
    loadError.value = ''

    const result = await window.workbench.listNotes(current)
    if (job !== scanJob) return
    loading.value = false

    if (!result.ok || !result.data) {
      loadError.value = result.error ?? '读取笔记文件夹失败'
      return
    }

    nodes.value = result.data
    loaded.value = true
    ready = true

    // 打开的那一篇在磁盘上没了（在应用外面删掉 / 改名 / 换文件夹）：把选中项也一起收起来，
    // 否则右栏会对着一个已经不存在的路径继续显示，下一次自动保存还会把它重新创建出来
    if (activeRel.value && !findNoteNode(nodes.value, activeRel.value)) {
      activeRel.value = ''
      closeNote()
    }
  }

  /**
   * 首次进页面时扫一次。
   *
   * 页面被 KeepAlive 包着，来回切页不会重挂载，所以这里挡住并发调用，
   * 并且只在读成功之后才算「就绪」（失败时下次进来还能重试）。
   */
  async function init(): Promise<void> {
    started = true
    if (ready) return
    if (!pending) {
      pending = reload().finally(() => {
        pending = null
      })
    }
    await pending
  }

  /**
   * 记下用户挑的文件夹，并把它排到「最近打开」的最前面。
   *
   * 落盘走设置（`noteDir` + `noteDirs`），随后的扫描由下面那条 watch 触发 ——
   * 两条路各扫一次的话，慢的那次会把快的覆盖掉。
   */
  async function setRoot(dir: string): Promise<boolean> {
    const target = sanitizeNoteRoot(dir)
    if (!target) return false

    return settings.updateSettings({
      noteDir: target,
      noteDirs: pushNoteHistory(settings.settings.noteDirs, target)
    })
  }

  /**
   * 从「最近打开」里删掉一条。
   *
   * 只是不再列出来 —— 删的若是当前打开的那个，笔记本不跟着换（那得由用户另挑一个），
   * 所以这里只动 `noteDirs`，不碰 `noteDir`。
   */
  async function forgetRoot(dir: string): Promise<boolean> {
    return settings.updateSettings({
      noteDirs: removeFromNoteHistory(settings.settings.noteDirs, dir)
    })
  }

  // 设置里的笔记文件夹一改就重新扫（首次选的目录、换一个目录、清空都走这里）
  watch(root, () => {
    if (!started) return
    ready = false
    void reload()
  })

  /** 收起编辑器（删掉正在写的那一篇、切到文件夹、换文件夹时都用到） */
  function closeNote(): void {
    active.value = null
    openError.value = ''
  }

  /**
   * 选中一个节点。
   *
   * 选中与打开在界面上是同一件事：点文件夹就是选中它（右栏说一句「这是个文件夹」），
   * 点笔记才是打开来写。分成两套状态的话，新建完一个文件夹左栏没有任何反应，反而说不通。
   */
  function select(rel: string): void {
    const node = findNoteNode(nodes.value, rel)
    activeRel.value = rel
    saveError.value = ''

    if (!node || node.kind === 'folder') {
      closeNote()
      return
    }
    void open(node)
  }

  /** 读一篇的正文并打开它 */
  async function open(node: NoteNode): Promise<void> {
    /**
     * 已经打开着这一篇就什么都不做。
     *
     * 不能「再读一遍」：编辑器手上那份可能比磁盘新（防抖窗口里还没写下去的字），
     * 把它换成盘上那份旧的之后，再输入就会以旧的结尾往下写 —— 刚才那几个字就没了。
     * 换了别的篇再回来时 rel 变了，那时才真的重读。
     */
    if (active.value?.rel === node.rel) return

    const job = (openJob += 1)
    const result = await window.workbench.readNote(root.value, node.rel)
    // 期间又点了别的（或换了文件夹）：这一份已经过期了
    if (job !== openJob) return

    if (!result.ok || result.data === undefined) {
      closeNote()
      openError.value = result.error ?? '读取笔记失败'
      return
    }

    openError.value = ''
    saveError.value = ''
    active.value = {
      rel: node.rel,
      name: node.name,
      content: result.data,
      mtimeMs: node.mtimeMs ?? 0
    }
  }

  /**
   * 保存正文。
   *
   * 不回滚内容：用户刚敲的字不能因为一次写盘失败就消失，失败原因挂在 `saveError` 上由界面显示。
   * 也不替换整棵树 —— 结构没变，重建一遍只会打断左栏的展开态。
   *
   * 路径已经不在树里时（刚被改名 / 拖动 / 删除）这一次写盘直接不发出去：
   * 那个位置在磁盘上已经没有了，写下去会在原地凭空长出一个同名文件 ——
   * 编辑器交回来的这一段是**上一次**写盘之前的旧路径（改名那一下它还没换过来），
   * 内容本身没丢：改名的对话框点完就要几百毫秒，防抖攒下的那一段通常早写完了；
   * 真撞上极端时序时宁可少最后几个字，也不要留下一个没人认领的文件。
   */
  function saveContent(rel: string, content: string): Promise<void> {
    if (!findNoteNode(nodes.value, rel)) return Promise.resolve()

    const task = writeContent(rel, content)
    writing = task
    return task
  }

  async function writeContent(rel: string, content: string): Promise<void> {
    const result = await window.workbench.writeNote(root.value, rel, content)
    saveError.value = result.ok ? '' : (result.error ?? '保存笔记失败')
    if (!result.ok) return

    savedAt.value = Date.now()
    // 本地也记下这一份：右栏那句「最后修改」与下次打开时给的初值都用它
    if (active.value?.rel === rel) {
      active.value.content = content
      active.value.mtimeMs = savedAt.value
    }
  }

  /**
   * 等最近一次落盘落地。
   *
   * 同步前必须等它：编辑器是防抖写盘的，点下同步按钮那一刻可能还有一份在路上，
   * 不等的话提交上去的是「按下按钮之前」的那一版（内容没丢，但同步的就该是用户看到的东西）。
   */
  function waitForWrites(): Promise<void> {
    return writing
  }

  /**
   * 与远端同步一次：提交本机改动 → 拉 → 推（细节全在 `sync::sync_notes`）。
   *
   * 调用方（笔记页那颗按钮）负责**先让编辑器把手上的那一份交出来**并 `waitForWrites`
   * —— 编辑器里的防抖是组件自己的事，store 够不着它。
   *
   * 回来之后还有两件必做的事：
   *  1. **重新扫一遍树**：远端可能带来新文件、也可能改掉 / 删掉某几篇，而树只信磁盘（`reload`）；
   *  2. **重读打开着的那一篇**（若它被远端改过）：编辑器手上那份是旧的，不换掉的话
   *     下一次输入就会以旧内容为准把远端那份盖回去。换内容这件事本身由界面转达给编辑器
   *     （见返回的 activeChanged），store 不直接碰编辑器实例。
   *
   * 返回 null 表示这次没成，原因在 `syncError` 里（没配地址、git 的话、冲突的文件名都在那）。
   */
  async function syncNotes(): Promise<NoteSyncOutcome | null> {
    const repo = settings.settings.noteSyncRepo
    if (!repo) {
      syncError.value = '还没有配置笔记仓库（设置 → 笔记）'
      return null
    }
    const current = root.value
    if (!current) {
      syncError.value = '还没有选择笔记文件夹'
      return null
    }

    syncing.value = true
    syncError.value = ''
    try {
      const result = await window.workbench.syncNotes({
        repo,
        dir: current,
        useAccount: settings.settings.useAccountForSync
      })
      if (!result.ok || !result.data) {
        syncError.value = result.error ?? '同步笔记失败'
        return null
      }

      await reload()
      const activeChanged = await rereadActive()
      return { summary: result.data, activeChanged }
    } finally {
      syncing.value = false
    }
  }

  /**
   * 把打开着的那一篇从磁盘重读一份（同步之后远端可能改过它）。
   *
   * 内容一样就什么都不做：白换一次会用掉编辑器里的撤销栈。
   * 这一篇要是在这次同步里被删掉了，`reload` 已经把它收起来了（`active` 是 null），这里直接跳过。
   */
  async function rereadActive(): Promise<boolean> {
    const current = active.value
    if (!current) return false

    const result = await window.workbench.readNote(root.value, current.rel)
    if (!result.ok || result.data === undefined) return false
    if (result.data === current.content) return false

    active.value = {
      rel: current.rel,
      name: current.name,
      content: result.data,
      mtimeMs: findNoteNode(nodes.value, current.rel)?.mtimeMs ?? current.mtimeMs
    }
    return true
  }

  /**
   * 改完之后把当前打开的那一篇接着认下去。
   *
   * `from` 是被改动节点的老路径，`to` 是它的新路径（删除时是空串）：
   * 打开的那一篇正是它、或正住在它里面时，路径都要跟着换 ——
   * 否则编辑器会继续往老路径上写，那已经不是同一篇了。
   */
  function remapActive(from: string, to: string): void {
    const current = activeRel.value
    if (!current) return
    if (current !== from && !current.startsWith(`${from}/`)) return

    const next = to ? `${to}${current.slice(from.length)}` : ''
    activeRel.value = next
    if (!active.value) return

    if (!next) {
      closeNote()
      return
    }
    const node = findNoteNode(nodes.value, next)
    active.value = {
      rel: next,
      name: node?.name ?? active.value.name,
      content: active.value.content,
      mtimeMs: node?.mtimeMs ?? active.value.mtimeMs
    }
  }

  /**
   * 新建一个文件夹或笔记，建完就选中它。
   *
   * 重名在这里退让（`新建笔记 2`）：从右键菜单新建时多数人不打算起名，
   * 为此弹一句「已存在同名」只会挡路；重命名不退让，那是用户自己打的名字。
   */
  async function create(input: NoteCreateInput): Promise<NoteNode | null> {
    const parent = input.parentRel ?? ''
    const siblings = parent ? (findNoteNode(nodes.value, parent)?.children ?? []) : nodes.value
    const name = uniqueNoteName(siblings, input.name)

    const result = await window.workbench.createNote(root.value, { ...input, name })
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '新建失败')
      return null
    }

    nodes.value = result.data.nodes
    // 建完就选中它：新笔记正是要来写的那一篇，新文件夹则是接下来要往里放东西的那个
    select(result.data.rel)
    return findNoteNode(nodes.value, result.data.rel)
  }

  async function rename(rel: string, name: string): Promise<boolean> {
    const result = await window.workbench.renameNote(root.value, rel, name)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '重命名失败')
      return false
    }

    nodes.value = result.data.nodes
    remapActive(rel, result.data.rel)
    return true
  }

  /**
   * 删除。删掉的正是当前打开的那一篇（或它所在的文件夹）时把编辑器收起来 ——
   * 否则右栏会继续显示一篇已经不存在的笔记，下一次自动保存会把它重新创建出来。
   */
  async function remove(rel: string): Promise<boolean> {
    const result = await window.workbench.removeNote(root.value, rel)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '删除失败')
      return false
    }

    nodes.value = result.data.nodes
    remapActive(rel, '')
    return true
  }

  /** 把一篇拖进某个文件夹（`targetDir` 为空串表示拖回最外层） */
  async function move(rel: string, targetDir: string): Promise<boolean> {
    const result = await window.workbench.moveNote(root.value, rel, targetDir)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '移动失败')
      return false
    }

    nodes.value = result.data.nodes
    remapActive(rel, result.data.rel)
    return true
  }

  return {
    root,
    rootName,
    recentRoots,
    nodes,
    activeRel,
    active,
    activeChain,
    noteCount,
    loading,
    loaded,
    loadError,
    openError,
    saveError,
    savedAt,
    syncing,
    syncError,
    init,
    reload,
    setRoot,
    forgetRoot,
    select,
    create,
    rename,
    remove,
    move,
    saveContent,
    waitForWrites,
    syncNotes,
    closeNote
  }
})
