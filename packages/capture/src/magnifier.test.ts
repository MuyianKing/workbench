import { describe, expect, it } from 'vitest'
import { magnifierView } from './magnifier'

describe('magnifierView', () => {
  it('光标像素摆正中央（格数为奇数时就是中心那格）', () => {
    const view = magnifierView({ x: 100, y: 200 }, 8, 160)
    // 160 / 8 = 20 格，中心偏移 10
    expect(view.cells).toBe(20)
    expect(view.cell).toBe(8)
    expect(view.source).toEqual({ x: 90, y: 190, width: 20, height: 20 })
    expect(view.cursorCell).toEqual({ x: 80, y: 80, width: 8, height: 8 })
  })

  it('格数取整，格宽用 side / 格数（不是 zoom），不留半格缝', () => {
    const view = magnifierView({ x: 0, y: 0 }, 6, 100)
    expect(view.cells).toBe(17)
    expect(view.cell * view.cells).toBeCloseTo(100)
  })

  it('小数光标按所在像素取整', () => {
    const view = magnifierView({ x: 10.9, y: 3.2 }, 8, 160)
    expect(view.source.x).toBe(0)
    expect(view.source.y).toBe(-7)
  })

  it('左上角的负坐标照给，边界留给画的一方裁剪', () => {
    const view = magnifierView({ x: 0, y: 0 }, 8, 160)
    expect(view.source.x).toBe(-10)
    expect(view.source.y).toBe(-10)
  })

  it('zoom 非法时退回 1 倍，不除零也不给零格', () => {
    const view = magnifierView({ x: 0, y: 0 }, 0, 80)
    expect(view.cells).toBe(80)
    expect(view.cell).toBe(1)
  })
})
