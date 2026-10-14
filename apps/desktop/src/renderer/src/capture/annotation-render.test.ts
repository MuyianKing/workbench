import { describe, expect, it } from 'vitest'
import { measureTextBlock, TEXT_LINE_HEIGHT, textLines } from './annotation-render'

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
