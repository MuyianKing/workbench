import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_OPACITY_DEFAULT,
  BACKGROUND_OPACITY_MAX,
  BACKGROUND_OPACITY_MIN,
  backgroundVeilAlpha,
  clampBackgroundOpacity,
  sanitizeBackgroundPath,
  sanitizeVeilColor,
  veilRgbTriplet
} from './workspace-background'

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

describe('sanitizeVeilColor', () => {
  it('六位色值统一成小写', () => {
    expect(sanitizeVeilColor('#EFF1F3')).toBe('#eff1f3')
    expect(sanitizeVeilColor('  #edeff2  ')).toBe('#edeff2')
  })

  it('三位简写补齐成六位', () => {
    expect(sanitizeVeilColor('#abc')).toBe('#aabbcc')
    expect(sanitizeVeilColor('#FFF')).toBe('#ffffff')
  })

  it('认不出来的写法一律当「没配」', () => {
    expect(sanitizeVeilColor('#12345')).toBe('')
    expect(sanitizeVeilColor('edeff2')).toBe('')
    expect(sanitizeVeilColor('#gggggg')).toBe('')
    expect(sanitizeVeilColor('rgba(1, 2, 3, 0.5)')).toBe('')
    expect(sanitizeVeilColor('')).toBe('')
    expect(sanitizeVeilColor(null)).toBe('')
    expect(sanitizeVeilColor(16777215)).toBe('')
  })
})

describe('veilRgbTriplet', () => {
  it('拆成 CSS 里能直接用的三元组', () => {
    expect(veilRgbTriplet('#edeff2')).toBe('237, 239, 242')
    expect(veilRgbTriplet('#fff')).toBe('255, 255, 255')
    expect(veilRgbTriplet('#000')).toBe('0, 0, 0')
    expect(veilRgbTriplet('#1b212a')).toBe('27, 33, 42')
  })

  it('没配（或非法）时返回空串，由主题变量接管', () => {
    expect(veilRgbTriplet('')).toBe('')
    expect(veilRgbTriplet(undefined)).toBe('')
    expect(veilRgbTriplet('红色')).toBe('')
  })
})
