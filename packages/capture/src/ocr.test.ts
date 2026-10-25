import type { OcrLine, OcrWord } from './wire'
import { describe, expect, it } from 'vitest'
import { layoutOcrSpans } from './ocr'

/** 一个词：坐标与尺寸取真实 OCR 那个量级（26px 字号的字框） */
function word(text: string, x: number, y = 40, w = text.length * 33, h = 32): OcrWord {
  return { text, x, y, w, h }
}

describe('layoutOcrSpans', () => {
  it('中文一字一词就是一个字位，框原样保留', () => {
    const laid = layoutOcrSpans([{ words: [word('工', 229), word('作', 263), word('台', 300)] }])
    expect(laid).toEqual([[
      { text: '工', x: 229, y: 40, w: 33, h: 32 },
      { text: '作', x: 263, y: 40, w: 33, h: 32 },
      { text: '台', x: 300, y: 40, w: 33, h: 32 },
    ]])
  })

  it('英文一词多字按框宽均分，字位首尾相接收在框右缘', () => {
    const line = layoutOcrSpans([{ words: [word('Total:', 22, 104, 89, 28)] }])[0]
    expect(line).toHaveLength(6)
    expect(line[0]).toMatchObject({ text: 'T', x: 22, w: 89 / 6 })
    expect(line[5]).toMatchObject({ text: ':', x: 22 + 89 / 6 * 5, w: 89 / 6 })
    expect(line[5].x + line[5].w).toBeCloseTo(111)
  })

  it('词间空隙够宽补一个空格位，紧挨着的当排版留白不补', () => {
    // 字高 20 → 门槛 5：空隙 30 补，空隙 2 不补
    const wide = layoutOcrSpans([{ words: [word('ab', 0, 0, 40, 20), word('cd', 70, 0, 40, 20)] }])
    expect(wide[0].some(span => span.text === ' ')).toBe(true)

    const tight = layoutOcrSpans([{ words: [word('ab', 0, 0, 40, 20), word('cd', 42, 0, 40, 20)] }])
    expect(tight[0].some(span => span.text === ' ')).toBe(false)
  })

  it('中文词之间就算缝够宽也不补空格，一边挨着拉丁词才补', () => {
    // 字高 20、缝 12（过了 5 的门槛）：纯中文不补 —— 小字上 OCR 的字框松，
    // 见缝就补会把「直接把」拆成「直 接 把」
    const cjk = layoutOcrSpans([{ words: [word('直', 0, 0, 20, 20), word('接', 32, 0, 20, 20), word('把', 64, 0, 20, 20)] }])
    expect(cjk[0].some(span => span.text === ' ')).toBe(false)

    // 一边是拉丁词（span）就照补：英文没空格没法读
    const mixed = layoutOcrSpans([{ words: [word('span', 0, 0, 40, 20), word('接', 60, 0, 20, 20)] }])
    expect(mixed[0].some(span => span.text === ' ')).toBe(true)
  })

  it('多行时非末行行尾带换行位，最后一行不带', () => {
    const laid = layoutOcrSpans([
      { words: [word('第一行', 0, 0, 99, 30)] },
      { words: [word('第二行', 0, 40, 99, 30)] },
    ])
    expect(laid[0].at(-1)).toMatchObject({ text: '\n', break: true, x: 99 })
    expect(laid[1].at(-1)?.text).toBe('行')
  })

  it('整行都是废词时那一行不出，也不给前一行挂悬空的换行', () => {
    const laid = layoutOcrSpans([
      { words: [word('好', 0, 0, 10, 10)] },
      {
        words: [
          word('', 0),
          word('  ', 0),
          { text: '坏', x: Number.NaN, y: 0, w: 10, h: 10 },
          { text: '坏', x: 0, y: 0, w: 0, h: 10 },
        ],
      },
    ])
    expect(laid).toEqual([[{ text: '好', x: 0, y: 0, w: 10, h: 10 }]])
  })

  it('摆出来的字位按顺序串回去就是原文（含空格与换行）', () => {
    const lines: OcrLine[] = [
      { words: [word('Workbench', 0, 0, 193, 28), word('工作台', 230, 0, 99, 30)] },
      { words: [word('Total:', 0, 40, 89, 28), word('12345', 125, 40, 99, 28)] },
    ]
    const text = layoutOcrSpans(lines)
      .map(line => line.map(span => span.text).join(''))
      .join('')
    // 两处词间空隙（37 与 36）都过了门槛（7），行间靠换行位
    expect(text).toBe('Workbench 工作台\nTotal: 12345')
  })
})
