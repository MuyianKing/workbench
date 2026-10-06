//! 发信报文的构建：完整 RFC 822 报文在这里拼好、整份递给 Rust 的 mail_send，
//! Rust 只负责 SMTP 传输（见 mail.rs 的职责分工）。正文与附件全部 base64 ——
//! 中文、二进制在这条路上都安全，报文里不出现裸的 8-bit 内容。
//!
//! 所有行一律 CRLF（SMTP 的硬要求），信体文本里的换行也归一成 CRLF。

import { bytesToBase64 } from './base64'
import { encodeRfc2047Word } from './rfc2047'

/** 与 Rust 侧 mail.rs 的 MAX_MESSAGE_BYTES 同一个数：超限在构建这一步就拦下。 */
export const MAX_MESSAGE_BYTES = 30 * 1024 * 1024

export interface MailAttachmentInput {
  /** 展示用的文件名（可中文；进报文头时走 RFC 2231 编码） */
  name: string
  contentType: string
  /** 文件内容的 base64（渲染层用现成的 fs_read_base64 读进来） */
  bytesBase64: string
}

export interface BuildMimeInput {
  /** 发件人邮箱地址（就是账户自己的地址） */
  from: string
  to: string[]
  subject: string
  /** 纯文本正文 */
  text: string
  attachments?: MailAttachmentInput[]
}

/** 报文正文里的换行归一成 CRLF；空行不用特殊处理。 */
function normalizeText(text: string): string {
  return text.replace(/\r\n|\n|\r/g, '\r\n')
}

/** base64 按 76 列折行 —— 报文体的传统行宽。 */
function wrappedBase64(base64: string): string {
  const compact = base64.replace(/\s/g, '')
  const lines: string[] = []
  for (let offset = 0; offset < compact.length; offset += 76) {
    lines.push(compact.slice(offset, offset + 76))
  }
  return lines.join('\r\n')
}

/** 收件人列表进 To 头：逗号分隔。 */
function addressList(to: string[]): string {
  return to.map((address) => address.trim()).join(', ')
}

/** 附件文件名进 Content-Disposition：RFC 2231 的 filename*（utf-8 百分号编码）。
 *  filename= 一份 ASCII 兜底 —— 不认 filename* 的老客户端至少看得到个名字。 */
function contentDisposition(name: string): string {
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = Array.from(new TextEncoder().encode(name))
    .map((byte) => (byte < 0x21 || byte > 0x7e || byte === 0x25 ? `%${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte)))
    .join('')
  return `attachment; filename="${asciiFallback}"; filename*=utf-8''${encoded}`
}

/** 信头里的日期：RFC 5322 要求的 `+0000` 形态。 */
function rfc5322Date(): string {
  return new Date().toUTCString().replace(/GMT$/, '+0000')
}

function messageId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}`
  return `<${random.replace(/-/g, '.')}@workbench.mail>`
}

/** 常见后缀 → MIME 类型。认不出的一律 application/octet-stream —— 服务器按扩展名
 *  也能猜个八九不离十，这里只是让收件方的预览体验好一点。 */
const CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  pdf: 'application/pdf',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv'
}

/** 按文件名猜 Content-Type（发附件用）。 */
export function contentTypeForFileName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/** 附件大小进界面：KB 以下按字节、MB 以下按 KB，其余按 MB（一位小数）。 */
export function formatMailSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 拼一份完整的发信报文。附件可省；有附件时 multipart/mixed 包住文本与文件。
 * 超过 30 MB 直接抛 —— 服务器收不下，发出去也是白费一趟。
 */
export function buildMime(input: BuildMimeInput): string {
  const textBase64 = wrappedBase64(bytesToBase64(new TextEncoder().encode(normalizeText(input.text))))
  const attachments = input.attachments ?? []
  const totalBytes = textBase64.length + attachments.reduce((sum, part) => sum + part.bytesBase64.length, 0)
  if (totalBytes > MAX_MESSAGE_BYTES) {
    throw new Error('邮件（含附件）超过 30 MB，发件服务器收不下，拆小一点再试')
  }

  const headers = [
    `Date: ${rfc5322Date()}`,
    `From: ${input.from.trim()}`,
    `To: ${addressList(input.to)}`,
    `Subject: ${encodeRfc2047Word(input.subject)}`,
    'MIME-Version: 1.0',
    `Message-ID: ${messageId()}`
  ]

  if (attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      textBase64,
      ''
    ].join('\r\n')
  }

  const boundary = `=_workbench_${messageId().replace(/[<>.@]/g, '')}`
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    textBase64
  ]
  for (const part of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${part.contentType || 'application/octet-stream'}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${contentDisposition(part.name)}`,
      '',
      wrappedBase64(part.bytesBase64)
    )
  }
  parts.push(`--${boundary}--`, '')
  return parts.join('\r\n')
}
