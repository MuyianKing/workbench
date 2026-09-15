/**
 * 笔记：一棵「文件夹 + 笔记」的树，以及当前打开的那一篇。
 *
 * 数据住在本机的 `note-data.json`（**不进同步仓库**，见 shared/note.ts 的文件头）。
 * 树的形状（同层不撞名、删文件夹连带子树）由适配层调 shared 里的纯函数保证，
 * 这里只做三件事：维护界面这一份、记住当前选中的是哪一篇、把动作转发给 `window.workbench`。
 *
 * 为什么不把整棵树摊在组件里：树（左栏）与编辑器（右栏）分属两个组件，
 * 而「新建完要选中它」「删掉的正是当前这篇时要把编辑器切走」都是**跨组件**的联动，
 * 放在 store 里两边读同一份状态，不必用事件把结果抛来抛去。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { countNotes, findNote, notePath, type NoteInput, type NoteNode } from '@shared/note'
import { notifyError } from '@/notify'

export const useNotesStore = defineStore('notes', () => {
  const nodes = ref<NoteNode[]>([])
  const activeId = ref<string | null>(null)
  /** 正在读盘；「还在读」与「读完了但一篇都没有」在界面上是两句不同的话 */
  const loading = ref(false)
  /** 读盘成功过：工具栏的新建按钮据此决定给不给点 */
  const loaded = ref(false)
  /** 读盘失败与「还一篇都没写过」是两回事，不能都显示成空态 */
  const loadError = ref('')
  /** 最近一次正文保存失败的原因；编辑器那行状态显示它 */
  const saveError = ref('')
  let ready = false
  let pending: Promise<void> | null = null

  /**
   * 当前选中的那个节点（左栏高亮的就是它），可能是一个文件夹。
   *
   * 「选中」与「打开」在这里是同一件事：点文件夹就是选中它（右栏说一句「这是个文件夹」），
   * 点笔记才是打开来写。分成两套状态的话，新建文件夹之后左栏没有任何反应，反而说不通。
   */
  const activeNode = computed(() =>
    activeId.value ? findNote(nodes.value, activeId.value) : null
  )

  /** 当前打开的笔记；选中的是文件夹（或什么都没选）时为 null，编辑器据此收起 */
  const activeNote = computed(() => {
    const node = activeNode.value
    return node && node.kind === 'note' ? node : null
  })

  /** 选中项从根到自身的链，界面拿它显示「它在哪一层」 */
  const activePath = computed(() =>
    activeId.value ? notePath(nodes.value, activeId.value) : []
  )

  const noteCount = computed(() => countNotes(nodes.value))

  /**
   * 首次进页面时读一次盘。
   *
   * 页面被 KeepAlive 包着，来回切页不会重挂载，所以这里还要挡住并发调用：
   * 两次进页面撞在一起时只读一次文件（读失败不置 ready，下次进来还能重试）。
   */
  async function init(): Promise<void> {
    if (ready) return
    if (!pending) {
      loading.value = true
      loadError.value = ''
      pending = (async () => {
        try {
          const result = await window.workbench.listNotes()
          if (!result.ok || !result.data) {
            loadError.value = result.error ?? '读取笔记失败'
            return
          }
          nodes.value = result.data
          ready = true
          loaded.value = true
        } catch (error) {
          loadError.value = error instanceof Error ? error.message : '读取笔记失败'
        } finally {
          loading.value = false
          pending = null
        }
      })()
    }
    await pending
  }

  function select(id: string | null): void {
    activeId.value = id
    saveError.value = ''
  }

  /**
   * 新建一个文件夹或笔记，建完就选中它。
   *
   * 文件夹不切编辑器（它不是能被编辑的东西），笔记则直接打开 —— 右键新建的本意就是「现在写它」。
   */
  async function create(input: NoteInput): Promise<NoteNode | null> {
    const result = await window.workbench.createNote(input)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '新建失败')
      return null
    }

    nodes.value = result.data.nodes
    // 建完就选中它：新笔记正是要来写的那一篇，新文件夹则是接下来要往里放东西的那个
    select(result.data.id)
    return findNote(nodes.value, result.data.id)
  }

  async function rename(id: string, name: string): Promise<boolean> {
    const result = await window.workbench.renameNote(id, name)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '重命名失败')
      return false
    }
    nodes.value = result.data
    return true
  }

  /**
   * 删除。删掉的正是当前这篇（或它所在的文件夹）时把编辑器收起来 ——
   * 否则右栏会继续显示一篇已经不存在的笔记，下一次自动保存就往一个空 id 上写。
   */
  async function remove(id: string): Promise<boolean> {
    const result = await window.workbench.removeNote(id)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '删除失败')
      return false
    }

    nodes.value = result.data
    if (activeId.value && !findNote(nodes.value, activeId.value)) select(null)
    return true
  }

  /**
   * 保存正文。
   *
   * 先在本地把这一篇改掉、再落盘：编辑器边打字边存，等一次 IPC 往返才更新状态会让
   * 「最后修改时间」那行明显滞后。失败不回滚内容（用户刚敲的字不能凭空消失），
   * 只把原因挂到 `saveError` 上由界面显示。
   *
   * 这里**不替换整棵树**：结构没变，只有这一篇的正文变了；替换会让左栏的树整体重建一遍，
   * 每敲一段就重建一次纯属白费，还会打断展开态的恢复。
   */
  async function saveContent(id: string, content: string): Promise<void> {
    const node = findNote(nodes.value, id)
    if (!node || node.kind !== 'note' || node.content === content) return

    node.content = content
    node.updatedAt = Date.now()

    const result = await window.workbench.updateNoteContent(id, content)
    // 这篇刚被删掉时保存会失败，这是正常路径，不该往界面上弹东西
    saveError.value = result.ok ? '' : (result.error ?? '保存笔记失败')
  }

  /** 给别的组件（工具栏的「新建笔记」）用的默认父级：当前选中的文件夹，选中的是笔记则用它的父级 */
  function currentFolderId(): string | null {
    const node = activeNote.value
    if (!node) return null
    if (node.kind === 'folder') return node.id
    const path = activePath.value
    return path.length > 1 ? path[path.length - 2].id : null
  }

  return {
    nodes,
    activeId,
    activeNode,
    activeNote,
    activePath,
    noteCount,
    loading,
    loaded,
    loadError,
    saveError,
    init,
    select,
    create,
    rename,
    remove,
    saveContent,
    currentFolderId
  }
})
