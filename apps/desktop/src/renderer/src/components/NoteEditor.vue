<script setup lang="ts">
import type { NoteDocument } from '@workbench/notes'
import { Loading } from '@element-plus/icons-vue'
import { imageFileName, imageMarkdown, NOTE_IMAGE_MAX_BYTES, resolveNoteLink } from '@workbench/notes'

import Vditor from 'vditor'
/**
 * 笔记正文编辑器（Vditor，即时渲染模式）。
 *
 * 用 Vditor 而不是自己搭 textarea：markdown 的表格、代码块、列表续行这些
 * 「写起来才知道难」的地方它都处理好了，正文也仍然是 markdown 原文（`getValue` 拿到的就是原文），
 * 所以笔记数据不依赖任何编辑器 —— 换掉它不影响已经写下的东西（那些就是磁盘上的 .md 文件）。
 *
 * 四件必须自己管的事：
 *   1. **静态资源不联网**。Vditor 默认从 unpkg 拉图标、语言包、内容主题、表情与代码高亮，
 *      而这个应用默认不联网，所以 `cdn` 指向随包带的那一份（见下面的 VDITOR_CDN）。
 *   2. **写盘归我们**。关掉 Vditor 自带的 localStorage 缓存，输入防抖后把原文交给上层，
 *      由 store → 适配层 → Rust 写回那个 .md 文件。
 *   3. **链接归我们管**：**按住 Ctrl 点**才打开 —— 外部地址交给系统浏览器（与 MarkdownView
 *      同一条出口），指向另一篇笔记的相对链接（`[标题](./别的.md)`）报给上层去打开；普通点击
 *      什么都不做（写东西时误点不该换掉这一篇）。三件要知道的事 —— 只有 Ctrl 那一下才算、
 *      IR 模式下的链接不是 `<a>`、Vditor 默认还会自己 `window.open` —— 见 onClick 那一段。
 *   4. **动作从右键菜单走**。工具带整条藏起来了（样式里 `display: none`），
 *      它那套动作改成菜单里的项（NoteContextMenu），菜单点一项、这里去点工具带上那颗按钮。
 *
 * 组件只认「当前这一篇」的路径与正文：换一篇走 `setValue` 而不是重建实例
 * （重建会闪一下白、也会丢撤销栈）。正文由上层读了给它，它不碰文件。
 *
 * 第五件是**粘贴的图片**（见 uploadImages）：剪切板里的图推到用户配置的图片仓库，
 * 拿回地址后插一条 `![](…)` 进正文。图片不进笔记本目录、也不进数据文件 ——
 * 正文里只有一个外链，于是笔记本搬到哪台机器、用哪个编辑器打开都成立。
 *
 * 第六件是**只读**（见 `props.readOnly`）。底子是 Vditor 自带的 `disabled()`：它关掉正文那个
 * `contenteditable`，也就关掉了「写」的平台保证（打字、Ctrl+X、`execCommand` 全进不来）——
 * 但它只管「不能写」，不管「还像不像编辑器」。四条要知道的：
 *   - **它自带的样式会把整篇文章压到 30% 不透明度**（`opacity: .3; cursor: not-allowed`）
 *     —— 那是「编辑器坏了」的样子，不是「在读文章」的样子，样式里要覆盖回去；
 *   - 它的 IR 点击 / 按键处理器**不问 `contenteditable`**：点击一律 `expandMarker()`
 *     （点过的代码块会露出围栏与原始代码，看着还能编辑），点复选框会改 DOM，空文档上按退格
 *     会清 `innerHTML`；而展开态靠 `blur` 收，只读下又点不出焦点，于是那副样子会一直挂着。
 *     所以在**捕获阶段**把这两类事件拦在 Vditor 之外（见 onClick / onKeyCapture）；
 *   - 粘贴 / 拖进来的图片**不走 contenteditable**（Vditor 把 paste / drop 挂在元素上，
 *     与能不能编辑无关），而一次上传就是往仓库推一次 git，uploadImages 里要自己挡一道；
 *   - 反过来，`contenteditable="false"` 会把正文从「可聚焦元素」里摘出去 —— 而它正是那个
 *     滚动的容器，于是点了不给焦点、键盘再也滚不动。要补一个 `tabindex` 补回来
 *     （见 applyReadOnly 第 2 条）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import NoteContextMenu from '@/components/NoteContextMenu.vue'
import { notifyWarning } from '@/notify'
import 'vditor/dist/index.css'

const props = defineProps<{
  note: NoteDocument
  /**
   * 当前笔记本（笔记文件夹的绝对路径）。
   *
   * 粘贴的图片要按「哪台机器、哪个笔记本」分目录进仓库（见 packages/notes/src/note-image.ts 的 imageScopeDir），
   * 而这两个来源里只有笔记本在这里说了算：路径由上层带进来，省得编辑器自己去问一遍。
   */
  root: string
  /** 应用当前的明暗（编辑器的配色要跟着走，它与应用的主题是两套） */
  theme: 'light' | 'dark'
  /**
   * 只读（笔记页按 Ctrl+/ 切的那一档，状态在上层）：正文不可编辑。
   *
   * 挡住的不只是打字：粘贴 / 拖进来的图片会走 uploadImages（那是往图片仓库推一次 git），
   * 格式菜单点一下也会真的改正文 —— 两处各自另有一道闸（见 uploadImages / openMenu）。
   * 读盘、链接跳转、滚动、选中照旧，那些都是「读」。
   */
  readOnly: boolean
  /**
   * 图片仓库地址（设置里的 `noteImageRepo`）。
   *
   * **不再从 settings store 里读**：这枚组件要能在独立 Markdown 编辑窗口里挂起来，
   * 而那扇窗口只装适配层、不装 Pinia（见 docs/modules/notes.md）。笔记页把值传进来，
   * 独立窗口不传，粘贴图片时如实提示去设置里配。
   */
  imageRepo?: string
  /**
   * 允不允许粘贴 / 拖入图片（默认允许）。
   *
   * 独立编辑窗口传 false：那个窗口没有「笔记本」这个概念，一次上传会把图片推到
   * 图片仓库的某个临时层级里，不是用户在那个窗口里期待的动作。挡下来并说清楚。
   */
  allowImageUpload?: boolean
  /** 空文档时的提示语；不传用笔记页那一句（含 Ctrl+/ 说明），独立窗口用简短版 */
  placeholder?: string
  /**
   * 大纲栏的落点（笔记页与独立 Markdown 窗口布局里的那条右栏）。
   *
   * Vditor 把大纲建在编辑器自己的正文区里，于是它只能从正文顶部开始 ——
   * 比页头（标题 / 保存状态）低一整行，跟页头对不齐。上层传一个右栏容器进来，
   * 初始化完成后把大纲那枚元素搬过去：开合、内容与跳转都还是 Vditor 的，
   * 只是换了个待着的地方。不传就留在原处（默认关着，从右键菜单才开）。
   */
  outlineHost?: HTMLElement | null
  /**
   * 大纲钉在右侧、始终开着（独立 Markdown 窗口用）。
   *
   * 那边没有标题行、也没有开关：右侧那条目录栏是固定的，初始化完成后直接打开；
   * 右键菜单里的「大纲」项在这一档不出现（否则能从菜单把它关掉，栏里剩一条空白）。
   * 笔记页不传：那边按需打开，开合由标题行那颗图标键说了算。
   */
  outlinePinned?: boolean
}>()

const emit = defineEmits<{
  /**
   * 正文变了（已防抖）。
   *
   * 带上路径而不是让上层去看「当前打开的是哪一篇」：换篇时这里会先把上一篇没写完的改动冲出去，
   * 而那一刻上层的选中项已经是新的一篇了（按选中项取就会把上一篇的正文写进刚点开的那一篇）。
   */
  'change': [payload: { rel: string, content: string }]
  /**
   * 正文里点了一个指向**本笔记本里另一篇笔记**的链接（`[标题](./别的.md)`）：请上层打开它。
   *
   * 这里只做到「链接指向哪一篇」（相对路径的解析是纯函数，见 packages/notes/src/note.ts 的 resolveNoteLink）；
   * 那一篇在不在、要不要重扫一遍树、跳过去之后选中谁，都是上层的事。
   */
  'open': [rel: string]
  /**
   * 大纲开了 / 关了（每次真正变化时报一次）。
   *
   * 笔记页拿它决定右边那条大纲栏显不显示：栏的位置在页面布局里，开合状态却在
   * Vditor 手里（它把 display 写在大纲元素上），所以这里替它转达一声。
   */
  'outline-change': [open: boolean]
}>()

/** 笔记页那句提示：工具带藏起来之后，格式入口与两处隐形快捷键都在这里说清楚 */
const DEFAULT_PLACEHOLDER = '写点什么…markdown 直接写；图片粘贴即上传，格式走右键菜单；Ctrl+点击链接可打开，Ctrl+/ 切只读'

/**
 * Vditor 的静态资源目录。
 *
 * 与 `scripts/sync-vditor-assets.mjs` 的落点是一对：那份脚本在 dev / build 前把
 * `node_modules/vditor/dist` 里用得着的一小部分复制到 `src/renderer/public/vditor/`，
 * 于是开发态由 vite 直接提供、构建态被复制进产物根目录（打包后由自定义协议提供）。
 *
 * 用相对路径（基址取 vite 的 BASE_URL）而不是 `/vditor`：两种运行方式下都能落到同一处。
 */
const VDITOR_CDN = `${import.meta.env.BASE_URL}vditor`

/**
 * 编辑器的动作清单：只留「写东西用得上、且不需要额外资源」的那些。
 *
 * 工具带本身不显示（见样式），这份清单还在，因为**它就是右键菜单的动作表** ——
 * 菜单里每一项都是按名字来点这里对应的那颗按钮（`runAction`）。
 * 所以往里删项之前先看菜单有没有用它，删了名字还在菜单里，表现是那一项点了没反应。
 */
const TOOLBAR = [
  'headings',
  'bold',
  'italic',
  'strike',
  '|',
  'list',
  'ordered-list',
  'check',
  'quote',
  'line',
  'code',
  'inline-code',
  '|',
  'link',
  'table',
  '|',
  'undo',
  'redo',
  '|',
  'outline',
  'fullscreen',
]

/** 输入防抖：一边打字一边整份落盘太费，停顿一下再写 */
const SAVE_DELAY = 600

const host = ref<HTMLDivElement | null>(null)
/**
 * 正在上传的图片张数（0 = 没在传）：粘贴的图片要推一次 git 仓库，几秒钟很正常，
 * 编辑器上挂一颗角标告诉用户「在传」，不能让这几秒看起来像什么都没发生。
 */
const uploading = ref(0)
let editor: Vditor | null = null
let timer: number | null = null
/** 编辑器里这份正文属于哪一篇（相对路径） */
let editingRel = ''
/** 还没交出去的那份正文；null 表示没有待写入的改动 */
let pending: string | null = null
/** 已经交出去的那份：用来判断这次 input 是不是真的改了东西（换一篇时的 setValue 也会触发 input） */
let saved = ''

const isDark = (): boolean => props.theme === 'dark'

/** 编辑器现在的正文；还没初始化完（Vditor 的初始化是异步的）时返回 undefined */
function currentValue(): string | undefined {
  if (!editor)
    return undefined
  try {
    return editor.getValue()
  }
  catch {
    return undefined
  }
}

/**
 * 把只读那一档落到编辑器上。
 *
 * 三件事，缺一件就会出现「点了还是编辑器的样子」或者「滚不动」：
 *  1. `disabled()` / `enable()`：关掉 `contenteditable`，这是**平台层面**的那道保证
 *     （打字、Ctrl+X 的删除、`execCommand` 全都进不来，不是靠我们逐个堵洞）；
 *  2. **只读下给正文补一个 `tabindex`**：`contenteditable="false"` 之后它不再是可聚焦元素，
 *     点它不给焦点、`Tab` 也到不了 —— 而它正是那个滚动的容器（`.vditor-reset { overflow: auto }`），
 *     于是 PageUp / PageDown / 方向键全都没反应（可写时点是能聚焦的，所以这一条是「只读后
 *     滚不动了」的来源）。补上 tabindex 就与可写时一样：点一下就聚焦，键盘能滚，Tab 也能进来
 *     （可写时它本来就在 Tab 序里，这里只是把同一件事补回来）；
 *  3. 点击与按键在**捕获阶段**拦下来（`onClick` / `onKeyCapture`），别让 Vditor 那套
 *     IR 处理器动 DOM —— 它们的理由见那两段注释。
 *
 * `!editor?.vditor` 那道判断不是多余的：**Vditor 的初始化是异步的**（构造函数先把
 * 语言包 / lute 的 script 取回来，真正建 DOM 在那之后 —— 见它源码里 `init` 是被
 * `.then()` 起来的），所以刚 `new` 完就调 `disabled()` 会在它内部取 `this.vditor.toolbar`
 * 时炸掉。初始化完成那一刻由 `after` 回调再调一次这里（读到的是当时的 `props.readOnly`，
 * 中途切过也不怕），开关切换则由下面那条 watch 负责。
 */
function applyReadOnly(): void {
  if (!editor?.vditor)
    return

  // IR 模式的写作区（就是那个滚动的容器）；与上面那道判断同理，初始化没完时可能还没有
  const element = editor.vditor.ir?.element

  if (props.readOnly) {
    editor.disabled()
    if (element)
      element.tabIndex = 0
    return
  }

  editor.enable()
  // 可写时它靠 contenteditable 自己就是可聚焦的，这个补丁要摘干净
  element?.removeAttribute('tabindex')
}

/**
 * 两份正文算不算同一份。
 *
 * 空文档在 Vditor 里是 `'\n'`（即时渲染会把空内容规范化成一个换行），而磁盘上的空文件是 `''`：
 * 这两者之间的差别不是「用户改了什么」，照实写下去就是每打开一次空笔记都给它补一个换行。
 * 所以两段都是空白时一律算没变 —— 整篇删空仍然算改动（那一边不是空白）。
 */
function sameText(left: string, right: string): boolean {
  return left === right || (left.trim() === '' && right.trim() === '')
}

/**
 * 把正文交出去。
 *
 * `current` 是「现问编辑器要一份」，换篇与卸载时用：**Vditor 的 input 回调不保证同步到**
 * （它自己有一层处理延迟），换篇那一刻不能指望它已经把最后几个字报上来，
 * 否则「打完字立刻点开另一篇」这几个字就没了（踩过）。平时不传，用防抖攒下的那一份。
 */
function flush(current?: string): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }

  // 现取的那一份优先：它比防抖攒下的更新，也是切换前编辑器里真正的样子
  const content = current ?? pending
  pending = null
  if (content === undefined || content === null || sameText(content, saved))
    return

  saved = content
  // **必须带上它是哪一篇**：换篇时这份改动属于上一篇，而 `props.note` 那时已经是新的了，
  // 上层按 props 取路径就会把上一篇的正文写进刚点开的那一篇（踩过，静默改错内容）
  emit('change', { rel: editingRel, content })
}

function schedule(content: string): void {
  if (sameText(content, saved))
    return
  pending = content
  if (timer !== null)
    window.clearTimeout(timer)
  timer = window.setTimeout(flush, SAVE_DELAY)
}

/** 把编辑器整份换成 `node` 的正文（不交任何东西出去、也不动防抖计时器） */
function applyDocument(node: NoteDocument): void {
  editingRel = node.rel
  saved = node.content
  pending = null
  editor?.setValue(saved, true)
}

/** 换一篇：先把上一篇没写完的改动交出去，再整份换成新的 */
function load(node: NoteDocument): void {
  flush(currentValue())
  applyDocument(node)
}

/**
 * 手上这一份算不算「有没保存的修改」。
 *
 * 不能只看组件里的 `saved`：写盘失败（被 Rust 以「别处改过」拒绝）之后，`flush` 已经把
 * `saved` 推进到那段新正文了，可磁盘上并没有它。所以由上层把**最后一次真正落盘 / 读盘的
 * 内容**传进来比对；两侧都是空白（`''` 与 Vditor 的 `'\n'`）不算改动，与 `sameText` 同一口径。
 */
function hasUnsaved(base: string): boolean {
  const current = currentValue()
  if (current === undefined)
    return pending !== null
  return !sameText(current, base)
}

/**
 * 丢掉手上这一份、整份换成 `node` 的正文（防抖里攒着的也一起丢）。
 *
 * 只在**上层已经确认过「按磁盘重读」**时用：它不 flush，不会把编辑器里的旧正文写回去。
 * 正文从参数进来而不是读 `props.note` —— 上层刚把 store 里那一份换掉，props 未必已经跟上。
 */
function discardAndReload(node: NoteDocument): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  applyDocument(node)
}

/**
 * 正文里的链接：**按住 Ctrl 点的那一下**才打开 —— 外部地址交给系统浏览器，
 * 指向另一篇笔记的就在应用里跳过去。
 *
 * 普通点击一律不打开（Typora / VS Code 那一套）：这一页是拿来写东西的，点正文里的一处
 * 本来是「把光标挪过去」，顺手把打开着的那一篇换掉、或者弹出一个浏览器，都很打扰。
 * 光标正落在链接里（IR 把它展开成 `[文字](地址)` 的原文、正在改它）时也照这个来。
 *
 * **IR 模式下的链接不是一个 `<a>`**：lute 把 `[文字](地址)` 渲染成
 * `<span data-type="a" class="vditor-ir__node">`，文字在里面的 `.vditor-ir__link`，
 * 地址在 `.vditor-ir__marker--link`（收起时那颗 marker 宽高都是 0，只是看不见）。
 * 所以这里按 `data-type` 找节点 —— 写成 `closest('a')` 一个都匹配不上。
 *
 * 读地址、按「这一篇」解析目标（用 `editingRel` 而不是 `props.note.rel`：编辑器里
 * 现在这份正文属于哪一篇，它说了算），都只在这里做一次。
 *
 * **挂在捕获阶段**（模板里的 `@click.capture`），因为只读那一档要在事件走到 Vditor 之前
 * 拦住它 —— 理由见下面那一段；顺带链接这半边也跟着提前了，`preventDefault` 在哪一阶段
 * 都算数，行为与从前一样。
 */
async function onClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement | null

  /**
   * 大纲（右侧那一栏目录）与工具带都是编辑器自己的东西，点击要交给 Vditor。
   *
   * **只读那一档必须在这里让路**：
   *  - 工具带：开合大纲靠「点工具带上那颗按钮」（右键菜单与标题行那颗按钮都走这条路），
   *    而工具带就在 `.editor` 里 —— 一条 `stopPropagation` 会把这一下吞掉，表现成
   *    「只读下大纲打不开」（踩过）；
   *  - 大纲：点标题要交给 Vditor 去滚正文。
   */
  if (target?.closest('.vditor-toolbar, .vditor-outline'))
    return

  const node = target?.closest('[data-type="a"]')
  if (!(node instanceof HTMLElement)) {
    /**
     * 只读：不是链接的那一下也不放它过去。
     *
     * Vditor 的 IR 点击处理器**不看 `contenteditable`**，它一律 `expandMarker()`
     * ——把点到的那个节点展开成源码样子：代码块会露出 `` ``` `` 围栏与那块灰底的原始代码，
     * 点复选框会直接改 DOM 再触发一次 input（那是一次真实写盘），点最后一段下面还会补一个空段落。
     * 只读下这些全是「看上去还能编辑」的假象，得在**捕获阶段**拦下来（事件到不了挂在
     * `pre` 上的那些监听器）。展开态还有第二个麻烦：Vditor 靠 `blur` 收展开（见它的
     * `blurEvent`），而这一档点它不给焦点，于是那副样子会一直挂着 —— 拦下来两头都干净。
     *
     * 非链接那一支本来什么都不做，所以这里对光标、选区、拖选都没影响（点就是「读」）。
     */
    if (props.readOnly)
      event.stopPropagation()
    return
  }

  // IR 下这条链接不是 `<a>`、本来没有默认动作；预览 / 所见即所得模式渲染的是真 `<a>`，
  // 那两处这一下会把界面导航走，所以照旧拦掉
  event.preventDefault()
  if (props.readOnly)
    event.stopPropagation()

  // 没按 Ctrl 就是一次普通点击：什么都不做（光标归 Vditor 管）
  if (!event.ctrlKey)
    return

  const href = node.querySelector(':scope > .vditor-ir__marker--link')?.textContent ?? ''
  if (/^(https?:|mailto:)/i.test(href)) {
    const result = await window.workbench.openExternal(href)
    if (!result.ok)
      console.warn('[workbench] 打开链接失败', result.error)
    return
  }

  // 相对链接里认得的是「指向本笔记本里的一篇」那种：相对的是这一篇所在的文件夹
  const rel = resolveNoteLink(href, editingRel)
  if (rel) {
    emit('open', rel)
    return
  }

  // 剩下的（图片、附件、别的相对路径）没有能去的地方 —— 如实说一句，别让这一次点击
  // 看着像坏了。`#锚点` 指的是这一篇自己，不必说（引用式链接 Vditor 自己也不打开，跟着它）
  if (href && !href.startsWith('#')) {
    notifyWarning('这个链接跳不过去：只有 .md / .markdown 的笔记能打开')
  }
}

/**
 * 只读：按键也不交给 Vditor。
 *
 * 上面那条 tabindex 让这块正文重新能被聚焦，于是挂在 `pre` 上的那对 keydown / keyup
 * 监听器又够得着了 —— 它们和点击那半边一样不问 `contenteditable`：方向键会走
 * `expandMarker()`（又一次把节点展开成源码样子），空文档上按退格还会直接把 `innerHTML` 清掉。
 *
 * **只拦传下去，不 `preventDefault`**：默认动作要留着 —— 它是滚动的那个容器，
 * PageUp / PageDown / 空格 / 方向键正是靠浏览器自己的默认行为滚它（见 applyReadOnly 第 2 条）。
 */
function onKeyCapture(event: KeyboardEvent): void {
  if (props.readOnly)
    event.stopPropagation()
}

/** 右键菜单的落点（视口坐标）；null 表示没开 */
const menu = ref<{ x: number, y: number } | null>(null)

function openMenu(event: MouseEvent): void {
  // 编辑器还没建好时菜单没有可点的东西（动作全在那份工具带上）；
  // 只读下同样没有：工具带被 `disabled()` 禁掉了，弹出来会是一份每一项都没反应的菜单
  if (!editor || props.readOnly)
    return
  menu.value = { x: event.clientX, y: event.clientY }
}

/**
 * 菜单里点了一项：**去点工具带上对应的那颗按钮**，而不是另写一套动作。
 *
 * 选区怎么判断、markdown 怎么往返、撤销栈怎么记都归 Vditor，自己重写一遍只会与工具带的行为分叉。
 * 代价是动作名必须与 TOOLBAR 对得上，点不到时只在这里留一句告警（工具带是藏着的，界面上看不出来）。
 */
function runAction(name: string): void {
  const elements = editor?.vditor?.toolbar?.elements
  if (!elements)
    return

  // 标题在工具带上是一个下拉面板，动作挂在面板里的按钮上（data-tag="h1"…见 Vditor 的 Headings）
  const target = name.startsWith('heading')
    ? elements.headings?.querySelector(`[data-tag="h${name.slice('heading'.length)}"]`)
    : elements[name]?.firstElementChild
  if (!(target instanceof HTMLElement)) {
    console.warn('[workbench] 工具带上找不到这一项，右键菜单的动作没有执行', name)
    return
  }

  target.click()

  // 大纲的开合不经过我们（Vditor 自己写 display），这里顺手把状态同步出去。
  // 右键菜单与标题行那颗按钮都走这条，所以这一处就够
  if (name === 'outline')
    syncOutlineOpen()
}

/** 大纲此刻开没开（Vditor 不对外暴露状态，开合落在元素的行内 display 上） */
const outlineOpen = ref(false)

/** 把「实际开没开」同步成事件；真正变了才报 */
function syncOutlineOpen(): void {
  // `editor` 有值不代表 `vditor` 已经建好：Vditor 的初始化是异步的，
  // 宿主那一侧的 watcher 可能比它先跑（见 attachOutline）
  const vditor = editor?.vditor
  if (!vditor)
    return

  const open = vditor.outline.element.style.display === 'block'
  if (open === outlineOpen.value)
    return
  outlineOpen.value = open
  emit('outline-change', open)
}

/**
 * 把大纲元素搬进上层给的右栏。
 *
 * **只有初始化完成之后 `vditor` 才存在**（Vditor 初始化是异步的，元素那会儿才挂进它
 * 自己的正文区），所以这里必须连 `vditor` 一起判空 —— 宿主是上层模板里的一个 ref，
 * 它的 watcher 可能比初始化先跑（不判会抛 `Cannot read properties of undefined`）。
 * 搬过去之后 Vditor 照旧拿着这个元素的引用 —— `toggle` 设 display、`render` 写 innerHTML
 * 都不看它在谁名下，所以行为不变。
 */
function attachOutline(): void {
  const vditor = editor?.vditor
  const host = props.outlineHost
  if (!vditor || !host)
    return

  const element = vditor.outline.element
  if (element.parentElement === host)
    return
  host.appendChild(element)
}

/**
 * 开关右侧的大纲（目录结构）。
 *
 * 与右键菜单里那一项走同一条路：**点工具带上那颗按钮**。`options.outline.enable`
 * 与按钮的选中态都由 Vditor 自己维护，所以这里不留第二份状态 —— 开没开看右栏那块
 * 面板本身。工具带虽然藏着（见样式），按钮照旧在 DOM 里、照旧点得动；
 * 只读那一档也没把它禁掉（`disabled()` 只禁带编辑动作的那批）。
 */
function toggleOutline(): void {
  runAction('outline')
}

/**
 * 大纲还没开就打开它（`outlinePinned` 那一档在初始化完成时调一次）。
 *
 * 不走 `toggleOutline` 直接调用是因为它是「开关」：已经开着时再点一下就关了。
 * 初始化那一刻正常是关着的，但 `setValue` / 切主题之类重渲染后未必 —— 这里按
 * 元素自己的 `display` 判断实际状态（与 `syncOutlineOpen` 同一个口径）。
 */
function ensureOutlineOpen(): void {
  const element = editor?.vditor?.outline?.element
  if (!element || element.style.display === 'block')
    return
  toggleOutline()
}

/**
 * 粘贴 / 拖进来的图片：推给图片仓库，回来一条 `![](地址)` 插到光标处。
 *
 * 几件必须自己扛的事：
 *   1. **返回字符串等于「报错」**。Vditor 拿到 handler 的返回值只看一件事：是不是字符串 ——
 *      是就当一句提示弹出来然后结束，插入得我们自己 `insertValue`（它源码里那条分支就是这样，
 *      别指望它替我们把 markdown 放进去）。
 *   2. **一张接一张地插**，而不是等全部传完再一次性插：贴三张图时前两张已经在仓库里了，
 *      第三张失败就把前两张的地址一起丢掉，那是白传。
 *   3. **没配置仓库时说清楚去哪儿配**，而不是退回 Vditor 默认的 base64 内联 ——
 *      那会把整张图塞进 .md 文件，几篇笔记就能把笔记本撑成几兆。
 *   4. 异步过程中光标可能被移走，插进去的位置以那时为准（Vditor 自己的上传也是这个行为）。
 *   5. **上传期间挂一个 loading**（见模板里那颗角标）：一次上传是「push 一个 git 仓库」，
 *      几秒钟很正常，而这几秒里正文里什么都不会出现 —— 没有提示就像按下去没反应。
 */
async function uploadImages(files: File[]): Promise<string | null> {
  const images = files.filter(file => file.type.startsWith('image/'))
  if (!images.length)
    return null

  /**
   * 只读：一张都不传。
   *
   * 这一道闸不能省 —— 粘贴 / 拖动**不看 `contenteditable`**（Vditor 把 paste / drop
   * 直接挂在那个元素上），而一次上传就是往用户仓库推一次 git：「读着读着手一抖」
   * 正是这个模式要挡住的那种失手。如实说一句，别静默丢掉。
   */
  if (props.readOnly)
    return '只读模式：图片没有上传（Ctrl+/ 切回可写再贴）'

  // 独立 Markdown 编辑窗口：没有「笔记本」这一层，一次上传会把图片推到图片仓库里
  // 一个临时层级 —— 不是那个窗口里期待的动作，挡下来并说清楚（笔记页行为不变）
  if (props.allowImageUpload === false)
    return '这个编辑窗口不上传图片：粘贴图片只在笔记页里推到图片仓库'

  if (!props.imageRepo) {
    return '还没有配置图片仓库：设置 → 笔记图片，填一个 git 仓库地址后，粘贴的图片会自动传上去'
  }

  uploading.value = images.length
  try {
    for (const file of images) {
      if (file.size > NOTE_IMAGE_MAX_BYTES) {
        return `这张图太大了（${(file.size / 1024 / 1024).toFixed(1)}MB，上限 ${NOTE_IMAGE_MAX_BYTES / 1024 / 1024}MB）`
      }

      const data = await toBase64(file)
      if (!data)
        return `读不出这张图片的内容：${file.name || '粘贴的图片'}`

      const result = await window.workbench.uploadNoteImage({
        repo: props.imageRepo ?? '',
        root: props.root,
        name: imageFileName({ mime: file.type }),
        data,
      })
      if (!result.ok || !result.data)
        return result.error ?? '上传图片失败'

      if (!result.data.url) {
        return `图片已经传进仓库（${result.data.path}），但这个仓库拼不出访问地址：图片只认得 GitHub / Gitee / GitLab 的仓库地址`
      }
      editor?.insertValue(imageMarkdown(result.data.url))
    }

    return null
  }
  finally {
    // 收尾只有这里：中途 return（图太大、传失败）时角标一样要收掉，
    // 否则它会一直挂在编辑器上，像是一次永远传不完的上传
    uploading.value = 0
  }
}

/**
 * 交给 Vditor 的 handler。
 *
 * 它声明的返回类型是 `Promise<string> | Promise<null>`（二选一），而我们两种都可能返回，
 * 所以这里如实转一下并写清楚：**运行时它只判「是不是字符串」**（是就当提示弹出来，
 * 不是就当这次上传已经处理完了），两种都接得住。
 */
function uploadHandler(files: File[]): Promise<string> | Promise<null> {
  return uploadImages(files) as Promise<string> | Promise<null>
}

/** 整张图 → base64。分块拼字符串：一次性 `String.fromCharCode(...bytes)` 在几兆的图上会爆栈 */
async function toBase64(file: File): Promise<string> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    const CHUNK = 0x8000
    for (let index = 0; index < bytes.length; index += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
    }
    return btoa(binary)
  }
  catch (error) {
    console.warn('[workbench] 读取粘贴的图片失败', error)
    return ''
  }
}

onMounted(() => {
  if (!host.value)
    return

  editingRel = props.note.rel
  saved = props.note.content
  editor = new Vditor(host.value, {
    cdn: VDITOR_CDN,
    mode: 'ir',
    value: saved,
    height: '100%',
    minHeight: 240,
    icon: 'ant',
    lang: 'zh_CN',
    // 工具带藏起来之后，界面上没有别的入口提示「格式在哪」，所以在这里说一句；
    // 「Ctrl+点击」与「Ctrl+/」也一样 —— 那两下是隐形的，不写在这儿就没人知道
    placeholder: props.placeholder ?? DEFAULT_PLACEHOLDER,
    // 缓存与落盘都归我们：Vditor 自带的那份存在 localStorage 里，会与磁盘上的 .md 打架
    cache: { enable: false },
    counter: { enable: false },
    /**
     * 粘贴 / 拖进来的图片走我们自己的 handler。
     *
     * **必须配置 handler**：不配的话 Vditor 会把图片读成 base64 直接内联进正文
     * （见 dist/index.js 里那条「没有 url / handler 就 FileReader 成 data URL」的分支），
     * 几篇带图的笔记就能把 .md 文件撑成几兆，同步和备份全跟着遭殃。
     */
    upload: {
      accept: 'image/*',
      multiple: true,
      handler: uploadHandler,
    },
    theme: isDark() ? 'dark' : 'classic',
    preview: {
      delay: 300,
      // 正文区（内容主题）与代码块高亮各有一套配色，明暗切换时一起换
      theme: { current: isDark() ? 'dark' : 'light' },
      hljs: { enable: true, lineNumber: false, style: isDark() ? 'github-dark' : 'github' },
    },
    /**
     * 链接**不交给 Vditor 打开**。
     *
     * 它默认（`link.isOpen`）在点击链接时自己 `window.open(地址)`（见它 IR 的 click 处理）——
     * 那一下我们拦不住：`preventDefault` 拦的是浏览器的默认动作，拦不住一个已经发出去的
     * `window.open`。于是外链会多弹一个窗口，而笔记之间那种相对链接在 WebView 里根本取不到
     * 东西（应用不是一个网站，`./别的.md` 那个地址不存在），弹出来只会是一个错误页。
     * 关掉之后点击全归下面那个 onClick，Vditor 那一段只剩一次 `return`。
     */
    link: { isOpen: false },
    /**
     * 大纲（目录结构）在**右侧、按需打开**。
     *
     * `enable` 保持 false：进这一页不先占掉正文 250px，要目录时从标题行那颗按钮
     * （或右键菜单的「大纲」）开一下 —— 两个入口点的都是工具带上那颗按钮。
     * 位置只能是 left / right，这里定死 right。
     */
    outline: { enable: false, position: 'right' },
    toolbar: TOOLBAR,
    input: value => schedule(value),
    // 初始化完成那一刻：核一遍只读（编辑器可能是「已经切到只读之后」才建起来的）、
    // 把大纲搬进右栏、再把它的开合状态同步一次；钉死那一档顺手打开它
    after: () => {
      applyReadOnly()
      attachOutline()
      syncOutlineOpen()
      if (props.outlinePinned)
        ensureOutlineOpen()
    },
  })
})

watch(
  () => props.outlineHost,
  () => attachOutline(),
)

watch(
  () => props.note.rel,
  () => load(props.note),
)

watch(
  () => props.theme,
  (theme) => {
    // 编辑器配色 / 内容主题 / 代码高亮是三处，setTheme 一次换掉
    const dark = theme === 'dark'
    editor?.setTheme(dark ? 'dark' : 'classic', dark ? 'dark' : 'light', dark ? 'github-dark' : 'github')
  },
)

// 只读是 Vditor 自己那对 `disabled()` / `enable()`（初始化还没完时那次是空转，
// 由 options 里的 `after` 兜底，见 applyReadOnly）
watch(() => props.readOnly, applyReadOnly)

onBeforeUnmount(() => {
  // 卸载前把没写完的那一段交出去：防抖窗口里切走不该丢字（同样是现取，道理见 flush）
  flush(currentValue())
  // 大纲元素是我们搬到右栏里的，`destroy()` 只管它自己那棵树 —— 不摘掉的话，
  // 它会留在那条栏里没人清理，下一位编辑器进来再挂一个，两块并排
  const outline = editor?.vditor?.outline?.element
  if (outline?.parentElement && outline.parentElement === props.outlineHost)
    outline.remove()
  if (outlineOpen.value) {
    outlineOpen.value = false
    emit('outline-change', false)
  }
  editor?.destroy()
  editor = null
})

/**
 * 露给上层的一双手（编辑器实例只有上层拿得到）。
 *
 * 笔记页那颗同步按钮要按这个次序用它们：先把防抖里那一份交出去（否则提交的是按下按钮
 * 之前的那一版），同步回来若是远端改过这一篇，再整份换掉（否则编辑器的旧内容会在
 * 下一次输入时把远端那份盖回去）。
 */
defineExpose({
  /** 立刻把攒着的那一份交出去，不等 `SAVE_DELAY` */
  flushAll: () => flush(currentValue()),
  /**
   * 编辑器现在的正文（只读，不触发写盘）。
   *
   * 独立编辑窗口在「上一次保存被拒」之后要重试：那时 `flushAll` 不会重复交出
   * 同一段正文（`saved` 已经推进过了），重试得自己拿这份内容再发一次。
   */
  currentContent: (): string | undefined => currentValue(),
  /** 用上层刚读回来的那一份（`props.note`）整份重置正文 */
  reloadFromProps: () => load(props.note),
  /** 手上这一份与 `base`（最后一次真正落盘 / 读盘的内容）比，有没有未保存的修改 */
  hasUnsaved,
  /** 丢掉手上这一份、整份换成 `node`（上层确认「按磁盘重读」之后才用；不 flush） */
  discardAndReload,
  /** 开关右侧大纲（标题行那颗按钮用；与右键菜单「大纲」同一个动作） */
  toggleOutline,
})
</script>

<template>
  <!--
    编辑器的宿主单独裹一层：角标是这张卡片上的浮层，不能塞进 Vditor 自己那块 DOM 里。

    **只读那个类挂在这一层，不挂在宿主上**（见样式里那几条 `.editor-wrap.is-readonly`）：
    Vditor 初始化时会给宿主（下面这个 `.editor`）**用 JS 加上一个 `vditor` 类**，而只要宿主身上
    还有一个 Vue 的 `:class` 绑定，那一档一变 Vue 就会把整个 `class` 属性重写成「它自己算出来的
    那一份」，把 `vditor` 抹掉。少了这个类，Vditor 那套 `.vditor { display: flex; flex-direction:
    column }` 全都不再适用，正文那个 `height: 100%` 便解析不出来 —— 它会涨成内容高度（实测 633px
    → 1603px），于是没有溢出、没有滚动条、也滚不动，卡片还是 `overflow: hidden`，剩下全被裁掉
    （踩过：现象是「只读之后滚不动了」，看着与滚动无关，其实坏在布局上）。这一层是我们自己的元素，
    Vditor 不碰，挂在它身上两边都安全。
  -->
  <div class="editor-wrap" :class="{ 'is-readonly': readOnly, 'is-dark': theme === 'dark' }">
    <div
      ref="host"
      class="editor"
      @click.capture="onClick"
      @keydown.capture="onKeyCapture"
      @keyup.capture="onKeyCapture"
      @contextmenu.prevent="openMenu"
    />

    <div v-if="uploading" class="upload" role="status">
      <el-icon class="is-loading">
        <Loading />
      </el-icon>
      <span>正在上传{{ uploading > 1 ? ` ${uploading} 张` : '' }}图片…</span>
    </div>
  </div>

  <!-- 菜单挂在 body 上（见组件里的 Teleport）：它是浮层，定位与层叠都不必看这张卡片与别处的脸色 -->
  <!-- 菜单挂在 body 上（见组件里的 Teleport）；大纲钉死那一档不摆「大纲」项，免得把固定栏关成空条 -->
  <NoteContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :hidden="outlinePinned ? ['outline'] : []"
    @act="runAction"
    @close="menu = null"
  />
</template>

<style scoped>
/*
 * Vditor 把 `.vditor` 这个类加在**宿主元素**上（就是我们这个 .editor），所以下面这几条写在自己身上、
 * 不用 :deep()。它自带的边框与圆角在外层卡片（.panel）里就是多画了一层，底色也交给卡片给。
 */
/* 角标的定位参照；编辑器自己仍然吃掉整张卡片剩下的高度 */
.editor-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
}

.editor {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  border: 0;
  border-radius: 0;
  background: transparent;
}

/**
 * 上传图片时的角标：贴在编辑器右下角，压着正文但不挡路。
 *
 * 不用 `v-loading` 那层遮罩：上传期间用户往往还在接着写，遮罩会把正文一起锁住。
 */
.upload {
  position: absolute;
  right: var(--sp-3);
  bottom: var(--sp-3);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  box-shadow: var(--shadow-pop);
  font-size: var(--fs-micro);
  color: var(--ink-2);
  pointer-events: none;
}

/*
 * 工具带整条藏起来：动作改从右键菜单走（见组件开头的说明）。
 *
 * **只是不显示，不是不建** —— 菜单里每一项都是去点工具带上对应的那颗按钮，
 * 所以这份 DOM 得照旧存在（见 TOOLBAR 那一段的说明）。
 */
.editor :deep(.vditor-toolbar) {
  display: none;
}

.editor :deep(.vditor-content) {
  background: transparent;
}

/**
 * 右侧大纲（目录结构）：Vditor 自带的 `outline`，开到 `position: 'right'`。
 *
 * 它默认是编辑器自己的样子，直接嵌进这张半透明卡片会有三处不对，所以整片换成应用这一套：
 *  1. **底色**：它铺的是 `--panel-background-color`（亮色纯白、暗色 #24292e），
 *     而这一页的底色归卡片 —— 铺上去就是右栏嵌了一块实心（与正文透明那条同一个理由）；
 *  2. **边线与字色**：那条 `#d1d5da` 比卡片还亮（与引用块那条竖线同一个坑），
 *     悬停色默认是它写死的蓝，而这一页的交互色跟主题走；
 *  3. **字体**：Vditor 根节点挂的是 Helvetica Neue 那一套，大纲是界面文字、不是正文。
 *
 * 宽度留它自己的 250px：那是它内部布局（标题栏、缩进、折叠箭头）算好的那一档。
 */
.editor :deep(.vditor-outline) {
  --border-color: var(--border);
  --panel-background-color: transparent;
  --toolbar-icon-color: var(--ink-3);
  --toolbar-icon-hover-color: var(--ink);
  background-color: transparent;
  border-left-color: var(--border);
  font-family: var(--font-ui);
  font-size: var(--fs-body);
}

/* 栏首那行「大纲」：虚线换成实线，字色与字号跟界面小标题同一档 */
.editor :deep(.vditor-outline__title) {
  border-bottom-style: solid;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/**
 * 正文面也要透明。
 *
 * Vditor 给 IR 模式的写作区（`pre.vditor-reset`）铺了一层不透明的底色
 * （`--panel-background-color`，亮色是纯白、暗色是 #24292e），于是「半透明卡片里
 * 嵌一块实心白」—— 左栏那张卡片整块都是透的，右边只有标题那一行透，两张卡片对不上。
 * 这一页的底色归卡片（`.panel` + 卡片不透明度），编辑器不再自己铺一层。
 */
.editor :deep(.vditor-ir pre.vditor-reset),
.editor :deep(.vditor-wysiwyg pre.vditor-reset),
.editor :deep(.vditor-sv .vditor-reset) {
  background-color: transparent;
}

/**
 * 引用块左侧那条竖线：Vditor 的内容主题给的是 `#eaecef`（比这张半透明卡片还亮），
 * 压上来像一道白边。亮色取 `--border-strong` —— 页面里别处的引用（MarkdownView）都是这一档；
 * 暗色不动，Vditor 自带的那条 `#d1d5da` 本身就是清楚的亮灰。
 *
 * 明暗那个类挂在 `.editor-wrap` 上，理由与只读那一档相同（见模板里那段）。
 */
.editor-wrap:not(.is-dark) :deep(.vditor-reset blockquote) {
  border-left-color: var(--border-strong);
}

/**
 * 只读：把 Vditor 禁用态自带的样式收回来。
 *
 * `disabled()` 只是把 contenteditable 关掉，Vditor 那边配的样式是
 * `pre.vditor-reset[contenteditable="false"] { opacity: .3; cursor: not-allowed }` ——
 * 那是「这个编辑器不能用了」的样子。这一档是拿来**读**的，正文得与平时一样清楚，
 * 光标也不该是禁止符号（它是内容，不是一颗按不动的按钮）。
 *
 * 空笔记那句 placeholder（「写点什么…」）在这一档里是错的，一并收掉 ——
 * 模式开着的时候标题行上写着「只读」。
 *
 * 选择器从 `.editor-wrap` 这一层起（不是 `.editor`）：只读那个类挂在外壳上，
 * 理由见模板里那段 —— 宿主身上的类归 Vditor 管，Vue 一碰就会把它的 `vditor` 抹掉。
 */
.editor-wrap.is-readonly :deep(.vditor-ir pre.vditor-reset[contenteditable='false']),
.editor-wrap.is-readonly :deep(.vditor-wysiwyg pre.vditor-reset[contenteditable='false']) {
  opacity: 1;
  cursor: auto;
}

.editor-wrap.is-readonly :deep(.vditor-ir pre.vditor-reset:empty::before),
.editor-wrap.is-readonly :deep(.vditor-wysiwyg pre.vditor-reset:empty::before) {
  content: none;
}

/**
 * 代码块上下那两条空档收掉。
 *
 * 收起态的代码块在 DOM 里是「一行 inline 的围栏标记 + 一块真正的 `<pre>`」，而写作区是
 * `white-space: pre-wrap`：那两个标记（`width` / `height` 都是 0）照样撑起一个整行的行盒，
 * 节点身上还有 Vditor 的 `:before/:after { content: ' ' }` —— 于是代码块上下各空出一整个行高
 * （16px 字号 + 1.5 行距 = 24px，上下共 48px）。写「列表项 + 代码块」这种笔记时，
 * 那两条空档就顶在文字与灰底之间，像是多敲了两个空行（踩过）。
 *
 * 收起态把这些去掉，并给节点补一条与段落一致的 16px 下边距 —— 上下各剩 16px（上面那条来自
 * 列表自己的 margin-bottom），节奏与正文其它块一样。
 *
 * **只动收起态**：展开态那两行就是围栏本身（`\`\`\`` 与语言名，见 Vditor 的
 * `.vditor-ir__node--expand[data-type="code-block"]:before`），删掉就没法看 / 改代码块的语言了。
 */
.editor :deep(.vditor-ir__node[data-type='code-block']) {
  margin-bottom: 16px;
}

.editor :deep(.vditor-ir__node[data-type='code-block']:not(.vditor-ir__node--expand)::before),
.editor :deep(.vditor-ir__node[data-type='code-block']:not(.vditor-ir__node--expand)::after),
.editor :deep(.vditor-ir__node[data-type='code-block']:not(.vditor-ir__node--expand) > .vditor-ir__marker) {
  display: none;
}
</style>
