// ! 收信侧的 MIME 解析与阅读视图。Rust 只把原始报文（base64）带回来，解析全在这里
// ! —— postal-mime 是纯 JS、无运行时外取资源的库，中文各代字符集经 TextDecoder 天然支持。
// !
// ! **渲染的硬边界**：`htmlBody` 产出的文档交给 sandbox 的 iframe（禁脚本 / 同源 /
// ! 表单 / 弹窗，与 AI 预览栏同一套，见 AiPreviewHtml.vue），注入 CSP 放行外链图片
// ! （营销信的主视觉跟着信里的地址加载）但掐死其余一切外链资源 —— 脚本、字体、
// ! 音视频、iframe 都没有。内联图（cid:）是邮件自带的内容，转成 data URL。

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

/** 解一份原始报文（Rust 回传的 base64）。解不开抛错，由适配层给人话。 */
export async function parseMessage(rawBase64: string): Promise<ParsedMail> {
  const bytes = base64ToBytes(rawBase64)
  if (!bytes)
    throw new Error('报文不是合法的 base64')
  const parsed = await new PostalMime().parse(bytes)
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

/** contentId → data URL 的替换表。 */
function cidMap(inline: ParsedAttachment[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of inline) {
    if (part.contentId)
      map.set(part.contentId.toLowerCase(), `data:${part.contentType};base64,${part.base64}`)
  }
  return map
}

/** 外链图片放行（跟着信里写的地址加载），其余资源全掐死：脚本、字体、音视频外链、iframe 都没有。 */
const SANDBOX_CSP = 'default-src \'none\'; img-src * data:; style-src \'unsafe-inline\'; media-src data:'

/** 图片请求不带 Referer：读信这件事不留给图片主机多余的来路。 */
const NO_REFERRER = '<meta name="referrer" content="no-referrer">'

/**
 * 把 HTML 正文准备成能进沙箱 iframe 的文档：注入 CSP 与 no-referrer、cid: 换成 data URL、
 *  链接统一 target="_top"。返回 null 表示这封信没有 HTML 正文，展示层改走纯文本。
 */
export function htmlBody(parsed: ParsedMail): string | null {
  if (!parsed.html.trim())
    return null
  const map = cidMap(parsed.inline)
  let html = parsed.html.replace(/cid:\s*([^"'>\s]+)/gi, (whole, id: string) => {
    return map.get(id.toLowerCase().trim()) ?? whole
  })
  // 链接一律 target="_top"：sandbox iframe 里点链接本来就是死的，改成往顶层窗口
  // 导航后由 main.rs 的 on_navigation 拦下转交系统浏览器。按整段标签做改写 ——
  // 属性值里带 > 的写法（罕见）会漏改，漏改的链接点不动，不破沙箱。
  html = html.replace(/<a\b[^>]*>/gi, (tag) => {
    if (/target\s*=/i.test(tag))
      return tag.replace(/target\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, 'target="_top"')
    return `${tag.slice(0, -1)} target="_top">`
  })
  const head = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">${NO_REFERRER}`
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, tag => `${tag}${head}`)
  }
  else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, tag => `${tag}<head>${head}</head>`)
  }
  else {
    html = `${head}${html}`
  }
  return html
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
