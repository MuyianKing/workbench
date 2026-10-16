import { describe, expect, it } from 'vitest'
import { measureTextBlock, TEXT_LINE_HEIGHT, textBaselineOffset, textLines } from './annotation-render'

/**
 * 量文字只用到 save / restore / font / measureText 这几样，所以给一个假上下文就够：
 * 假字体按「一个字 10 像素」量（与真字体无关，测的是多行怎么合尺寸）。
 * 不碰 document —— 那个只在 `measureTextSize` 里现用现建，测试环境里走不到。
 */
function stubContext(): CanvasRenderingContext2D {
  return {
    save() {},
    restore() {},
    font: '',
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as unknown as CanvasRenderingContext2D
}

describe('textLines', () => {
  it('按三种换行拆开，空行也留着（空行是用户敲的）', () => {
    expect(textLines('上\n下')).toEqual(['上', '下'])
    expect(textLines('上\r\n下')).toEqual(['上', '下'])
    expect(textLines('上\r下')).toEqual(['上', '下'])
    expect(textLines('上\n\n下')).toEqual(['上', '', '下'])
  })

  it('没有换行就是一行（含空串）', () => {
    expect(textLines('一行到底')).toEqual(['一行到底'])
    expect(textLines('')).toEqual([''])
  })
})

describe('measureTextBlock', () => {
  it('单行：宽按量出来的字宽、高按一个字号的 1.3 倍', () => {
    const box = measureTextBlock(stubContext(), '三个字', 24)
    expect(box).toEqual({ width: 30, height: Math.ceil(24 * TEXT_LINE_HEIGHT) })
  })

  it('多行：宽取最长的那一行，高按行数累加', () => {
    const box = measureTextBlock(stubContext(), '短\n长长的一行', 24)
    expect(box.width).toBe(50)
    expect(box.height).toBe(Math.ceil(2 * 24 * TEXT_LINE_HEIGHT))
  })

  it('空行照样占一行的高度（回车敲出来的空行不能白敲）', () => {
    const two = measureTextBlock(stubContext(), '一\n一', 24)
    const three = measureTextBlock(stubContext(), '一\n\n一', 24)
    expect(two.height).toBe(Math.ceil(2 * 24 * TEXT_LINE_HEIGHT))
    expect(three.height).toBe(Math.ceil(3 * 24 * TEXT_LINE_HEIGHT))
  })
})

describe('文字第一行的基线落点', () => {
  /** 只用到 font 与 measureText 的字体度量那几项 */
  const ctxWith = (ascent: number, descent: number): CanvasRenderingContext2D =>
    ({
      font: '',
      measureText: () => ({ width: 10, fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent }),
    }) as unknown as CanvasRenderingContext2D

  /**
   * 这里测的是**量不到 DOM 时那条退路**（测试环境里没有 document，浏览器里走的是
   * `domBaseline` 自己排一行那一条）。模型与输入框那一行的 CSS 行盒一致：
   * 行盒高 = 字号 × 1.3，字号自带的 ascender + descender 居中落在行盒里，
   * 基线 = 半行距 + ascender。
   */
  it('半行距 + ascender（与输入框里的那一行对齐）', () => {
    // 24px 字号、ascender 24 / descender 6：行盒 31.2、内容高 30 → 半行距 0.6 → 基线 24.6
    expect(textBaselineOffset(ctxWith(24, 6), 24)).toBeCloseTo((24 * TEXT_LINE_HEIGHT - 30) / 2 + 24, 6)
    expect(textBaselineOffset(ctxWith(24, 6), 24)).toBeCloseTo(24.6, 6)
  })

  /** 度量给不出来时（0 / NaN）宁可粗估，也不要摆到行盒外面去 */
  it('量不出字体度量时按字号兜底', () => {
    const fallback = textBaselineOffset(ctxWith(0, 0), 24)
    expect(fallback).toBeGreaterThan(24)
    expect(fallback).toBeLessThan(24 * TEXT_LINE_HEIGHT)
  })
})
