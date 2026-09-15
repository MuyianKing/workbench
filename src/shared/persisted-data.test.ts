import { describe, expect, it } from 'vitest'
import { sanitizeSettings } from './persisted-data'
import { TERMINAL_BUTTON_TOP_MAX } from './terminal-dock'

describe('设置里那颗悬浮按钮的位置', () => {
  it('老数据文件里没有这一项时回到「跟随终端面板」', () => {
    expect(sanitizeSettings({}).terminalButtonTop).toBeNull()
    expect(sanitizeSettings({ hotkey: 'Control+J' }).terminalButtonTop).toBeNull()
    expect(sanitizeSettings({ terminalButtonTop: '60' }).terminalButtonTop).toBeNull()
  })

  it('拖过的位置原样保留，越界的收敛到区间内', () => {
    expect(sanitizeSettings({ terminalButtonTop: 62.5 }).terminalButtonTop).toBe(62.5)
    expect(sanitizeSettings({ terminalButtonTop: -80 }).terminalButtonTop).toBe(3)
    expect(sanitizeSettings({ terminalButtonTop: 999 }).terminalButtonTop).toBe(TERMINAL_BUTTON_TOP_MAX)
  })

  it('开发期那个只存绝对值的 terminalDockTop 被清掉，且不顶替掉「跟随终端」', () => {
    const value = sanitizeSettings({ terminalDockTop: 50 }) as unknown as Record<string, unknown>
    expect('terminalDockTop' in value).toBe(false)
    expect(value.terminalButtonTop).toBeNull()
  })
})
