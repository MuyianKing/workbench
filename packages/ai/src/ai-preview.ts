/**
 * AI 对话里的站内链接 → 右侧预览栏要打开的那个文件。
 *
 * 回答里 `[文字](../test.md)` 这类链接的地址是相对**会话工作目录**写的（Pi 就在那儿干活），
 * 预览前得对到磁盘上的绝对路径；顺带按扩展名定预览的画法。外部地址（http(s) / mailto）
 * 在 MarkdownView 就交给系统浏览器了，到不了这里；解析出的路径**不限于工作目录之内** ——
 * `../` 出去是这类链接的本意，文件读不读得到由读文件那一步说。
 *
 * markdown-it 交给界面的地址带百分号转义（`测试.md` → `%E6%B5%8B%E8%AF%95.md`），
 * 这里统一解回来；`javascript:` 这类危险地址 markdown-it 自己已经剥成空串。
 */

/**
 * 预览的画法：markdown 按正文渲染，html 走沙箱 iframe，docx / pptx 交给渲染库
 * （二进制经 base64 进来），image 显示原图，其余文本走等宽原文。
 */
export type AiPreviewKind = 'markdown' | 'text' | 'image' | 'html' | 'docx' | 'pptx'

export interface AiPreviewTarget {
  /** 绝对路径（分隔符统一成反斜杠 —— 仅 Windows） */
  path: string
  kind: AiPreviewKind
}

export type AiPreviewResolution =
  | ({ ok: true } & AiPreviewTarget)
  | { ok: false; reason: string }

/** 预览栏的一屏状态（AiView 编排取数，AiPreviewPane 只管画；多份并存 = 多个 Tab） */
export interface AiPreviewState {
  /** 这次打开的键：同一文件一个 Tab，过期结果（已关掉）靠它丢弃 */
  key: string
  /** 当初点的那条链接：再次点开同一个文件时按它重读（刷新内容） */
  href: string
  /** Tab 与标题上显示的文件名 */
  name: string
  kind: AiPreviewKind
  loading: boolean
  error: string
  /** markdown / html / text 的正文（image 与二进制画法时不给） */
  text: string
  /** docx / pptx 的文件内容（base64，见 decodeBase64ToBuffer） */
  binary: string
  /** 图片画法的 asset URL */
  imageUrl: string
  /** 正文里相对图片的替换表（原文里的 src → 已授权的 asset URL；markdown 与 html 共用） */
  imageSrcs: Record<string, string>
}

/** 超过这么多字符的文本文件不进预览（几兆的原文能把渲染卡住），就地报错 */
export const AI_PREVIEW_MAX_CHARS = 2_000_000

/**
 * 二进制（base64 回传）文件的大小上限，按回传串算 —— 约合 24MB 的原文件。
 * 大过它的 docx / pptx 多半不是给人读的，渲染库解包也吃力。
 */
export const AI_PREVIEW_MAX_BINARY_CHARS = 32_000_000

/** 盘符（`C:\` / `C:/`）与 UNC（`\\主机\共享`）是绝对路径，不是协议头 —— 判定要在协议头之前 */
const WIN_DRIVE = /^[a-z]:[\\/]/i
const WIN_UNC = /^\\\\|^\/\//
/** 带协议头的地址（https: / ftp: / …）不在这里打开；盘符只有一个字母，已被上一条先行分走 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

const MARKDOWN_EXT = new Set(['md', 'markdown'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tif', 'tiff'])
const HTML_EXT = new Set(['html', 'htm'])
const DOCX_EXT = new Set(['docx'])
const PPTX_EXT = new Set(['pptx'])
/** 渲染库只认 OOXML（zip 容器），老二进制格式解不了；Excel 这轮不做预览 */
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'xls'])
const LEGACY_WORD_EXT = new Set(['doc'])
const LEGACY_SLIDES_EXT = new Set(['ppt'])

function extOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase()
}

function kindOf(path: string): AiPreviewKind {
  const ext = extOf(path)
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (HTML_EXT.has(ext)) return 'html'
  if (DOCX_EXT.has(ext)) return 'docx'
  if (PPTX_EXT.has(ext)) return 'pptx'
  return 'text'
}

/**
 * 目录 + 相对地址 → 绝对路径：收敛 `.` / `..`，分隔符统一成反斜杠。
 * 锚点是盘符或 UNC 的两段（`\\主机\共享`）—— 弹出锚点就停在锚点上，
 * 没有锚点（理论到不了，工作目录总是绝对路径）才真往外弹 `..`。
 */
function joinPath(dir: string, href: string): string {
  const normalized = dir.replace(/\//g, '\\')
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(normalized)
  const drive = /^[a-z]:/i.exec(normalized)
  const head = unc?.[0] ?? drive?.[0] ?? ''

  const parts = normalized
    .slice(head.length)
    .split(/[\\/]+/)
    .concat(href.split(/[\\/]+/))

  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length) out.pop()
      else if (!head) out.push('..')
      continue
    }
    out.push(part)
  }
  return (head ? `${head}\\` : '') + out.join('\\')
}

/**
 * 链接地址 + 会话工作目录 → 预览目标。解不出（空串、锚点、带协议头）给 `ok: false`
 * 与一句给人看的理由，预览栏照实显示。
 */
export function resolveAiPreview(href: string, dir: string): AiPreviewResolution {
  let decoded = href.trim()
  if (!decoded) return { ok: false, reason: '链接是空的' }
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // 百分号不是转义（原文写了「50%风险.md」）：按原文处理
  }
  if (decoded.startsWith('#')) return { ok: false, reason: '页内锚点不是文件' }
  if (WIN_DRIVE.test(decoded) || WIN_UNC.test(decoded)) {
    const path = decoded.replace(/\//g, '\\')
    return settle(path)
  }
  if (SCHEME.test(decoded)) return { ok: false, reason: '外部链接不在这里打开' }
  if (!WIN_DRIVE.test(dir) && !WIN_UNC.test(dir)) {
    return { ok: false, reason: '这段对话还没有工作目录' }
  }
  return settle(joinPath(dir, decoded))
}

/** 路径到手后的最后一道：老格式与 Excel 明确说「不支持」，别让它们掉进文本通道读出乱码 */
function settle(path: string): AiPreviewResolution {
  const ext = extOf(path)
  if (SHEET_EXT.has(ext)) return { ok: false, reason: 'Excel 文件暂不支持预览' }
  if (LEGACY_WORD_EXT.has(ext)) return { ok: false, reason: '旧版 .doc 暂不支持预览，另存为 .docx 再看' }
  if (LEGACY_SLIDES_EXT.has(ext)) return { ok: false, reason: '旧版 .ppt 暂不支持预览，另存为 .pptx 再看' }
  return { ok: true, path, kind: kindOf(path) }
}

/**
 * base64 → 二进制：DOCX / PPTX 的渲染库吃 ArrayBuffer，二进制经 `fs_read_base64`
 * 过 IPC 后在这里解回去。坏串解不出（不太可能，编解码都在自己手里）返回 null。
 */
export function decodeBase64ToBuffer(encoded: string): ArrayBuffer | null {
  try {
    const raw = atob(encoded)
    const bytes = new Uint8Array(raw.length)
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
    return bytes.buffer
  } catch {
    return null
  }
}

/** <img> 的 src：`<img src="…">`，单双引号都认；srcset / CSS 里的 url() 不碰 */
const IMG_SRC_RE = /<img\b[^>]*?\ssrc=(["'])([^"']+)\1/gi

/**
 * HTML 原文里 <img> 的地址（按出现顺序，重复也保留）。预览栏按它把**相对**图片
 * 挨个授权 —— 外链、data URL 不是这里的活，调用方解析时自然筛掉。
 */
export function htmlImageSrcs(html: string): string[] {
  if (typeof html !== 'string' || !html) return []
  const srcs: string[] = []
  for (const match of html.matchAll(IMG_SRC_RE)) srcs.push(match[2])
  return srcs
}

/**
 * 把 HTML 原文里的图片地址按替换表换掉（键是原文里的 src，值通常是已授权的 asset URL）。
 * 表里没有的地址原样保留 —— 外链图片照旧由 webview 自己取。
 */
export function rewriteHtmlImages(html: string, replacements: Record<string, string>): string {
  if (typeof html !== 'string' || !html) return html
  return html.replace(IMG_SRC_RE, (whole, quote: string, src: string) => {
    const replacement = replacements[src]
    return replacement ? `<img src=${quote}${replacement}${quote}` : whole
  })
}
