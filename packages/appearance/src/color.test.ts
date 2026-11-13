import { describe, expect, it } from 'vitest'
import { contrastRatio, inkOn, isColorValue, mixHex, parseHex, relativeLuminance } from './color'

describe('parseHex', () => {
  it('只认带 # 的三位 / 六位 hex；认不出来回 null 而不是抛错', () => {
    expect(parseHex('#cc785c')).toEqual({ r: 204, g: 120, b: 92 })
    expect(parseHex('#abc')).toEqual({ r: 170, g: 187, b: 204 })
    expect(parseHex('#CC785C')).toEqual({ r: 204, g: 120, b: 92 })
    expect(parseHex('cc785c')).toBeNull()
    expect(parseHex('rgb(1,2,3)')).toBeNull()
    expect(parseHex(undefined)).toBeNull()
    expect(parseHex(123)).toBeNull()
  })
})

describe('isColorValue', () => {
  it('只放行能写进样式表的颜色写法', () => {
    expect(isColorValue('#fff')).toBe(true)
    expect(isColorValue('rgba(0,0,0,0.5)')).toBe(true)
    expect(isColorValue('transparent')).toBe(true)
    expect(isColorValue('红色')).toBe(false)
    expect(isColorValue('url(x)')).toBe(false)
  })
})

describe('mixHex', () => {
  it('两个 hex 之间线性插值，比例夹在 0–1', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', -1)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 5)).toBe('#ffffff')
  })

  it('认不出 hex 时原样回第一个值', () => {
    expect(mixHex('rgba(0,0,0,0.5)', '#ffffff', 0.5)).toBe('rgba(0,0,0,0.5)')
    expect(mixHex('cc785c', '#ffffff', 0.5)).toBe('cc785c')
    expect(mixHex('#000000', 'not-a-color', 0.5)).toBe('#000000')
  })
})

describe('相对亮度与对比度', () => {
  it('黑白两端与单调性', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#2f6bd8')).toBeGreaterThan(relativeLuminance('#1b212a'))
  })

  it('认不出的颜色按 0 处理', () => {
    expect(relativeLuminance('cc785c')).toBe(0)
    expect(contrastRatio('cc785c', '#ffffff')).toBeCloseTo(21, 5)
  })

  it('黑白对比度是 21，同色是 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#2f6bd8', '#2f6bd8')).toBeCloseTo(1, 5)
  })
})

describe('inkOn', () => {
  it('深底配白字、浅底配黑字', () => {
    expect(inkOn('#000000')).toBe('#ffffff')
    expect(inkOn('#181715')).toBe('#ffffff')
    expect(inkOn('#ffffff')).toBe('#11151b')
    expect(inkOn('#faf9f5')).toBe('#11151b')
    expect(inkOn('transparent')).toBe('#ffffff')
  })
})
