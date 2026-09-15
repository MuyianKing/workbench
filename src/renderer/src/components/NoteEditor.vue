<script setup lang="ts">
/**
 * 笔记正文编辑器（Vditor，即时渲染模式）。
 *
 * 用 Vditor 而不是自己搭 textarea：markdown 的表格、代码块、列表续行这些
 * 「写起来才知道难」的地方它都处理好了，正文也仍然是 markdown 原文（`getValue` 拿到的就是原文），
 * 所以笔记数据不依赖任何编辑器 —— 换掉它不影响已经写下的东西。
 *
 * 三件必须自己管的事：
 *   1. **静态资源不联网**。Vditor 默认从 unpkg 拉图标、语言包、内容主题、表情与代码高亮，
 *      而这个应用默认不联网，所以 `cdn` 指向随包带的那一份（见下面的 VDITOR_CDN）。
 *   2. **写盘归我们**。关掉 Vditor 自带的 localStorage 缓存，输入防抖后把原文交给上层，
 *      由 store → 适配层 → note-data.json 落盘。
 *   3. **链接不能把界面导航走**。界面是个 WebView，点正文里的 `<a>` 会把自己替换掉，
 *      所以在这里接管点击、交给系统浏览器（与 MarkdownView 同一条出口）。
 *
 * 组件只认「当前这一篇」：换一篇走 `setValue` 而不是重建实例（重建会闪一下白、也会丢撤销栈）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import type { NoteNode } from '@shared/note'

const props = defineProps<{
  note: NoteNode
  /** 应用当前的明暗（编辑器的配色要跟着走，它与应用的主题是两套） */
  theme: 'light' | 'dark'
}>()

const emit = defineEmits<{
  /**
   * 正文变了（已防抖）。
   *
   * 带上 id 而不是让上层去看「当前打开的是哪一篇」：换篇时这里会先把上一篇没写完的改动冲出去，
   * 而那一刻上层的选中项已经是新的一篇了。
   */
  change: [payload: { id: string; content: string }]
}>()

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

/** 工具栏：只留「写东西用得上、且不需要额外资源」的那些 */
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
  'fullscreen'
]

/** 输入防抖：一边打字一边整份落盘太费，停顿一下再写 */
const SAVE_DELAY = 600

const host = ref<HTMLDivElement | null>(null)
let editor: Vditor | null = null
let timer: number | null = null
/** 编辑器里这份正文属于哪一篇 */
let editingId = ''
/** 还没交出去的那份正文；null 表示没有待写入的改动 */
let pending: string | null = null
/** 已经交出去的那份：用来判断这次 input 是不是真的改了东西（换一篇时的 setValue 也会触发 input） */
let saved = ''

const isDark = (): boolean => props.theme === 'dark'

/** 编辑器现在的正文；还没初始化完（Vditor 的初始化是异步的）时返回 undefined */
function currentValue(): string | undefined {
  if (!editor) return undefined
  try {
    return editor.getValue()
  } catch {
    return undefined
  }
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
  if (content === undefined || content === null || content === saved) return

  saved = content
  // **必须带上它是哪一篇**：换篇时这份改动属于上一篇，而 `props.note` 那时已经是新的了，
  // 上层按 props 取 id 就会把上一篇的正文写进刚点开的那一篇（踩过，静默改错内容）
  emit('change', { id: editingId, content })
}

function schedule(content: string): void {
  if (content === saved) return
  pending = content
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => flush(), SAVE_DELAY)
}

/** 换一篇：先把上一篇没写完的改动交出去，再整份换成新的 */
function load(node: NoteNode): void {
  flush(currentValue())
  editingId = node.id
  saved = node.content ?? ''
  pending = null
  editor?.setValue(saved, true)
}

/**
 * 正文里的链接交给系统浏览器。
 *
 * 无论打不打得开都要 `preventDefault`：Vditor 给正文里的链接写了 `target="_blank"`，
 * 在 WebView 里那是弹一个（WebView2 自己的）新窗口，界面就此跑偏。
 */
async function onClick(event: MouseEvent): Promise<void> {
  const anchor = (event.target as HTMLElement | null)?.closest('a')
  if (!anchor) return

  event.preventDefault()
  const href = anchor.getAttribute('href') ?? ''
  if (!/^(https?:|mailto:)/i.test(href)) return

  const result = await window.workbench.openExternal(href)
  if (!result.ok) console.warn('[workbench] 打开链接失败', result.error)
}

onMounted(() => {
  if (!host.value) return

  editingId = props.note.id
  saved = props.note.content ?? ''
  editor = new Vditor(host.value, {
    cdn: VDITOR_CDN,
    mode: 'ir',
    value: saved,
    height: '100%',
    minHeight: 240,
    icon: 'ant',
    lang: 'zh_CN',
    placeholder: '写点什么…支持 markdown：标题、列表、表格、`代码`、链接',
    // 缓存与落盘都归我们：Vditor 自带的那份存在 localStorage 里，会与 note-data.json 打架
    cache: { enable: false },
    counter: { enable: false },
    theme: isDark() ? 'dark' : 'classic',
    preview: {
      delay: 300,
      // 正文区（内容主题）与代码块高亮各有一套配色，明暗切换时一起换
      theme: { current: isDark() ? 'dark' : 'light' },
      hljs: { enable: true, lineNumber: false, style: isDark() ? 'github-dark' : 'github' }
    },
    toolbar: TOOLBAR,
    input: (value) => schedule(value)
  })
})

watch(
  () => props.note.id,
  () => load(props.note)
)

watch(
  () => props.theme,
  (theme) => {
    // 编辑器配色 / 内容主题 / 代码高亮是三处，setTheme 一次换掉
    const dark = theme === 'dark'
    editor?.setTheme(dark ? 'dark' : 'classic', dark ? 'dark' : 'light', dark ? 'github-dark' : 'github')
  }
)

onBeforeUnmount(() => {
  // 卸载前把没写完的那一段交出去：防抖窗口里切走不该丢字（同样是现取，道理见 flush）
  flush(currentValue())
  editor?.destroy()
  editor = null
})
</script>

<template>
  <div ref="host" class="editor" @click="onClick" />
</template>

<style scoped>
/*
 * Vditor 把 `.vditor` 这个类加在**宿主元素**上（就是我们这个 .editor），所以下面这几条写在自己身上、
 * 不用 :deep()。它自带的边框与圆角在外层卡片（.panel）里就是多画了一层，底色也交给卡片给。
 */
.editor {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.editor :deep(.vditor-toolbar) {
  padding-left: 0;
  background: transparent;
}

.editor :deep(.vditor-content) {
  background: transparent;
}
</style>
