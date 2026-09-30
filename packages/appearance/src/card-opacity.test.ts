import { describe, expect, it } from 'vitest'
import {
  CARD_OPACITY_DEFAULT,
  CARD_OPACITY_MAX,
  CARD_OPACITY_MIN,
  cardSurfaceAlpha,
  clampCardOpacity
} from './card-opacity'

describe('clampCardOpacity', () => {
  it('区间内的值原样返回', () => {
    expect(clampCardOpacity(60)).toBe(60)
    expect(clampCardOpacity(CARD_OPACITY_MIN)).toBe(CARD_OPACITY_MIN)
    expect(clampCardOpacity(CARD_OPACITY_MAX)).toBe(CARD_OPACITY_MAX)
  })

  it('过小 / 过大收敛到边界', () => {
    expect(clampCardOpacity(0)).toBe(CARD_OPACITY_MIN)
    expect(clampCardOpacity(-10)).toBe(CARD_OPACITY_MIN)
    expect(clampCardOpacity(1000)).toBe(CARD_OPACITY_MAX)
  })

  it('小数四舍五入成整数百分比', () => {
    expect(clampCardOpacity(60.6)).toBe(61)
    expect(clampCardOpacity(60.4)).toBe(60)
  })

  it('非有限数字回落到默认值', () => {
    expect(clampCardOpacity(undefined)).toBe(CARD_OPACITY_DEFAULT)
    expect(clampCardOpacity(null)).toBe(CARD_OPACITY_DEFAULT)
    expect(clampCardOpacity('60')).toBe(CARD_OPACITY_DEFAULT)
    expect(clampCardOpacity(Number.NaN)).toBe(CARD_OPACITY_DEFAULT)
    expect(clampCardOpacity(Number.POSITIVE_INFINITY)).toBe(CARD_OPACITY_DEFAULT)
  })
})

describe('cardSurfaceAlpha', () => {
  it('按百分比换算成 0~1 的 alpha', () => {
    expect(cardSurfaceAlpha(100)).toBe(1)
    expect(cardSurfaceAlpha(70)).toBe(0.7)
    expect(cardSurfaceAlpha(CARD_OPACITY_MIN)).toBe(0.2)
  })

  it('非法值按默认不透明度换算', () => {
    expect(cardSurfaceAlpha(undefined)).toBe(CARD_OPACITY_DEFAULT / 100)
    expect(cardSurfaceAlpha('70')).toBe(CARD_OPACITY_DEFAULT / 100)
  })
})
