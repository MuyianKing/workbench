/**
 * OCR 结果 → 文字层的摆位（纯逻辑，带单测）。
 *
 * Windows OCR 给的是「行 → 词」两级，文字层要的是**逐字**摆：
 *
 * - **词内字符按框宽均分**：选中粒度到字。中文一词一字本来就是一个框；英文一词多字，
 *   均分出来的字位与真实排版的偏差很小（UI 无衬线字体的字宽接近等分）；
 * - **空格只补在拉丁词身边**（词里带字母 / 数字的才算）：英文没有空格就没法读，
 *   而中文不用空格分词 —— 小字上 OCR 的字框本来就松，见缝就补会把「直接把」拆成「直 接 把」；
 *   间隙小于字高四分之一的当排版留白，也不补；
 * - **行末补换行位**：拖选跨行时靠它隔出 `\n` —— 那层里的元素全是绝对定位的 span，
 *   浏览器串选区文本时不会自己给「上一行末尾 → 下一行开头」补换行。
 */

import type { OcrLine, OcrWord } from './wire'

/** 文字层里的一个位：一个字、一个空格，或行末的换行 */
export interface OcrSpan {
  text: string
  x: number
  y: number
  w: number
  h: number
  /** 行末的换行位（最后一行不带） */
  break?: boolean
}

/** 词间空隙达到字高的这个比例才看得见（小于它的是排版留白） */
const SPACE_GAP_RATIO = 0.25

/** 带字母 / 数字的词（空格只补在它们身边，纯中文词之间不补） */
const LATIN = /[A-Z0-9]/i

/** 换行位的宽（物理像素）：能被拖选路径跨到就行，摆出来不占地方 */
const BREAK_WIDTH = 2

/** 词的四个数是不是都能摆（NaN / 零尺寸 / 空白文本的直接丢：摆不出东西还挡选区） */
function usable(word: OcrWord): boolean {
  return (
    Number.isFinite(word.x)
    && Number.isFinite(word.y)
    && Number.isFinite(word.w)
    && Number.isFinite(word.h)
    && word.w > 0
    && word.h > 0
    && word.text.trim() !== ''
  )
}

/**
 * 行 → 字位。返回按行分组的摆位清单（整行没东西的不进来）；坐标仍是选区内的物理像素，
 * 换算到视口（÷ 缩放、+ 选区原点）由渲染层做 —— 那一步要问 DOM，纯逻辑这边不掺和。
 *
 * 换行位分两趟补：先分好行，再给**非末行**的行尾各补一个 —— 一趟里补的话，
 * 「后面的行全是废词」时前一行会挂一个悬空的换行（选中全部时末尾多出一个空行）。
 */
export function layoutOcrSpans(lines: OcrLine[]): OcrSpan[][] {
  const rows: OcrSpan[][] = []

  for (const line of lines) {
    const spans: OcrSpan[] = []
    let previous: OcrWord | null = null

    for (const word of line.words) {
      if (!usable(word))
        continue

      if (previous) {
        const gap = word.x - (previous.x + previous.w)
        const wide = gap > 0 && gap >= SPACE_GAP_RATIO * Math.min(previous.h, word.h)
        // 空格只补在拉丁词身边（中文不用空格分词，见文件头那条）
        if (wide && (LATIN.test(previous.text) || LATIN.test(word.text))) {
          spans.push({
            text: ' ',
            x: previous.x + previous.w,
            y: word.y,
            w: gap,
            h: Math.min(previous.h, word.h),
          })
        }
      }

      // 按码位拆（Array.from）：代理对（emoji 一类）不会被拆成半个
      const chars = Array.from(word.text)
      const cell = word.w / chars.length
      for (let at = 0; at < chars.length; at += 1) {
        spans.push({ text: chars[at], x: word.x + cell * at, y: word.y, w: cell, h: word.h })
      }
      previous = word
    }

    if (spans.length)
      rows.push(spans)
  }

  for (const spans of rows.slice(0, -1)) {
    const last = spans[spans.length - 1]
    spans.push({ text: '\n', x: last.x + last.w, y: last.y, w: BREAK_WIDTH, h: last.h, break: true })
  }
  return rows
}
