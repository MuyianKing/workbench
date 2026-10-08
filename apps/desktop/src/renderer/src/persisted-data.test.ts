import type { AppSettings, StoredSettings } from './types'
import { APPEARANCE_SETTING_KEYS, columnIds, columnOfRow, DEFAULT_APPEARANCE, DEFAULT_THEME, pickAppearance, rowOf, sanitizeAppearanceSettings, sanitizeTheme, stripAppearance, TERMINAL_BUTTON_TOP_MAX } from '@workbench/appearance'
import { describe, expect, it } from 'vitest'
import { DEFAULT_STORED_SETTINGS, mergeSettingsAppearance, migrateAppearanceIntoTheme, sanitizeSettings, splitSettingsPatch } from './persisted-data'
import { DEFAULT_SETTINGS } from './types'

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
      noteTreeExpanded: ['工作', '工作/周报'],
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
      noteTreeExpanded: ['工作\\周报', '../越界', '', '工作/周报'],
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

/**
 * 外观配置的分流与搬家：哪些设置住在 theme.json、老数据怎么搬过去、渲染层看到的那份怎么合出来。
 *
 * 盯的是三类不会报错、只看结果不对的问题：
 *  - 白名单漏了一项，那项就再也不落盘（改一次设置、重启就回到默认值）；
 *  - 分流写错了地方，数据文件里留下一份永远不会被采纳的副本；
 *  - 老数据没搬过去，升级一次用户的主题色 / 背景 / 终端高度静悄悄回到默认。
 *
 * 这组测试原先在 @workbench/appearance 包里，桥接函数（merge / split / migrate）随
 * monorepo 化搬进了 persisted-data.ts —— 它们吃 AppSettings / StoredSettings，那是应用级类型。
 */
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
  })
})

describe('按落点拆一份设置补丁', () => {
  it('外观归主题文件，其余归数据文件，没提到的键两边都不出现', () => {
    const { settings: stored, appearance } = splitSettingsPatch({
      accentColor: '#3b82f6',
      terminalHeight: 300,
      activeView: 'projects',
    })

    expect(appearance).toEqual({ accentColor: '#3b82f6', terminalHeight: 300 })
    expect(stored).toEqual({ activeView: 'projects' })
  })

  it('只改非外观项时外观那一半是空的（调用方据此决定要不要动主题文件）', () => {
    const { settings: stored, appearance } = splitSettingsPatch({ hotkeyEnabled: false })
    expect(Object.keys(appearance)).toHaveLength(0)
    expect(stored).toEqual({ hotkeyEnabled: false })
  })

  it('导航菜单那一项算外观：住在 theme.json 里，跟着配置一起同步', () => {
    const { settings: stored, appearance } = splitSettingsPatch({
      hiddenViews: ['notes'],
      activeView: 'projects',
    })

    expect(appearance).toEqual({ hiddenViews: ['notes'] })
    // 当前页留在数据文件里：「这台机器上次停在哪儿」换台机器就不成立
    expect(stored).toEqual({ activeView: 'projects' })
    expect(DEFAULT_STORED_SETTINGS).not.toHaveProperty('hiddenViews')
  })

  it('关掉的页一样要过收敛（手改过的主题文件可能写着认不出来的 id）', () => {
    expect(sanitizeAppearanceSettings({ hiddenViews: ['notes', 'nope', 'notes'] }).hiddenViews).toEqual([
      'notes',
    ])
    expect(sanitizeAppearanceSettings({ hiddenViews: 'notes' }).hiddenViews).toEqual([])
  })

  it('导航栏顺序同样算外观，也要收敛成一个完整排列', () => {
    const { appearance } = splitSettingsPatch({ viewOrder: ['notes', 'home'] })
    expect(appearance).toEqual({ viewOrder: ['notes', 'home'] })

    // 认不出来的丢掉，落下的按默认顺序补到末尾；不是数组就回默认
    expect(sanitizeAppearanceSettings({ viewOrder: ['notes', 'nope', 'home'] }).viewOrder).toEqual([
      'notes',
      'home',
      'projects',
      'work',
      'skills',
      'kb',
      'ai',
      'vault',
      'mail',
      'styles',
      'video',
    ])
    expect(sanitizeAppearanceSettings({ viewOrder: 'notes' }).viewOrder.length).toBe(11)
  })

  it('合回来的设置与拆之前一致', () => {
    const before = settings({ accentColor: '#ef4444', hotkey: 'Control+J', terminalHeight: 250 })
    const patch = { accentColor: '#22c55e', terminalHeight: 320 } as Partial<AppSettings>
    const { settings: stored, appearance } = splitSettingsPatch(patch)

    const merged = mergeSettingsAppearance(
      { ...(stripAppearance(before) as StoredSettings), ...stored },
      { ...pickAppearance(before), ...appearance },
    )
    expect(merged).toEqual({ ...before, ...patch })
  })
})

describe('老数据搬家', () => {
  it('主题文件里还没有外观时，从数据文件的设置里搬过去', () => {
    const legacyTheme = { version: 2, cardGap: 14, cards: {} }
    const legacySettings = { accentColor: '#ef4444', terminalHeight: 320, hotkey: 'Control+J' }

    const migrated = sanitizeTheme(migrateAppearanceIntoTheme(legacyTheme, legacySettings))

    expect(migrated.appearance.accentColor).toBe('#ef4444')
    expect(migrated.appearance.terminalHeight).toBe(320)
    // 布局与其余设置都照旧（搬外观不能顺手把布局清了）
    expect(migrated.cardGap).toBe(14)
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
      { theme: 'neon', cardOpacity: 999, terminalHeight: 'tall' },
    )
    const appearance = sanitizeTheme(migrated).appearance

    expect(appearance.theme).toBe(DEFAULT_APPEARANCE.theme)
    expect(appearance.cardOpacity).toBe(100)
    expect(appearance.terminalHeight).toBe(DEFAULT_APPEARANCE.terminalHeight)
  })

  it('单个 mailAccount 搬成 mailAccounts 清单，旧字段不再写回', () => {
    const value = sanitizeSettings({
      mailAccount: { address: 'A@163.com', imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465 },
    })
    expect(value.mailAccounts).toHaveLength(1)
    expect(value.mailAccounts[0].address).toBe('a@163.com')
    expect(value.mailAccounts[0].imapHost).toBe('imap.163.com')
    // 授权码按地址住在凭据管理器里，搬清单不用动它；旧字段清掉免得一直写回
    expect('mailAccount' in (value as unknown as Record<string, unknown>)).toBe(false)
  })

  it('mailAccounts 清单照常收敛：没地址的丢、按地址去重', () => {
    const value = sanitizeSettings({
      mailAccounts: [{ address: 'a@163.com' }, { address: 'a@163.com' }, { imapHost: 'x' }, { address: 'b@qq.com' }],
    })
    expect(value.mailAccounts.map(account => account.address)).toEqual(['a@163.com', 'b@qq.com'])
    expect(value.mailAccounts[1].imapHost).toBe('imap.qq.com')
  })

  it('后台检查周期：没填回默认 30，0 保留为关闭，其余夹进范围', () => {
    expect(sanitizeSettings({}).mailPollMinutes).toBe(30)
    expect(sanitizeSettings({ mailPollMinutes: 0 }).mailPollMinutes).toBe(0)
    expect(sanitizeSettings({ mailPollMinutes: 10 }).mailPollMinutes).toBe(10)
    expect(sanitizeSettings({ mailPollMinutes: 1 }).mailPollMinutes).toBe(1)
    expect(sanitizeSettings({ mailPollMinutes: -3 }).mailPollMinutes).toBe(1)
    expect(sanitizeSettings({ mailPollMinutes: 'x' }).mailPollMinutes).toBe(30)
  })

  it('两边都没有时清单是空的（出口关闭）', () => {
    expect(sanitizeSettings({}).mailAccounts).toEqual([])
  })

  it('原始数据的来源：老数据文件里没有就是空清单（一律读库里的 data/raw）', () => {
    expect(sanitizeSettings({}).kbRawSources).toEqual([])
  })

  it('原始数据的来源逐项收敛：缺项丢掉、同名去重、指到知识库文件夹里的按没配处理', () => {
    const value = sanitizeSettings({
      kbDir: 'E:/muyian/agent',
      kbRawSources: [
        { root: 'E:/muyian/agent', name: 'mu-ui', dir: 'D:/work/mu-ui' },
        { root: 'E:/muyian/agent', name: 'mu-ui', dir: 'D:/other' },
        { root: 'E:/muyian/agent', name: 'v2', dir: 'E:\\muyian\\agent\\data\\raw\\v2' },
        { name: '没有 root', dir: 'D:/x' },
      ],
    })
    expect(value.kbRawSources).toEqual([
      { root: 'E:/muyian/agent', name: 'mu-ui', dir: 'D:/work/mu-ui' },
      { root: 'E:/muyian/agent', name: 'v2', dir: '' },
    ])
  })
})

describe('theme.json 的整份收敛（适配层视角）', () => {
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
  })
})
