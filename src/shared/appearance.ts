/**
 * 外观配置：**哪些设置算「看起来什么样」，以及它们在文件里怎么落**。
 *
 * 这些项住在主题文件 `theme.json` 里（和首页布局同一个文件），不跟 `workbench-data.json` 混：
 *  - 它们与布局是同一类东西（都是「界面长什么样」），一起读一起写正好；
 *  - 同步时整份 theme.json 就是一台机器要带给另一台机器的那份配置（见 sync-config.ts）；
 *  - 反过来，快捷键 / 开机自启 / 同步仓库地址这些换台机器就不成立，留在数据文件里，
 *    天然不会被同步带过去 —— 把仓库地址同步到另一台机器等于让它往一个它没填过的地址推东西。
 *
 * 渲染层仍然看到**一份完整的 `AppSettings`**（外观那几项照旧在里面）：适配层在读的时候把
 * theme.json 的 appearance 合进数据文件的设置（`mergeSettingsAppearance`），写的时候再按
 * 白名单分流（`splitSettingsPatch`）。文件怎么存是宿主的事，组件不必知道。
 *
 * 背景图这里有个如实的代价：外观是整份复制的，所以另一台机器上自定义的图片路径会跟着过去，
 * 而那个路径在那边不存在 —— 界面会照实显示「图片读不出来」，用户重新选一张即可。
 * 内置壁纸（`builtin:<id>`）没有这个问题，它在两台机器上指向同一张随包发布的图。
 */
import { sanitizeAccentColor, sanitizeAccentInkMode, type AccentInkMode } from './accent-color'
import { sanitizeAppName } from './app-name'
import { clampCardOpacity } from './card-opacity'
import { clampTerminalHeight } from './terminal-height'
import {
  DEFAULT_SETTINGS,
  TOP_BAR_STYLES,
  type AppSettings,
  type StoredSettings,
  type ThemeSource,
  type TopBarStyle
} from './types'
import { clampBackgroundOpacity, sanitizeBackgroundPath, sanitizeVeilColor } from './workspace-background'
import { sanitizeHiddenViews, type ViewId } from './views'

/**
 * 住在 theme.json 里的设置项，也是「一台机器要带给另一台机器」的那份配置。
 *
 * **不在**这里的都是有意的：开机自启、全局快捷键是每台机器各自适配系统的东西，
 * 同步仓库地址更是只对本机成立；项目列表、快捷启动、独立命令那些带本机路径的数据同理。
 */
export const APPEARANCE_SETTING_KEYS = [
  'appName',
  'theme',
  'terminalHeight',
  'workspaceBackground',
  'workspaceBackgroundOpacity',
  'workspaceBackgroundVeil',
  'accentColor',
  'accentInk',
  'topBarStyle',
  'cardOpacity',
  'hiddenViews'
] as const

export type AppearanceSettingKey = (typeof APPEARANCE_SETTING_KEYS)[number]

export interface AppearanceSettings {
  appName: string
  theme: ThemeSource
  /** 终端面板展开时的高度（px） */
  terminalHeight: number
  /** 工作区背景：磁盘路径或内置壁纸引用，空串表示用默认画布 */
  workspaceBackground: string
  workspaceBackgroundOpacity: number
  workspaceBackgroundVeil: string
  accentColor: string
  accentInk: AccentInkMode
  topBarStyle: TopBarStyle
  cardOpacity: number
  /** 左侧导航栏上关掉的页（见 views.ts）：这是「导航栏长什么样」，同样是配置而不是机器状态 */
  hiddenViews: ViewId[]
}

const THEME_SOURCES: readonly ThemeSource[] = ['system', 'light', 'dark']

/** 认不出来的明暗取值一律回到默认（数据文件那份设置的收敛也走这里，全项目只有一个口径） */
export function sanitizeThemeSource(value: unknown): ThemeSource {
  return THEME_SOURCES.includes(value as ThemeSource)
    ? (value as ThemeSource)
    : DEFAULT_SETTINGS.theme
}

function sanitizeTopBarStyle(value: unknown): TopBarStyle {
  return TOP_BAR_STYLES.includes(value as TopBarStyle)
    ? (value as TopBarStyle)
    : DEFAULT_SETTINGS.topBarStyle
}

/**
 * 收敛一份外观设置：缺一项补默认、认不出来的取值回默认、越界的夹到区间内。
 * 它既是「磁盘上的老文件 / 手改过的文件」的防线，也是包在远端那份配置外面的防线。
 */
export function sanitizeAppearanceSettings(raw: unknown): AppearanceSettings {
  // 默认值先铺一层（外观这项在数据文件的默认设置里就有一份完整取值），再让入参盖上去
  const value = { ...pickAppearance(DEFAULT_SETTINGS), ...pickAppearance(raw) }
  return {
    appName: sanitizeAppName(value.appName),
    theme: sanitizeThemeSource(value.theme),
    terminalHeight: clampTerminalHeight(value.terminalHeight),
    // 图片读不出来不在这里拦（路径本来就可能指向别处的文件）：宿主读图时给出具体原因
    workspaceBackground: sanitizeBackgroundPath(value.workspaceBackground),
    workspaceBackgroundOpacity: clampBackgroundOpacity(value.workspaceBackgroundOpacity),
    workspaceBackgroundVeil: sanitizeVeilColor(value.workspaceBackgroundVeil),
    accentColor: sanitizeAccentColor(value.accentColor),
    accentInk: sanitizeAccentInkMode(value.accentInk),
    topBarStyle: sanitizeTopBarStyle(value.topBarStyle),
    cardOpacity: clampCardOpacity(value.cardOpacity),
    hiddenViews: sanitizeHiddenViews(value.hiddenViews)
  }
}

/** 对象才谈得上「有没有这些字段」；null / 数组 / 字符串一律当空 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只挑出外观那一批键（值保持原样，收敛交给 sanitizeAppearanceSettings） */
export function pickAppearance(raw: unknown): Partial<AppearanceSettings> {
  if (!isRecord(raw)) return {}
  const picked: Record<string, unknown> = {}
  for (const key of APPEARANCE_SETTING_KEYS) {
    if (key in raw) picked[key] = raw[key]
  }
  return picked as Partial<AppearanceSettings>
}

/** 从一份完整设置里摘掉外观项，得到数据文件里该存的那部分 */
export function stripAppearance(raw: unknown): StoredSettings {
  if (!isRecord(raw)) return {} as StoredSettings
  const rest = { ...raw }
  for (const key of APPEARANCE_SETTING_KEYS) delete rest[key]
  return rest as StoredSettings
}

/** 数据文件的设置 ＋ 主题文件的外观 = 渲染层看到的完整设置 */
export function mergeSettingsAppearance(stored: StoredSettings, appearance: unknown): AppSettings {
  return { ...stored, ...sanitizeAppearanceSettings(appearance) }
}

/**
 * 把一份设置补丁按落点拆开：外观那几项归 theme.json，其余归数据文件。
 * 返回的 appearance 里只含补丁真正带了的键（没带的不动），settings 同理。
 */
export function splitSettingsPatch(patch: Partial<AppSettings>): {
  settings: Partial<StoredSettings>
  appearance: Partial<AppearanceSettings>
} {
  const appearance = pickAppearance(patch)
  const settings = { ...patch }
  for (const key of Object.keys(appearance)) {
    delete (settings as Record<string, unknown>)[key]
  }
  return { settings: settings as Partial<StoredSettings>, appearance }
}

export const DEFAULT_APPEARANCE: AppearanceSettings = sanitizeAppearanceSettings(DEFAULT_SETTINGS)

export const DEFAULT_STORED_SETTINGS: StoredSettings = stripAppearance(DEFAULT_SETTINGS)

/**
 * 老数据的搬家：外观那几项原本住在数据文件的 settings 里，主题文件里没有它们。
 *
 * 读主题时如果发现主题文件还没带 appearance，就把数据文件里那几项搬进去 ——
 * 不然升级之后用户的主题色、背景图、终端高度会静悄悄回到默认值。
 * 没得搬（两处都没有）时返回原对象，调用方据此判断「要不要立刻落盘」（见适配层的 initState）。
 */
export function migrateAppearanceIntoTheme(rawTheme: unknown, rawSettings: unknown): unknown {
  if (isRecord(rawTheme) && isRecord(rawTheme.appearance)) return rawTheme

  const appearance = pickAppearance(rawSettings)
  if (Object.keys(appearance).length === 0) return rawTheme
  return { ...(isRecord(rawTheme) ? rawTheme : {}), appearance }
}
