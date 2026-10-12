import { describe, expect, it } from 'vitest'
import { hexToRgb, readableInkOn, rgbToHex } from './color'

describe('rgbToHex / hexToRgb', () => {
  it('互逆', () => {
    const rgb = { r: 18, g: 52, b: 86 }
    expect(rgbToHex(rgb)).toBe('#123456')
    expect(hexToRgb('#123456')).toEqual(rgb)
  })

  it('三位简写也认', () => {
    expect(hexToRgb('#f0a')).toEqual({ r: 255, g: 0, b: 170 })
  })

  it('越界 / 小数一律夹到字节', () => {
    expect(rgbToHex({ r: -10, g: 300, b: 127.6 })).toBe('#00ff80')
  })

  it('认不出的回黑色，不给 NaN', () => {
    expect(hexToRgb('red')).toEqual({ r: 0, g: 0, b: 0 })
    expect(hexToRgb('')).toEqual({ r: 0, g: 0, b: 0 })
  })
})

describe('readableInkOn', () => {
  it('亮底给深字、暗底给白字', () => {
    expect(readableInkOn({ r: 255, g: 255, b: 255 })).toBe('#111111')
    expect(readableInkOn({ r: 0, g: 0, b: 0 })).toBe('#ffffff')
    expect(readableInkOn({ r: 250, g: 219, b: 20 })).toBe('#111111')
  })
})
