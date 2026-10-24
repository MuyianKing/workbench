import { describe, expect, it } from 'vitest'
import { nearestPlotSlot, usePlotHover } from './use-plot-hover'

describe('nearestPlotSlot', () => {
  it('等宽格:格宽 = 宽 / 点数,取整即格号', () => {
    // 10 格、宽 300:每格 30px,150 落在第 5 格
    expect(nearestPlotSlot(150, 300, 10)).toBe(5)
    expect(nearestPlotSlot(0, 300, 10)).toBe(0)
    expect(nearestPlotSlot(29.9, 300, 10)).toBe(0)
    expect(nearestPlotSlot(30, 300, 10)).toBe(1)
  })

  it('贴着右界与越界都夹回最后一格,左界之外给 null', () => {
    expect(nearestPlotSlot(299, 300, 10)).toBe(9)
    expect(nearestPlotSlot(300, 300, 10)).toBe(9)
    expect(nearestPlotSlot(-1, 300, 10)).toBeNull()
  })

  it('没有点数或没有宽度就不落在任何格上', () => {
    expect(nearestPlotSlot(10, 300, 0)).toBeNull()
    expect(nearestPlotSlot(10, 0, 5)).toBeNull()
  })
})

describe('usePlotHover', () => {
  /** 假容器:getBoundingClientRect 固定宽 300、clientX 相对它换算 */
  function moveEvent(clientX: number): MouseEvent {
    return {
      clientX,
      currentTarget: { getBoundingClientRect: () => ({ left: 100, width: 300, top: 0, height: 10, right: 400, bottom: 10, x: 100, y: 0, toJSON: () => ({}) }) },
    } as unknown as MouseEvent
  }

  it('mousemove 按容器坐标算格号与指针位置,离开清空', () => {
    const { hoverIndex, pointerX, containerWidth, onPlotMove, onPlotLeave } = usePlotHover(() => 10)
    onPlotMove(moveEvent(100 + 150))
    expect(hoverIndex.value).toBe(5)
    expect(pointerX.value).toBe(150)
    expect(containerWidth.value).toBe(300)

    onPlotLeave()
    expect(hoverIndex.value).toBeNull()
  })

  it('count 是 getter:数据变了按新的点数算', () => {
    let count = 10
    const { hoverIndex, onPlotMove } = usePlotHover(() => count)
    onPlotMove(moveEvent(100 + 150))
    expect(hoverIndex.value).toBe(5)

    count = 5 // 同一位置,格宽翻倍 → 第 2 格
    onPlotMove(moveEvent(100 + 150))
    expect(hoverIndex.value).toBe(2)
  })

  it('容器量不出尺寸时清空,不落到任何格', () => {
    const { hoverIndex, onPlotMove } = usePlotHover(() => 10)
    const broken = { clientX: 0, currentTarget: null } as unknown as MouseEvent
    onPlotMove(broken)
    expect(hoverIndex.value).toBeNull()
  })
})
