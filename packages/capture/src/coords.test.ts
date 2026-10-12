import { describe, expect, it } from 'vitest'
import { canvasToViewport, monitorAt, viewportToCanvas, virtualBounds } from './coords'

const box = { left: 100, top: 50, width: 400, height: 300 }
const canvas = { width: 800, height: 600 }

describe('viewportToCanvas / canvasToViewport', () => {
  it('按「画布 / 元素」的比例换算，与 devicePixelRatio 无关', () => {
    // 元素左上角 = 画布原点；元素宽 400 对应画布 800 → 2 倍
    expect(viewportToCanvas({ x: 100, y: 50 }, box, canvas)).toEqual({ x: 0, y: 0 })
    expect(viewportToCanvas({ x: 200, y: 200 }, box, canvas)).toEqual({ x: 200, y: 300 })
  })

  it('两个方向互为逆运算', () => {
    const point = { x: 137, y: 219 }
    const back = canvasToViewport(viewportToCanvas(point, box, canvas), box, canvas)
    expect(back.x).toBeCloseTo(point.x)
    expect(back.y).toBeCloseTo(point.y)
  })

  it('元素尺寸为 0 时按 1:1 退让，不除零也不给 NaN', () => {
    const degenerate = { left: 0, top: 0, width: 0, height: 0 }
    expect(viewportToCanvas({ x: 10, y: 10 }, degenerate, canvas)).toEqual({ x: 10, y: 10 })
    expect(canvasToViewport({ x: 10, y: 10 }, degenerate, canvas)).toEqual({ x: 10, y: 10 })
  })
})

describe('virtualBounds', () => {
  it('把并排的两块屏包成一个矩形', () => {
    const bounds = virtualBounds([
      { index: 0, name: 'A', x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
      { index: 1, name: 'B', x: 1920, y: 0, width: 2560, height: 1440, scale: 1.5 },
    ])
    expect(bounds).toEqual({ x: 0, y: 0, width: 4480, height: 1440 })
  })

  it('左边那块屏是负坐标（Windows 允许多屏往左上排）', () => {
    const bounds = virtualBounds([
      { index: 0, name: 'A', x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
      { index: 1, name: 'B', x: -1280, y: -200, width: 1280, height: 1024, scale: 1 },
    ])
    expect(bounds).toEqual({ x: -1280, y: -200, width: 3200, height: 1280 })
  })

  it('一块屏都没有时是空矩形', () => {
    expect(virtualBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('monitorAt', () => {
  const monitors = [
    { index: 0, name: 'A', x: 0, y: 0, width: 1920, height: 1080, scale: 1 },
    { index: 1, name: 'B', x: 1920, y: 0, width: 1280, height: 1024, scale: 1.25 },
  ]

  it('落在哪块屏上报哪块', () => {
    expect(monitorAt(monitors, { x: 10, y: 10 })?.index).toBe(0)
    expect(monitorAt(monitors, { x: 2000, y: 500 })?.index).toBe(1)
  })

  it('右边界归左边那块（半开区间）', () => {
    expect(monitorAt(monitors, { x: 1920, y: 10 })?.index).toBe(1)
    expect(monitorAt(monitors, { x: 1919.5, y: 10 })?.index).toBe(0)
  })

  it('都在外面时 null', () => {
    expect(monitorAt(monitors, { x: -5, y: 10 })).toBeNull()
  })
})
