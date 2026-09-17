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

/**
 * 行为记忆那几项（上次看的是哪一档 / 怎么排的 / 目录树摊开了哪几层）。
 *
 * 它们都会原样写回界面上的选中值，所以「老文件里没有」与「文件被手工改坏」两条路
 * 都得落到一个控件认得出的值上 —— 这是磁盘边界，测试直接打这里。
 */
describe('行为记忆那几项设置', () => {
  it('老数据文件里没有时落到默认档', () => {
    const value = sanitizeSettings({})
    expect(value.projectSort).toBe('recent')
    expect(value.workRange).toBe('today')
    expect(value.workSort).toBe('time')
    expect(value.noteTreeExpanded).toEqual([])
  })

  it('认得出的取值原样保留', () => {
    const value = sanitizeSettings({
      projectSort: 'name',
      workRange: 'month',
      workSort: 'project',
      noteTreeExpanded: ['工作', '工作/周报']
    })
    expect(value.projectSort).toBe('name')
    expect(value.workRange).toBe('month')
    expect(value.workSort).toBe('project')
    expect(value.noteTreeExpanded).toEqual(['工作', '工作/周报'])
  })

  it('认不出的取值回默认，摊开的路径按笔记那套收敛', () => {
    const value = sanitizeSettings({
      projectSort: 'size',
      workRange: 3,
      workSort: null,
      noteTreeExpanded: ['工作\\周报', '../越界', '', '工作/周报']
    })
    expect(value.projectSort).toBe('recent')
    expect(value.workRange).toBe('today')
    expect(value.workSort).toBe('time')
    expect(value.noteTreeExpanded).toEqual(['工作/周报'])
  })

  /** 外观那一批要留在 theme.json 里；这几项反过来必须留在数据文件里，不能被当成外观摘掉 */
  it('它们不是外观项，不会被 stripAppearance 摘掉', () => {
    const value = sanitizeSettings({ appearance: { projectSort: 'name' }, projectSort: 'created' })
    expect(value.projectSort).toBe('created')
  })
})
