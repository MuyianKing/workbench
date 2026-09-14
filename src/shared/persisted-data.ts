/**
 * 持久化数据文件的纯逻辑：默认值、逐项收敛（sanitize）、解析。
 *
 * 从 main/store.ts 下沉到这里，是因为「把磁盘上的未知数据收敛成合法结构」与运行环境无关：
 * Electron 主进程与 Tauri 侧的适配层都要用它，放 shared 才能两边共用一份（见 AGENTS.md 第 3 节）。
 * 磁盘 IO、路径、防抖落盘不在这里 —— 那些各自留在宿主侧。
 */
import { sanitizeAccentColor, sanitizeAccentInkMode } from './accent-color'
import { sanitizeCommands } from './command'
import { sanitizeQuickApps } from './quick-launch'
import { sanitizeAppName } from './app-name'
import { DEFAULT_SETTINGS, TOP_BAR_STYLES, type AppSettings, type PersistedData } from './types'
import { clampTerminalHeight } from './terminal-height'
import { clampCardOpacity } from './card-opacity'
import {
  clampBackgroundOpacity,
  sanitizeBackgroundPath,
  sanitizeVeilColor
} from './workspace-background'
import { pruneDays, sanitizeActivity } from './activity'

export function emptyData(): PersistedData {
  return {
    projects: [],
    groups: [],
    quickApps: [],
    commands: [],
    settings: { ...DEFAULT_SETTINGS },
    activeSessions: [],
    activity: {}
  }
}

/**
 * 设置项来自磁盘，可能是旧版本写的或是被手工改过的，逐项收敛到合法取值。
 * 缺失的字段（老版本数据文件没有 settings）直接落到默认值。
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  const input = (raw ?? {}) as Partial<AppSettings>
  const value: AppSettings = { ...DEFAULT_SETTINGS, ...input }

  // 「退出行为」设置已废弃：现在从托盘退出时只要还有项目在跑就统一弹窗让用户选，
  // 旧数据文件里可能还留着这个字段，顺手清掉，免得一直写回。
  delete (value as unknown as Record<string, unknown>).closeBehavior
  // 「最小化到托盘」已废弃：关闭按钮本身就是收进托盘，最小化再收托盘两个按钮就成了同一个动作。
  // 旧数据文件里存着 true 会把行为一直带下去，必须主动清掉。
  delete (value as unknown as Record<string, unknown>).minimizeToTray
  // 程序名称：老数据文件里没有，空白名会让标题栏空掉，统一收敛
  value.appName = sanitizeAppName(value.appName)
  if (value.theme !== 'system' && value.theme !== 'light' && value.theme !== 'dark') {
    value.theme = DEFAULT_SETTINGS.theme
  }
  if (typeof value.hotkey !== 'string' || !value.hotkey.trim()) {
    value.hotkey = DEFAULT_SETTINGS.hotkey
  }
  value.launchAtLogin = value.launchAtLogin === true
  value.hotkeyEnabled = value.hotkeyEnabled !== false
  // 终端高度是拖出来的像素值，老数据文件里没有；非法值落回默认高度
  value.terminalHeight = clampTerminalHeight(value.terminalHeight)
  // 背景图：老数据文件里没有。图片被删 / 换了格式读不出来时不在这里拦，
  // 由宿主读图时给出具体原因，界面才好提示用户重新选一张
  value.workspaceBackground = sanitizeBackgroundPath(value.workspaceBackground)
  value.workspaceBackgroundOpacity = clampBackgroundOpacity(value.workspaceBackgroundOpacity)
  // 蒙版色：认不出来的写法一律当「跟随主题」，别让一个手改过的色值把整条 background 拼废
  value.workspaceBackgroundVeil = sanitizeVeilColor(value.workspaceBackgroundVeil)
  // 主题色：同理，认不出来的一律回到默认的中性色，别让一个手改过的色值把整族主色带崩
  value.accentColor = sanitizeAccentColor(value.accentColor)
  value.accentInk = sanitizeAccentInkMode(value.accentInk)
  // 顶部样式：老数据文件里没有这个字段，认不出的取值一律回到默认那一种
  if (!TOP_BAR_STYLES.includes(value.topBarStyle)) value.topBarStyle = DEFAULT_SETTINGS.topBarStyle
  // 卡片不透明度：老数据文件里没有这个字段，越界 / 非法值落回完全实底
  value.cardOpacity = clampCardOpacity(value.cardOpacity)

  return value
}

/**
 * 把磁盘上的未知数据收敛成一份完整的 PersistedData。
 * uuid 由调用方注入：渲染层用 crypto.randomUUID，主进程用 node:crypto。
 */
export function parseData(raw: unknown, uuid: () => string): PersistedData {
  const parsed = (raw ?? {}) as Partial<PersistedData>
  return {
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    // 老数据文件没有这一项；手工改坏过的条目在这里被丢掉或补全
    quickApps: sanitizeQuickApps(parsed.quickApps, uuid),
    commands: sanitizeCommands(parsed.commands, uuid),
    settings: sanitizeSettings(parsed.settings),
    // 上次被强杀时留下的子进程记录，启动清理要用（漏掉这个字段清理就成了空转）
    activeSessions: Array.isArray(parsed.activeSessions) ? parsed.activeSessions : [],
    // 老数据文件没有这个字段；顺手裁掉图已经画不到的旧计数
    activity: pruneDays(sanitizeActivity(parsed.activity), Date.now())
  }
}
