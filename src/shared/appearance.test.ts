/**
 * 外观配置的分流与搬家：哪些设置住在 theme.json、老数据怎么搬过去、渲染层看到的那份怎么合出来。
 *
 * 盯的是三类不会报错、只看结果不对的问题：
 *  - 白名单漏了一项，那项就再也不落盘（改一次设置、重启就回到默认值）；
 *  - 分流写错了地方，数据文件里留下一份永远不会被采纳的副本；
 *  - 老数据没搬过去，升级一次用户的主题色 / 背景 / 终端高度静悄悄回到默认。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from './types'
import {
  APPEARANCE_SETTING_KEYS,
  DEFAULT_APPEARANCE,
  DEFAULT_STORED_SETTINGS,
  mergeSettingsAppearance,
  migrateAppearanceIntoTheme,
  pickAppearance,
  sanitizeAppearanceSettings,
  sanitizeThemeSource,
  splitSettingsPatch,
  stripAppearance
} from './appearance'
import { DEFAULT_THEME, sanitizeTheme } from './theme'

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

describe('哪些设置算外观', () => {
  it('白名单里的项一个都不能少（漏了就再也存不下去）', () => {
    // 每一项都必须真的存在于 AppSettings 里（拼错了这里会先挂）
    for (const key of APPEARANCE_SETTING_KEYS) {
      expect(DEFAULT_SETTINGS).toHaveProperty(key)
    }

    // 反过来：这几项是「换台机器就不成立」的，绝不能进外观
    const stored = DEFAULT_STORED_SETTINGS as Record<string, unknown>
    for (const key of ['hotkey', 'hotkeyEnabled', 'launchAtLogin', 'tokenSyncRepo', 'activeView']) {
      expect(stored).toHaveProperty(key)
      expect(APPEARANCE_SETTING_KEYS as readonly string[]).not.toContain(key)
    }
  })

  it('默认外观就是默认设置里那一批，不另立一份口径', () => {
    expect(DEFAULT_APPEARANCE).toEqual(pickAppearance(DEFAULT_SETTINGS))
    expect(mergeSettingsAppearance(DEFAULT_STORED_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('摘掉外观项之后剩下的就是数据文件该存的那部分', () => {
    const stored = stripAppearance(settings({ accentColor: '#ef4444', hotkey: 'Control+J' }))

    expect(stored).not.toHaveProperty('accentColor')
    expect(stored.hotkey).toBe('Control+J')
    // 不是对象（null / 数字 / 字符串）一律当空，不能抛错
    expect(stripAppearance(null)).toEqual({})
    expect(stripAppearance(42)).toEqual({})
  })
})

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
      workspaceBackground: '  C:\\Users\\me\\wall.png  '
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
    expect(sanitizeThemeSource(undefined)).toBe(DEFAULT_SETTINGS.theme)
    expect(sanitizeThemeSource('DARK')).toBe(DEFAULT_SETTINGS.theme)
  })

  it('整份认不出来时就是默认外观', () => {
    expect(sanitizeAppearanceSettings(null)).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearanceSettings('外观')).toEqual(DEFAULT_APPEARANCE)
  })
})

describe('按落点拆一份设置补丁', () => {
  it('外观归主题文件，其余归数据文件，没提到的键两边都不出现', () => {
    const { settings: stored, appearance } = splitSettingsPatch({
      accentColor: '#3b82f6',
      terminalHeight: 300,
      activeView: 'projects'
    })

    expect(appearance).toEqual({ accentColor: '#3b82f6', terminalHeight: 300 })
    expect(stored).toEqual({ activeView: 'projects' })
  })

  it('只改非外观项时外观那一半是空的（调用方据此决定要不要动主题文件）', () => {
    const { settings: stored, appearance } = splitSettingsPatch({ hotkeyEnabled: false })
    expect(Object.keys(appearance)).toHaveLength(0)
    expect(stored).toEqual({ hotkeyEnabled: false })
  })

  it('合回来的设置与拆之前一致', () => {
    const before = settings({ accentColor: '#ef4444', hotkey: 'Control+J', terminalHeight: 250 })
    const patch = { accentColor: '#22c55e', terminalHeight: 320 } as Partial<AppSettings>
    const { settings: stored, appearance } = splitSettingsPatch(patch)

    const merged = mergeSettingsAppearance(
      { ...stripAppearance(before), ...stored },
      { ...pickAppearance(before), ...appearance }
    )
    expect(merged).toEqual({ ...before, ...patch })
  })
})

describe('老数据搬家', () => {
  it('主题文件里还没有外观时，从数据文件的设置里搬过去', () => {
    const legacyTheme = { version: 2, gridStep: 2, cards: {} }
    const legacySettings = { accentColor: '#ef4444', terminalHeight: 320, hotkey: 'Control+J' }

    const migrated = sanitizeTheme(migrateAppearanceIntoTheme(legacyTheme, legacySettings))

    expect(migrated.appearance.accentColor).toBe('#ef4444')
    expect(migrated.appearance.terminalHeight).toBe(320)
    // 布局与其余设置都照旧（搬外观不能顺手把布局清了）
    expect(migrated.gridStep).toBe(2)
  })

  it('主题文件里已经有外观时不再搬（否则每次启动都把新值覆盖回老的）', () => {
    const theme = { version: 2, appearance: { accentColor: '#22c55e' } }
    const raw = migrateAppearanceIntoTheme(theme, { accentColor: '#ef4444' })

    // 同一份对象原样返回：调用方据此判断「没搬家，不用落盘」
    expect(raw).toBe(theme)
    expect(sanitizeTheme(raw).appearance.accentColor).toBe('#22c55e')
  })

  it('两处都没有外观时返回原值，不做无意义的落盘', () => {
    const theme = { version: 2 }
    expect(migrateAppearanceIntoTheme(theme, { hotkey: 'Control+J' })).toBe(theme)
    expect(migrateAppearanceIntoTheme(null, null)).toBeNull()
  })

  it('搬过来的值一样要过收敛（老数据文件可能是手改过的）', () => {
    const migrated = migrateAppearanceIntoTheme(
      { version: 2 },
      { theme: 'neon', cardOpacity: 999, terminalHeight: 'tall' }
    )
    const appearance = sanitizeTheme(migrated).appearance

    expect(appearance.theme).toBe(DEFAULT_APPEARANCE.theme)
    expect(appearance.cardOpacity).toBe(100)
    expect(appearance.terminalHeight).toBe(DEFAULT_APPEARANCE.terminalHeight)
  })
})

describe('theme.json 的整份收敛', () => {
  it('老主题文件（没有外观、没有时间戳）也能读进来，布局不动', () => {
    const legacy = {
      version: DEFAULT_THEME.version,
      gridStep: 3,
      cardGap: 14,
      leftWidth: 320,
      rightWidth: 260,
      cards: { quick: { column: 'center', order: 0, mode: 'fixed', height: 120 } }
    }
    const theme = sanitizeTheme(legacy)

    expect(theme.gridStep).toBe(3)
    expect(theme.leftWidth).toBe(320)
    expect(theme.cards.quick.column).toBe('center')
    expect(theme.appearance).toEqual(DEFAULT_APPEARANCE)
    expect(theme.updatedAt).toBe(0)
  })

  it('时间戳只认正数，其余归 0（表示时间未知）', () => {
    expect(sanitizeTheme({ version: DEFAULT_THEME.version, updatedAt: 1234 }).updatedAt).toBe(1234)
    expect(sanitizeTheme({ version: DEFAULT_THEME.version, updatedAt: -5 }).updatedAt).toBe(0)
    expect(sanitizeTheme({ version: DEFAULT_THEME.version, updatedAt: 'x' }).updatedAt).toBe(0)
  })
})
