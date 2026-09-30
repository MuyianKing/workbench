import { describe, expect, it } from 'vitest'
import {
  TERMINAL_BUTTON_TOP_DEFAULT,
  TERMINAL_BUTTON_TOP_MAX,
  TERMINAL_BUTTON_TOP_MIN,
  clampTerminalButtonTop
} from './terminal-dock'

describe('clampTerminalButtonTop', () => {
  it('区间内的值原样返回', () => {
    expect(clampTerminalButtonTop(50)).toBe(50)
    expect(clampTerminalButtonTop(TERMINAL_BUTTON_TOP_MIN)).toBe(TERMINAL_BUTTON_TOP_MIN)
    expect(clampTerminalButtonTop(TERMINAL_BUTTON_TOP_MAX)).toBe(TERMINAL_BUTTON_TOP_MAX)
  })

  it('过小 / 过大收敛到边界', () => {
    expect(clampTerminalButtonTop(-20)).toBe(TERMINAL_BUTTON_TOP_MIN)
    expect(clampTerminalButtonTop(0)).toBe(TERMINAL_BUTTON_TOP_MIN)
    expect(clampTerminalButtonTop(100)).toBe(TERMINAL_BUTTON_TOP_MAX)
    expect(clampTerminalButtonTop(9999)).toBe(TERMINAL_BUTTON_TOP_MAX)
  })

  it('保留小数：百分比取整会让拖动一格跳好几个像素', () => {
    expect(clampTerminalButtonTop(50.4)).toBe(50.4)
    expect(clampTerminalButtonTop(1.2)).toBe(TERMINAL_BUTTON_TOP_MIN)
  })

  it('缺失或认不出的取值回到「跟随终端面板」', () => {
    expect(clampTerminalButtonTop(undefined)).toBe(TERMINAL_BUTTON_TOP_DEFAULT)
    expect(clampTerminalButtonTop(null)).toBe(TERMINAL_BUTTON_TOP_DEFAULT)
    expect(clampTerminalButtonTop('50')).toBe(TERMINAL_BUTTON_TOP_DEFAULT)
    expect(clampTerminalButtonTop(Number.NaN)).toBe(TERMINAL_BUTTON_TOP_DEFAULT)
    expect(clampTerminalButtonTop(Number.POSITIVE_INFINITY)).toBe(TERMINAL_BUTTON_TOP_DEFAULT)
    expect(clampTerminalButtonTop({})).toBe(TERMINAL_BUTTON_TOP_DEFAULT)
    expect(TERMINAL_BUTTON_TOP_DEFAULT).toBeNull()
  })
})
