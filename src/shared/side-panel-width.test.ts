import { describe, expect, it } from 'vitest'
import {
  SIDE_PANEL_WIDTH_DEFAULT,
  SIDE_PANEL_WIDTH_MAX,
  SIDE_PANEL_WIDTH_MIN,
  clampSidePanelWidth
} from './side-panel-width'

describe('clampSidePanelWidth', () => {
  it('区间内的值原样返回', () => {
    expect(clampSidePanelWidth(340)).toBe(340)
    expect(clampSidePanelWidth(SIDE_PANEL_WIDTH_MIN)).toBe(SIDE_PANEL_WIDTH_MIN)
    expect(clampSidePanelWidth(SIDE_PANEL_WIDTH_MAX)).toBe(SIDE_PANEL_WIDTH_MAX)
  })

  it('过小 / 过大收敛到边界', () => {
    expect(clampSidePanelWidth(10)).toBe(SIDE_PANEL_WIDTH_MIN)
    expect(clampSidePanelWidth(99999)).toBe(SIDE_PANEL_WIDTH_MAX)
  })

  it('小数四舍五入成整数像素', () => {
    expect(clampSidePanelWidth(340.6)).toBe(341)
    expect(clampSidePanelWidth(340.4)).toBe(340)
  })

  it('非有限数字回落到默认值', () => {
    expect(clampSidePanelWidth(undefined)).toBe(SIDE_PANEL_WIDTH_DEFAULT)
    expect(clampSidePanelWidth(null)).toBe(SIDE_PANEL_WIDTH_DEFAULT)
    expect(clampSidePanelWidth('340')).toBe(SIDE_PANEL_WIDTH_DEFAULT)
    expect(clampSidePanelWidth(Number.NaN)).toBe(SIDE_PANEL_WIDTH_DEFAULT)
    expect(clampSidePanelWidth(Number.POSITIVE_INFINITY)).toBe(SIDE_PANEL_WIDTH_DEFAULT)
    expect(clampSidePanelWidth({})).toBe(SIDE_PANEL_WIDTH_DEFAULT)
  })
})
