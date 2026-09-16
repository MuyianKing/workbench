/**
 * 持久化数据文件（workbench-data.json）的纯逻辑：默认值、逐项收敛（sanitize）、解析。
 *
 * 从 main/store.ts 下沉到这里，是因为「把磁盘上的未知数据收敛成合法结构」与运行环境无关：
 * 适配层落盘前要用它，单测也直接调它，放 shared 才能共用一份（见 AGENTS.md 第 3 节）。
 * 磁盘 IO、路径、防抖落盘不在这里 —— 那些各自留在宿主侧。
 *
 * **这里只管「换台机器就不成立」的那些设置**：程序名称、明暗、主题色、顶部样式、卡片不透明度、
 * 终端高度、工作区背景与首页布局都住在 theme.json 里（见 appearance.ts 的文件头），
 * 同步时整份 theme.json 就是带走的那份配置。
 */
import { DEFAULT_STORED_SETTINGS, stripAppearance } from './appearance'
import { sanitizeAccount } from './auth'
import { sanitizeCommands } from './command'
import { sanitizeQuickApps } from './quick-launch'
import { sanitizeIconCache } from './icon-cache'
import { DEFAULT_SETTINGS, type PersistedData, type StoredSettings } from './types'
import { clampTerminalButtonTop } from './terminal-dock'
import { sanitizeNoteHistory, sanitizeNoteRepo, sanitizeNoteRoot } from './note'
import { sanitizeImageBaseUrl, sanitizeImageDir, sanitizeImageRepo } from './note-image'
import { sanitizeSyncRepo } from './token-usage'
import { pruneDays, sanitizeActivity } from './activity'
import { sanitizeViewId } from './views'

export function emptyData(): PersistedData {
  return {
    projects: [],
    groups: [],
    quickApps: [],
    iconCache: {},
    commands: [],
    settings: { ...DEFAULT_STORED_SETTINGS },
    activeSessions: [],
    activity: {},
    account: null
  }
}

/**
 * 设置项来自磁盘，可能是旧版本写的或是被手工改过的，逐项收敛到合法取值。
 * 缺失的字段（老版本数据文件没有 settings）直接落到默认值。
 *
 * 外观那一批（appName、theme、terminalHeight、背景、主题色、顶部样式、卡片不透明度）
 * 现在住在 theme.json，这里**一律摘掉**：留着它们会成为第二份真源，
 * 而且适配层读设置时会把主题文件里的值合过来（见 mergeSettingsAppearance），
 * 数据文件里的那份永远不会被采纳 —— 只会让下一个看代码的人困惑。
 */
export function sanitizeSettings(raw: unknown): StoredSettings {
  const input = stripAppearance(raw) as Partial<StoredSettings>
  const value: StoredSettings = { ...DEFAULT_STORED_SETTINGS, ...input }

  // 「退出行为」设置已废弃：现在从托盘退出时只要还有项目在跑就统一弹窗让用户选，
  // 旧数据文件里可能还留着这个字段，顺手清掉，免得一直写回。
  delete (value as unknown as Record<string, unknown>).closeBehavior
  // 「最小化到托盘」已废弃：关闭按钮本身就是收进托盘，最小化再收托盘两个按钮就成了同一个动作。
  // 旧数据文件里存着 true 会把行为一直带下去，必须主动清掉。
  delete (value as unknown as Record<string, unknown>).minimizeToTray
  if (typeof value.hotkey !== 'string' || !value.hotkey.trim()) {
    value.hotkey = DEFAULT_SETTINGS.hotkey
  }
  value.launchAtLogin = value.launchAtLogin === true
  value.hotkeyEnabled = value.hotkeyEnabled !== false
  // Token 同步仓库：老数据文件里没有这个字段（默认空串 = 不同步）。
  // 认不出的一律按没填处理，别留一个每次同步都失败的地址在那儿反复重试
  value.tokenSyncRepo = sanitizeSyncRepo(value.tokenSyncRepo)
  // 上次停留的页面：老数据文件里没有，认不出来的值回首页
  value.activeView = sanitizeViewId(value.activeView)
  // 用账号 token 授权同步：老数据文件里没有这个字段。（已登录但关掉它 = 退回系统 git 凭据）
  value.useAccountForSync = value.useAccountForSync !== false
  // 同步时是否连主题文件一起写进仓库：老数据文件里没有，默认开
  value.syncAppearance = value.syncAppearance !== false
  // 终端收起后那颗悬浮按钮的位置：老数据文件里没有这个字段，默认 null（跟随终端面板）。
  // 它落在视口外面的话用户再也够不着这颗按钮，必须在这里拦住
  value.terminalButtonTop = clampTerminalButtonTop(value.terminalButtonTop)
  // 笔记文件夹：老数据文件里没有它（默认空串 = 还没选过，笔记页显示引导）。
  // 收尾的空白与分隔符在这里现收敛：值是要拿去拼文件路径的
  value.noteDir = sanitizeNoteRoot(value.noteDir)
  // 打开过的笔记本清单（笔记页左栏底部的「最近打开」）：老数据文件里没有，默认空；
  // 手工改坏过、重复、超上限的都在这里收敛
  value.noteDirs = sanitizeNoteHistory(value.noteDirs)
  // 笔记仓库地址：老数据文件里没有，默认空串（不同步）。认不出的一律按没填处理 ——
  // 与 Token 同步仓库同一个道理：留着一个每次同步都失败的地址在那儿反复重试，不如关掉
  value.noteSyncRepo = sanitizeNoteRepo(value.noteSyncRepo)
  // 图片仓库三项：老数据文件里没有，默认未配置 / images / 自动推导。
  // 地址那一项与 Token 同步仓库同一条口径（含空白、以 `-` 开头的一律当没填）
  value.noteImageRepo = sanitizeImageRepo(value.noteImageRepo)
  value.noteImageDir = sanitizeImageDir(value.noteImageDir)
  value.noteImageBaseUrl = sanitizeImageBaseUrl(value.noteImageBaseUrl)
  // 这个字段的开发期名字，存的是「绝对值、没有跟随终端这一档」。它只出现在未发布的中间版本里，
  // 而那个值会把「跟随终端」这档永远盖住 —— 清掉，免得它一直写回数据文件当第二份真源。
  delete (value as unknown as Record<string, unknown>).terminalDockTop

  return value
}

/**
 * 把磁盘上的未知数据收敛成一份完整的 PersistedData。
 * uuid 由调用方注入：渲染层用 crypto.randomUUID，主进程用 node:crypto。
 */
export function parseData(raw: unknown, uuid: () => string): PersistedData {
  const parsed = (raw ?? {}) as Partial<PersistedData>
  // 快捷启动列表先收敛：图标缓存要按它过滤（见下）
  const quickApps = sanitizeQuickApps(parsed.quickApps, uuid)

  return {
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    // 老数据文件没有这一项；手工改坏过的条目在这里被丢掉或补全
    quickApps,
    // 老数据文件没有这一项；只留还在用的程序，删掉的程序不该把图标一直留在盘上
    iconCache: sanitizeIconCache(
      parsed.iconCache,
      new Set(quickApps.map((app) => app.target))
    ),
    commands: sanitizeCommands(parsed.commands, uuid),
    settings: sanitizeSettings(parsed.settings),
    // 上次被强杀时留下的子进程记录，启动清理要用（漏掉这个字段清理就成了空转）
    activeSessions: Array.isArray(parsed.activeSessions) ? parsed.activeSessions : [],
    // 老数据文件没有这个字段；顺手裁掉图已经画不到的旧计数
    activity: pruneDays(sanitizeActivity(parsed.activity), Date.now()),
    // 老数据文件没有这一项。**只是显示用的资料**：是否真的已登录以凭据管理器为准，
    // 那边没有 token 时适配层会把这份残留资料清掉（见工作区适配层的 auth.ts）
    account: sanitizeAccount(parsed.account)
  }
}
