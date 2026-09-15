/**
 * 把 Vditor 的静态资源同步到渲染层的 `public/vditor/`。
 *
 * 为什么需要这一步：Vditor 的编辑器本体是打包进 JS 的，但图标（工具栏那一套 SVG sprite）、
 * 语言包、内容主题、表情图片、代码高亮这几样是**运行时**按 `options.cdn` 拼出地址去取的，
 * 默认指向 `https://unpkg.com/vditor@<版本>`。这个应用默认不联网（见 AGENTS.md 第 1 节的出口约定），
 * 所以把用得着的那一小部分随包带一份，`cdn` 指向本地（见 NoteEditor.vue 的 VDITOR_CDN）。
 *
 * 带的是**子集**不是整个 dist：整包 20MB，其中 katex / mermaid / echarts / highlight.js 全语言
 * 那几块占了绝大部分，而它们只在启用对应的预览功能时才会被取用 —— 这个笔记页不启用。
 *
 * 落点是 `public/`（不进版本库，见 .gitignore）：开发态由 vite 直接提供，构建态被复制进产物根目录。
 * 内容随 Vditor 的版本走，`.version` 记着上一次复制的是哪一版，版本没变就直接跳过。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'node_modules', 'vditor', 'dist')
/** 与 NoteEditor.vue 里的 `VDITOR_CDN` 是一对：那边的基址是 `public/` 下的 `vditor` */
const TARGET = join(root, 'src', 'renderer', 'public', 'vditor')

/**
 * 要带走的文件。路径都相对 `vditor/dist`，因为 Vditor 拼的地址就是 `${cdn}/dist/<这里写的>`。
 *
 * 没带的那些（katex / mermaid / echarts / mathjax / method.min.js）只在启用对应功能
 * 或「导出为 HTML」时才会被取 —— 取不到就是那个功能不生效（本地 404），不会退回联网，
 * 因为资源地址只有 `cdn` 一个来源。
 *
 * 代码高亮的两套配色各带一份：明暗切换时 Vditor 会按 `preview.hljs.style` 换 <link>，
 * 缺了暗色那份，暗色主题下的代码块会是浅色底。
 */
const FILES = [
  // markdown 引擎本体：编辑器与预览都要它，缺了整个编辑器起不来（不是可选功能）
  'js/lute/lute.min.js',
  'js/icons/ant.js',
  'js/i18n/zh_CN.js',
  'js/highlight.js/highlight.min.js',
  'js/highlight.js/third-languages.js',
  'js/highlight.js/styles/github.min.css',
  'js/highlight.js/styles/github-dark.min.css'
]

/** 整目录带走的（内容主题是四份 css，表情是一组 png/gif） */
const DIRS = ['css/content-theme', 'images/emoji']

function installedVersion() {
  return JSON.parse(readFileSync(join(root, 'node_modules', 'vditor', 'package.json'), 'utf8')).version
}

export function syncVditorAssets() {
  if (!existsSync(SOURCE)) {
    throw new Error('没有找到 node_modules/vditor，先跑一次 npm install')
  }

  const version = installedVersion()
  const marker = join(TARGET, '.version')
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === version) return

  // 先整个换掉：升级 / 降级时不会留下旧版本那些其实已经用不到的文件
  rmSync(TARGET, { recursive: true, force: true })

  for (const file of FILES) {
    const dest = join(TARGET, 'dist', file)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(join(SOURCE, file), dest)
  }
  for (const dir of DIRS) {
    cpSync(join(SOURCE, dir), join(TARGET, 'dist', dir), { recursive: true })
  }

  writeFileSync(marker, `${version}\n`)
}

/**
 * 挂到 vite 上的插件。
 *
 * 用 `configResolved` 而不是 `buildStart`：public 目录是在构建流程里被复制的，
 * 得赶在那之前把文件放好；`configResolved` 早于两者（dev 与 build 都会走到）。
 */
export function vditorAssets() {
  return {
    name: 'workbench:vditor-assets',
    configResolved() {
      syncVditorAssets()
    }
  }
}
