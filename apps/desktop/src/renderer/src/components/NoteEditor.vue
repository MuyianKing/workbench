<script setup lang="ts">
import type { NoteDocument } from '@workbench/notes'
import type { FloatingMenuItem } from '@/components/FloatingMenu.vue'
import { Loading } from '@element-plus/icons-vue'
import { blobToBase64 } from '@workbench/core'

import { buildExportHtml, imageFileName, imageMarkdown, mergeEditorHotkeys, NOTE_IMAGE_MAX_BYTES, resolveNoteLink } from '@workbench/notes'
import Vditor from 'vditor'
// 自包含 HTML 导出：把随包那几份 CSS 在构建期读成字符串，导出时直接内联进去 ——
// 运行期不再去 fetch 资源（默认不联网，且导出的文件离开应用后相对路径也解析不了）
import contentThemeDarkCss from 'vditor/dist/css/content-theme/dark.css?raw'
import contentThemeLightCss from 'vditor/dist/css/content-theme/light.css?raw'
import highlightDarkCss from 'vditor/dist/js/highlight.js/styles/github-dark.min.css?raw'
import highlightLightCss from 'vditor/dist/js/highlight.js/styles/github.min.css?raw'
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FloatingMenu from '@/components/FloatingMenu.vue'
import NoteContextMenu from '@/components/NoteContextMenu.vue'
import OverlayScrollbar from '@/components/OverlayScrollbar.vue'
import { acceleratorOfEvent } from '@/composables/use-hotkey-recorder'
import { notifyError, notifySuccess, notifyWarning } from '@/notify'
import 'vditor/dist/index.css'

const props = defineProps<{
  note: NoteDocument
  /**
   * 当前笔记本（笔记文件夹的绝对路径）。
   *
   * 粘贴的图片要按「哪台机器、哪个笔记本」分目录进仓库（见 packages/notes/src/note-image.ts），
   * 而这两个来源里只有笔记本在这里说了算：路径由上层带进来，省得编辑器自己去问一遍。
   */
  root: string
  /**
   * 当前笔记本连着的 origin（有仓库时）：粘贴的图片按 origin 分层、跨设备共享。
   * 与 imageRepo 同一条规矩——不从 store 读，由上层传（笔记页从 store、独立窗口现探）。
   */
  imageOrigin?: string
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
   * **不从 settings store 里读**：这枚组件要能在独立 Markdown 编辑窗口里挂起来，
   * 而那扇窗口只装适配层、不装 Pinia（见 docs/modules/notes.md）。值由上层传进来：
   * 笔记页传设置里的值，独立窗口从首屏快照的设置取，没配时粘贴图片如实提示去设置里配。
   */
  imageRepo?: string
  /**
   * 编辑器的自定义快捷键表（动作名 → 组合键串，见 `@workbench/notes` 的 editor-hotkeys.ts）。
   *
   * 与 imageRepo 同一条规矩：**不从 settings store 里读**（独立 Markdown 窗口不装 Pinia），
   * 值由上层传。**拦截按「默认 + 用户覆盖」的合成表来**（`mergeEditorHotkeys`）：
   * 用户没碰过的动作按默认键位（标题 Ctrl+1~6、粗体 Ctrl+B…）也能拦下来走工具带；
   * 用户存空串的动作被禁用（不拦，只剩 Vditor 原厂键位）。
   */
  editorHotkeys?: Record<string, string>
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
   * 大纲钉在右侧、始终开着（笔记页与独立 Markdown 窗口都用）。
   *
   * 两边都没有开关：右侧那条目录栏是固定的，初始化完成后直接打开；
   * 右键菜单里的「大纲」项在这一档不出现（否则能从菜单把它关掉，栏里剩一条空白）。
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
  change: [payload: { rel: string, content: string }]
  /**
   * 正文里点了一个指向**本笔记本里另一篇笔记**的链接（`[标题](./别的.md)`）：请上层打开它。
   *
   * 这里只做到「链接指向哪一篇」（相对路径的解析是纯函数，见 packages/notes/src/note.ts 的 resolveNoteLink）；
   * 那一篇在不在、要不要重扫一遍树、跳过去之后选中谁，都是上层的事。
   */
  open: [rel: string]
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
 * 正文真正的滚动容器（Vditor 的 `pre.vditor-reset`）。
 *
 * 原生滚动条在样式里藏掉了，改由 `OverlayScrollbar` 画一条不占宽度的悬浮滑块。
 * Vditor 是异步初始化的，这个 ref 要到 `after` 里才拿得到；在那之前滚动条自己隐藏。
 */
const scrollTarget = ref<HTMLElement | null>(null)
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
   * 工具带与大纲都是编辑器自己的东西，点击要交给 Vditor。
   *
   * **只读那一档必须在这里让路**：下面那条 `stopPropagation` 挂在捕获阶段，会把
   * 这两处的点击一起吞掉 —— 工具带虽然藏着，里面的按钮照旧点得动；大纲条目的
   * 跳转也归 Vditor 的监听器接。
   */
  if (target?.closest('.vditor-toolbar, .vditor-outline'))
    return

  /**
   * 图片：源码标记（![]() 与地址）已整体藏起来（地址走 img 的 hover tooltip）。
   * Vditor 那个「点击图片选中地址」的处理器不能放它接 —— 不然用户对着藏起来的文本
   * 按 Backspace，会把地址一个字一个字删掉（正文看着没变，下一次保存就把图改坏了）。
   */
  if (target instanceof HTMLImageElement && target.closest('span[data-type="img"]')) {
    event.stopPropagation()
    return
  }

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
 * 段落行首的那一下空格。
 *
 * Markdown 把段落开头的 ASCII 空格当缩进丢掉（1–3 个是段落缩进，4 个起才是代码块），
 * 而 Vditor 每次输入还会把当前块交给 Lute 重新解析（`SpinVditorIRDOM`）—— 行首第一个
 * 普通空格连 DOM 里都留不住，所以看起来「打不进去」。
 *
 * 只处理**顶层普通段落、光标在整段最前面**这一档（空段落也算 —— 新起一行先打空格再写，
 * 同样是这个动作）：把这一次空格换成 EN SPACE（U+2002）。它是正文字符，Lute 不修剪，
 * 落进 `.md` 也是一个真正的空白字符，别的编辑器照样显示成缩进。列表项 / 引用 / 表格 /
 * 代码块不碰（各有自己的 Markdown 语义）；第一颗 EN SPACE 打头之后，后面再按空格就是
 * 普通空格，Lute 会照常保留。
 */
function insertLeadingSpace(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.isComposing || event.key !== ' ')
    return false
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)
    return false

  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed)
    return false
  const range = selection.getRangeAt(0)

  const element: Element | null = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer as Element | null
  const block = element?.closest<HTMLElement>('p[data-block="0"]')
  if (!block)
    return false
  // 只认顶层普通段落：列表里的段落、引用、表格、代码块各有自己的缩进语义
  if (block.closest('li, blockquote, table, [data-type="code-block"]'))
    return false

  // 光标前必须真的什么都没有：行内空格不归这里管
  const before = range.cloneRange()
  before.selectNodeContents(block)
  before.setEnd(range.startContainer, range.startOffset)
  if (before.toString().replace(/[\u200b\ufeff]/g, '') !== '')
    return false

  event.preventDefault()
  event.stopPropagation()
  // 交给浏览器的输入通道：Vditor 的 input 监听会照常重排，我们的防抖保存也照常收到
  document.execCommand('insertText', false, '\u2002')
  return true
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
  if (props.readOnly) {
    event.stopPropagation()
    return
  }
  if (
    event.type === 'keydown' && event.key === 'Enter' && !event.isComposing
    && !event.ctrlKey && !event.altKey && !event.metaKey
  ) {
    markBottomStick()
  }
  if (insertLeadingSpace(event))
    return
  // 自定义快捷键命中时事件已被拦住（preventDefault + stopPropagation），这里不用再做什么
  dispatchEditorHotkey(event)
}

/**
 * 自定义快捷键命中了吗？命中就拦下来去点工具带按钮，返回 true。
 *
 * 拦截按**「默认 + 用户覆盖」的合成表**（`mergeEditorHotkeys`，computed 缓存一份）：
 * 默认键位（标题 Ctrl+1~6、粗体 Ctrl+B…）真的生效 —— 不只是设置里的显示；
 * 用户覆盖的动作换用户的键；用户存空串的动作被禁用（不拦，只剩 Vditor 原厂键位）。
 * 与原厂键位是**并行**关系：拦的是合成表里的键，原厂那套（Ctrl+Alt+3 等）它自己
 * 还在监听，两边同时有效。
 *
 * 组合键串的拼法与设置里录制的共用一份口径（`acceleratorOfEvent`）—— 否则
 * 「录进去的键按不出来」没处查。命中判断挂在 keydown 一档（keyup 再拦一次会
 * 把同一个动作跑两遍）；输入法组合中（isComposing）让路。**表里没有的组合一概
 * 不拦**：Ctrl+S / Ctrl+/ 这些都是外层监听器的，各走各的。
 */
function dispatchEditorHotkey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown' || event.isComposing)
    return false

  // 只认带修饰键的组合：单按一个字符是打字本身，与快捷键无关
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey)
    return false

  const accelerator = acceleratorOfEvent(event)
  if (!accelerator)
    return false

  const lowered = accelerator.toLowerCase()
  const target = Object.entries(effectiveHotkeys.value).find(([, bound]) => String(bound).trim().toLowerCase() === lowered)
  if (!target)
    return false

  event.preventDefault()
  event.stopPropagation()
  runAction(target[0])
  return true
}

/** 生效的键位表 = 默认 + 用户覆盖（设置里传上来的 `editorHotkeys`）；空串项被剔除 */
const effectiveHotkeys = computed(() => mergeEditorHotkeys(props.editorHotkeys))

/**
 * 按回车前是不是已经贴着底（含底部那段留白）。
 *
 * 浏览器只把光标滚到「刚好可见」为止，底部留白会留在视野外 —— 一路回车时看起来
 * 时灵时不灵：有时滚到留白，有时停在最后一行。所以输入前先记一笔，输入后再把
 * 滚动位置补到底（见 onContentInput）；读着上面时这一条不成立，不会抢滚动。
 */
let stickToBottom = false

function markBottomStick(): void {
  const element = editor?.vditor?.ir?.element
  if (!element)
    return
  // 留白是样式里的 `--editor-bottom`（见下面那一段），这里按实际值算，别另抄一份数字
  const gap = parseFloat(getComputedStyle(element).getPropertyValue('--editor-bottom')) || 0
  stickToBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - gap - 2
}

/**
 * 回车落定后补一次滚动：让底部留白稳定留在光标下方（Typora 那种手感）。
 *
 * 放在 rAF 里：Vditor 的 input 处理会同步重绘当前块，等这一帧的布局量完再设 scrollTop。
 */
function onContentInput(): void {
  if (!stickToBottom)
    return
  stickToBottom = false
  requestAnimationFrame(() => {
    const element = editor?.vditor?.ir?.element
    if (element)
      element.scrollTop = element.scrollHeight
  })
}

/** 右键菜单的落点（视口坐标）；null 表示没开。`inTable` 是右键那一刻光标的状态，菜单据此摆不摆表格那排 */
const menu = ref<{ x: number, y: number, inTable: boolean } | null>(null)

/** 右击图片弹出的宽高预设菜单（条目见 IMAGE_MENU_ITEMS）；null 表示没开 */
const imageMenu = ref<ImageMenuState | null>(null)

function openMenu(event: MouseEvent): void {
  // 编辑器还没建好时菜单没有可点的东西（动作全在那份工具带上）；
  // 只读下同样没有：工具带被 `disabled()` 禁掉了，弹出来会是一份每一项都没反应的菜单
  if (!editor || props.readOnly)
    return
  // 右击的是正文里的图片：出宽高预设（25 / 50 / 75 / 100% 与原始大小），不出格式菜单
  const target = event.target
  const imageNode = target instanceof HTMLImageElement
    ? target.closest<HTMLElement>('span[data-type="img"]')
    : null
  if (target instanceof HTMLImageElement && imageNode) {
    imageMenu.value = { x: event.clientX, y: event.clientY, img: target, node: imageNode }
    return
  }
  menu.value = { x: event.clientX, y: event.clientY, inTable: focusInTable() }
}

/**
 * 右键菜单点了一项：`table:` 前缀走快捷键通道，`export:` 前缀走导出，其余照旧点工具带按钮。
 */
function onMenuAction(name: string): void {
  if (name.startsWith('table:')) {
    runTableAction(name.slice('table:'.length) as Parameters<typeof runTableAction>[0])
    return
  }
  if (name.startsWith('export:')) {
    void exportNote(name.slice('export:'.length) as 'markdown' | 'html' | 'pdf')
    return
  }
  runAction(name)
}

/** 导出容器的默认文件名：笔记名 + 后缀（去掉可能带上的 .md） */
function exportBaseName(): string {
  return props.note.name.replace(/\.(md|markdown)$/i, '') || '笔记'
}

/**
 * 把渲染后的正文包成自包含 HTML（样式内联，任何浏览器打开都一样）。
 *
 * 不做「点 Vditor 工具带按钮」那条路：它导出 HTML 时引随包的 `cdn` 资源，
 * PDF 更是往 iframe 写内联 `<script>` —— 生产态有 CSP nonce，那段脚本被丢掉，点了没反应。
 * 这里改成应用自己拼文档：CSS 构建期内联（`?raw`），不引用任何应用内相对路径。
 */
function exportHtmlDocument(): string {
  const html = editor?.getHTML() ?? ''
  return buildExportHtml({
    body: html,
    title: props.note.name,
    contentThemeCss: isDark() ? contentThemeDarkCss : contentThemeLightCss,
    highlightCss: isDark() ? highlightDarkCss : highlightLightCss,
    dark: isDark(),
  })
}

/**
 * 导出正文：弹「另存为」让用户挑路径，写完给一句 feedback。
 *
 * - Markdown：正文原文（`getValue()`）直接存 `.md`；
 * - HTML：自包含 HTML 存下来，双击就能在任意浏览器打开；
 * - PDF：不写文件，用隐藏 iframe 装自包含 HTML 调 `window.print()`，
 *   由用户在打印对话框里选「另存为 PDF」—— Tauri 里没有免对话框的 PDF 生成器，
 *   这是不引新依赖、也不联网的前提下唯一可靠的路。
 */
async function exportNote(format: 'markdown' | 'html' | 'pdf'): Promise<void> {
  const filters = format === 'markdown'
    ? [{ name: 'Markdown', extensions: ['md'] }]
    : [{ name: 'HTML', extensions: ['html', 'htm'] }]

  if (format === 'pdf') {
    printPdf()
    return
  }

  const base = exportBaseName()
  const path = await window.workbench.pickSavePath({
    title: format === 'markdown' ? '导出为 Markdown' : '导出为 HTML',
    defaultPath: `${base}.${format === 'markdown' ? 'md' : 'html'}`,
    filters,
  })
  if (!path)
    return // 用户取消，不是失败

  const content = format === 'markdown' ? (currentValue() ?? '') : exportHtmlDocument()
  const result = await window.workbench.writeTextFile(path, content)
  if (!result.ok) {
    notifyError(result.error ?? '导出失败')
    return
  }
  notifySuccess(`已导出到 ${path}`)
}

/**
 * PDF：临时往页面里塞一个 srcdoc iframe 装自包含 HTML，加载完调它的 `print()`，
 * 由用户在打印对话框里选「另存为 PDF」—— Tauri 里没有免对话框的 PDF 生成器，
 * 这是不引新依赖、也不联网的前提下唯一可靠的路（不用 `window.open`：WebView2 里它
 * 会开到没有应用上下文的错误页，见文档开头的链接那一条）。
 *
 * 用 `srcdoc`（不是写 iframe.innerHTML 内联脚本）绕开生产 CSP：srcdoc 是新文档，
 * 里面只有 `<style>` 与正文，没有需要 nonce 的脚本；打印由我们这边调，文档里不放脚本。
 * 打印窗口关掉后（print 是同步返回的）把 iframe 摘掉。
 */
function printPdf(): void {
  const frame = document.createElement('iframe')
  frame.title = '打印预览'
  // CSSOM 定位（行内 style 属性在生产态 CSP nonce 下会被丢弃，见文档）——
  // 放到屏幕外而不是 display:none：后者在部分 WebView 里打印出来是空白页
  frame.style.position = 'fixed'
  frame.style.left = '-10000px'
  frame.style.top = '0'
  frame.style.width = '794px'
  frame.style.height = '1123px'
  frame.style.border = '0'
  frame.srcdoc = exportHtmlDocument()
  frame.addEventListener('load', () => {
    // 独立 Markdown 窗口的 index.html 有内联 <style>，生产态 Tauri 会给 CSP 的 style-src
    // 加 nonce（nonce 在场 'unsafe-inline' 失效，子框架继承同一份策略）—— srcdoc 里的
    // <style> 没带 nonce 就会被丢掉、打出无样式的白纸。把父文档那枚 nonce 抄过来。
    // 必须用 IDL 的 .nonce：内容属性被 CSP 刻意藏起来，get/setAttribute('nonce') 不参与匹配。
    const nonce = document.querySelector('style')?.nonce
    if (nonce) {
      frame.contentDocument?.querySelectorAll('style').forEach((style) => {
        style.nonce = nonce
      })
    }
    // 等一帧让布局与样式就绪再打印，避免打出空白页
    window.setTimeout(() => {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
      // print 对话框关掉后把临时 iframe 摘掉
      window.setTimeout(() => frame.remove(), 1000)
    }, 100)
  })
  document.body.appendChild(frame)
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
  if (name.startsWith('heading')) {
    const level = name.slice('heading'.length)

    /**
     * 光标已经在**同级**标题里时改点主按钮：它带开关语义 —— 光标在标题里时挂着
     * `vditor-menu--current`（Vditor 的 highlightToolbarIR 点的），此时点它是
     * 「去掉标题」（IR 走 `processHeading(vditor, "")`）。照旧去点面板里那颗的话，
     * 同一级只会「再设置一遍」，Ctrl+1 就取消不掉 H1。不同级照旧是切换。
     */
    const current = getSelection()?.anchorNode
    const anchor = current instanceof Element ? current : current?.parentElement ?? null
    const heading = anchor?.closest('h1, h2, h3, h4, h5, h6')
    if (heading && heading.tagName === `H${level}`) {
      const toggle = elements.headings?.firstElementChild
      if (toggle instanceof HTMLElement) {
        toggle.click()
        return
      }
    }

    const target = elements.headings?.querySelector(`[data-tag="h${level}"]`)
    if (!(target instanceof HTMLElement)) {
      console.warn('[workbench] 工具带上找不到这一项，右键菜单的动作没有执行', name)
      return
    }
    target.click()
    return
  }

  const target = elements[name]?.firstElementChild
  if (!(target instanceof HTMLElement)) {
    console.warn('[workbench] 工具带上找不到这一项，右键菜单的动作没有执行', name)
    return
  }

  target.click()
}

/**
 * 光标（或选区）此刻是否落在表格的单元格里。
 *
 * 右键菜单据此决定要不要摆出「表格」那一组 —— IR 模式下 Vditor 对表格没有
 * 所见即所得那种悬停工具条（它只挂在 wysiwyg 元素上），行列的增删只能走
 * 它自己那组快捷键（见 runTableAction）。
 */
function focusInTable(): boolean {
  const node = getSelection()?.anchorNode
  if (!node)
    return false
  const element = node instanceof Element ? node : node.parentElement
  return !!element?.closest('.vditor-ir pre.vditor-reset td, .vditor-ir pre.vditor-reset th')
}

/**
 * 表格的行列操作：往 IR 元素上**派发一次 Vditor 自己认的快捷键**。
 *
 * Vditor 对表格的增删改全挂在它 IR / wysiwyg 共用的那个按键处理器上（光标必须在
 * `td` / `th` 里才生效）；与其把插行删列的 DOM 手术照抄一遍 —— 渲染、光标、撤销栈
 * 都会与它分叉 —— 不如把事件合成出来交给它。它不看 `isTrusted`，合成事件照走原路。
 *
 * 键名的坑：Vditor 的匹配器在非 Mac 上会把带 Shift 的 `=` / `-` 先改写成 `+` / `_`
 * **再与 `event.key` 比**，所以这里给的是改写后的键，不是按键字面上的 `=` / `-`。
 * `bubbles: true` 不能省 —— 监听器挂在 IR 元素上，事件得从 `td` 冒泡上去。
 */
function runTableAction(
  action: 'row-after' | 'row-before' | 'col-after' | 'col-before' | 'row-delete' | 'col-delete',
): void {
  const element = editor?.vditor?.ir?.element
  if (!element || !focusInTable()) {
    console.warn('[workbench] 表格动作被跳过：光标不在单元格里', action)
    return
  }

  // 六个动作与 Vditor 按键处理器里的六条一一对应：⌘= ⇧⌘F ⇧⌘= ⇧⌘G ⌘- ⇧⌘-
  const keys = {
    'row-after': { ctrlKey: true, shiftKey: false, key: '=' },
    'row-before': { ctrlKey: true, shiftKey: true, key: 'F' },
    'col-after': { ctrlKey: true, shiftKey: true, key: '+' },
    'col-before': { ctrlKey: true, shiftKey: true, key: 'G' },
    'row-delete': { ctrlKey: true, shiftKey: false, key: '-' },
    'col-delete': { ctrlKey: true, shiftKey: true, key: '_' },
  } as const

  const init = keys[action]
  element.dispatchEvent(new KeyboardEvent('keydown', {
    key: init.key,
    code: `Key${init.key.toUpperCase()}`,
    ctrlKey: init.ctrlKey,
    shiftKey: init.shiftKey,
    altKey: false,
    metaKey: false,
    bubbles: true,
    cancelable: true,
  }))
}

/**
 * 抓住正文的滚动容器（`.vditor-ir pre.vditor-reset`）。
 *
 * Vditor 自己在这个元素上开 `overflow: auto`，原生滚动条被样式藏掉，滑块要跟着它走。
 * 初始化完成时调一次；切主题会让 Vditor 重渲染正文，顺手再抓一次（元素没换也无害）。
 *
 * **必须圈定在 `.vditor-ir` 里**：`pre.vditor-reset` 在文档顺序上先出现的是隐藏的
 * wysiwyg 那份（Vditor 把三套模式的容器都建出来），抓到它滚动条就永远量不出尺寸。
 */
function bindScrollTarget(): void {
  scrollTarget.value = host.value?.querySelector<HTMLElement>('.vditor-ir pre.vditor-reset') ?? null
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

/** Vditor 大纲里收起分支的箭头类名（见 outlineRender 的 click 处理） */
const OUTLINE_CLOSE_CLASS = 'vditor-outline__action--close'

/** 大纲分支的路径键：从顶层逐级写下的标题文本；重建后 id 会换，这条路径不会 */
function outlineBranchKey(path: string[]): string {
  return JSON.stringify(path)
}

/**
 * 走一遍大纲的分支（`li > span[data-target-id] + ul`），把每一级都交给 visit。
 *
 * 路径按标题文本记而不是 target id：`outlineRender` 用「正文子元素序号」拼 id，
 * 在中间插入一个标题就会让后面所有条目的 id 整体错位。
 */
function eachOutlineBranch(
  root: HTMLElement,
  visit: (row: HTMLElement, sub: HTMLElement, key: string) => void,
): void {
  const walk = (list: Element, path: string[]): void => {
    for (const item of Array.from(list.children)) {
      if (!(item instanceof HTMLElement) || item.tagName !== 'LI')
        continue
      const row = item.querySelector(':scope > span[data-target-id]')
      const sub = item.querySelector(':scope > ul')
      if (!(row instanceof HTMLElement) || !(sub instanceof HTMLElement))
        continue
      const label = (row.querySelector(':scope > span')?.textContent ?? '').trim()
      const nextPath = [...path, label]
      visit(row, sub, outlineBranchKey(nextPath))
      walk(sub, nextPath)
    }
  }
  const list = root.querySelector('.vditor-outline__content ul')
  if (list)
    walk(list, [])
}

/** 记下大纲里已经收起的分支（箭头转开、子列表 display:none） */
function collapsedOutlineBranches(): Set<string> {
  const collapsed = new Set<string>()
  const root = editor?.vditor?.outline?.element
  if (!(root instanceof HTMLElement))
    return collapsed

  eachOutlineBranch(root, (row, sub, key) => {
    const action = row.querySelector(':scope > svg.vditor-outline__action')
    if (sub.style.display === 'none' || action?.classList.contains(OUTLINE_CLOSE_CLASS))
      collapsed.add(key)
  })
  return collapsed
}

/** 把上次收起的分支按同一路径补回（CSSOM 赋值，窗口的 CSP 不拦这一路） */
function restoreOutlineBranches(collapsed: Set<string>): void {
  if (!collapsed.size)
    return
  const root = editor?.vditor?.outline?.element
  if (!(root instanceof HTMLElement))
    return

  eachOutlineBranch(root, (row, sub, key) => {
    if (!collapsed.has(key))
      return
    row.querySelector(':scope > svg.vditor-outline__action')?.classList.add(OUTLINE_CLOSE_CLASS)
    sub.style.display = 'none'
  })
}

/** 大纲重建的补丁每个编辑器实例只打一次 */
let outlineRenderPatched = false

/**
 * 保住大纲分支的展开 / 收起状态。
 *
 * Vditor 每次输入都会 `renderToc`，它无条件调 `outline.render` 把整棵目录重建一遍
 * （`outlineRender` 直接覆写 innerHTML）—— 收起的分支（箭头 `--close` + 子列表
 * `display:none`）就会全部重新展开。现象是「标题一加 / 字一敲，左侧目录自己弹开」。
 *
 * 这里包一层 render：重建前记下收起的分支，重建后按同一路径补回。只影响大纲的外观，
 * Vditor 的渲染结果与它自己的点击监听都照旧。
 */
function patchOutlineRender(): void {
  const outline = editor?.vditor?.outline
  if (!outline || outlineRenderPatched)
    return
  outlineRenderPatched = true

  const target = outline as unknown as { render: (vditor: unknown) => string }
  const original = target.render.bind(outline)
  target.render = (vditor: unknown) => {
    const collapsed = collapsedOutlineBranches()
    const html = original(vditor)
    restoreOutlineBranches(collapsed)
    return html
  }
}

/**
 * 打开 / 关掉右侧的大纲（目录结构）。
 *
 * 与右键菜单里那一项走同一条路：**点工具带上那颗按钮**。`options.outline.enable`
 * 与按钮的选中态都由 Vditor 自己维护。现在两处调用方（笔记页 / 独立窗口）都钉着大纲，
 * 它只由 `ensureOutlineOpen` 在初始化后调一次；工具带虽然藏着（见样式），按钮照旧在 DOM 里、
 * 照旧点得动，只读那一档也没把它禁掉（`disabled()` 只禁带编辑动作的那批）。
 */
function toggleOutline(): void {
  runAction('outline')
}

/**
 * 大纲还没开就打开它（`outlinePinned` 那一档在初始化完成时调一次）。
 *
 * 不走 `toggleOutline` 直接调用是因为它是「开关」：已经开着时再点一下就关了。
 * 初始化那一刻正常是关着的，但 `setValue` / 切主题之类重渲染后未必 —— 这里按
 * 元素自己的 `display` 判断实际状态。
 */
function ensureOutlineOpen(): void {
  const element = editor?.vditor?.outline?.element
  if (!element || element.style.display === 'block')
    return
  toggleOutline()
}

// ---------- 图片宽高 ----------

/**
 * 图片尺寸存进 **alt 文本**的约定：`![说明|宽x高](地址)`。
 *
 * Markdown / Lute 都不认 `=宽x高`、`{width=…}` 这类扩展语法（试过，原样留在正文里），
 * 而 IR 重排会把 `<img>` 上的 width / height 属性剥掉 —— 尺寸只有写进 alt 才能活下来
 * （alt 是普通文本，落盘、round-trip 都不丢；别的编辑器不认识就当普通说明文字）。
 * 渲染时在这里把 alt 尾巴解析出来，落到 img 的 style 上。
 *
 * 三种尾巴都认：`|800x450`（宽高都定）、`|800x`（只定宽，高不设）、`|x450`（只定高）。
 */
const IMAGE_SIZE_PATTERN = /\|(\d*)x(\d*)$/

/** 拖动热区：距图片右 / 下边缘多少像素内算「抓到把手」（右缘与右下角都是等比缩放） */
const IMAGE_RESIZE_HOT = 10

/** 最小宽度（px）：拖没了图就看不见了 */
const IMAGE_SIZE_MIN = 40

interface ImageResizeState {
  img: HTMLImageElement
  /** 图片所在的 IR 节点（alt 标记在里面） */
  node: HTMLElement
  startX: number
  startWidth: number
  /** 原始宽高比：拖动只等比缩放，宽定了高就跟着 */
  ratio: number
  maxWidth: number
  moved: boolean
}

/** 右击图片弹出的预设菜单：`img:` 前缀的百分比按正文内容宽度算 */
const IMAGE_MENU_ITEMS: FloatingMenuItem[] = [
  { name: 'img:25', label: '宽度 25%' },
  { name: 'img:50', label: '宽度 50%' },
  { name: 'img:75', label: '宽度 75%' },
  { name: 'img:100', label: '宽度 100%' },
  { name: 'img:original', label: '原始大小', sep: true },
  // 源码标记藏起来之后（见下方 CSS），键盘选中整段图片不再直观，删除给个确定的入口
  { name: 'img:remove', label: '删除图片', danger: true },
]

interface ImageMenuState {
  x: number
  y: number
  img: HTMLImageElement
  node: HTMLElement
}

let imageResize: ImageResizeState | null = null
let imageStyleFrame = 0
let imageObserver: MutationObserver | null = null

/** alt 标记：`[` 那枚 marker 的下一个兄弟（IR 节点里 alt 是普通文本 marker） */
function imageAltMarker(node: HTMLElement): HTMLElement | null {
  const open = node.querySelector(':scope > .vditor-ir__marker--bracket')
  return open?.nextElementSibling instanceof HTMLElement ? open.nextElementSibling : null
}

/** 把 alt 尾巴里的尺寸落到 img 的 style 上；没有尾巴就清掉（Vditor 重排会剥掉行内样式） */
function applyImageSizes(): void {
  const element = editor?.vditor?.ir?.element
  if (!element)
    return

  element.querySelectorAll<HTMLImageElement>('span[data-type="img"] > img').forEach((img) => {
    // 地址以原生 tooltip 显示（悬停可见）：正文里的源码标记整段藏了，这是看地址的唯一入口
    img.title = /^https?:/i.test(img.src) ? img.src : ''
    const match = IMAGE_SIZE_PATTERN.exec(img.alt ?? '')
    if (!match || (!match[1] && !match[2])) {
      img.style.removeProperty('width')
      img.style.removeProperty('height')
      return
    }
    if (match[1])
      img.style.width = `${match[1]}px`
    else img.style.removeProperty('width')
    if (match[2])
      img.style.height = `${match[2]}px`
    else img.style.removeProperty('height')
  })
}

/** Vditor 每次输入都重建 DOM（行内样式同时被剥掉），用 MutationObserver 跟着重放尺寸 */
function observeImageSizes(): void {
  const element = editor?.vditor?.ir?.element
  if (!element || imageObserver)
    return
  imageObserver = new MutationObserver(() => {
    if (imageStyleFrame)
      return
    imageStyleFrame = window.requestAnimationFrame(() => {
      imageStyleFrame = 0
      applyImageSizes()
    })
  })
  imageObserver.observe(element, { childList: true, subtree: true })
}

/** 正文内容的宽度（px）：拖动与百分比预设都以它为上限 / 基准。
 *
 * **必须圈定在 `.vditor-ir` 里**：Vditor 把三套模式的容器都建在宿主里，最先出现的
 * `pre.vditor-reset` 是隐藏的 wysiwyg 那份（clientWidth 恒为 0）—— 直接查会把 0 当内容宽，
 * 拖动与「宽度 100%」全部被压到 40px（实测踩过，现象是「一拖就变小一丢丢」）。
 */
function imageContentWidth(): number {
  const content = host.value?.querySelector<HTMLElement>('.vditor-ir pre.vditor-reset')
  const style = content ? getComputedStyle(content) : null
  const width = content && style
    ? content.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
    : 0
  return Math.max(IMAGE_SIZE_MIN, Math.round(width))
}

/** 图片的原始宽高比；natural 尺寸还没到（图在加载）时退回当前显示比例 */
function imageRatioOf(img: HTMLImageElement): number {
  if (img.naturalWidth > 0 && img.naturalHeight > 0)
    return img.naturalHeight / img.naturalWidth
  const rect = img.getBoundingClientRect()
  return rect.height / Math.max(1, rect.width)
}

/** 光标落点在不在拖动热区（右缘 / 右下角；一律等比缩放） */
function imageResizeHotAt(x: number, y: number, rect: DOMRect): boolean {
  return rect.right - x <= IMAGE_RESIZE_HOT || rect.bottom - y <= IMAGE_RESIZE_HOT
}

/** 宽度可拖的上限是正文内容宽度：style 写超了也会被 max-width 压回来，存个用不上的数没意义 */
function imageWidthOf(state: ImageResizeState, dx: number): number {
  return Math.min(Math.max(IMAGE_SIZE_MIN, state.startWidth + dx), state.maxWidth)
}

/**
 * 把一份宽度落到图片上并立即保存：宽按比例带出高，尺寸写进 alt 尾巴。
 * `width` 为 null 表示回原始大小（摘掉尾巴）。
 */
function applyImageWidth(img: HTMLImageElement, node: HTMLElement, width: number | null): void {
  const altMarker = imageAltMarker(node)
  if (!altMarker)
    return
  const base = (altMarker.textContent ?? '').replace(IMAGE_SIZE_PATTERN, '')

  if (width === null) {
    altMarker.textContent = base
    img.alt = base
    img.style.removeProperty('width')
    img.style.removeProperty('height')
  }
  else {
    const finalWidth = Math.round(Math.min(Math.max(IMAGE_SIZE_MIN, width), imageContentWidth()))
    const height = Math.round(finalWidth * imageRatioOf(img))
    altMarker.textContent = `${base}|${finalWidth}x${height}`
    img.alt = altMarker.textContent
    img.style.width = `${finalWidth}px`
    img.style.height = `${height}px`
  }
  flush(currentValue())
}

function onImagePointerDown(event: PointerEvent): void {
  if (props.readOnly || event.button !== 0)
    return
  const target = event.target
  if (!(target instanceof HTMLImageElement))
    return
  const node = target.closest<HTMLElement>('span[data-type="img"]')
  if (!node)
    return

  const rect = target.getBoundingClientRect()
  if (!imageResizeHotAt(event.clientX, event.clientY, rect))
    return

  // 拦下这一下：既不让 Vditor 选中图片地址，也不让浏览器起原生拖图
  event.preventDefault()
  event.stopPropagation()

  imageResize = {
    img: target,
    node,
    startX: event.clientX,
    startWidth: rect.width,
    ratio: imageRatioOf(target),
    maxWidth: imageContentWidth(),
    moved: false,
  }
  document.body.classList.add('is-resizing-note-image')
  document.body.style.cursor = 'ew-resize'
  window.addEventListener('pointermove', onImageResizeMove)
  window.addEventListener('pointerup', onImageResizeEnd)
}

function onImageResizeMove(event: PointerEvent): void {
  const state = imageResize
  if (!state)
    return
  const dx = event.clientX - state.startX
  if (!state.moved && Math.abs(dx) < 3)
    return
  state.moved = true

  // **始终等比**：宽由指针带，高按原始比例跟
  const width = imageWidthOf(state, dx)
  state.img.style.width = `${Math.round(width)}px`
  state.img.style.height = `${Math.round(width * state.ratio)}px`
}

function onImageResizeEnd(): void {
  const state = imageResize
  imageResize = null
  window.removeEventListener('pointermove', onImageResizeMove)
  document.body.classList.remove('is-resizing-note-image')
  document.body.style.cursor = ''
  if (state)
    delete state.img.dataset.resizeMode
  if (!state || !state.moved)
    return

  // 尺寸写回 alt 标记（markdown 里唯一留得住的位置），随后立刻交一次保存
  const img = state.img
  const width = img.style.width ? Math.round(Number.parseFloat(img.style.width)) : 0
  if (!width)
    return
  applyImageWidth(img, state.node, width)
}

/** 悬停在热区上给个光标提示（拖动中的光标归 body 那条管） */
function onImagePointerHover(event: PointerEvent): void {
  if (imageResize || props.readOnly)
    return
  const target = event.target
  if (!(target instanceof HTMLImageElement) || !target.closest('span[data-type="img"]'))
    return
  if (imageResizeHotAt(event.clientX, event.clientY, target.getBoundingClientRect()))
    target.dataset.resizeMode = 'scale'
  else if (target.dataset.resizeMode)
    delete target.dataset.resizeMode
}

/** 从热区起手时不许浏览器把图片拖走（其余位置的拖放仍归 Vditor 的粘贴 / 拖入逻辑） */
function onImageDragStart(event: DragEvent): void {
  const target = event.target
  if (target instanceof HTMLImageElement && target.dataset.resizeMode)
    event.preventDefault()
}

/** 右击图片：出宽高预设菜单，不出格式菜单 */
function onImageMenuAction(name: string): void {
  const state = imageMenu.value
  if (!state)
    return
  imageMenu.value = null
  if (name === 'img:original') {
    applyImageWidth(state.img, state.node, null)
    return
  }
  if (name === 'img:remove') {
    removeImageFrom(state.node)
    return
  }
  const percent = Number(name.slice('img:'.length))
  if (!Number.isFinite(percent))
    return
  applyImageWidth(state.img, state.node, Math.round(imageContentWidth() * percent / 100))
}

/**
 * 删掉一张图片（右键菜单的「删除图片」）：整枚 IR 节点摘掉，所在段落空了就一起删；
 * 正文删空时补一个空段（Vditor 的空文档就是一份没有内容的块）。
 *
 * 走 DOM 手术而不是键盘删除：源码标记藏起来之后（见样式），用键盘选整段图片不再直观，
 * 这里给一个确定的一次到位。注意 Vditor 的撤销栈不记这一次 —— 删错了靠再贴一张。
 */
function removeImageFrom(node: HTMLElement): void {
  const block = node.closest<HTMLElement>('[data-block="0"]') ?? node.parentElement
  node.remove()
  if (block && !(block.textContent ?? '').replace(/[\u200b\ufeff]/g, '').trim() && !block.querySelector('img'))
    block.remove()
  const element = editor?.vditor?.ir?.element
  if (element && !element.firstElementChild)
    element.innerHTML = '<p data-block="0"><wbr></p>'
  flush(currentValue())
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

  // 独立 Markdown 编辑窗口也走同一套：root / imageRepo / imageOrigin 都由上层传进来，
  // 没有 store 也不影响（见 MarkdownWindowApp）。没有图片仓库地址时下面的分支如实提示去配。
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
        origin: props.imageOrigin ?? '',
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

/** 整张图 → base64（分块拼字符串的实现在 `@workbench/core` 的 `bytesToBase64`） */
async function toBase64(file: File): Promise<string> {
  try {
    return await blobToBase64(file)
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
      /**
       * 正文不再按 800px 居中：Vditor 默认把可读宽度钉在 800，宽窗口下左右各留几百像素，
       * 内容没多长就换行。给一个大数让它的自动内边距退回最小值，真正的左右留白交给样式
       * （固定 50px、剩下的全给正文，见 `.vditor-ir pre.vditor-reset` 那一段）。
       */
      maxWidth: 100000,
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
     * 大纲（目录结构）在**右侧**。
     *
     * `enable` 保持 false：打开这个动作放在初始化完成之后（`after` 里的 `ensureOutlineOpen`），
     * 与「把元素搬进右栏」是同一步 —— 两处调用方都钉着大纲，界面上不再有开关。
     * 位置只能是 left / right，这里定死 right。
     */
    outline: { enable: false, position: 'right' },
    toolbar: TOOLBAR,
    input: value => schedule(value),
    // 初始化完成那一刻：核一遍只读（编辑器可能是「已经切到只读之后」才建起来的）、
    // 把大纲搬进右栏、钉死那一档顺手打开它；图片尺寸跟着 alt 尾巴落一遍并盯住重排
    after: () => {
      applyReadOnly()
      attachOutline()
      patchOutlineRender()
      bindScrollTarget()
      applyImageSizes()
      observeImageSizes()
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
    // 重渲染之后正文元素若换了，滚动条要跟到新那一个上
    void nextTick(bindScrollTarget)
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
  editor?.destroy()
  editor = null
  // 图片尺寸的观察器与可能还挂着的那次拖动一并收掉
  imageObserver?.disconnect()
  imageObserver = null
  if (imageStyleFrame) {
    window.cancelAnimationFrame(imageStyleFrame)
    imageStyleFrame = 0
  }
  imageResize = null
  window.removeEventListener('pointermove', onImageResizeMove)
  document.body.classList.remove('is-resizing-note-image')
  document.body.style.cursor = ''
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
  /** 光标此刻在表格单元格里吗（右键菜单据此决定要不要摆「表格」那一组） */
  focusInTable: () => focusInTable(),
  /**
   * 表格的行列操作（动作名见 `runTableAction`）。
   *
   * 右键菜单的「表格」一组用它 —— IR 模式没有表格工具条，这组动作走的是
   * Vditor 自己的快捷键通道，与工具带上的按钮是两回事，所以单独开一个口。
   */
  execTable: (
    action: 'row-after' | 'row-before' | 'col-after' | 'col-before' | 'row-delete' | 'col-delete',
  ) => runTableAction(action),
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
      @input="onContentInput"
      @pointerdown.capture="onImagePointerDown"
      @pointermove.capture="onImagePointerHover"
      @dragstart.capture="onImageDragStart"
      @contextmenu.prevent="openMenu"
    />

    <!-- 原生滚动条在样式里藏掉了；这一条不占正文宽度，只在正文右边浮一枚胶囊 -->
    <OverlayScrollbar :target="scrollTarget" />

    <div v-if="uploading" class="upload" role="status">
      <el-icon class="is-loading">
        <Loading />
      </el-icon>
      <span>正在上传{{ uploading > 1 ? ` ${uploading} 张` : '' }}图片…</span>
    </div>
  </div>

  <!-- 菜单挂在 body 上（见组件里的 Teleport）：它是浮层，定位与层叠都不必看这张卡片与别处的脸色 -->
  <!-- 菜单挂在 body 上（见组件里的 Teleport）；大纲钉死那一档不摆「大纲」项，免得把固定栏关成空条 -->
  <!-- 光标在单元格里时右键，菜单多摆一排表格的行列操作（openMenu 记下那一刻的状态） -->
  <NoteContextMenu
    v-if="menu"
    :x="menu.x"
    :y="menu.y"
    :hidden="outlinePinned ? ['outline'] : []"
    :in-table="menu.inTable"
    @act="onMenuAction"
    @close="menu = null"
  />

  <!-- 右击图片的宽高预设（贴指针，与其他右键菜单同一副外壳） -->
  <FloatingMenu
    v-if="imageMenu"
    :x="imageMenu.x"
    :y="imageMenu.y"
    :items="IMAGE_MENU_ITEMS"
    @act="onImageMenuAction"
    @close="imageMenu = null"
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
 * 正文的原生滚动条收掉 —— 滚动位置由 `OverlayScrollbar` 那条 5px 胶囊表示。
 *
 * 两条都写：标准属性在 Chromium / Edge 152 里比 `::-webkit-scrollbar` 优先（见 global.css
 * 同一段注释），所以只写伪元素的话 WebView2 里原生条仍会露出来。
 */
.editor :deep(pre.vditor-reset) {
  scrollbar-width: none;
}

.editor :deep(pre.vditor-reset)::-webkit-scrollbar {
  display: none;
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
 * 正文宽度：左右各留 50px，剩下的全给正文（宽窗口下跟着变宽，不再按 800px 居中）。
 *
 * Vditor 的 `setPadding` 会在 window resize / 切模式时把 `padding` 写成**行内样式**，
 * 所以这里得 `!important` 才压得住（上下仍是它的 10px）；`preview.maxWidth` 给大数
 * 只是让它的自动内边距算出来是默认的最小值，不跟这条打架。
 *
 * 底部那段留白借它自己的 `pre.vditor-reset::after`（高度取 `--editor-bottom`）——
 * 空白长在滚动内容里，滚动条位置与长度都不受影响，滚到底时最后一行下面就是这一段。
 */
.editor :deep(.vditor-ir pre.vditor-reset),
.editor :deep(.vditor-wysiwyg pre.vditor-reset) {
  --editor-bottom: 120px;
  padding-right: 50px !important;
  padding-left: 50px !important;
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

/**
 * 展开态只留源码，预览那层收掉。
 *
 * IR 的代码块在 DOM 里是两层：可编辑源码（`pre.vditor-ir__marker--pre`）与高亮预览
 * （`pre.vditor-ir__preview`，带复制按钮），折叠 / 展开靠 marker 的宽高切换 —— 上面那条
 * 管折叠态（只留预览）。但 Vditor 自己的样式从不隐藏预览：点进代码块（节点挂上
 * `--expand`）后两层一起出现，围栏 + 灰底源码下面还叠着一份高亮块，同一段代码看两遍。
 *
 * 这里补对称的另一边 —— 展开态（正在编辑）只留源码，blur 收起后回到高亮预览。
 * 预览层在输入时仍被 Vditor 同步着（源码一变它就跟着重算高亮），收起那一刻就是新的。
 */
.editor :deep(.vditor-ir__node--expand[data-type='code-block'] > .vditor-ir__preview) {
  display: none;
}

/**
 * 图片右 / 下边缘的拖动热区光标（热区由 `onImagePointerHover` 写在 data 属性上）；
 * 拖动一律等比缩放。拖动中的光标与文本选择归 body 那条全局规则兜（global.css /
 * markdown.html 各一份）。
 */
.editor :deep(img[data-resize-mode='scale']) {
  cursor: ew-resize;
}

/**
 * 图片节点的源码标记（`![alt|尺寸](地址)` 那一串）整段藏起来：IR 默认把它排在图片
 * 旁边，上传图的长地址会一直占一大行。地址在悬停图片时以原生 tooltip 显示
 * （`applyImageSizes` 写 `img.title`），正文里不再排出这一串。
 *
 * **必须连「点击图片选中地址」一起拦掉**（见 onClick）：标记藏了但 DOM 还在，
 * Vditor 的选中是隐形的，对着它按 Backspace 会把地址一个个字删掉。
 */
.editor :deep(.vditor-ir__node[data-type='img'] .vditor-ir__marker) {
  display: none;
}
</style>
