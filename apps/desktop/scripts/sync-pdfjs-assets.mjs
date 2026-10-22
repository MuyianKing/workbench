/**
 * 把 pdf.js（pdfjs-dist）运行时按需取的那几样静态资源同步到渲染层的 `public/pdfjs/`。
 *
 * 为什么需要这一步：pdf.js 的解析本体是打包进 JS 的，但**编解码数据**它是在运行时按
 * 传入的 `cMapUrl` / `standardFontDataUrl` / `wasmUrl` / `iccUrl` 拼出地址去取的 ——
 * 这几个目录就在包里、不随 JS 走。这个应用默认不联网（见 AGENTS.md 第 1 节的出口约定），
 * 所以随包带一份，那四个基址指向本地（见 PdfPreview.vue）。
 *
 * 缺哪一样各是什么后果：`cmaps` 缺了，中文 / 日文这类用预定义 CMap 的 PDF 正文会空掉；
 * `standard_fonts` 缺了，没内嵌字体的那份用 14 款标准字体的正文会退回兜底字形；
 * `wasm` 是 JBIG2 / JPEG2000 图像与色彩管理的解码器（扫描件常见），缺了那几页只剩空白。
 *
 * 落点是 `public/`（不进版本库，见 .gitignore）：开发态由 vite 直接提供，构建态被复制进产物根目录。
 * 内容随 pdfjs-dist 的版本走，`.version` 记着上一次复制的是哪一版，版本没变就直接跳过。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'node_modules', 'pdfjs-dist')
/** 与 PdfPreview.vue 里那几个基址是一对：那边的基址是 `public/` 下的 `pdfjs` */
const TARGET = join(root, 'src', 'renderer', 'public', 'pdfjs')

/** 整目录带走（pdf.js 按文件名取里面的条目，不许改名） */
const DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

/**
 * 不带的那几份（相对 `wasm/`，合计约 1.1MB）：
 *
 *  - `*_nowasm_fallback.js`（jbig2 / openjpeg）是「WebAssembly 不可用」时的退路，
 *    WebView2 永远有 wasm，这两份取不到也用不上；
 *  - `quickjs-eval.js` / `.wasm` 只服务 `pdf.sandbox`（在 PDF 内嵌 JS 里跑沙箱），
 *    这个应用只渲染不执行，连 `pdf.sandbox` 都没 import。
 *
 * 别顺手把 LICENSE 那几份也删了 —— 它们是随包分发 PDF 解码器要带的。
 */
const EXCLUDE = [
  'jbig2_nowasm_fallback.js',
  'openjpeg_nowasm_fallback.js',
  'quickjs-eval.js',
  'quickjs-eval.wasm',
]

/**
 * 排除清单的版本号：**这份清单变了就要 +1**，否则 `.version` 对得上、本地那份已经
 * 同步过的目录不会重来一遍，新加的排除项就落不到盘上。
 */
const REVISION = '2'

function installedVersion() {
  return JSON.parse(readFileSync(join(SOURCE, 'package.json'), 'utf8')).version
}

export function syncPdfjsAssets() {
  if (!existsSync(SOURCE)) {
    throw new Error('没有找到 node_modules/pdfjs-dist，先跑一次 pnpm install')
  }

  const version = `${installedVersion()}+r${REVISION}`
  const marker = join(TARGET, '.version')
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === version)
    return

  // 先整个换掉：升级 / 降级时不会留下旧版本那些其实已经用不到的文件
  rmSync(TARGET, { recursive: true, force: true })

  for (const dir of DIRS)
    cpSync(join(SOURCE, dir), join(TARGET, dir), { recursive: true })
  for (const file of EXCLUDE)
    rmSync(join(TARGET, 'wasm', file), { force: true })

  mkdirSync(TARGET, { recursive: true })
  writeFileSync(marker, `${version}\n`)
}

/**
 * 挂到 vite 上的插件（与 vditorAssets 同一套：见 sync-vditor-assets.mjs）。
 * 用 `configResolved` 而不是 `buildStart`：public 目录是在构建流程里被复制的，
 * 得赶在那之前把文件放好；`configResolved` 早于两者（dev 与 build 都会走到）。
 */
export function pdfjsAssets() {
  return {
    name: 'workbench:pdfjs-assets',
    configResolved() {
      syncPdfjsAssets()
    },
  }
}
