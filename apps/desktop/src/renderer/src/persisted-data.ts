/**
 * 持久化数据文件（workbench-data.json）的纯逻辑：默认值、逐项收敛（sanitize）、解析，
 * 外加 theme.json 与数据文件之间的分流桥接（merge / split / migrate）。
 *
 * 从 main/store.ts 下沉到渲染层，是因为「把磁盘上的未知数据收敛成合法结构」与运行环境无关：
 * 适配层落盘前要用它，单测也直接调它，放渲染层才能共用一份。磁盘 IO、路径、防抖落盘不在这里
 * —— 那些各自留在宿主侧。逐项的收敛函数住在各自的域包（@workbench/*），这里只做编排。
 *
 * **这里只管「换台机器就不成立」的那些设置**：程序名称、明暗、主题色、顶部样式、卡片不透明度、
 * 终端高度、工作区背景、导航菜单显示哪几页与首页布局都住在 theme.json 里（见 @workbench/appearance
 * 的文件头），同步时整份 theme.json 就是带走的那份配置。
 */
import {
  clampTerminalButtonTop,
  pickAppearance,
  sanitizeAppearanceSettings,
  sanitizeViewId,
  stripAppearance,
  type AppearanceSettings
} from '@workbench/appearance'
import { sanitizeAccount } from '@workbench/auth'
import {
  pruneDays,
  sanitizeActivity,
  sanitizeCommands,
  sanitizeIconCache,
  sanitizeProjectSort,
  sanitizeQuickApps
} from '@workbench/core'
import {
  pickAiActiveSession,
  sanitizeAiApiFormat,
  sanitizeAiBaseUrl,
  sanitizeAiModelId,
  sanitizeAiModels,
  sanitizeAiName,
  sanitizeAiPermission,
  sanitizeAiProviders,
  sanitizeAiSessionId,
  sanitizeAiSessions,
  sanitizeAiSkillsOff,
  sanitizeAiThinking,
  type AiProvider
} from '@workbench/ai'
import {
  sanitizeImageRepo,
  sanitizeNoteHistory,
  sanitizeNoteRoot,
  sanitizeNoteTreeExpanded
} from '@workbench/notes'
import { sanitizeSyncRepo } from '@workbench/usage'
import {
  sanitizeVideoHistory,
  sanitizeVideoLastRel,
  sanitizeVideoRoot,
  sanitizeVideoTreeExpanded
} from '@workbench/video'
import { sanitizeWeatherCity } from '@workbench/weather'
import { sanitizeMailAccounts, sanitizeMailBulkSenders, sanitizeMailPollMinutes } from '@workbench/mail'
import { sanitizeWorkRange, sanitizeWorkSort } from '@workbench/work-log'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type PersistedData,
  type StoredSettings
} from './types'

/** 数据文件里该存的那部分设置的默认值：完整默认设置摘掉外观项（stripAppearance 来自外观包） */
export const DEFAULT_STORED_SETTINGS: StoredSettings = stripAppearance(
  DEFAULT_SETTINGS
) as StoredSettings

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
 * 外观那一批（appName、theme、terminalHeight、背景、主题色、顶部样式、卡片不透明度、hiddenViews）
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
  // 行为记忆那几项（上次看的是哪一档 / 怎么排的 / 目录树摊开了哪几层）：
  // 老数据文件里都没有，认不出来的一律回默认 —— 它们会被写回界面上的选中值，
  // 留一个控件认不出的值在那儿，界面会是「一个都没选中」的样子
  value.projectSort = sanitizeProjectSort(value.projectSort)
  value.workRange = sanitizeWorkRange(value.workRange)
  value.workSort = sanitizeWorkSort(value.workSort)
  // 摊开的文件夹：路径要拿去和树里的节点比对，得先统一分隔符、去掉越界的项
  value.noteTreeExpanded = sanitizeNoteTreeExpanded(value.noteTreeExpanded)
  // 终端收起后那颗悬浮按钮的位置：老数据文件里没有这个字段，默认 null（跟随终端面板）。
  // 它落在视口外面的话用户再也够不着这颗按钮，必须在这里拦住
  value.terminalButtonTop = clampTerminalButtonTop(value.terminalButtonTop)
  // 笔记文件夹：老数据文件里没有它（默认空串 = 还没选过，笔记页显示引导）。
  // 收尾的空白与分隔符在这里现收敛：值是要拿去拼文件路径的
  value.noteDir = sanitizeNoteRoot(value.noteDir)
  // 打开过的笔记本清单（笔记页左栏底部的「最近打开」）：老数据文件里没有，默认空；
  // 手工改坏过、重复、超上限的都在这里收敛
  value.noteDirs = sanitizeNoteHistory(value.noteDirs)
  // 技能库目录（本机挑的一个目录）：老数据文件里没有，默认空串 = 还没选过。
  // 与笔记文件夹同一条收敛（去空白与末尾分隔符、盘根留住分隔符）—— 它要拿去拼文件路径
  value.skillDir = sanitizeNoteRoot(value.skillDir)
  // 知识库文件夹（本机挑的一个目录，一个独立项目的根）：老数据文件里没有，默认空串 = 还没选过。
  // 与笔记 / 技能同一条收敛 —— 它同样要拿去拼文件路径
  value.kbDir = sanitizeNoteRoot(value.kbDir)
  // AI 助手的模型配置（AI 服务清单）：老数据文件里没有，默认空 = 还没配过。
  // 更早的版本只有「一个自定义端点」（aiProviderName / aiBaseUrl / aiApiFormat / aiModels
  // 四样平铺在设置里），这里顺手搬成一条服务 —— 只搬一次，之后那四个字段就清掉了
  value.aiProviders = sanitizeAiProviders(asRecord(input).aiProviders)
  if (!value.aiProviders.length) {
    const legacy = legacyAiProvider(input)
    if (legacy) value.aiProviders = [legacy]
  }
  // 默认模型（行为记忆）：挑的服务 / 模型从不在收敛里对着清单核对 —— 清单随时可以关停增减，
  // 核对放在用它的那一刻（@workbench/ai 的 pickAiChoice）
  const rawDefault = asRecord(input)
  value.aiDefaultProvider = sanitizeAiName(rawDefault.aiDefaultProvider)
  value.aiDefaultModel = sanitizeAiModelId(rawDefault.aiDefaultModel)
  if (!value.aiDefaultProvider && !value.aiDefaultModel && value.aiProviders.length) {
    // 老版本那一个端点：当时挑的模型就是「唯一那个服务下的」
    value.aiDefaultProvider = value.aiProviders[0].id
    value.aiDefaultModel = sanitizeAiModelId(rawDefault.aiRunModel)
  }
  // 老版本那一个端点的五个字段（名称 / Base URL / API 形态 / 清单 / 挑的模型）已经搬进
  // aiProviders 与默认模型：不主动清掉的话它们会被一直写回，看着像还有人在用
  for (const key of ['aiProviderName', 'aiBaseUrl', 'aiApiFormat', 'aiModels', 'aiRunModel']) {
    delete (value as unknown as Record<string, unknown>)[key]
  }
  value.aiThinking = sanitizeAiThinking(value.aiThinking)
  // 工具权限（composer 左边那一栏）：老数据文件里没有，默认自动编辑（命令先问一句）
  value.aiPermission = sanitizeAiPermission(value.aiPermission)
  // 用过的指令已废弃：起始那一屏下方那排 chips 去掉了，历史不再进设置。旧数据文件里
  // 存着它，不主动清掉的话它会一直被写回，看着像还有人在读它
  delete (value as unknown as Record<string, unknown>).aiHistory
  // 会话清单与「上次打开的那个」：老数据文件里没有，默认空清单 / 空串。
  // 会话 id 要拿去当 Pi 的 session-id（字符集是它定的）、目录要拿去拼路径与起进程，
  // 两样都在收敛里卡住；选中的那个认不出来（被删了）时回最近说过话的那个
  value.aiSessions = sanitizeAiSessions(value.aiSessions)
  value.aiActiveSession = pickAiActiveSession(value.aiSessions, sanitizeAiSessionId(value.aiActiveSession))
  // 关掉的技能（AI 助手页那颗「技能」按钮里那排开关）：老数据文件里没有，默认全开。
  // 键是「技能根 + 技能名」，认不出的整条丢掉（见 @workbench/ai 的 pi-skills 的 skillKey）
  value.aiSkillsOff = sanitizeAiSkillsOff(value.aiSkillsOff)
  // AI 助手的工作目录已废弃：会话把「在哪个目录里干活」收到了自己身上（一个会话一个目录，
  // 见 AiSession），再留一个全局的值就是第二份真源 —— 而且它会把上一次的目录一直写回。
  delete (value as unknown as Record<string, unknown>).aiWorkDir
  // 笔记仓库地址已废弃：同步现在只看那个文件夹自己的 `origin`（见 @workbench/notes 的 NoteRepoState），
  // 地址不再进设置。旧数据文件里存着它，不主动清掉的话它会一直被写回，看着像还有人在用它。
  delete (value as unknown as Record<string, unknown>).noteSyncRepo
  // 天气城市：老数据文件里没有，默认空串 = 不显示、不联网。空白与超长在这里收敛
  value.weatherCity = sanitizeWeatherCity(value.weatherCity)
  // 邮箱账户清单（可同时配多个，收件箱合并按时间排）：老数据文件里没有，默认空清单 =
  // 出口关闭。更老的版本只有一个 mailAccount，这里搬成清单的第一条 —— 只搬一次，
  // 之后那个旧字段就清掉了。授权码不在这份明文 JSON 里 —— 它在 Windows 凭据管理器
  // （Rust 侧 mail_key_save，按地址一条，搬清单不用动它）
  value.mailAccounts = sanitizeMailAccounts(asRecord(input).mailAccounts)
  if (!value.mailAccounts.length) {
    const legacy = asRecord(input).mailAccount
    if (legacy) {
      const migrated = sanitizeMailAccounts([legacy])
      if (migrated.length) value.mailAccounts = migrated
    }
  }
  delete (value as unknown as Record<string, unknown>).mailAccount
  // 广告发件人黑名单（邮箱页右击「标记为广告」攒的）：老数据文件里没有，默认空清单
  value.mailBulkSenders = sanitizeMailBulkSenders(value.mailBulkSenders)
  // 后台新邮件检查的周期（分钟，0 = 关闭）：老数据文件里没有，默认 30。
  // 与 mailBulkSenders 同一待遇：只对本机成立，不参与外观同步
  value.mailPollMinutes = sanitizeMailPollMinutes(value.mailPollMinutes)
  // 图片仓库地址：老数据文件里没有，默认未配置。
  // 与 Token 同步仓库同一条口径（含空白、以 `-` 开头的一律当没填）
  value.noteImageRepo = sanitizeImageRepo(value.noteImageRepo)
  // 视频文件夹与打开过的目录、目录树的展开态、上次打开的视频：老数据文件里都没有，
  // 默认空 / 空清单。收敛与笔记那几样各是同一条（它们都只是「本机的一个目录」+ 一份相对路径）
  value.videoDir = sanitizeVideoRoot(value.videoDir)
  value.videoDirs = sanitizeVideoHistory(value.videoDirs)
  value.videoTreeExpanded = sanitizeVideoTreeExpanded(value.videoTreeExpanded)
  value.videoLastRel = sanitizeVideoLastRel(value.videoLastRel)
  // 这个字段的开发期名字，存的是「绝对值、没有跟随终端这一档」。它只出现在未发布的中间版本里，
  // 而那个值会把「跟随终端」这档永远盖住 —— 清掉，免得它一直写回数据文件当第二份真源。
  delete (value as unknown as Record<string, unknown>).terminalDockTop

  return value
}

/**
 * 磁盘上的设置当成一张「字段名 → 未知值」的表来读：收敛用的都是纯函数（自己会看类型），
 * 而几个已经废弃的字段（AI 那一个端点的五个、closeBehavior 一类）已经不在 StoredSettings 里，
 * 只能从这张表里对口读。
 */
function asRecord(raw: unknown): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>
}

/** 对象才谈得上「有没有这些字段」；null / 数组 / 字符串一律当空 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 老版本那**一个自定义端点**（`aiProviderName` / `aiBaseUrl` / `aiApiFormat` / `aiModels`
 * 平铺在设置里的年代）→ 一条服务。四样齐了才搬：半截的配置搬过去本来也跑不起来，
 * 留在设置里只会让用户以为配过了。
 */
function legacyAiProvider(raw: unknown): AiProvider | null {
  const record = asRecord(raw)
  const id = sanitizeAiName(record.aiProviderName)
  const baseUrl = sanitizeAiBaseUrl(record.aiBaseUrl)
  const apiFormat = sanitizeAiApiFormat(record.aiApiFormat)
  const models = sanitizeAiModels(record.aiModels)
  if (!id || !baseUrl || !apiFormat || !models.length) return null
  return { id, label: id, baseUrl, apiFormat, preset: '', enabled: true, models }
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

// ---------- theme.json 与数据文件的分流桥接 ----------
//
// 这三个函数吃的是 AppSettings / StoredSettings（应用级类型，进不了 @workbench/appearance 包），
// 但「哪些键归 theme.json」的口径（APPEARANCE_SETTING_KEYS / pickAppearance）来自外观包。
// 它们原先住在包里的 appearance.ts，随 monorepo 化搬到这 —— 唯一的两处消费方
// （适配层的 state.ts 与这里）本来就在应用侧。

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
