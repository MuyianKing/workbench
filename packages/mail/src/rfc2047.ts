//! RFC 2047 编码词的解码：`=?gbk?B?...?=` 这类东西在中文邮件的 Subject / From 里是常态
//! （IMAP 拉回的头部三件套是原始文本，Rust 侧不碰）。也提供一个反向的 B 编码 ——
//! 发信时中文主题要走它（buildMime 用）。
//!
//! 罕见字符集解不动就原样保留，不假装成功 —— 看得到原文比看到乱码强。

import { base64ToBytes } from './base64'

/** Q 编码：下划线当空格，=XX 是十六进制字节（与百分号编码同形不同义）。 */
function qEncodedBytes(text: string): Uint8Array {
  const normalized = text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
  const bytes = new Uint8Array(normalized.length)
  for (let index = 0; index < normalized.length; index += 1) {
    bytes[index] = normalized.charCodeAt(index) & 0xff
  }
  return bytes
}

function decodeWord(charset: string, encoding: string, text: string): string | null {
  const bytes =
    encoding.toLowerCase() === 'b'
      ? base64ToBytes(text)
      : qEncodedBytes(text)
  if (!bytes) return null
  try {
    // TextDecoder 认大小写与常见别名（gb2312 会映射到 gbk）；不认识的字符集直接抛
    return new TextDecoder(charset.toLowerCase()).decode(bytes)
  } catch {
    return null
  }
}

/** 解一段头部文本里的全部编码词。相邻编码词之间的空白按规范吃掉 ——
 *  被折叠的主题拆成多个词时中间那个换行不该显示出来。 */
export function decodeEncodedWords(input: string): string {
  // 先把「?=  =?」之间的线性空白缝掉，词与词才连得起来
  const joined = input.replace(/(\?=)[ \t\r\n]+(=\?)/g, '$1$2')
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset, encoding, text) => {
    return decodeWord(charset, encoding, text) ?? whole
  })
}

/** 中文主题进报文头：B 编码（`=?utf-8?B?...?=`）。纯 ASCII 原样放行，不值得编码。 */
export function encodeRfc2047Word(text: string): string {
  // 全部落在可打印 ASCII 里就不用编码
  if (/^[\x20-\x7e]*$/.test(text)) return text
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return `=?utf-8?B?${btoa(binary)}?=`
}
