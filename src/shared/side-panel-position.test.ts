import { describe, expect, it } from 'vitest'
import {
  SIDE_PANEL_POSITION_DEFAULT,
  SIDE_PANEL_POSITIONS,
  sanitizeSidePanelPosition
} from './side-panel-position'

describe('sanitizeSidePanelPosition', () => {
  it('两个合法位置原样返回', () => {
    for (const position of SIDE_PANEL_POSITIONS) {
      expect(sanitizeSidePanelPosition(position)).toBe(position)
    }
    expect(SIDE_PANEL_POSITIONS).toEqual(['left', 'right'])
  })

  it('缺失、类型不对或写错的取值落到默认位置', () => {
    expect(sanitizeSidePanelPosition(undefined)).toBe(SIDE_PANEL_POSITION_DEFAULT)
    expect(sanitizeSidePanelPosition(null)).toBe(SIDE_PANEL_POSITION_DEFAULT)
    expect(sanitizeSidePanelPosition('')).toBe(SIDE_PANEL_POSITION_DEFAULT)
    expect(sanitizeSidePanelPosition('RIGHT')).toBe(SIDE_PANEL_POSITION_DEFAULT)
    expect(sanitizeSidePanelPosition('center')).toBe(SIDE_PANEL_POSITION_DEFAULT)
    // 上下两个位置已经取消：旧数据文件里还留着的也回到默认的右
    expect(sanitizeSidePanelPosition('top')).toBe(SIDE_PANEL_POSITION_DEFAULT)
    expect(sanitizeSidePanelPosition('bottom')).toBe(SIDE_PANEL_POSITION_DEFAULT)
    expect(sanitizeSidePanelPosition(1)).toBe(SIDE_PANEL_POSITION_DEFAULT)
    expect(sanitizeSidePanelPosition({})).toBe(SIDE_PANEL_POSITION_DEFAULT)
  })

  it('默认位置是「右」，与内建布局一致', () => {
    expect(SIDE_PANEL_POSITION_DEFAULT).toBe('right')
  })
})
