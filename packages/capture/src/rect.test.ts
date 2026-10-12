import { describe, expect, it } from 'vitest'
import { clampRect, EMPTY_RECT, fromDrag, growRect, normalizeRect, rectContains, rectIsEmpty, rectsEqual, rectSizeText, unionRect } from './rect'

describe('fromDrag', () => {
  it('往四个方向拖都得到同一个矩形', () => {
    const expected = { x: 10, y: 20, width: 30, height: 40 }
    expect(fromDrag({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected)
    expect(fromDrag({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected)
    expect(fromDrag({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected)
    expect(fromDrag({ x: 10, y: 60 }, { x: 40, y: 20 })).toEqual(expected)
  })

  it('原地按下松开是一个零尺寸的选区（位置留在按下的地方）', () => {
    expect(fromDrag({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, width: 0, height: 0 })
  })
})

describe('normalizeRect', () => {
  it('负宽高翻成正常矩形', () => {
    expect(normalizeRect({ x: 40, y: 60, width: -30, height: -40 })).toEqual({ x: 10, y: 20, width: 30, height: 40 })
  })

  it('正常的原样返回', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 }
    expect(normalizeRect(rect)).toEqual(rect)
  })
})

describe('clampRect', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 80 }

  it('越界的两条边收回来', () => {
    expect(clampRect({ x: -10, y: -10, width: 200, height: 200 }, bounds)).toEqual(bounds)
  })

  it('整个在外面时收成零宽，不倒挂', () => {
    const clamped = clampRect({ x: 500, y: 500, width: 10, height: 10 }, bounds)
    expect(clamped.width).toBe(0)
    expect(clamped.height).toBe(0)
    expect(clamped.x).toBe(100)
    expect(clamped.y).toBe(80)
  })

  it('完全在里面的原样返回', () => {
    const inner = { x: 10, y: 10, width: 20, height: 20 }
    expect(clampRect(inner, bounds)).toEqual(inner)
  })

  it('负宽度的中间态先归一化再夹', () => {
    expect(clampRect({ x: 30, y: 30, width: -20, height: -10 }, bounds)).toEqual({ x: 10, y: 20, width: 20, height: 10 })
  })
})

describe('rectContains', () => {
  const rect = { x: 10, y: 10, width: 10, height: 10 }

  it('含边界', () => {
    expect(rectContains(rect, { x: 10, y: 10 })).toBe(true)
    expect(rectContains(rect, { x: 20, y: 20 })).toBe(true)
    expect(rectContains(rect, { x: 12, y: 18 })).toBe(true)
  })

  it('外面一律 false', () => {
    expect(rectContains(rect, { x: 9, y: 15 })).toBe(false)
    expect(rectContains(rect, { x: 21, y: 15 })).toBe(false)
  })
})

describe('unionRect / growRect / rectIsEmpty / rectsEqual', () => {
  it('unionRect 取包住两个的最小矩形', () => {
    expect(unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 }))
      .toEqual({ x: 0, y: 0, width: 30, height: 15 })
  })

  it('growRect 正数放大、负数缩进', () => {
    expect(growRect({ x: 10, y: 10, width: 10, height: 10 }, 5)).toEqual({ x: 5, y: 5, width: 20, height: 20 })
    expect(growRect({ x: 10, y: 10, width: 10, height: 10 }, -2)).toEqual({ x: 12, y: 12, width: 6, height: 6 })
  })

  it('rectIsEmpty 按阈值判', () => {
    expect(rectIsEmpty({ x: 0, y: 0, width: 0, height: 10 })).toBe(true)
    expect(rectIsEmpty({ x: 0, y: 0, width: 3, height: 3 }, 4)).toBe(true)
    expect(rectIsEmpty({ x: 0, y: 0, width: 4, height: 4 }, 4)).toBe(false)
  })

  it('rectsEqual 逐字段比', () => {
    expect(rectsEqual(EMPTY_RECT, { x: 0, y: 0, width: 0, height: 0 })).toBe(true)
    expect(rectsEqual(EMPTY_RECT, { x: 0, y: 0, width: 1, height: 0 })).toBe(false)
  })

  it('rectSizeText 是「宽 × 高」', () => {
    expect(rectSizeText({ x: 0, y: 0, width: 1024.4, height: 768.6 })).toBe('1024 × 769')
  })
})
