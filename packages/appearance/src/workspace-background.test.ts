import { describe, expect, it } from 'vitest'
import { BACKGROUND_OPACITY_DEFAULT, BACKGROUND_OPACITY_MAX, BACKGROUND_OPACITY_MIN, backgroundVeilAlpha, clampBackgroundOpacity, sanitizeBackgroundPath } from './workspace-background'

describe('clampBackgroundOpacity', () => {
  it('区间内的值原样返回', () => {
    expect(clampBackgroundOpacity(40)).toBe(40)
    expect(clampBackgroundOpacity(BACKGROUND_OPACITY_MIN)).toBe(BACKGROUND_OPACITY_MIN)
    expect(clampBackgroundOpacity(BACKGROUND_OPACITY_MAX)).toBe(BACKGROUND_OPACITY_MAX)
  })

  it('过小 / 过大收敛到边界', () => {
    expect(clampBackgroundOpacity(0)).toBe(BACKGROUND_OPACITY_MIN)
    expect(clampBackgroundOpacity(-30)).toBe(BACKGROUND_OPACITY_MIN)
    expect(clampBackgroundOpacity(1000)).toBe(BACKGROUND_OPACITY_MAX)
  })

  it('小数四舍五入成整数百分比', () => {
    expect(clampBackgroundOpacity(40.6)).toBe(41)
    expect(clampBackgroundOpacity(40.4)).toBe(40)
  })

  it('非有限数字回落到默认值', () => {
    expect(clampBackgroundOpacity(undefined)).toBe(BACKGROUND_OPACITY_DEFAULT)
    expect(clampBackgroundOpacity(null)).toBe(BACKGROUND_OPACITY_DEFAULT)
    expect(clampBackgroundOpacity('40')).toBe(BACKGROUND_OPACITY_DEFAULT)
    expect(clampBackgroundOpacity(Number.NaN)).toBe(BACKGROUND_OPACITY_DEFAULT)
    expect(clampBackgroundOpacity(Number.POSITIVE_INFINITY)).toBe(BACKGROUND_OPACITY_DEFAULT)
  })
})

describe('backgroundVeilAlpha', () => {
  it('图片越浓，蒙版越淡', () => {
    expect(backgroundVeilAlpha(BACKGROUND_OPACITY_MAX)).toBe(0)
    expect(backgroundVeilAlpha(40)).toBe(0.6)
  })

  it('边界值也不会算出负数 alpha', () => {
    expect(backgroundVeilAlpha(0)).toBe(0.95)
    expect(backgroundVeilAlpha(999)).toBe(0)
    // 非法值先落到默认浓淡，再换算成蒙版
    expect(backgroundVeilAlpha('x')).toBe((100 - BACKGROUND_OPACITY_DEFAULT) / 100)
  })
})

describe('sanitizeBackgroundPath', () => {
  it('去掉首尾空白', () => {
    expect(sanitizeBackgroundPath('  D:\\pics\\bg.jpg ')).toBe('D:\\pics\\bg.jpg')
  })

  it('非字符串一律当没有背景', () => {
    expect(sanitizeBackgroundPath(undefined)).toBe('')
    expect(sanitizeBackgroundPath(null)).toBe('')
    expect(sanitizeBackgroundPath(42)).toBe('')
    expect(sanitizeBackgroundPath('')).toBe('')
  })
})
