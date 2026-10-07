/**
 * 外观包的纯域测试：默认外观的唯一口径、一份外观设置的收敛、theme.json 的整份收敛。
 *
 * 「哪些键算外观、怎么在数据文件与主题文件之间分流、老数据怎么搬家」的桥接测试
 * 在应用侧的 persisted-data.test.ts —— 那几个桥接函数吃 AppSettings（应用级类型），
 * 随 monorepo 化搬过去了。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, sanitizeAppearanceSettings, sanitizeThemeSource, stripAppearance } from './appearance'
import { columnIds, columnOfRow, DEFAULT_THEME, rowOf, sanitizeTheme } from './theme'

describe('收敛一份外观', () => {
  it('缺项补默认、认不出来的回默认、越界的夹住', () => {
    const clean = sanitizeAppearanceSettings({
      appName: '',
      theme: 'neon',
      topBarStyle: 'rainbow',
      accentInk: 'chartreuse',
      accentColor: 'javascript:alert(1)',
      terminalHeight: -100000,
      cardOpacity: 999,
      workspaceBackgroundOpacity: '60',
      workspaceBackgroundVeil: 'red',
      workspaceBackground: '  C:\\Users\\me\\wall.png  ',
    })

    expect(clean.appName).toBe(DEFAULT_APPEARANCE.appName)
    expect(clean.theme).toBe(DEFAULT_APPEARANCE.theme)
    expect(clean.topBarStyle).toBe(DEFAULT_APPEARANCE.topBarStyle)
    expect(clean.accentInk).toBe(DEFAULT_APPEARANCE.accentInk)
    expect(clean.accentColor).toBe('')
    expect(clean.cardOpacity).toBe(100)
    expect(clean.workspaceBackgroundOpacity).toBe(DEFAULT_APPEARANCE.workspaceBackgroundOpacity)
    expect(clean.workspaceBackgroundVeil).toBe('')
    // 背景路径照旧留着（去掉首尾空白）：另一台机器上读不出来是那边的事，不在这里改用户的选择
    expect(clean.workspaceBackground).toBe('C:\\Users\\me\\wall.png')
  })

  it('明暗的收敛只有一个口径（数据文件那份设置的收敛也走它）', () => {
    expect(sanitizeThemeSource('system')).toBe('system')
    expect(sanitizeThemeSource(undefined)).toBe(DEFAULT_APPEARANCE.theme)
    expect(sanitizeThemeSource('DARK')).toBe(DEFAULT_APPEARANCE.theme)
  })

  it('整份认不出来时就是默认外观', () => {
    expect(sanitizeAppearanceSettings(null)).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearanceSettings('外观')).toEqual(DEFAULT_APPEARANCE)
  })

  it('摘掉外观项之后剩下的就是数据文件该存的那部分', () => {
    const stored = stripAppearance({ accentColor: '#ef4444', hotkey: 'Control+J' })

    expect(stored).not.toHaveProperty('accentColor')
    expect(stored.hotkey).toBe('Control+J')
    // 不是对象（null / 数字 / 字符串）一律当空，不能抛错
    expect(stripAppearance(null)).toEqual({})
    expect(stripAppearance(42)).toEqual({})
  })
})

describe('theme.json 的整份收敛', () => {
  it('老主题文件（没有外观、没有时间戳）也能读进来，布局不动', () => {
    const legacy = {
      version: 3,
      cardGap: 14,
      columns: [
        { id: 'col-1', width: 320 },
        { id: 'col-2', width: null },
      ],
      cards: { quick: { column: 'col-2', order: 0, mode: 'fixed', height: 120 } },
    }
    const theme = sanitizeTheme(legacy)

    expect(theme.cardGap).toBe(14)
    expect(columnIds(theme.columns)).toEqual(['col-1', 'col-2'])
    expect(theme.columns.map(column => column.width)).toEqual([320, null])
    // 卡片挪到了「行」这一层，老结构里那份高度与模式一样带了过来
    expect(columnOfRow(theme.columns, theme.cards.quick.row)?.id).toBe('col-2')
    expect(rowOf(theme.columns, theme.cards.quick.row)).toEqual({
      id: theme.cards.quick.row,
      mode: 'fixed',
      height: 120,
    })
    expect(theme.appearance).toEqual(DEFAULT_APPEARANCE)
    expect(theme.updatedAt).toBe(0)
  })

  it('时间戳只认正数，其余归 0（表示时间未知）', () => {
    expect(sanitizeTheme({ version: DEFAULT_THEME.version, updatedAt: 1234 }).updatedAt).toBe(1234)
    expect(sanitizeTheme({ version: DEFAULT_THEME.version, updatedAt: -5 }).updatedAt).toBe(0)
    expect(sanitizeTheme({ version: DEFAULT_THEME.version, updatedAt: 'x' }).updatedAt).toBe(0)
  })
})
