import { describe, expect, it } from 'vitest'
import { HANDLE_IDS, handleCursor, handlePoint, hitHandle, resizeByHandle } from './handles'

const rect = { x: 100, y: 100, width: 200, height: 100 }

describe('handlePoint', () => {
  it('四角取角', () => {
    expect(handlePoint(rect, 'nw')).toEqual({ x: 100, y: 100 })
    expect(handlePoint(rect, 'ne')).toEqual({ x: 300, y: 100 })
    expect(handlePoint(rect, 'se')).toEqual({ x: 300, y: 200 })
    expect(handlePoint(rect, 'sw')).toEqual({ x: 100, y: 200 })
  })

  it('四边取中点', () => {
    expect(handlePoint(rect, 'n')).toEqual({ x: 200, y: 100 })
    expect(handlePoint(rect, 'e')).toEqual({ x: 300, y: 150 })
    expect(handlePoint(rect, 's')).toEqual({ x: 200, y: 200 })
    expect(handlePoint(rect, 'w')).toEqual({ x: 100, y: 150 })
  })
})

describe('hitHandle', () => {
  it('容差内命中最近的把手', () => {
    expect(hitHandle(rect, { x: 102, y: 98 }, 6)).toBe('nw')
    expect(hitHandle(rect, { x: 296, y: 198 }, 6)).toBe('se')
  })

  it('小选区里挑最近的那个，而不是先判到的角', () => {
    // 4×4 的选区：八个把手全挤在一块，点在右下角附近就该是 se
    const tiny = { x: 0, y: 0, width: 4, height: 4 }
    expect(hitHandle(tiny, { x: 4, y: 4 }, 10)).toBe('se')
    expect(hitHandle(tiny, { x: 0, y: 0 }, 10)).toBe('nw')
  })

  it('容差外一律 null', () => {
    expect(hitHandle(rect, { x: 200, y: 150 }, 6)).toBeNull()
    expect(hitHandle(rect, { x: 108, y: 108 }, 4)).toBeNull()
  })
})

describe('resizeByHandle', () => {
  it('拖角同时改两条边', () => {
    expect(resizeByHandle(rect, 'nw', { x: 10, y: 20 })).toEqual({ x: 110, y: 120, width: 190, height: 80 })
    expect(resizeByHandle(rect, 'se', { x: 10, y: 20 })).toEqual({ x: 100, y: 100, width: 210, height: 120 })
  })

  it('拖边只改一条边', () => {
    expect(resizeByHandle(rect, 'e', { x: 30, y: 999 })).toEqual({ x: 100, y: 100, width: 230, height: 100 })
    expect(resizeByHandle(rect, 'n', { x: 999, y: -30 })).toEqual({ x: 100, y: 70, width: 200, height: 130 })
  })

  it('拖过对边会翻转，不产生负矩形', () => {
    const flipped = resizeByHandle(rect, 'w', { x: 250, y: 0 })
    expect(flipped).toEqual({ x: 300, y: 100, width: 50, height: 100 })
    expect(flipped.width).toBeGreaterThan(0)
  })
})

describe('handleCursor', () => {
  it('八个把手都有指针形状', () => {
    const shapes = HANDLE_IDS.map(handleCursor)
    expect(shapes).toHaveLength(8)
    expect(new Set(shapes).size).toBe(4)
    expect(handleCursor('nw')).toBe('nwse-resize')
    expect(handleCursor('ne')).toBe('nesw-resize')
  })
})
