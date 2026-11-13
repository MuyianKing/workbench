import { describe, expect, it } from 'vitest'
import { clampVideoFloatHeight, clampVideoFloatPercent, clampVideoFloatWidth, VIDEO_FLOAT_SIZE_DEFAULT, VIDEO_FLOAT_SIZE_MAX, VIDEO_FLOAT_SIZE_MIN } from './video-float'

describe('画中画小窗的档位', () => {
  it('位置收敛到 0–100 的视口百分比，认不出的回到 0', () => {
    expect(clampVideoFloatPercent(-20)).toBe(0)
    expect(clampVideoFloatPercent(100)).toBe(100)
    expect(clampVideoFloatPercent(137.5)).toBe(100)
    expect(clampVideoFloatPercent(undefined)).toBe(0)
    expect(clampVideoFloatPercent(Number.NaN)).toBe(0)
  })

  it('尺寸收敛到边界内，缺失回到默认尺寸', () => {
    expect(clampVideoFloatWidth(100)).toBe(VIDEO_FLOAT_SIZE_MIN.width)
    expect(clampVideoFloatWidth(9999)).toBe(VIDEO_FLOAT_SIZE_MAX.width)
    expect(clampVideoFloatWidth(402.4)).toBe(402)
    expect(clampVideoFloatHeight(1)).toBe(VIDEO_FLOAT_SIZE_MIN.height)
    expect(clampVideoFloatHeight(9999)).toBe(VIDEO_FLOAT_SIZE_MAX.height)
    expect(clampVideoFloatWidth(undefined)).toBe(VIDEO_FLOAT_SIZE_DEFAULT.width)
    expect(clampVideoFloatHeight(undefined)).toBe(VIDEO_FLOAT_SIZE_DEFAULT.height)
  })

  it('默认小窗是 16:9（320×180），最小尺寸也是', () => {
    expect(VIDEO_FLOAT_SIZE_DEFAULT).toEqual({ width: 320, height: 180 })
    expect(VIDEO_FLOAT_SIZE_MIN.width / VIDEO_FLOAT_SIZE_MIN.height).toBeCloseTo(16 / 9)
  })
})
