/**
 * 悬浮滚动条的几何用例。
 *
 * 这几条钉住的是「滑块永远在轨道里、到底就是到底」：内容高、可视区小、轨道被压扁
 * 三种情况分开验 —— 视觉上最刺眼的问题不是颜色，而是滑块算错了位置、或者到末尾还差一截。
 */
import { describe, expect, it } from 'vitest'
import { MIN_THUMB, thumbMetrics } from './use-overlay-scrollbar'

describe('thumbMetrics', () => {
  it('内容装得下时不给滑块', () => {
    expect(thumbMetrics(0, 500, 500, 500)).toBeNull()
    expect(thumbMetrics(0, 500, 501, 500)).toBeNull()
  })

  it('高度按可视区比例缩放，顶部时贴住轨道顶', () => {
    expect(thumbMetrics(0, 500, 1000, 500)).toEqual({ height: 250, top: 0 })
  })

  it('滚到中间时滑块在中间，滚到底时贴住轨道底', () => {
    expect(thumbMetrics(250, 500, 1000, 500)).toEqual({ height: 250, top: 125 })
    expect(thumbMetrics(500, 500, 1000, 500)).toEqual({ height: 250, top: 250 })
  })

  it('内容再长也留一个最小滑块高度；轨道比最小高度还矮时以轨道为准', () => {
    expect(thumbMetrics(0, 100, 100_000, 500)).toEqual({ height: MIN_THUMB, top: 0 })
    expect(thumbMetrics(0, 100, 100_000, 10)).toEqual({ height: 10, top: 0 })
  })

  it('滚动位置越界时夹回两端', () => {
    expect(thumbMetrics(-80, 500, 1000, 500)).toEqual({ height: 250, top: 0 })
    expect(thumbMetrics(9999, 500, 1000, 500)).toEqual({ height: 250, top: 250 })
  })

  it('还没有尺寸（轨道收起来 / 编辑器没挂上）时不给滑块', () => {
    expect(thumbMetrics(0, 0, 1000, 500)).toBeNull()
    expect(thumbMetrics(0, 500, 1000, 0)).toBeNull()
  })
})
