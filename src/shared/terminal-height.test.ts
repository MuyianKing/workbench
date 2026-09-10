import { describe, expect, it } from 'vitest'
import {
  TERMINAL_HEIGHT_DEFAULT,
  TERMINAL_HEIGHT_MAX,
  TERMINAL_HEIGHT_MIN,
  clampTerminalHeight,
  maxTerminalHeightFor
} from './terminal-height'

describe('clampTerminalHeight', () => {
  it('区间内的值原样返回', () => {
    expect(clampTerminalHeight(320)).toBe(320)
    expect(clampTerminalHeight(TERMINAL_HEIGHT_MIN)).toBe(TERMINAL_HEIGHT_MIN)
    expect(clampTerminalHeight(TERMINAL_HEIGHT_MAX)).toBe(TERMINAL_HEIGHT_MAX)
  })

  it('过小 / 过大收敛到边界', () => {
    expect(clampTerminalHeight(10)).toBe(TERMINAL_HEIGHT_MIN)
    expect(clampTerminalHeight(99999)).toBe(TERMINAL_HEIGHT_MAX)
  })

  it('小数四舍五入成整数像素', () => {
    expect(clampTerminalHeight(320.6)).toBe(321)
    expect(clampTerminalHeight(320.4)).toBe(320)
  })

  it('非有限数字回落到默认值', () => {
    expect(clampTerminalHeight(undefined)).toBe(TERMINAL_HEIGHT_DEFAULT)
    expect(clampTerminalHeight(null)).toBe(TERMINAL_HEIGHT_DEFAULT)
    expect(clampTerminalHeight('320')).toBe(TERMINAL_HEIGHT_DEFAULT)
    expect(clampTerminalHeight(Number.NaN)).toBe(TERMINAL_HEIGHT_DEFAULT)
    expect(clampTerminalHeight(Number.POSITIVE_INFINITY)).toBe(TERMINAL_HEIGHT_DEFAULT)
    expect(clampTerminalHeight({})).toBe(TERMINAL_HEIGHT_DEFAULT)
  })
})

describe('maxTerminalHeightFor', () => {
  it('常规窗口取七成高度', () => {
    expect(maxTerminalHeightFor(1000)).toBe(700)
    expect(maxTerminalHeightFor(800)).toBe(560)
  })

  it('大窗口不超过硬上限', () => {
    expect(maxTerminalHeightFor(4000)).toBe(TERMINAL_HEIGHT_MAX)
  })

  it('极小窗口仍留得住最小高度，拖拽区间不会反转', () => {
    expect(maxTerminalHeightFor(100)).toBe(TERMINAL_HEIGHT_MIN)
    expect(maxTerminalHeightFor(0)).toBe(TERMINAL_HEIGHT_MIN)
  })

  it('窗口高度非法时退回硬上限', () => {
    expect(maxTerminalHeightFor(Number.NaN)).toBe(TERMINAL_HEIGHT_MAX)
  })
})
