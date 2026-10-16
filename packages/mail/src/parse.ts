// ! 收信侧的 MIME 解析与阅读视图。Rust 只把原始报文（base64）带回来，解析全在这里
// ! —— postal-mime 是纯 JS、无运行时外取资源的库，中文各代字符集经 TextDecoder 天然支持。
// !
// ! **渲染的硬边界**：`htmlBody` 产出的文档交给 sandbox 的 iframe（禁脚本 / 同源 /
// ! 表单 / 弹窗，与 AI 预览栏同一套，见 AiPreviewHtml.vue），注入 CSP 放行外链图片
// ! （营销信的主视觉跟着信里写的地址加载）但掐死其余一切外链资源 —— 脚本、字体、
// ! 音视频、iframe 都没有。内联图（cid:）是邮件自带的内容，转成 data URL。
// !
// ! **HTML 附件是这条边上唯一开了内联脚本的**（`attachmentHtml`）：那是一整页别人做的东西，
// ! 脚本不跑就只剩死版面。外链脚本照旧一个不放行，承载它的 iframe 也不给同源（不给
// ! 宿主能力），细则与代价见 docs/modules/mail.md。

import PostalMime from 'postal-mime'
import { base64ToBytes, bytesToBase64 } from './base64'
import { decodeEncodedWords } from './rfc2047'

export interface ParsedAttachment {
  /** 展示名；报文里没写的给「未命名」 */
  name: string
  contentType: string
  contentId: string
  base64: string
}

export interface ParsedMail {
  /** 主题（postal-mime 已解编码词）；报文里没有就空串 */
  subject: string
  /** 发件人（名字已解码）；组地址这类拆不出单个邮箱的是 null */
  from: { name: string, address: string } | null
  text: string
  html: string
  attachments: ParsedAttachment[]
  /** 信体内联图（cid: 引用），按 contentId 索引出 data URL 用 */
  inline: ParsedAttachment[]
}

/**
 * postal-mime 的 content 有三种形态（见它的 d.ts）：Uint8Array / ArrayBuffer / 字符串。
 *  归一成字节数组再编码 —— 直接把 ArrayBuffer 喂给 bytesToBase64 会静默产出空串
 *  （它没有 length，循环一轮都不跑）。
 */
function normalizeBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string')
    return new TextEncoder().encode(content)
  if (content instanceof Uint8Array)
    return content
  return new Uint8Array(content)
}

/**
 * 头部带了 RFC 2231 的扩展参数（`filename*` / `name*`）时，先把它旁边那份同名纯参数摘掉，
 * 剩下的交给 postal-mime 自己的解码器（charset、百分号编码、续行 `filename*0*` 都由它解，
 * 我们不重写一份）。
 *
 * 为什么要在递进去之前动手：postal-mime 4.0.4 明确按「同名纯参数优先」读
 * （见它 decodeParameterValueContinuations 里那条守卫，changelog 4.0.3 的原话是
 * 「keep a continuation from overriding the plain parameter of the same name」）。
 * 于是我们自己发出去的 `filename="__ DOCX __.docx"; filename*=utf-8''%E6%B5%8B…`
 * 读回来只剩那串下划线 —— 中文名全成了 `__`。两份都在时业界（浏览器下载、Gmail、
 * 雷鸟）一律认扩展那份，这里按同一口径归一；**已经只剩兜底那份的报文救不回来**
 * （信息在那台改写它的服务器上就没了），那种只能照实显示。
 *
 * 只动 `Content-Disposition` / `Content-Type` 两行头（含折叠续行），报文体一个字节不碰。
 */
export function preferExtendedFilenames(raw: string): string {
  return raw.replace(
    /^(content-(?:disposition|type)[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/gim,
    block => rewriteFilenameHeader(block),
  )
}

/** 头里的参数拆成一段一段（引号串里的 `;` 不算分隔符），保留原始片段好原样拼回去。 */
function splitHeaderParams(rest: string): string[] {
  const segments: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index]
    if (char === '\\' && quoted) {
      current += char + (rest[index + 1] ?? '')
      index += 1
      continue
    }
    if (char === '"') {
      quoted = !quoted
    }
    else if (char === ';' && !quoted) {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/** 一段参数的键（` filename*=` → `filename*`；拿不到键给 null）。 */
function paramKey(segment: string): string | null {
  const match = segment.match(/^\s*([!#$%&'*+.^\w`|~-]+)\s*=/)
  return match ? match[1] : null
}

function rewriteFilenameHeader(block: string): string {
  const joined = block.replace(/\r?\n[ \t]+/g, ' ')
  const colon = joined.indexOf(':')
  if (colon < 0)
    return block
  const segments = splitHeaderParams(joined.slice(colon + 1))
  // 有扩展参数的键（filename / name，含续行的 `*0*` 写法）
  const extended = new Set<string>()
  for (const segment of segments.slice(1)) {
    const match = paramKey(segment)?.match(/^(filename|name)\*(\d+)?\*?$/i)
    if (match)
      extended.add(match[1].toLowerCase())
  }
  if (extended.size === 0)
    return block
  const kept = segments.filter((segment, index) =>
    index === 0 || !extended.has((paramKey(segment) ?? '').toLowerCase()))
  if (kept.length === segments.length)
    return block
  return `${joined.slice(0, colon + 1)}${kept.join(';')}`
}

/**
 * 字节 → 交给 postal-mime 的字节。报文里出现扩展附件名的那几个字节时才走一遍文本改写，
 * 其余原样把字节递过去 —— 24 MB 的正文不该为一件偶尔才有的事整份进出一次字符串。
 */
function favorExtendedFilenames(bytes: Uint8Array): Uint8Array {
  if (!hasAscii(bytes, 'filename*') && !hasAscii(bytes, 'name*'))
    return bytes
  const raw = latin1FromBytes(bytes)
  const next = preferExtendedFilenames(raw)
  return next === raw ? bytes : bytesFromLatin1(next)
}

/** 字节里有没有这一段 ASCII（快路判断，逐字节比、不建字符串） */
function hasAscii(bytes: Uint8Array, needle: string): boolean {
  const last = bytes.length - needle.length
  for (let index = 0; index <= last; index += 1) {
    let offset = 0
    while (offset < needle.length && bytes[index + offset] === needle.charCodeAt(offset))
      offset += 1
    if (offset === needle.length)
      return true
  }
  return false
}

/** 字节 → 每字节一个码元的字符串（改写只落在头部的 ASCII 上，正文原样过）。 */
function latin1FromBytes(bytes: Uint8Array): string {
  let text = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk)
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  return text
}

function bytesFromLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1)
    bytes[index] = text.charCodeAt(index) & 0xFF
  return bytes
}

/** 解一份原始报文（Rust 回传的 base64）。解不开抛错，由适配层给人话。 */
export async function parseMessage(rawBase64: string): Promise<ParsedMail> {
  const bytes = base64ToBytes(rawBase64)
  if (!bytes)
    throw new Error('报文不是合法的 base64')
  const parsed = await new PostalMime().parse(favorExtendedFilenames(bytes))
  const toPart = (part: {
    filename?: string | null
    mimeType?: string
    contentId?: string
    content: ArrayBuffer | Uint8Array | string
  }): ParsedAttachment => ({
    name: part.filename?.trim() || '未命名',
    contentType: part.mimeType || 'application/octet-stream',
    contentId: part.contentId?.replace(/^<|>$/g, '') || '',
    base64: bytesToBase64(normalizeBytes(part.content)),
  })
  const all = (parsed.attachments ?? []).map(toPart)
  // postal-mime 的 Address 有组（group）形态 —— 那种拆不出单个邮箱，置 null
  const sender
    = parsed.from && !parsed.from.group
      ? { name: parsed.from.name || '', address: parsed.from.address || '' }
      : null
  return {
    subject: parsed.subject?.trim() || '',
    from: sender,
    text: parsed.text || '',
    html: parsed.html || '',
    attachments: all.filter(part => part.contentId === ''),
    inline: all.filter(part => part.contentId !== ''),
  }
}

/**
 * 附件是不是图：只看 contentType 的 `image/` 前缀。信里没写类型的（给的是
 *  `application/octet-stream`）当普通文件 —— 宁可不预览，也不把二进制塞进 <img>。
 */
export function isImageAttachment(part: ParsedAttachment): boolean {
  return /^image\//i.test(part.contentType)
}

/** 附件 → data URL。图片预览直接用手里的 base64，不落盘、不经过文件系统。 */
export function attachmentDataUrl(part: ParsedAttachment): string {
  return `data:${part.contentType};base64,${part.base64}`
}

/**
 * 附件在应用里怎么打开：图给查看器，md / html / docx / pptx / pdf 进预览弹层，其余只能另存
 * （压缩包、老式 .doc / .ppt 这些应用里画不了；pdf 由 pdf.js 在页面里画，见 PdfPreview.vue；
 * html 与邮件正文同一道边界 —— 只进 sandbox 的 iframe，见 attachmentHtml）。
 * 判据是**扩展名与 contentType 两条** —— 服务器转手时这两样都可能被改写或丢掉一样。
 */
export type MailAttachmentKind = 'image' | 'markdown' | 'html' | 'docx' | 'pptx' | 'pdf' | 'file'

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const PDF_TYPE = 'application/pdf'
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const MARKDOWN_TYPES = new Set(['text/markdown', 'text/x-markdown'])
const HTML_EXTS = new Set(['html', 'htm'])
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

/** 文件名 → 小写扩展名（没有点、或以点开头的一律当没扩展名）。 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function attachmentKind(part: ParsedAttachment): MailAttachmentKind {
  if (isImageAttachment(part))
    return 'image'
  const type = part.contentType.split(';')[0].trim().toLowerCase()
  const extension = extensionOf(part.name)
  if (extension === 'docx' || type === DOCX_TYPE)
    return 'docx'
  if (extension === 'pptx' || type === PPTX_TYPE)
    return 'pptx'
  if (extension === 'pdf' || type === PDF_TYPE)
    return 'pdf'
  if (MARKDOWN_EXTS.has(extension) || MARKDOWN_TYPES.has(type))
    return 'markdown'
  if (HTML_EXTS.has(extension) || HTML_TYPES.has(type))
    return 'html'
  return 'file'
}

/**
 * 附件片上那枚图标 / 角标的颜色。
 *
 * **这是应用里唯一按文件类型着色的一处** —— 「界面主体灰度、彩色只表达运行状态与项目标识色」
 * 那条规矩（见 AGENTS.md 第 4 节）在这里开了第二个口子（第一个是禅道 Bug 的严重程度 / 优先级）：
 * 附件那一行的名字与大小都是灰的，只有左首这枚小图标带色，几种文件一眼分得开。
 * **别把这套色阶扩到别处去**（也不要用它给整片附件上色）。
 *
 * 取的是各家品牌那一档色相（红 = PDF、蓝 = Word、橙 = 幻灯片、紫 = Markdown、青 = 网页），
 * 明暗两套主题下都按 500 档上下取：低饱和度的底 + 本色图标两边都读得清。
 */
export function attachmentTint(kind: MailAttachmentKind): string {
  switch (kind) {
    case 'pdf':
      return '#e5484d'
    case 'docx':
      return '#3b82f6'
    case 'pptx':
      return '#f97316'
    case 'markdown':
      return '#8b5cf6'
    case 'html':
      return '#0891b2'
    case 'image':
      return '#10b981'
    default:
      return '#8a8a8a'
  }
}

/** 附件内容当文本读（markdown 预览用）：base64 → 字节 → UTF-8 文本。解不开给空串。 */
export function attachmentText(part: ParsedAttachment): string {
  const bytes = base64ToBytes(part.base64)
  return bytes ? new TextDecoder().decode(bytes) : ''
}

/** 找字符集声明只读头部这一段（正好罩得住 `<head>` 里那一行 meta） */
const CHARSET_PROBE_BYTES = 1024

/**
 * HTML 附件的字节 → 文本：先认文档头部声明的字符集（国内工具的产物不少是 GBK / GB2312，
 * 照 UTF-8 解出来整页乱码），声明的那个本机不认、或压根没声明就按 UTF-8 来。
 */
function decodeHtmlBytes(part: ParsedAttachment): string {
  const bytes = base64ToBytes(part.base64)
  if (!bytes)
    return ''
  const declared = latin1FromBytes(bytes.subarray(0, CHARSET_PROBE_BYTES))
    .match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]
    ?.toLowerCase() ?? ''
  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    try {
      return new TextDecoder(declared).decode(bytes)
    }
    catch {
      // 认不出的字符集名：落回 UTF-8，宁可看到乱码也不给一页空白
    }
  }
  return new TextDecoder().decode(bytes)
}

/**
 * 附件里的 HTML 当预览文档读（`text/html` 那一档）：base64 → 文本 → 与正文同一套沙箱准备
 * （注入 CSP 与 no-referrer、链接统一 target="_top"），**CSP 换成放行内联脚本的那一份**
 * （见 ATTACHMENT_CSP）—— 附件是一整页别人做的东西，脚本不跑就只剩一张死版面。
 *
 * 两道闸一起才算数：这份 CSP + 承载它的 iframe 的 `allow-scripts`（见 MailAttachmentDialog）
 * + 应用自己那份 CSP 的 `script-src`（见 docs/modules/mail.md）。与正文只有一处差别：
 * 附件的 HTML 是一份独立文档，不做 cid 替换 —— 信体的内联图是正文那一份的事。
 */
export function attachmentHtml(part: ParsedAttachment): string {
  return withSandboxHead(linksToTop(decodeHtmlBytes(part)), ATTACHMENT_CSP)
}

/**
 * 附件片左首那块小方块里的**扩展名角标**：扩展名大写（最多 4 个字符），认不出扩展名给 FILE。
 *
 * 认得出的那五类（pdf / docx / pptx / markdown / html）**不用它** —— 那几档给的是按类型着色的图标
 * （见 attachmentTint）；它只服务认不出的那一档（zip / rar / 老式 .doc），
 * 那儿扩展名才是唯一的信息。
 */
export function attachmentBadge(part: ParsedAttachment): string {
  const extension = extensionOf(part.name)
  return extension ? extension.slice(0, 4).toUpperCase() : 'FILE'
}

/** contentId → data URL 的替换表。 */
function cidMap(inline: ParsedAttachment[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of inline) {
    if (part.contentId)
      map.set(part.contentId.toLowerCase(), `data:${part.contentType};base64,${part.base64}`)
  }
  return map
}

/**
 * 沙箱文档的 CSP（**正文那一份**）：外链图片放行（跟着信里写的地址加载），其余外链资源
 * 全掐死 —— 脚本、字体、音视频、iframe 都没有网络可去（`default-src 'none'` 同时兜住
 * `connect-src`：连 IPC 那条 http://ipc.localhost 也出不去）。
 */
const SANDBOX_CSP = 'default-src \'none\'; img-src * data:; style-src \'unsafe-inline\'; media-src data:'

/**
 * **HTML 附件那一档**的 CSP：在正文那份之上放行内联脚本与 data: 字体 —— 自带的网页
 * 基本是单文件，样式与脚本都写在文件里。**外链脚本仍然一个都不放行**（`script-src` 里
 * 没有 http(s) / `'self'`）：附件跑自己带的代码可以，去 CDN 取代码不行。
 *
 * 这一份**不是充分条件**：应用自己的 CSP（`tauri.conf.json`，按 meta 注入、会被子框架
 * 继承）里的 `script-src` 也得放行内联脚本，两份都允许才跑得起来（见 docs/modules/mail.md）。
 * `'unsafe-eval'` 刻意没给：要它得连应用那份一起加，先看看附件是不是真的需要。
 */
const ATTACHMENT_CSP = `${SANDBOX_CSP}; script-src 'unsafe-inline'; font-src data:`

/** 图片请求不带 Referer：读信这件事不留给图片主机多余的来路。 */
const NO_REFERRER = '<meta name="referrer" content="no-referrer">'

/** 塞进沙箱文档 `<head>` 的那一句（正文与 HTML 附件共用一副写法，CSP 各自一份） */
function sandboxHead(csp: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">${NO_REFERRER}`
}

/** 把沙箱头塞进文档：有 head 进 head，有 html 补一层，两样都没有就顶在最前。 */
function withSandboxHead(html: string, csp = SANDBOX_CSP): string {
  const head = sandboxHead(csp)
  if (/<head[^>]*>/i.test(html))
    return html.replace(/<head[^>]*>/i, tag => `${tag}${head}`)
  if (/<html[^>]*>/i.test(html))
    return html.replace(/<html[^>]*>/i, tag => `${tag}<head>${head}</head>`)
  return `${head}${html}`
}

/**
 * 链接一律 target="_top"：sandbox iframe 里点链接本来就是死的，改成往顶层窗口导航后
 * 由 main.rs 的 on_navigation 拦下转交系统浏览器。按整段标签做改写 —— 属性值里带 > 的
 * 写法（罕见）会漏改，漏改的链接点不动，不破沙箱。
 */
function linksToTop(html: string): string {
  return html.replace(/<a\b[^>]*>/gi, (tag) => {
    if (/target\s*=/i.test(tag))
      return tag.replace(/target\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, 'target="_top"')
    return `${tag.slice(0, -1)} target="_top">`
  })
}

/**
 * 把 HTML 正文准备成能进沙箱 iframe 的文档：注入 CSP 与 no-referrer、cid: 换成 data URL、
 *  链接统一 target="_top"。返回 null 表示这封信没有 HTML 正文，展示层改走纯文本。
 */
export function htmlBody(parsed: ParsedMail): string | null {
  if (!parsed.html.trim())
    return null
  const map = cidMap(parsed.inline)
  const html = parsed.html.replace(/cid:\s*([^"'>\s]+)/gi, (whole, id: string) => {
    return map.get(id.toLowerCase().trim()) ?? whole
  })
  return withSandboxHead(linksToTop(html))
}

/** 发件人头部 → 展示名：优先名字，退回地址。编码词在这里解码。 */
export function displaySender(raw: string): string {
  const text = raw.trim()
  const angled = text.match(/^(.*?)<([^<>]+)>\s*$/)
  if (angled) {
    const name = decodeName(angled[1])
    if (name)
      return name
    return angled[2].trim()
  }
  return text
}

/** 发件人头部 → 邮箱地址（回复要用）。 */
export function senderAddress(raw: string): string {
  const angled = raw.match(/<([^<>]+)>\s*$/)
  return (angled ? angled[1] : raw).trim()
}

/**
 * 地址头部（To / Cc）拆成逐个条目：逗号分隔，但引号串与 `<>` 里的逗号不算分隔符
 * （`"Doe, John" <j@d.com>` 是一个收件人）。拆不动的（组地址）原样留一条。
 */
function splitAddressList(raw: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angled = false
  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted
    }
    else if (char === '<') {
      angled = true
    }
    else if (char === '>') {
      angled = false
    }
    else if (char === ',' && !quoted && !angled) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(Boolean)
}

/** 收件人头部 → 展示串：逐个取展示名（没名字给地址），顿号连接。发件箱的清单行用它。 */
export function displayRecipients(raw: string): string {
  return splitAddressList(raw).map(entry => displaySender(entry)).join('、')
}

/** 收件人头部 → 第一个收件人地址（发件箱里回信要发给谁）。没有收件人给空串。 */
export function recipientAddress(raw: string): string {
  const first = splitAddressList(raw)[0]
  return first ? senderAddress(first) : ''
}

/**
 * 收件人头部 → 第一个收件人的展示名（信里没写名字就给地址）：发件箱里「存为联系人」
 * 用它当名字。群发的信只认头一个（一封信存不出好几个联系人），其余靠用户对着别的信
 * 再右击一次，或到联系人弹层里手加。
 */
export function recipientDisplay(raw: string): string {
  const first = splitAddressList(raw)[0]
  return first ? displaySender(first) : ''
}

function decodeName(raw: string): string {
  const text = raw.trim().replace(/^"|"$/g, '').trim()
  if (!text)
    return ''
  return decodeEncodedWords(text)
}

/** 头部日期 → 展示串。解析不动就原样给 —— 看得到原文比空着强。 */
export function displayDate(raw: string): string {
  const text = raw.trim()
  if (!text)
    return ''
  const date = new Date(text)
  if (Number.isNaN(date.getTime()))
    return text
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 头部日期 → 时间戳（多账户合并清单按它排序）。解析不动给 0 —— 没有日期的信排最后。 */
export function mailTime(raw: string): number {
  const time = Date.parse(raw.trim())
  return Number.isNaN(time) ? 0 : time
}

/**
 * 账户地址 → 清单上的来源标注：本地部分 + 域名第一段（`zhangsan@163`）——
 *  全地址太长挤不动一行，完整地址由 title 兜着。拆不动的原样给。
 */
export function accountTag(address: string): string {
  const at = address.indexOf('@')
  if (at <= 0 || at === address.length - 1)
    return address
  const domain = address.slice(at + 1).toLowerCase().split('.')[0]
  return `${address.slice(0, at)}@${domain}`
}
