<script setup lang="ts">
import type { NoteKind, NoteSyncSummary } from '@workbench/notes'
import { Document, EditPen, FolderOpened, Notebook, Picture, Refresh, RefreshRight } from '@element-plus/icons-vue'
import { countNodes, findNoteNode, noteAbsPath, noteRootName } from '@workbench/notes'
import { ElMessage } from 'element-plus'
/**
 * 笔记页：左边目录树，右边正文。
 *
 * 它就是一个**本地 markdown 编辑器**，笔记本是用户自己挑的一个文件夹
 * （设置里的 `noteDir`，见 packages/notes/src/note.ts 的文件头）。所以这一页有两种样子：
 *   - **还没选文件夹**：整页只有一句引导与那颗「选择文件夹」按钮。
 *     在那之前不给任何操作入口 —— 没有文件夹就没有地方放笔记，先摆一排按钮只是挡路；
 *   - **选好了**：左树右正文，新建都从树的右键菜单走（顶部那条工具条已经去掉），
 *     左栏底部是笔记本本身与「最近打开」那一份历史记录。
 *
 * 两栏的分隔线可以左右拖（宽度住在 theme.json 里，见 packages/appearance/src/theme.ts 的 `noteTreeWidth`），
 * 右栏大纲常显、拖它左缘那条缝也能改宽（`noteRailWidth`），与首页那两条栏宽把手同一套做法：
 * 拖动时只改本地让界面跟手，松手才落盘。
 *
 * 另外还有一档**只读**（**默认就是它**，Ctrl+/ 切到可写）：读一篇长笔记时不想手一抖改掉它，
 * 就把**正文**的写入口收起来（正文、格式菜单），省得「看一眼」变成「改一处」。
 * 这一档不落盘，开着的时候标题行里挂着「只读」（带快捷键提示）—— 口径与三条守卫见 readOnly / onShortcut 那两段。
 *
 * 与其它页面一样，它是导航栏上的一项（见 packages/appearance/src/views.ts），换页由 App.vue 的
 * `<KeepAlive><component :is>` 负责 —— 切走再回来时编辑器还是刚才那一篇、光标位置也还在。
 * 数据与动作都在 store 里，这一层负责编排：谁被选中、什么时候弹起名字的弹窗、
 * 增删改的确认与提示。树在 NoteTree，正文编辑在 NoteEditor，
 * 左栏底部那一行与分隔条是 RecentRoots / PanelResizer（与视频页共用）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { copyText } from '@/clipboard'
import NoteAssetsDialog from '@/components/NoteAssetsDialog.vue'
import NoteEditor from '@/components/NoteEditor.vue'
import NoteNameDialog from '@/components/NoteNameDialog.vue'
import NoteTree from '@/components/NoteTree.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import RecentRoots from '@/components/RecentRoots.vue'
import SideLoadError from '@/components/SideLoadError.vue'
import { toggleOutlineRow } from '@/composables/use-outline-row-toggle'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { formatTimestamp } from '@/format'
import { confirmAction, notifyError } from '@/notify'
import { useNavStore } from '@/stores/nav'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'

const store = useNotesStore()
const settings = useSettingsStore()
const nav = useNavStore()

/**
 * 目录树的展开态（行为记忆）：状态住在设置里，这一层只做「读出来 / 写回去」。
 *
 * 树自己不留第二份（见 NoteTree 的文件头）：上次摊开的那几层下次进来还是摊开的。
 * 只对当前这个笔记本成立 —— 换笔记本时由 notes store 的 setRoot 清空，
 * 因为相对路径在另一个笔记本里指的是完全不同的东西。
 */
const expandedKeys = computed<string[]>({
  get: () => settings.settings.noteTreeExpanded,
  set: (value) => {
    void settings.updateSettings({ noteTreeExpanded: value })
  },
})

/**
 * 起名字的那个弹窗：新建与重命名共用。
 *
 * `mode` 决定提交后走哪条路 —— 两者的差别只有「落在哪个文件夹」和「报什么错」，
 * 让两个入口各写一个弹窗只会让校验那一段抄两遍。
 */
const dialog = reactive({
  open: false,
  mode: 'create' as 'create' | 'rename',
  kind: 'note' as NoteKind,
  /** 新建时落在哪个文件夹（相对路径）；空串表示最外层 */
  parentRel: '',
  /** 重命名时的目标路径 */
  targetRel: '',
})

const dialogTitle = computed(() => {
  if (dialog.mode === 'rename')
    return dialog.kind === 'folder' ? '重命名文件夹' : '重命名笔记'
  return dialog.kind === 'folder' ? '新建文件夹' : '新建笔记'
})

const dialogDefaultName = computed(() => {
  if (dialog.mode === 'rename')
    return findNoteNode(store.nodes, dialog.targetRel)?.name ?? ''
  return dialog.kind === 'folder' ? '新建文件夹' : '新建笔记'
})

/** 正在扫盘：右栏据此说一句「正在读取」，而不是显示成「这个文件夹里什么都没有」 */
const scanning = computed(() => store.loading && !store.loaded)
/**
 * 「它在哪一层」：选中项**所在的那几层文件夹**，从最外层排下来。
 *
 * 末尾那个（选中项自己）要摘掉 —— 它已经写在标题上了，留着就是「README README」
 * 这种并排重复（选中的是文件夹时同样如此）。最外层的东西没有上一级，这时它是空串，
 * 标题行只剩名字与保存状态。
 */
const locationText = computed(() =>
  store.activeChain
    .slice(0, -1)
    .map(node => node.name)
    .join(' / '),
)

/** 保存状态：失败时给原因，正常时给最后一次落盘的时间 */
const savedText = computed(() => {
  if (!store.active)
    return ''
  const at = store.savedAt || store.active.mtimeMs
  return at ? `已保存 · ${formatTimestamp(at)}` : '已保存'
})

/** 两栏的宽度：左栏是主题里存的那个值，分隔条按它定位 */
const bodyStyle = computed(() => ({
  'gridTemplateColumns': `${settings.themeConfig.noteTreeWidth}px minmax(0, 1fr)`,
  '--tree-w': `${settings.themeConfig.noteTreeWidth}px`,
}))

/** 素材管理那个面板：当前笔记本在这台机器上传过哪些图、谁还在用（见 NoteAssetsDialog） */
const assetsOpen = ref(false)

/**
 * 只读模式：这一页不接任何写入口，只让人把东西看清楚。**Ctrl+/ 切换**（见 onShortcut）。
 *
 * **默认就是这一档**（初值 `true`）：进笔记页先按「读」来，想写才按那一下切过去 ——
 * 「看一眼」变成「改一处」是这个页面上最容易犯的事（点进代码块、顺手勾一个框、
 * 甚至贴一张图就推一次 git），把默认值放在安全那一侧，代价只是想写的时候多按一次。
 *
 * **不落盘**（不写设置）：它记的是「这一趟用它来干什么」，不是「我偏好什么」——
 * 落盘的话，某次读着读着关掉应用，下次打开笔记就是不能写的，而那时未必想得起来按什么切回来。
 * 标题行里那颗「只读」小片（带提示，写着 Ctrl+/）就是这一档的落点。
 *
 * 关掉的写入口有两处，各在自己的地方实现，改的时候不要漏掉任何一处：
 *  1. 正文（NoteEditor 收 `readOnly`，落到 Vditor 的 `disabled()`）：不能打字，
 *     粘贴 / 拖进来的图片也不会上传（那一下是往图片仓库推一次 git）；
 *  2. 正文的格式右键菜单（同上）：只读下它一个动作都做不了，索性不弹。
 *
 * **不管左栏**：目录树上的新建 / 重命名 / 删除 / 拖动都是用户明确点下去的动作（删除还有确认框），
 * 不属于「读的时候手一抖」那类误触，所以树不接这一档（NoteTree 没有 readOnly 这个 prop）；
 * 左栏底部那两颗按钮（同步、素材管理）动的是远端与图片仓库，也不归它管。
 */
const readOnly = ref(true)

/**
 * Ctrl+/ 切只读。
 *
 * 三条守卫都是必须的：
 *  - **只有在笔记页显示着的时候接手**：KeepAlive 把这一页留在内存里，切走之后监听器还在，
 *    不判当前页的话在别处按 Ctrl+/ 也会悄悄动它；
 *  - 焦点在输入框里（起名字的那个弹窗）时让路。**正文是 contenteditable，不能一起挡掉** ——
 *    正读着某一篇、光标就在编辑器里的时候，才最想按这一下；
 *  - 还没选笔记本（整页只有一句引导）时不动：那时没有「模式」可言。
 *
 * 认 `event.key` 而不是 `event.code`：要的是「打出来是 `/`」，各键盘布局自己算 ——
 * 有些布局上 `/` 本来就在 Shift 那一档，按 `code` 判就会漏掉它们。
 */
function onShortcut(event: KeyboardEvent): void {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing)
    return
  if (event.key !== '/' || nav.activeView !== 'notes' || !store.root)
    return

  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select'))
    return

  event.preventDefault()
  readOnly.value = !readOnly.value
}

onMounted(() => {
  void store.init()
  // 捕获阶段挂：编辑器 / 弹窗自己也会处理键盘，这一下要在它们之前拿到
  window.addEventListener('keydown', onShortcut, true)
  // 别的编辑器改完、切回应用：打开着的那一篇要跟着变（见 onWindowFocus）
  window.addEventListener('focus', onWindowFocus)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onShortcut, true)
  window.removeEventListener('focus', onWindowFocus)
})

/** 第一次进来（或想换一个目录）时挑文件夹；取消就什么都不做 */
async function chooseFolder(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择笔记文件夹')
  if (!picked)
    return

  if (await store.setRoot(picked))
    ElMessage.success('笔记本已切换')
}

/** 从「最近打开」里换一个笔记本（当前的那条 RecentRoots 自己拦下了） */
function openRecentRoot(dir: string): void {
  void store.setRoot(dir)
}

/** 在指定的文件夹里新建；`parentRel` 为空串表示最外层 */
function openCreateIn(parentRel: string, kind: NoteKind): void {
  dialog.mode = 'create'
  dialog.kind = kind
  dialog.parentRel = parentRel
  dialog.targetRel = ''
  dialog.open = true
}

function openRename(rel: string): void {
  const node = findNoteNode(store.nodes, rel)
  if (!node)
    return
  dialog.mode = 'rename'
  dialog.kind = node.kind
  dialog.parentRel = ''
  dialog.targetRel = rel
  dialog.open = true
}

async function submitName(name: string): Promise<void> {
  if (dialog.mode === 'rename') {
    if (await store.rename(dialog.targetRel, name))
      ElMessage.success('已重命名')
    return
  }

  const created = await store.create({ parentRel: dialog.parentRel, kind: dialog.kind, name })
  if (created)
    ElMessage.success(dialog.kind === 'folder' ? '已新建文件夹' : '已新建笔记')
}

/**
 * 删除。
 *
 * 文件夹会带走整棵子树，所以确认框里先把「要删掉几个」说清楚 ——
 * 只说一句「删除文件夹？」的话，用户按下去才知道里面还有东西。
 */
async function remove(rel: string): Promise<void> {
  const node = findNoteNode(store.nodes, rel)
  if (!node)
    return

  const detail
    = node.kind === 'note'
      ? `删除笔记「${node.name}」？`
      : `删除文件夹「${node.name}」及里面的 ${countNodes(node.children ?? [])} 项？`
  if (!(await confirmAction(`${detail}删除后不可恢复。`, '删除', { confirmButtonText: '删除' }))) {
    return
  }

  if (await store.remove(rel))
    ElMessage.success('已删除')
}

/**
 * 在资源管理器中定位。
 *
 * 路径由 `noteAbsPath` 按笔记本根拼出来：笔记命令只认相对路径，而系统的能力（reveal）只认
 * 绝对路径。文件是选中它、文件夹是直接进去（口径见 src-tauri/src/system.rs 的 reveal）。
 * 这两项都是「看」，只读模式下照样给。
 */
function revealNote(rel: string): void {
  void window.workbench.reveal(noteAbsPath(store.root, rel))
}

/** 在资源管理器里打开笔记本本身（空白区菜单里那一项） */
function revealNotebook(): void {
  void window.workbench.reveal(store.root)
}

/** 复制这一项的绝对路径（粘到终端或别的编辑器里用） */
function copyNotePath(rel: string): void {
  void copyText(noteAbsPath(store.root, rel), '路径')
}

/**
 * 用系统关联的默认程序打开这一篇。
 *
 * 只读模式不拦它：打开的是另一个程序，不是这里的编辑器 —— 只读管的是「别在这个页面里
 * 手一抖改掉它」，不是「不许在别处读 / 改它」。失败时把原因说出来（没装关联程序、
 * 文件刚被删掉都在这里）。
 */
async function openNoteExternally(rel: string): Promise<void> {
  const result = await window.workbench.openPath(noteAbsPath(store.root, rel))
  if (!result.ok)
    notifyError(result.error ?? '打开失败')
}

/**
 * 拖动落下：报给 store 去挪文件。
 *
 * 失败时要**重新扫一遍**：`el-tree` 在松手那一刻已经把它自己那份数据挪过了，
 * 不重新读一次，左栏显示的会是一个磁盘上并不存在的位置。
 */
async function onMove(payload: { rel: string, targetDir: string }): Promise<void> {
  if (await store.move(payload.rel, payload.targetDir))
    return
  await store.reload()
}

/**
 * 编辑器把防抖后的正文交回来。
 *
 * 用编辑器给的路径而不是 `store.active.rel`：换一篇时它会先把上一篇没写完的那段冲出来，
 * 那一下发生在选中项已经切走之后，按当前选中项去取就会写错篇（见 NoteEditor 里的说明）。
 */
function onContentChange(payload: { rel: string, content: string }): void {
  void store.saveContent(payload.rel, payload.content)
}

/**
 * 正文里点了一个指向别的笔记的链接：跳到那一篇。
 *
 * 路径已经在编辑器里解析好了（见 packages/notes/src/note.ts 的 `resolveNoteLink`），这里只管打开：
 * 树上没有就先**重扫一遍**再看 —— 目标可能是刚在应用外面写下的（别的编辑器、同步拉回来的），
 * 而树只信磁盘。还没有就如实说找不到，**不把选中项切到一个不存在的路径上**：
 * 那样右栏会显示成「『』是文件夹」这种看不出所以然的话。
 *
 * 跳过去之后的展开与高亮交给 store 的 select（与在左栏点一下是同一条路）。
 */
async function openNoteLink(rel: string): Promise<void> {
  if (!findNoteNode(store.nodes, rel))
    await store.reload()
  if (!findNoteNode(store.nodes, rel)) {
    ElMessage.warning(`找不到这篇笔记：${rel}`)
    return
  }

  store.select(rel)
}

/** 编辑器实例：同步前后要借它一双手（先把攒着的那一份交出去 / 换掉远端改过的那一篇） */
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)

/**
 * 右侧大纲栏。
 *
 * 那枚大纲元素是 Vditor 建的，初始化完成后由 NoteEditor 搬进这条栏（见它的 `outlineHost`）——
 * 长在正文区里的时候，它的顶边只能与正文对齐，跟页头差着一整行，对不齐。
 *
 * 这一栏**常显**（打开着一篇笔记时它就在那儿），不再有开关：`outlinePinned` 让编辑器
 * 初始化完成后直接打开大纲，右键菜单里也不再给「大纲」那一项。
 */
const outlineRail = ref<HTMLElement | null>(null)

/**
 * 大纲条目整行收展：capture 阶段先于 Vditor 绑在根 `ul` 上的冒泡监听跑到，
 * 点在有子级的条目行任意位置就由这里收展（见 use-outline-row-toggle）。
 * 只有箭头上的点击需要拦下 —— 不拦的话 Vditor 自己那份也跑，同一下收展两次。
 */
function onOutlineRowClick(event: MouseEvent): void {
  if (toggleOutlineRow(event.target))
    event.stopPropagation()
}

/** 栏宽住在 theme.json 里（`noteRailWidth`）：拖动只改本地跟手，松手才落盘 */
const editorStyle = computed(() => ({
  '--rail-w': `${settings.themeConfig.noteRailWidth}px`,
}))

/** 拖动大纲栏左缘的把手（拖动态只用来让把手一直亮着） */
const railResizing = ref(false)

/**
 * 拖大纲栏左缘调宽：与目录树那条缝同一套做法（宽度以按下那一刻为基准，逐帧只算差值）。
 *
 * 栏在右边，所以指针往左拖才是把栏拉宽（差一个负号）。
 * 正文的左右留白是固定的 50px（见 NoteEditor 的样式），容器变窄变宽由 CSS 自己重排，
 * 不必再补 window resize。
 */
function onRailResize(event: PointerEvent): void {
  if (event.button !== 0)
    return
  event.preventDefault()

  const startWidth = settings.themeConfig.noteRailWidth
  railResizing.value = true
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: 'is-resizing-notes-rail',
    onMove: (moveEvent, start) =>
      settings.setThemeWidth('noteRailWidth', startWidth - (moveEvent.clientX - start.x)),
    onEnd: (_last, cancelled) => {
      railResizing.value = false
      if (cancelled)
        settings.setThemeWidth('noteRailWidth', startWidth)
      else
        void settings.commitThemeWidth('noteRailWidth')
    },
  })
}

/**
 * 同步按钮的提示：**同步到哪儿先说清楚**。
 *
 * 地址不是用户在这里填的，而是这个文件夹自己连着的远端 —— 文件夹里任何一个 origin 都会被
 * 当成笔记仓库（用户可能早先为别的用途连过一个），所以这一句不能省。
 * 有仓库但还没连远端时也照实说：那颗按钮仍然点得动，点下去 Rust 会报一句带解决办法的话，
 * 这样用户在终端里补上 origin 之后不必重启 —— 这也是它不禁用的原因。
 */
const syncTitle = computed(() =>
  store.remoteUrl
    ? `同步到 ${store.remoteUrl}（提交本机改动、拉回别处的改动）`
    : '这个文件夹是 git 仓库，但还没连远端仓库',
)

/**
 * 同步一次。
 *
 * 次序是有讲究的，三步都不能换：
 *  1. **先让编辑器把防抖里那一份交出去、并等它落盘**：不然这次提交的是按下按钮
 *     之前的那一版（`flushAll` 是现取，`waitForWrites` 等的是 store 那一侧的写盘）；
 *  2. 再走同步（提交 → 拉 → 推，git 全在 Rust 那边跑）；
 *  3. 回来若远端改过打开着的那一篇，**把新正文塞回编辑器** —— 否则编辑器手上是旧的，
 *     下一次输入就会以旧内容为准把远端那份盖回去。
 *
 * 失败一律是「说清楚」而不是静默：不是仓库、没连远端、git 报的错、冲突的那几个文件名都在里面。
 */
async function syncNow(): Promise<void> {
  editorRef.value?.flushAll()
  await store.waitForWrites()

  const outcome = await store.syncNotes()
  if (!outcome) {
    ElMessage.error(store.syncError || '同步笔记失败')
    return
  }
  if (outcome.activeChanged)
    editorRef.value?.reloadFromProps()

  ElMessage.success(syncDoneText(outcome.summary))
}

/** 同步成功那句提示：把「提交了什么、拉回了什么」说清楚，两边都没动就直说 */
function syncDoneText(summary: NoteSyncSummary): string {
  const parts: string[] = []
  if (summary.files)
    parts.push(`提交 ${summary.files} 个文件`)
  if (summary.received)
    parts.push('拉回了远端的改动')
  return parts.length ? `已同步（${parts.join('、')}）` : '已同步，两边都没有新改动'
}

/**
 * 重新读一遍：重扫目录树，再把打开着的那一篇按磁盘上的样子对齐一次。
 *
 * 左栏底部那颗刷新与树上空白区的「刷新列表」都走这里。只重扫树是不够的 ——
 * 别的编辑器改过的正文会一直停在旧的样子上（这个坑踩过）。
 */
async function refreshNotes(): Promise<void> {
  await store.reload()
  await pullActiveFromDisk()
}

/**
 * 把打开着的那一篇对齐磁盘。
 *
 *  - 编辑器没有未保存的修改 → 直接重读、换正文；
 *  - 有未保存的修改 → 只有磁盘确实变了才问一句「按磁盘重读 / 保留这里的」。
 *    选保留之后继续输入会被 Rust 的写前检查拦下（标题栏红字），磁盘上那一份不会被盖掉。
 *
 * 判「有没有未保存」用的是**最后一次真正落盘 / 读盘的内容**（`store.active.content`），
 * 不是编辑器自己那份基线：写盘被拒之后编辑器会以为已经保存了（见 NoteEditor 的 hasUnsaved）。
 */
async function pullActiveFromDisk(): Promise<void> {
  if (!store.root || !store.active)
    return

  // 先把正在路上的那一笔等掉：它落地之后 `active.content` 才是「最后一次真正落盘的内容」，
  // 否则拿着还没更新的旧基线去比，会把刚刚自己写下去的那一段误判成「别处改过」
  await store.waitForWrites()

  const active = store.active
  if (!active)
    return

  const editor = editorRef.value
  const dirty = editor?.hasUnsaved(active.content) ?? false
  if (!dirty) {
    if (await store.rereadActive())
      editor?.discardAndReload(store.active ?? active)
    return
  }

  if (!(await store.activeChangedOnDisk()))
    return

  const reload = await confirmAction(
    '磁盘上的这一篇被别处改过。要放弃这里的修改、按磁盘重读吗？',
    '这一篇被别处改过',
    { confirmButtonText: '按磁盘重读', cancelButtonText: '保留这里的' },
  )
  if (!reload)
    return
  if (await store.rereadActive())
    editor?.discardAndReload(store.active ?? active)
}

/**
 * 窗口重新获得焦点：在别的编辑器里改完切回来，这一篇要跟着变。
 *
 * 只探打开着的那一篇（一次读盘），不重扫整棵树 —— 那边新增 / 删除文件还是交给刷新按钮。
 * 页面被 KeepAlive 留着，切到别的页时也会收到焦点事件，所以先判当前页（与 onShortcut 同一道）。
 */
function onWindowFocus(): void {
  if (nav.activeView !== 'notes' || !store.root || !store.active)
    return
  void pullActiveFromDisk()
}
</script>

<template>
  <main class="notes" :class="{ 'is-intro': !store.root }">
    <!-- 还没选文件夹：整页只说一件事 —— 先挑一个文件夹当笔记本 -->
    <div v-if="!store.root" class="notes__intro panel">
      <div class="empty">
        <el-icon class="empty__icon">
          <Notebook />
        </el-icon>
        <p>笔记就是这个文件夹里的 markdown 文件。</p>
        <p class="empty__hint">
          选一个文件夹当笔记本：里面的目录结构会直接变成左边的目录树，
          用别的编辑器写下的 .md 也会显示出来。
        </p>
        <el-button type="primary" @click="chooseFolder">
          <el-icon><FolderOpened /></el-icon>
          选择文件夹
        </el-button>
      </div>
    </div>

    <div v-else class="notes__body" :style="bodyStyle">
      <aside class="notes__side panel">
        <!-- 读不出来：把原因说出来并给一次重试，不能显示成「这个文件夹里什么都没有」 -->
        <SideLoadError
          v-if="store.loadError"
          :error="store.loadError"
          @retry="store.reload()"
          @relocate="chooseFolder"
        />

        <NoteTree
          v-else
          v-model:expanded="expandedKeys"
          :nodes="store.nodes"
          :active-rel="store.activeRel"
          :loaded="store.loaded && !store.loading"
          @select="store.select"
          @create="({ parentRel, kind }) => openCreateIn(parentRel, kind)"
          @rename="openRename"
          @remove="remove"
          @move="onMove"
          @reveal="revealNote"
          @reveal-root="revealNotebook"
          @copy-path="copyNotePath"
          @open-default="openNoteExternally"
          @refresh="refreshNotes"
        />

        <!--
          底部：笔记本是哪个目录 + 最近打开的那几个（原顶部工具条右侧那一组搬到这里）。
          放在树的下面而不是顶上：进这一页要做的第一件事是找文件，不是找设置。
        -->
        <RecentRoots
          :root="store.root"
          :root-name="store.rootName"
          :count-text="`${store.noteCount} 篇笔记`"
          :roots="store.recentRoots"
          :tree-width="settings.themeConfig.noteTreeWidth"
          :name-of="noteRootName"
          @open="openRecentRoot"
          @forget="(dir: string) => store.forgetRoot(dir)"
        >
          <template #tools>
            <!-- 没仓库的文件夹就是本机的笔记：这颗按钮连同它的提示一起不出现 -->
            <el-tooltip v-if="store.canSync" :content="syncTitle" placement="top">
              <el-button size="small" text :disabled="store.syncing" @click="syncNow">
                <el-icon :class="{ 'is-loading': store.syncing }">
                  <RefreshRight />
                </el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="重新读取文件夹与打开着的正文" placement="top">
              <el-button size="small" text :disabled="store.loading" @click="refreshNotes">
                <el-icon><Refresh /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="换一个文件夹" placement="top">
              <el-button size="small" text @click="chooseFolder">
                <el-icon><FolderOpened /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="素材管理（这个笔记本传的图片）" placement="top">
              <el-button size="small" text @click="assetsOpen = true">
                <el-icon><Picture /></el-icon>
              </el-button>
            </el-tooltip>
          </template>
        </RecentRoots>
      </aside>

      <!-- 两栏之间的分隔条：热区是一条通高的窄条，看得见的只有正中间那个小竖条 -->
      <PanelResizer
        :width="settings.themeConfig.noteTreeWidth"
        body-class="is-resizing-notes-tree"
        @move="width => settings.setThemeWidth('noteTreeWidth', width)"
        @end="() => void settings.commitThemeWidth('noteTreeWidth')"
      />

      <section class="notes__editor panel" :style="editorStyle">
        <!-- 左列：页头 + 正文；大纲栏常显，它拿的是剩下的宽度 -->
        <div class="notes__main">
          <header class="notes__head">
            <template v-if="store.active">
              <span class="notes__title" :title="store.active.name">{{ store.active.name }}</span>
              <!-- 在最外层时它是空的：没有「哪一层」可说，就不摆一个空盒子占位 -->
              <span v-if="locationText" class="notes__location truncate">{{ locationText }}</span>
            </template>
            <template v-else-if="store.activeRel">
              <span class="notes__title">
                {{ findNoteNode(store.nodes, store.activeRel)?.name ?? '' }}
              </span>
              <!-- 在最外层时它是空的：没有「哪一层」可说，就不摆一个空盒子占位 -->
              <span v-if="locationText" class="notes__location truncate">{{ locationText }}</span>
            </template>
            <span v-else class="notes__location">未选中</span>

            <span class="notes__spacer" />

            <!--
              只读那一档的落点，**它自己就是切回去的按钮**：点一下切到可写（Ctrl+/ 同样有效）。
              **这一档是默认的**，所以它几乎一直挂在这儿，也正因为如此它得同时说清两件事：
              现在打字没反应是因为它在开着，以及怎么切回去（提示里那句）。
            -->
            <el-tooltip v-if="readOnly" content="正文只读：点击或 Ctrl+/ 切到可写" placement="bottom">
              <button type="button" class="notes__mode" @click="readOnly = false">
                只读
              </button>
            </el-tooltip>

            <!-- 保存状态就写在标题这一行：写东西的人需要知道「刚才那段到底存下去了没有」 -->
            <span v-if="store.saveError" class="notes__saved is-error">{{ store.saveError }}</span>
            <span v-else-if="store.active" class="notes__saved">{{ savedText }}</span>
          </header>

          <!-- 编辑器只在「打开的是一篇笔记」时出现；其余情况各说一句 -->
          <NoteEditor
            v-if="store.active"
            ref="editorRef"
            :note="store.active"
            :root="store.root"
            :theme="settings.effectiveTheme"
            :read-only="readOnly"
            :image-repo="settings.settings.noteImageRepo"
            :editor-hotkeys="settings.settings.editorHotkeys"
            :outline-host="outlineRail"
            outline-pinned
            @change="onContentChange"
            @open="openNoteLink"
          />

          <div v-else class="empty notes__hint">
            <template v-if="store.loadError">
              <p>读不出这个文件夹。</p>
              <p class="empty__hint">
                {{ store.loadError }}
              </p>
            </template>
            <PanelLoading v-else-if="scanning" text="正在读取笔记…" />
            <template v-else-if="store.openError">
              <p>这一篇打不开。</p>
              <p class="empty__hint">
                {{ store.openError }}
              </p>
              <el-button size="small" @click="store.select(store.activeRel)">
                重试
              </el-button>
            </template>
            <template v-else-if="store.activeRel">
              <p>「{{ findNoteNode(store.nodes, store.activeRel)?.name }}」是文件夹。</p>
              <p class="empty__hint">
                在左栏里选中一篇笔记打开，或者右击它往里面新建。
              </p>
            </template>
            <template v-else-if="!store.noteCount">
              <el-icon class="empty__icon">
                <EditPen />
              </el-icon>
              <p>这个文件夹里还没有笔记。</p>
              <p class="empty__hint">
                在左栏里右击新建一篇，写下第一行。
              </p>
            </template>
            <template v-else>
              <el-icon class="empty__icon">
                <Document />
              </el-icon>
              <p>从左边选一篇笔记打开。</p>
              <p class="empty__hint">
                标题栏右侧那句会显示它最后一次改动的时间。
              </p>
            </template>
          </div>
        </div>

        <!--
          大纲栏：Vditor 自己那枚大纲元素在初始化后搬进这里（见 NoteEditor 的 outlineHost）。
          它在正文区里的时候，顶边只能贴着正文，比页头低一整行；搬到这条栏里之后
          与页头同高起步，栏位多宽由左缘那条缝说了算。
          **常显**：打开着一篇笔记时它就在那儿（`outlinePinned` 让编辑器把大纲直接打开），
          不再有开关；拖左缘那条缝改宽度，宽度记在 theme.json 里。
        -->
        <span
          v-if="store.active"
          class="notes__rail-resizer"
          :class="{ 'is-dragging': railResizing }"
          title="拖动调整大纲宽度"
          @pointerdown="onRailResize"
        />
        <aside
          v-if="store.active"
          ref="outlineRail"
          class="notes__rail"
          @click.capture="onOutlineRowClick"
        />
      </section>
    </div>

    <NoteNameDialog
      v-model="dialog.open"
      :title="dialogTitle"
      :kind="dialog.kind"
      :default-name="dialogDefaultName"
      @submit="submitName"
    />

    <!-- 素材管理：当前笔记本（这台机器）传过哪些图、谁还在用 -->
    <NoteAssetsDialog v-model="assetsOpen" :root="store.root" />
  </main>
</template>

<style scoped>
.notes {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

/**
 * 还没选文件夹时的整页引导：与视频页同一副样子，四周留白也同源 —— 左右与下边距取
 * `--card-gap`（设置里的「卡片间距」）；**上边距 0**，顶栏下面那条缝归 .shell 管（见 global.css）。
 */
.notes__intro {
  min-height: 0;
  margin: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

/**
 * 左树右编辑器。
 *
 * 两栏各是一张卡片（.panel 那副外壳，写在 global.css），间距与别处同源 ——
 * 左栏宽度跟着 theme.json 里的 noteTreeWidth 走（拖动分隔条改它）、右栏吃掉剩余宽度；
 * 两栏各自滚，谁也不把谁撑高。
 *
 * **顶边一份不给自己加**：顶栏下面那条缝归 .shell 管（见 global.css「顶栏与内容之间那条缝」），
 * 与首页同款 —— 这里再补一份，正常 / 毛玻璃两档就成了两倍。
 */
.notes__body {
  position: relative;
  display: grid;
  gap: var(--card-gap, 10px);
  min-width: 0;
  min-height: 0;
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

.notes__side {
  min-height: 0;
}

/**
 * 右栏：左边一列是页头 + 正文，右边一条是大纲栏（常显）。
 *
 * `.panel` 原本是竖排的 flex（页头压着正文），这里拆成三列：正文、栏左缘那条拖动缝、大纲栏。
 * 大纲栏要与页头同高起步，它就得是这一层的直接子元素，不能跟着正文一起往下让。
 * 行间距归 `.notes__main` 自己，所以这一层的 gap 归零 —— 没有打开着的笔记时
 * 后两列整个不画，右边不会留一道空缝。
 */
.notes__editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0;
  min-width: 0;
  min-height: 0;
}

/* 左列：页头与正文，间距沿用 .panel 那一档（12） */
.notes__main {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
  min-height: 0;
}

/**
 * 大纲栏：与左列同高、与页头同顶。
 *
 * 它自己不带底色与卡片外壳 —— 这一页的底归 .panel，栏只留一道左侧发丝线与一点内边距，
 * 像书页边上的目录，而不是第二张卡片。宽度是主题里的 `noteRailWidth`：拖左缘那条缝改，
 * 大纲是导航、不抢正文宽度，所以下限只到放得下一行标题。
 */
.notes__rail {
  width: var(--rail-w, 224px);
  min-height: 0;
  padding-left: var(--sp-4);
  border-left: 1px solid var(--border);
  overflow: hidden;
}

/**
 * 大纲栏左缘的拖动把手：一条通高的热区（宽度就是原先栏的左边距），
 * 看得见的只有正中间那个小竖条 —— 与目录树那条缝（PanelResizer）同一副样子，
 * 只是它住在编辑器这一层的网格里、改的是右栏。指针落到缝上才露出来，
 * 拖动态由组件自己驱动（指针可能已经离开缝线，不亮就像拖动断了）。
 */
.notes__rail-resizer {
  position: relative;
  width: var(--sp-4);
  cursor: ew-resize;
}

.notes__rail-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 8px;
  height: 34px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--ink);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}

.notes__rail-resizer:hover::after,
.notes__rail-resizer.is-dragging::after {
  background: var(--ink);
  opacity: 1;
}

/**
 * 大纲本体（Vditor 自带的那枚元素，被搬到了这条栏里）。
 *
 * 它原本长在编辑器里：不透明底、粗边线、固定蓝悬停、Vditor 的字体。搬出来之后
 * 这些变量不再继承自 `.vditor`，所以关键的几枚（边线 / 字色 / 悬停色）在这里补一份，
 * 否则字会掉回浏览器默认色。
 */
.notes__rail :deep(.vditor-outline) {
  --border-color: var(--border);
  --panel-background-color: transparent;
  --textarea-text-color: var(--ink-2);
  --toolbar-icon-color: var(--ink-3);
  --toolbar-icon-hover-color: var(--ink);
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--fs-meta);
}

/**
 * 栏首「大纲」：与页头同一条水平线（行高取页头那颗按钮的 28，文字中心落在 14），
 * 左缘与条目文字对齐（8 内边距 + 10 箭头 + 4 间距），下缘一条细分隔。
 */
.notes__rail :deep(.vditor-outline__title) {
  padding: 0 0 var(--sp-2) 22px;
  border-bottom: 1px solid var(--border);
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 28px;
}

/* 条目区：从分隔线下面一点开始，别贴着 */
.notes__rail :deep(.vditor-outline__content) {
  padding-top: var(--sp-2);
}

/* 缩进：顶层不缩，子级按 12px 退一格（Vditor 默认的 1em 在这条窄栏里略宽） */
.notes__rail :deep(.vditor-outline__content > ul) {
  padding-left: 0;
}

.notes__rail :deep(.vditor-outline ul ul) {
  padding-left: var(--sp-3);
}

/**
 * 每一条：行高与内边距按「能点的一片」给（4px + 19px 行高 = 27px 高），
 * 悬停铺一层浅底、四角收圆 —— 它是这一栏里的导航，不是正文里的链接。
 */
.notes__rail :deep(.vditor-outline li > span) {
  padding: 4px var(--sp-2);
  border-radius: var(--r-sm);
  color: var(--ink-2);
  line-height: 19px;
  transition: background-color 0.15s var(--ease-out), color 0.15s var(--ease-out);
}

.notes__rail :deep(.vditor-outline li > span:hover) {
  background-color: var(--bg-subtle);
  color: var(--ink);
}

/* 层级：顶层用正墨色，子级弱一档 —— 缩进之外再给一层层次 */
.notes__rail :deep(.vditor-outline__content > ul > li > span) {
  color: var(--ink-2);
}

.notes__rail :deep(.vditor-outline ul ul li > span) {
  color: var(--ink-3);
}

/* 折叠箭头：小一号、弱一档；收起时 Vditor 自己加 `--close` 转半圈 */
.notes__rail :deep(.vditor-outline li > span > svg) {
  width: 10px;
  height: 10px;
  margin-right: var(--sp-1);
  color: var(--ink-3);
  opacity: 0.75;
  transition: transform 0.15s var(--ease-out);
}

.notes__rail :deep(.vditor-outline li > span > span) {
  line-height: 19px;
}

/**
 * 标题行：名字 + 位置 + 保存状态，右栏的「页头」。
 *
 * **垂直居中，不是基线对齐**：这一行混着 15px 的标题与 10.5px 的辅助文字（位置 / 保存状态），
 * 按基线对齐小字会浮在上半截；居中摆各自居中对齐。
 */
.notes__head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-shrink: 0;
  min-width: 0;
}

.notes__title {
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--ink);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.notes__location {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  min-width: 0;
}

.notes__spacer {
  flex: 1 1 auto;
}

.notes__saved {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/**
 * 只读那一档的标记：**实心深片**（墨底反白字；暗色下两个令牌互换，反成亮片深字）。
 * 它是一档模式徽章、不是普通的信息小片：默认档几乎一直挂在标题行里，浅底那副
 * （知识库信息面板小片的同款）压不出存在感 —— 得一眼能找到它、也一眼能看出
 * 「现在打不了字是因为它」。首页看板行那颗模式片需要打眼时也是切实心
 * （`.board-row__mode`），同一副处理。
 *
 * 仍是**一行纯字** —— 标题这一行是 `align-items: baseline` 的，里面放图标就得去猜
 * 那颗 svg 的基线落在哪儿（多半会把整片顶高、看着比旁边那行字浮起来）。
 *
 * 高度按标题那一档字号的自然行盒算（18px 行高，比标题的 22px 矮）：
 * 这一片出现 / 消失时，标题行一整行的高度不变 —— 另加竖向内边距就会顶高，
 * 模式一切标题行就往下跳一格。
 *
 * 为什么非有它不可：这是一档「按下去之后界面几乎不变」的模式（能变的只有打字打不出来），
 * 一个隐形的快捷键总得有个看得见的落脚点。
 *
 * **它是一颗按钮**（不是纯标签）：点一下就切到可写 —— 点下去它自己消失，那正是这一档
 * 结束时该有的样子；切回可写之后要回只读，仍是 Ctrl+/（提示里写着）。
 */
.notes__mode {
  display: inline-flex;
  align-items: baseline;
  flex-shrink: 0;
  padding: 0 var(--sp-2);
  border: 0;
  border-radius: var(--r-sm);
  background: var(--ink);
  font-family: inherit;
  font-size: var(--fs-meta);
  line-height: 18px;
  color: var(--ink-inverse);
  cursor: pointer;
  transition: opacity 0.15s var(--ease-out);
}

.notes__mode:hover {
  opacity: 0.85;
}

.notes__saved.is-error {
  color: var(--st-fail);
}

/* 空态与文件夹提示：居中占满右栏，与别处的 .empty 同一副样子 */
.notes__hint {
  flex: 1 1 auto;
}
</style>
