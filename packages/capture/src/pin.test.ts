import { describe, expect, it } from 'vitest'
import { clampPinOpacity, clampPinSize, initialPinSize, PIN_MAX_EDGE, PIN_MIN_EDGE, PIN_OPACITY_MAX, PIN_OPACITY_MIN, zoomAround } from './pin'

describe('clampPinOpacity', () => {
  it('越界的夹回区间', () => {
    expect(clampPinOpacity(0)).toBe(PIN_OPACITY_MIN)
    expect(clampPinOpacity(999)).toBe(PIN_OPACITY_MAX)
    expect(clampPinOpacity(55.4)).toBe(55)
  })

  it('认不出的（NaN / Infinity）回满', () => {
    expect(clampPinOpacity(Number.NaN)).toBe(PIN_OPACITY_MAX)
    expect(clampPinOpacity(Number.POSITIVE_INFINITY)).toBe(PIN_OPACITY_MAX)
  })
})

describe('clampPinSize', () => {
  it('太小撑到下限、太大收到上限', () => {
    expect(clampPinSize({ width: 4, height: 2 }, 2)).toEqual({ width: PIN_MIN_EDGE, height: PIN_MIN_EDGE / 2 })
    const huge = clampPinSize({ width: 40000, height: 20000 }, 2)
    expect(huge.width).toBe(PIN_MAX_EDGE)
    expect(huge.height).toBe(PIN_MAX_EDGE / 2)
  })

  it('长宽比非法时按 1 处理，不产出 NaN', () => {
    const size = clampPinSize({ width: 200, height: 100 }, 0)
    expect(Number.isFinite(size.height)).toBe(true)
  })
})

describe('initialPinSize', () => {
  const viewport = { width: 1920, height: 1080 }

  it('小图原样', () => {
    expect(initialPinSize({ width: 400, height: 300 }, viewport)).toEqual({ width: 400, height: 300 })
  })

  it('大图按七成视口收，且保持比例', () => {
    const size = initialPinSize({ width: 3840, height: 2160 }, viewport)
    expect(size.width).toBe(Math.round(1920 * 0.7))
    // 比例仍是 16:9（允许 1px 取整误差）
    expect(Math.abs(size.width / size.height - 16 / 9)).toBeLessThan(0.01)
  })

  it('又宽又高的图两面都收得住', () => {
    const size = initialPinSize({ width: 8000, height: 6000 }, { width: 1000, height: 1000 })
    expect(size.width).toBeLessThanOrEqual(700)
    expect(size.height).toBeLessThanOrEqual(700)
  })
})

describe('zoomAround', () => {
  it('锚点底下的内容停在原位', () => {
    const next = zoomAround({ x: 300, y: 200 }, { x: 100, y: 100 }, { width: 400, height: 400 }, { width: 800, height: 800 })
    // 锚点相对左上角的距离翻倍（100 → 200），于是左上角各退回 (锚点 - 新距离)：
    // x: 300 - 400 = -100，y: 200 - 200 = 0
    expect(next).toEqual({ x: -100, y: 0 })
  })

  it('尺寸为零时不动，不除零', () => {
    expect(zoomAround({ x: 0, y: 0 }, { x: 5, y: 5 }, { width: 0, height: 0 }, { width: 10, height: 10 }))
      .toEqual({ x: 5, y: 5 })
  })
})
