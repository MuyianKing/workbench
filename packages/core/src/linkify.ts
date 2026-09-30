/**
 * 终端日志里的 URL 识别。
 *
 * 面板要让地址可点，就得先把一行文本切成「普通文本 / 链接」若干片段。
 * 判定只认带协议的 http(s)：Vite、Next 这类工具打印出来的都是完整地址，
 * 不做裸域名猜测，免得 `README.md`、`localhost:5173` 这类词被误当成链接。
 */

/** 一行里切出来的一段；url 为 null 表示普通文本 */
export interface LinkSegment {
  text: string
  /** 仅链接段有值，已去掉紧跟在地址后面的标点 */
  url: string | null
}

/** 地址的形态：带协议，到空白或引号 / 尖括号为止 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/i

/** 只有协议头、后面没有主机名的空壳 */
const BARE_PROTOCOL = /^https?:\/\/$/i

/**
 * 紧跟在地址后面、但不该算进地址的标点。
 *
 * `Started at http://localhost:5173/.` 里的句号属于句子，不属于 URL；
 * 中文全角标点同理。牺牲的是 `.../foo(bar)` 这类以括号收尾的地址，
 * 在终端输出里基本见不到。
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}，。；：！？、）】》」』"']+$/

/**
 * 把一行日志切成若干片段，链接单独成段。
 *
 * 文本里没有 http(s) 时原样返回一段，省掉正则扫描 —— 绝大多数日志行走这条捷径。
 * 空串返回空数组，调用方要占位的话自己补空格。
 */
export function splitLinks(text: string): LinkSegment[] {
  if (!URL_PATTERN.test(text)) return text ? [{ text, url: null }] : []

  const segments: LinkSegment[] = []
  // g 标志的正则带 lastIndex，属于共享状态，这里每次现造一个
  const pattern = new RegExp(URL_PATTERN.source, 'gi')
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0]
    const url = raw.replace(TRAILING_PUNCTUATION, '')
    if (BARE_PROTOCOL.test(url)) continue

    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), url: null })
    }
    segments.push({ text: url, url })

    const trailing = raw.slice(url.length)
    if (trailing) segments.push({ text: trailing, url: null })

    cursor = match.index + raw.length
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), url: null })
  return segments
}
