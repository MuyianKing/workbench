/** 适配层与渲染层共用的类型定义与 IPC 契约 */

import { ACCENT_COLOR_DEFAULT, ACCENT_INK_DEFAULT, type AccentInkMode } from './accent-color'
import { APP_NAME_DEFAULT } from './app-name'
import { TERMINAL_HEIGHT_DEFAULT } from './terminal-height'
import { TERMINAL_BUTTON_TOP_DEFAULT } from './terminal-dock'
import { CARD_OPACITY_DEFAULT } from './card-opacity'
import { BACKGROUND_OPACITY_DEFAULT } from './workspace-background'
import { builtinReference } from './wallpaper'
import type { AppearanceSettingKey } from './appearance'
import type { SyncDeviceInfo } from './sync-config'
import type { ActivityCounts } from './activity'
import type { BuildTool, PortSource } from './dev-port'
import type { ProjectColor } from './project-color'
import type { ThemeConfig } from './theme'
import type { TokenUsageResult } from './token-usage'
import type { ViewId } from './views'
import type { WorkLogEntry, WorkLogInput, WorkLogPatch } from './work-log'

/** 活跃度计数、首页布局、同步的其它设备也走这里导出，渲染层统一从 @/types 取类型 */
export type { ActivityCounts, ThemeConfig, SyncDeviceInfo }
export type { TokenUsageResult } from './token-usage'
export type { ProjectColor } from './project-color'
export type { WorkLogEntry, WorkLogInput, WorkLogPatch } from './work-log'

export type ProjectStatus = 'idle' | 'installing' | 'running' | 'building' | 'success' | 'failed'

export type PackageManager = 'npm' | 'yarn' | 'pnpm'

/**
 * 可以在应用内一键安装的包管理器：走 `npm install -g`。
 * npm 自己随 Node.js 分发，装不了它 —— 系统里没有 npm 说明 Node 就没装好。
 */
export type InstallablePackageManager = Exclude<PackageManager, 'npm'>

export type PackageManagerSetting = 'auto' | PackageManager

/**
 * 能在应用内一键安装的全局工具。
 *
 * nrm 是「npm 镜像源管理器」，与包管理器不是一类东西，但安装方式一样（`npm install -g`），
 * 所以放进同一个联合里共用「一次只装一个」的那条安装通道。
 */
export type InstallableGlobalTool = InstallablePackageManager | 'nrm'

export type ThemeSource = 'system' | 'light' | 'dark'

/** 实际生效的主题（system 由主进程解析成 light / dark 再推给渲染层） */
export type EffectiveTheme = 'light' | 'dark'

/**
 * 顶部三条栏（标题栏 / 搜索栏 / 筛选栏）的样式。
 *
 * 壁纸现在铺满整个窗口，这三条栏就有了三种处理方式；取值同时用于落盘收敛与设置界面，
 * 所以放在 shared 里当唯一口径。
 *   band  —— 不透明的工具条：前两条白、筛选栏画布灰，壁纸从画布才开始（默认）
 *   glass —— 三条合成一整块磨砂，壁纸隔着玻璃铺到窗口顶边
 *   clear —— 三条全透，壁纸一路铺到窗口顶边
 */
export const TOP_BAR_STYLES = ['band', 'glass', 'clear'] as const

export type TopBarStyle = (typeof TOP_BAR_STYLES)[number]

export interface CustomCommand {
  name: string
  command: string
}

export interface ProjectScripts {
  /** 启动脚本名，如 serve / dev */
  serve?: string
  /** 所有可用的打包脚本名 */
  build: string[]
  /** 默认打包脚本名 */
  defaultBuild?: string
  custom?: CustomCommand[]
}

export interface RunRecord {
  id: string
  /** command 是首页「命令」卡片里那条独立的命令，不属于任何项目 */
  kind: 'start' | 'build' | 'install' | 'custom' | 'command'
  command: string
  startedAt: number
  durationMs?: number
  result: 'success' | 'failed' | 'stopped'
}

export interface Project {
  id: string
  name: string
  path: string
  /**
   * 标识色：用于在项目卡与工作日志里区分项目。
   *
   * 存的是主题色名（见 shared/project-color.ts），不是色值 —— 明暗切换与用户自定义主题色
   * 都会自动跟着走。**新加项目与老数据补齐都会自动分配一个**，所以正常不会缺失；
   * 缺失时界面按中性色画，不影响别的功能。
   */
  color?: ProjectColor
  /** 用户选择的包管理器，auto 表示按锁文件自动判定 */
  packageManager: PackageManagerSetting
  /** 扫描锁文件得出的实际包管理器 */
  detectedPackageManager: PackageManager
  /** 从依赖中识别出的框架，仅用于展示 */
  framework: string
  version: string
  scripts: ProjectScripts
  outputDir?: string
  autoOpenExplorer: boolean
  /** 仅管理目录（package.json 解析失败时加入），不执行任何命令 */
  manageOnly?: boolean
  /** 项目声明的 Node 版本要求（engines.node 或 .nvmrc），仅用于提示 */
  nodeRequirement?: string
  /**
   * 开发服务的监听端口。
   * 它是「项目是否已经在运行」的判据：启动应用后按它探测一次，
   * 就能认出上一次（可能是在 Workbench 之外）启动、至今还占着端口的服务。
   * 留空表示不检测 —— 此时只能靠本次会话里从启动日志识别到的端口。
   */
  port?: number
  /**
   * 该项目执行命令时使用的 nvm Node 版本（如 20.20.2）。
   * 留空表示跟随系统 PATH 里的 node；只影响本项目的子进程，不修改全局软链。
   */
  nodeVersion?: string
  groupId?: string
  order: number
  createdAt: number
  lastUsedAt?: number
  /** 最近若干次执行记录，最新的在前 */
  history?: RunRecord[]
}

export interface ProjectGroup {
  id: string
  name: string
  /** 拖动排序用；缺失时按 0 处理，老数据文件里的分组顺序保持不变 */
  order: number
}

/**
 * 首页「快捷启动」里的一个常用软件。
 *
 * 与项目不是一回事：这里只是「用系统的方式把某个程序拉起来」，
 * Workbench 不接管它的进程 —— 没有日志、没有停止按钮，关掉 Workbench 也不会连带结束它。
 */
export interface QuickApp {
  id: string
  name: string
  /** 程序路径：.exe / .lnk / .bat / .cmd，或任意能被系统关联打开的文件 */
  target: string
  order: number
  createdAt: number
  lastUsedAt?: number
}

/** 新增快捷启动项时提交给主进程的数据 */
export interface QuickAppInput {
  name: string
  target: string
}

/** 可编辑的快捷启动项配置 */
export interface QuickAppPatch {
  name?: string
  target?: string
}

/**
 * 程序图标的缓存条目（key 是程序路径，见 shared/icon-cache.ts）。
 *
 * 抽一张图标要打开程序、解析 PE 资源、编码 PNG 再 base64（实测 .lnk 每个 27~53ms），
 * 而图标几乎不变，所以连图标带判断依据一起落盘：修改时间没变就直接用，不再重抽。
 */
export interface IconCacheEntry {
  /** 程序文件的修改时间（毫秒，Unix 纪元）：与图标一一对应，程序升级换了图标就自动失效 */
  mtime: number
  /** 内联图片（data:image/png;base64,…），与界面直接可用的形状一致 */
  dataUrl: string
}

/**
 * 首页「命令」卡片里的一条命令。
 *
 * 与项目是两种东西：这里只有「一行命令 + 一个可选的监听端口」，没有目录、包管理器、
 * 脚本这些配置。进程仍然由 Workbench 接管 —— 有日志、能停止，输出进底部终端；
 * 命令的工作目录固定为用户主目录（见 main/commands.ts）。
 */
export interface CommandEntry {
  id: string
  name: string
  /** 整条命令原文，交给 shell 执行 */
  command: string
  /**
   * 监听端口，非必填。
   * 它是「这条命令有没有在跑」的判据：留空时只能靠本次会话的进程句柄判断，
   * 应用重启后也认不出上次留下的服务。
   */
  port?: number
  order: number
  createdAt: number
}

/** 新增命令卡片条目时提交给主进程的数据 */
export interface CommandInput {
  name: string
  command: string
  /** 显式传 null 表示用户清空了它，按「不检测」落盘 */
  port?: number | null
}

/** 可编辑的命令配置 */
export interface CommandPatch {
  name?: string
  command?: string
  /** null 或非法值表示清空 */
  port?: number | null
}

/**
 * 快捷启动的完整状态。
 * missing 以「启动项 id」为键（不是路径）：同一个程序可能被加两次，界面按 id 取用最直接。
 */
export interface QuickAppList {
  apps: QuickApp[]
  missing: Record<string, boolean>
}

/**
 * 应用级设置（F-8.x）。
 *
 * **这是渲染层看到的那一份完整设置**：外观那几项（见 APPEARANCE_SETTING_KEYS）实际存在
 * 主题文件 `theme.json` 里，由适配层读的时候合过来、写的时候按白名单分回去
 * （见 shared/appearance.ts）。组件照旧在一个对象上读写，不必知道文件怎么分的。
 */
export interface AppSettings {
  /**
   * 程序名称：显示在标题栏、托盘提示与窗口标题上。
   * 空串 / 全空白 / 超长都会在落盘前被收敛，见 shared/app-name.ts。
   */
  appName: string
  /** 开机自启，默认开启 */
  launchAtLogin: boolean
  /** 主题，默认暗色 */
  theme: ThemeSource
  /** 全局快捷键是否启用 */
  hotkeyEnabled: boolean
  /** 唤起 / 隐藏主窗口的全局快捷键 */
  hotkey: string
  /** 终端面板展开时的高度（px），由拖动面板上沿决定 */
  terminalHeight: number
  /**
   * 终端收起后，窗口最右侧那颗悬浮按钮的纵向位置。
   *
   * `null`（默认）= 没拖动过，按钮落在终端面板自己的位置上（面板纵向中线），
   * 由渲染层按当前面板高度现算；拖动过就是占窗口高度的百分比。
   *
   * 与 terminalHeight 不同，它**不进 theme.json**（见 appearance.ts 的白名单）：
   * 面板高度是「面板长什么样」，跟着主题走；而按钮落在屏幕的哪一处只对这台机器成立。
   */
  terminalButtonTop: number | null
  /**
   * 工作区背景图的磁盘路径，空串表示用默认的纯画布。
   *
   * 只落盘路径：图片本身不进数据文件（用户可能选的是几兆的照片），
   * 每次要用时由主进程读出来、压到合适尺寸后再交给渲染层。
   */
  workspaceBackground: string
  /** 背景图浓淡（百分比，越大图越清楚，蒙版越淡） */
  workspaceBackgroundOpacity: number
  /**
   * 背景图之上那层蒙版的颜色（#rrggbb）：图片就是「渐淡」进这个颜色。
   * 空串表示跟随主题画布色 —— 不动它就是原来的样子。
   */
  workspaceBackgroundVeil: string
  /**
   * 主题色（#rrggbb）：开关、选中、聚焦这类交互态与主按钮用它。
   * 空串表示用默认的中性色（亮色近黑、暗色近白），也就是界面原本的灰度样子；
   * 只接管交互态，状态色（--st-*）与终端（--term-*）不受影响。
   */
  accentColor: string
  /**
   * 铺在主题色上的文字色：auto 按主题色深浅自动挑（红底白字、浅灰底黑字），
   * white / dark 是用户手动钉死的选择。没设主题色时无意义。
   */
  accentInk: AccentInkMode
  /** 顶部三条栏的样式，默认 clear（三条全透），设置界面里叫「正常 / 毛玻璃 / 透明」 */
  topBarStyle: TopBarStyle
  /**
   * 卡片不透明度（百分比，越大越实）：首页工作台面板与项目卡共用的底色浓度。
   * 只管背景这一层，边框、阴影与里面的文字不变；100% 就是原本的实底卡片。
   */
  cardOpacity: number
  /**
   * Token 用量同步仓库地址（git 远程地址），空串表示不同步。
   *
   * 多台机器各自把「本机分片」推到这一个仓库里，读的时候全量合并 ——
   * 一个设备一个文件，所以永远不会有同文件冲突（详见 shared/token-usage.ts 的文件头）。
   * 值会被 shared 的 sanitizeSyncRepo 收敛：带空白或以 `-` 开头的一律当没填。
   *
   * 仓库里放的是模型名与 token 计数，**没有对话内容**，但仍然建议用私有仓库。
   */
  tokenSyncRepo: string
  /**
   * 上次停留的页面（左侧导航栏的当前项，见 shared/views.ts）。
   *
   * 放在设置里，只是因为设置本来就是「随数据文件落盘的界面状态」的容身处
   * （终端高度、顶部样式、卡片不透明度都在这里）——它不是设置界面上的选项，
   * 只用来让重启后回到上次那一页。
   */
  activeView: ViewId
  /**
   * 同步时是否把本机的外观配置一起写进分片（默认开启）。
   *
   * 外观＝明暗、主题色、顶部样式、卡片不透明度、终端高度、程序名称、工作区背景（只带内置壁纸）
   * 与首页布局，见 shared/appearance.ts。关掉之后本机分片里那一项会被清掉（下一次同步时提交），
   * 别的机器也就取不到这份配置了 —— 只同步用量数字的场景留给这个开关。
   */
  syncAppearance: boolean
  /**
   * 登录之后，是否用这个账号的 token 去授权 Token 同步（默认开启）。
   *
   * 关掉就退回「用系统里 git 自己配好的凭据」那条老路。**这条退路必须留着**：
   * 账号 token 会过期、会被撤销，如果同步只剩它一条路，token 一失效，
   * 原本一直好用的同步也跟着一起坏掉。
   */
  useAccountForSync: boolean
}

/**
 * `workbench-data.json` 里真正落盘的那部分设置：外观与首页布局都住在 `theme.json`（见 appearance.ts）。
 * 同步时带走的也是后面那一份 —— 这里的快捷键、开机自启、数据目录、仓库地址换台机器就不成立。
 */
export type StoredSettings = Omit<AppSettings, AppearanceSettingKey>

/** 支持登录的两家平台 */
export type AuthProvider = 'github' | 'gitee'

/**
 * 登录后的账号资料。
 *
 * **这里没有 token，也永远不会有**：token 只在 Rust 侧流转，落在 Windows 凭据管理器里
 * （见 Rust 的 credentials.rs）。渲染层拿到的只有用来显示昵称头像的这几项。
 */
export interface AccountProfile {
  provider: AuthProvider
  /** 平台给的用户 id（数字被字符串化，避免超出 JS 安全整数范围） */
  id: string
  /** 登录名，一定有 */
  login: string
  /** 昵称；用户没在平台上填过就是 null，界面上回落到 login */
  name: string | null
  /** 头像的 data URL（由 Rust 拉下来转好）；拉不到就是 null */
  avatar: string | null
}

/** 登录状态 */
export interface AuthStatus {
  /** 当前这个构建有没有内置 OAuth 凭据（没内置时登录按钮不可点） */
  configured: boolean
  /**
   * 一家都用不了时的原因，由 Rust 侧给出；能用时是空串。
   *
   * 比「未内置凭据」具体得多 —— 凭据填了但少一项时，缺的到底是哪一项只有那边知道，
   * 界面上照搬它就能直接告诉用户该补什么。
   */
  configError: string
  /**
   * 要在两家平台上注册的回调地址。
   * 由 Rust 侧给出而不是这里写死：它必须和回环监听实际用的地址逐字一致。
   */
  redirectUri: string
  /** 凭据管理器里确实有 token 的那些平台。**这才是「已登录」的判据。** */
  providers: AuthProvider[]
  /**
   * 已登录账号的显示资料（昵称 / 头像 / 登录名），未登录是 null。
   *
   * 它只是缓存：凭据管理器里没有对应 token 时，适配层会把它一并清掉
   * （在控制面板里手工删过凭据、换了 Windows 用户，都会走到这一步）。
   */
  account: AccountProfile | null
}

/** 起一次登录之后拿到的授权页地址 */
export interface LoginStart {
  authUrl: string
  redirectUri: string
}

/**
 * 一次登录轮询的结果。
 *
 * pending 之外的取值都意味着这次登录已经结束（无论成败），适配层据此停掉轮询。
 */
export interface LoginPoll {
  status: 'pending' | 'ok' | 'denied' | 'expired' | 'failed'
  /** status 为 ok 时必有 */
  account?: AccountProfile
  /** 失败原因（denied / expired / failed 时有） */
  error?: string
}

/**
 * 一次登录的最终结果。
 *
 * **取消单独占一档，没有被并进失败**：关掉弹窗、改主意都是正常操作，
 * 界面上不该为此弹一个红色错误 —— 真要报错就得能在文案上把这两件事分开。
 */
export type LoginOutcome =
  | { status: 'ok'; account: AccountProfile }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }

/**
 * 正在运行的子进程记录（落盘）。
 * 应用被强杀后，下次启动靠它找出残留的 dev server 并清理（设计文档 §7）。
 */
export interface ActiveSession {
  projectId: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  /** 派生它的应用进程 PID；这个进程还活着就说明会话有主，不能当残留处理 */
  ownerPid: number
  /**
   * 宿主应用进程的创建时间（毫秒，Unix 纪元）。
   * 光有 ownerPid 不够：PID 会被复用，一个复用了旧 PID 的新进程会让这条记录
   * 被误判成「有主」而被永远保留，残留进程也就永远清不掉。缺失时按「认不出宿主」处理。
   */
  ownerCreatedAt?: number
  /**
   * 子进程的创建时间（毫秒，Unix 纪元）。
   * 残留清理靠它确认「这个 PID 还是不是当初那个进程」—— PID 会被系统复用，
   * 只按 PID 杀有可能杀到一个毫不相干的新进程。老数据文件里没有这个字段，
   * 缺失时一律跳过（宁可漏清，不可杀错）。
   */
  processCreatedAt?: number
}

/** 持久化到磁盘的数据结构 */
export interface PersistedData {
  projects: Project[]
  groups: ProjectGroup[]
  /** 首页「快捷启动」的常用软件 */
  quickApps: QuickApp[]
  /**
   * 程序图标的 base64 缓存，key 是程序路径。
   * 省掉每次启动重新抽取一遍图标（见 shared/icon-cache.ts）。
   */
  iconCache?: Record<string, IconCacheEntry>
  /** 首页「命令」卡片里的命令，与项目相互独立 */
  commands: CommandEntry[]
  /** 这里只有「换台机器就不成立」的那些设置；外观与首页布局在 theme.json（见 StoredSettings） */
  settings: StoredSettings
  /** 上次运行期间启动、尚未确认结束的子进程 */
  activeSessions?: ActiveSession[]
  /**
   * 按本地日期聚合的命令执行次数，首页活跃度图的数据源。
   * 与项目各自的 history 分开存：history 每个项目只留最近 10 条，撑不起一整年的图。
   */
  activity?: ActivityCounts
  /**
   * 登录过的账号资料（昵称 / 头像 / 登录名，**非机密**）。
   *
   * token 不在这里 —— 它在 Windows 凭据管理器里，文件被拷走也解不开。
   * 因此判断「是否已登录」的权威来源始终是凭据管理器（`authStatus().providers`）：
   * 这里有资料而那边没有 token 时，一律按未登录处理，并顺手清掉这份残留资料。
   */
  account?: AccountProfile | null
}

export interface LogLine {
  id: number
  time: string
  stream: 'cmd' | 'out' | 'err' | 'sys'
  text: string
}

/** 项目级运行态（卡片 / 抽屉看这个）；日志按终端分开存放在渲染层 */
export interface RuntimeState {
  status: ProjectStatus
  pid?: number
  currentCommand?: string
  startedAt?: number
  durationMs?: number
  exitCode?: number | null
  port?: number
  /**
   * 这次「运行中」是探测到端口被占得出的，进程不归 Workbench 管：
   * 没有进程句柄也没有日志，停止只能按端口结束。
   */
  external?: boolean
}

/** 扫描项目目录得到的结果，用于添加项目前的预览 */
export interface ScanResult {
  ok: boolean
  error?: string
  /** package.json 存在但解析失败：允许以「仅管理目录」方式加入 */
  parseError?: boolean
  name: string
  version: string
  framework: string
  detectedPackageManager: PackageManager
  lockFile?: string
  serve?: string
  build: string[]
  allScripts: string[]
  outputDir?: string
  /** package.json 的 engines.node，缺失时回退 .nvmrc */
  enginesNode?: string
  /** enginesNode 的来源，用于提示文案 */
  nodeRequirementFrom?: 'engines' | 'nvmrc'
  /** 识别到的构建工具，决定端口按哪家的规则找 */
  buildTool?: BuildTool
  /** 自动识别出的开发服务监听端口 */
  port?: number
  /** 端口的来源：配置文件 / 启动脚本参数 / 工具默认值 */
  portFrom?: PortSource
  /** portFrom 为 config 时的配置文件名 */
  portFile?: string
}

/** 添加项目时提交给主进程的数据 */
export interface AddProjectInput {
  path: string
  name: string
  groupId?: string
  serve?: string
  build: string[]
  defaultBuild?: string
  /** 监听端口；显式传 null 表示用户清空了它，按「不检测」落盘 */
  port?: number | null
  /** package.json 解析失败时，是否以「仅管理目录」的方式加入 */
  allowInvalid?: boolean
}

/** 可编辑的项目配置项 */
export interface ProjectPatch {
  name?: string
  packageManager?: PackageManagerSetting
  scripts?: ProjectScripts
  outputDir?: string
  autoOpenExplorer?: boolean
  nodeVersion?: string
  /** 监听端口；null 或非法值表示清空 */
  port?: number | null
  groupId?: string
  /** 标识色（见 Project.color） */
  color?: ProjectColor
}

/**
 * 一个终端对应「某个项目的一类操作」，所以同一项目的启动与打包是两个终端。
 * system 是不属于任何项目的那类，例如在本机全局安装包管理器；
 * command 是首页「命令」卡片里的一条命令（单独一个终端）。
 */
export type TerminalKind = 'start' | 'build' | 'install' | 'custom' | 'command' | 'system'

/** 终端被创建（或复用）时推送一次，渲染层据此建 Tab 并切过去 */
export interface TerminalOpenEvent {
  /** 全局唯一：`${projectId}::${kindKey}`，自定义命令的 kindKey 形如 custom:0 */
  terminal: string
  projectId: string
  kind: TerminalKind
  /** Tab 上的操作名，如「启动」「打包」「类型检查」 */
  label: string
}

export interface ProcessLogEvent {
  /** 终端键，日志只写进对应终端，不再按项目混在一起 */
  terminal: string
  projectId: string
  stream: LogLine['stream']
  text: string
  time: string
}

/**
 * 日志事件在 IPC 上的载荷。
 *
 * 单条形式仍然合法（系统提示、包管理器安装输出这类零散消息直接发一条），
 * 但命令输出走数组：狂刷日志时逐行发会让后端与渲染层互相拖累，
 * Rust 侧按帧聚合后整批发一次（见 src-tauri/src/session.rs）。
 */
export type ProcessLogPayload = ProcessLogEvent | ProcessLogEvent[]

export interface ProcessStatusEvent {
  projectId: string
  /** 产生这次状态变化的终端；项目级的卡片状态也由它更新 */
  terminal: string
  status: ProjectStatus
  pid?: number
  currentCommand?: string
  startedAt?: number
  durationMs?: number
  exitCode?: number | null
  port?: number
}

export interface PortCheckResult {
  port: number
  inUse: boolean
  pid?: number
  processName?: string
}

export interface PackageManagerStatus {
  npm: boolean
  yarn: boolean
  pnpm: boolean
  node: string
}

/** 包管理器安装过程中的一行输出，用于在界面上显示进度 */
export interface PmInstallLogEvent {
  pm: InstallableGlobalTool
  text: string
}

/** Node 版本校验结果（仅提示，不阻断） */
export interface NodeCheckResult {
  /** 项目要求（engines.node 或 .nvmrc），空表示未声明 */
  required?: string
  /** 实际会用于执行的 Node 版本：项目选定的 nvm 版本优先，否则系统 node */
  actual: string
  /** actual 的来源，用于界面文案 */
  source: 'project' | 'system'
  ok: boolean
}

/**
 * nvm 探测结果（只读）。
 *
 * 这里刻意不调用 nvm.exe：nvm-windows 会先用 GetConsoleMode 检查 stdout 是不是真终端，
 * 从 GUI 进程里 spawn 只会拿到「should be run from a terminal」然后静默退出；
 * 而 nvm use 又要管理员权限去改软链。所以只读 nvm 的目录和软链，切换靠给子进程注入 PATH。
 */
export interface NvmStatus {
  /** 是否找到了 nvm 及其安装目录 */
  available: boolean
  /** nvm 根目录，各版本以 vX.Y.Z 子目录存放 */
  root?: string
  /** NVM_SYMLINK，即系统 node 所在的软链目录 */
  symlink?: string
  /** 软链当前指向的版本，即系统在用的 node */
  current?: string
  /** 已安装版本，按版本号从高到低 */
  versions: string[]
  /** 探测失败的原因，用于界面提示 */
  error?: string
}

/**
 * nrm 管理下的一个 npm 镜像源。
 * 清单本身不在这里维护：名字与地址由 `nrm ls` 给出（taobao 改名 npmmirror 就是一次），
 * 在代码里再抄一份必然过期。
 */
export interface NrmRegistry {
  name: string
  url: string
  /** 是不是 npm 当前正在用的那个 */
  current: boolean
}

/**
 * nrm（npm 镜像源管理器）探测结果。
 *
 * nrm 是个全局 npm 包，自己带一份镜像清单，当前用的是哪个写在 npm 的配置里，
 * 所以「装没装」「有哪些镜像」「当前是哪个」三件事都要问它。
 */
export interface NrmStatus {
  /** 是否检测到 nrm */
  available: boolean
  /** nrm 版本（探不到版本串但命令可用时为空） */
  version?: string
  /** 当前镜像名；认不出来（例如 registry 被手工改成了清单之外的值）时为空 */
  current?: string
  /** 可切换的镜像清单；nrm 不可用或者读不出时为[] */
  registries: NrmRegistry[]
  /** 探测失败的原因，用于界面提示 */
  error?: string
}

export interface Result<T> {
  ok: boolean
  data?: T
  error?: string
}

/**
 * 主进程读好、可以直接贴进 CSS 的背景图。
 *
 * 渲染层拿不到磁盘上的路径（dev server / 打包后的自定义协议都不允许引用 file://），
 * 所以统一由主进程解码、缩放、重新编码成 JPEG 的 data URL 再送过来。
 */
export interface BackgroundImage {
  /** 落盘的原始值：磁盘路径，或内置壁纸的 `builtin:<id>` 引用，界面展示与「清除」都认它 */
  path: string
  /** 文件名，用于界面提示 */
  name: string
  /**
   * 可以直接放进 CSS / `img.src` 的 URL。
   *
   * 是 asset 协议的 URL（webview 按文件加载，我们不碰像素），**不是** data URL ——
   * 详见适配层 loadBackground 里为什么改的。
   */
  url: string
}

/**
 * 随应用一起发布的内置壁纸（resources/backgrounds 下的那几张）。
 *
 * thumbnail 是主进程现压的小图：设置里那一排缩略图要是拿原图（几兆一张）来铺，
 * 打开一次设置就要传几十兆的 data URL。
 */
export interface BuiltinWallpaper {
  /** 文件名主干，例如 ink-bamboo */
  id: string
  /** 文件名（含后缀），界面展示用 */
  name: string
  /** 写进设置的引用串：builtin:<id> */
  reference: string
  /** 缩略图的 data URL */
  thumbnail: string
}

/**
 * 首屏快照。
 *
 * 设置只能经异步 IPC 拿到，而窗口在渲染层第一帧之后就显示了 —— 只走异步那条路的话，
 * 用户会先看见一份默认外观（亮色、无主题色、默认布局），几十到几百毫秒后才被换成自己的
 * 设置，看上去就是「启动时切换了一次」。Rust 侧在创建窗口之前已经读完设置，所以这里把
 * 决定第一帧的几份配置一次性同步交给渲染层（见适配层的 getBootstrap）。
 */
export interface BootstrapSnapshot {
  /** 实际生效的明暗；system 已按系统解析成 light / dark，与窗口底色用的是同一个值 */
  theme: EffectiveTheme
  settings: AppSettings
  themeConfig: ThemeConfig
}

/** `window.workbench` 向渲染层暴露的 API（由适配层实现） */
export interface WorkbenchApi {
  versions: { node: string; chrome: string }
  /**
   * 挑一个目录。
   * title 用于给不同用途换标题（选项目目录 / 选输出目录），不传就是「选择项目目录」。
   */
  pickDirectory: (title?: string) => Promise<string | null>
  scanProject: (dirPath: string) => Promise<Result<ScanResult>>
  listProjects: () => Promise<{ projects: Project[]; groups: ProjectGroup[] }>
  addProject: (input: AddProjectInput) => Promise<Result<Project>>
  updateProject: (id: string, patch: ProjectPatch) => Promise<Result<Project>>
  removeProject: (id: string) => Promise<Result<null>>
  /** 目录被移动或删除后重新绑定路径 */
  relocateProject: (id: string, newPath: string) => Promise<Result<Project>>
  /** 检查所有项目目录是否仍然存在，返回 项目 ID -> 是否有效 */
  checkProjectPaths: () => Promise<Record<string, boolean>>
  /** 按天聚合的命令执行次数（YYYY-MM-DD -> 次数） */
  getActivity: () => Promise<ActivityCounts>
  /** Token 用量:实读各 AI 工具本地库并合并进快照;读取失败的来源带原因,数据回退快照 */
  getTokenUsage: () => Promise<Result<TokenUsageResult>>
  /**
   * 只读本地那一份（本机快照 + 克隆里别人的分片），**不实读、不落盘、不碰网络**。
   *
   * 给面板首屏用：冷读一轮要一秒上下，那段时间卡片只能拿空态示人，
   * 明明有数据的用户会以为数据没了。先把上次的数据摆出来，再被 getTokenUsage 整份覆盖。
   * 返回形状与 getTokenUsage 一致，界面上不用区分两条路。
   */
  getTokenUsageSnapshot: () => Promise<Result<TokenUsageResult>>
  /**
   * 立刻同步一次 Token 快照并返回合并后的结果（面板上的手动同步按钮）。
   * 自动同步按间隔节流，这个入口不受节流限制。
   */
  syncTokenUsage: () => Promise<Result<TokenUsageResult>>
  /**
   * 同步仓库里**别的机器**（各自的外观配置快照一起带回来）。
   *
   * 只读本地那份克隆，不联网、也不推东西，所以设置界面打开时随时可以问；
   * 内容是上一次同步取回来的样子。地址没填时返回空数组。
   */
  listSyncDevices: () => Promise<SyncDeviceInfo[]>
  createGroup: (name: string) => Promise<Result<ProjectGroup>>
  renameGroup: (id: string, name: string) => Promise<Result<ProjectGroup>>
  removeGroup: (id: string) => Promise<Result<null>>
  /** 按给定顺序重排分组（拖动排序） */
  reorderGroups: (ids: string[]) => Promise<Result<ProjectGroup[]>>
  /** 快捷启动：列表 + 哪些程序已经不在原路径上了 */
  listQuickApps: () => Promise<QuickAppList>
  /** 挑一个要启动的程序（.exe / 快捷方式…），取消返回 null */
  pickQuickTarget: () => Promise<string | null>
  addQuickApp: (input: QuickAppInput) => Promise<Result<QuickApp>>
  updateQuickApp: (id: string, patch: QuickAppPatch) => Promise<Result<QuickApp>>
  removeQuickApp: (id: string) => Promise<Result<null>>
  /** 按给定顺序重排快捷启动项（拖动排序） */
  reorderQuickApps: (ids: string[]) => Promise<Result<QuickApp[]>>
  /** 启动一个常用软件；程序被移动或删除时返回失败原因 */
  launchQuickApp: (id: string) => Promise<Result<null>>
  /** 取程序的系统图标（主进程转成 data URL，取不到时用首字母兜底） */
  quickAppIcon: (target: string) => Promise<Result<string>>
  /** 首页「命令」卡片：独立于项目的一批命令 */
  listCommands: () => Promise<CommandEntry[]>
  addCommand: (input: CommandInput) => Promise<Result<CommandEntry>>
  updateCommand: (id: string, patch: CommandPatch) => Promise<Result<CommandEntry>>
  removeCommand: (id: string) => Promise<Result<null>>
  /**
   * 工作日志：整份列表（时间轴自己按范围分组、分页）。
   *
   * 数据住在本机的 `work-log.json` 里，**不进同步仓库** —— 它是个人记录，
   * 多机合并的语义也不成立（见 shared/work-log.ts 的文件头）。
   *
   * 这里是 `Result` 而不是裸数组：读盘失败与「确实还没写过」必须分得开，
   * 把前者显示成空列表会让人以为自己的记录丢了。
   */
  listWorkLogs: () => Promise<Result<WorkLogEntry[]>>
  /** 新增一条；工作内容必填，为空时返回失败 */
  addWorkLog: (input: WorkLogInput) => Promise<Result<WorkLogEntry>>
  updateWorkLog: (id: string, patch: WorkLogPatch) => Promise<Result<WorkLogEntry>>
  removeWorkLog: (id: string) => Promise<Result<null>>
  /** 启动一条命令；进程由 Workbench 接管，日志进底部终端 */
  startCommand: (id: string) => Promise<Result<null>>
  /** 停止一条命令；已在应用外跑着的那种只能按端口结束，由渲染层先确认 */
  stopCommand: (id: string) => Promise<Result<null>>
  reveal: (targetPath: string) => Promise<Result<null>>
  /** 用系统默认浏览器打开 http(s) 链接 */
  openExternal: (url: string) => Promise<Result<null>>
  checkPackageManagers: () => Promise<PackageManagerStatus>
  /** 用 npm 全局安装 yarn / pnpm；返回的 status 是装完（或装失败）后重新探测的结果 */
  installPackageManager: (
    pm: InstallablePackageManager
  ) => Promise<Result<PackageManagerStatus>>
  checkPort: (port: number) => Promise<PortCheckResult>
  killPortProcess: (port: number) => Promise<Result<null>>
  checkNodeVersion: (id: string) => Promise<NodeCheckResult>
  /** 读取 nvm 已安装的 Node 版本，用于项目级选择 */
  getNvmStatus: () => Promise<NvmStatus>
  /** nrm 状态：装没装、当前镜像、可切换的镜像清单 */
  getNrmStatus: () => Promise<NrmStatus>
  /** 用 npm 全局安装 nrm；返回装完（或装失败）后重新探测的结果 */
  installNrm: () => Promise<Result<NrmStatus>>
  /** 换一个 npm 镜像源（nrm use <name>）；返回切换后重新探测的结果 */
  useNrmRegistry: (name: string) => Promise<Result<NrmStatus>>
  install: (id: string) => Promise<Result<null>>
  start: (id: string) => Promise<Result<null>>
  build: (id: string, script: string) => Promise<Result<null>>
  /** 执行项目配置里的第 index 条自定义命令 */
  runCustom: (id: string, index: number) => Promise<Result<null>>
  stop: (id: string) => Promise<Result<null>>
  /**
   * 同步取一份首屏快照（见 BootstrapSnapshot）。
   * 渲染层在 mount 之前调用，让第一帧就是用户设置的样子，而不是先默认再切换。
   */
  getBootstrap: () => BootstrapSnapshot
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<Result<AppSettings>>
  /** 挑一张图片当工作区背景；只返回路径，落盘交给 updateSettings */
  pickBackground: () => Promise<string | null>
  /** 读取背景图（主进程压好尺寸后回传 data URL），文件不在或读不出来时返回失败 */
  loadBackground: (path: string) => Promise<Result<BackgroundImage>>
  /** 内置壁纸清单（含缩略图）；目录里没有图时返回空数组 */
  listWallpapers: () => Promise<BuiltinWallpaper[]>
  /** 首页布局配置（theme.json）：八块卡片的位置 / 尺寸与拖动步进 */
  getThemeConfig: () => Promise<ThemeConfig>
  /** 合并保存首页布局；返回收敛后的最终值 */
  updateThemeConfig: (patch: Partial<ThemeConfig>) => Promise<Result<ThemeConfig>>
  /** 项目数据文件所在目录（含是否为默认位置） */
  getDataLocation: () => Promise<DataLocation>
  /** 选择新的数据目录；目标已存在数据文件时返回冲突而不是直接覆盖 */
  pickDataDir: () => Promise<DataLocationPick>
  /** 迁移：把当前数据写到新目录并切过去 */
  migrateDataDir: (dir: string) => Promise<Result<DataLocation>>
  /**
   * 账号登录状态：能不能登录、回调地址、已登录哪些平台。
   * **不返回任何 token** —— 它在 Rust 侧，渲染层碰不到（见 AccountProfile）。
   */
  authStatus: () => Promise<AuthStatus>
  /** 重新拉一次账号资料（启动时刷新头像与昵称） */
  authRefreshAccount: (provider: AuthProvider) => Promise<Result<AccountProfile>>
  /**
   * 走完一次完整登录：起回环监听 → 打开浏览器 → 轮询等回调 → 回来时给账号资料。
   *
   * `onAuthUrl` 在浏览器被打开的那一刻回调一次，第二个参数说明自动打开成没成功 ——
   * 没成功时界面要把那个地址露出来让用户自己点，否则这一步就彻底卡死了。
   */
  authLogin: (
    provider: AuthProvider,
    onAuthUrl?: (authUrl: string, opened: boolean) => void
  ) => Promise<LoginOutcome>
  /**
   * 手动兜底：回调没跳回来时，把浏览器地址栏里那条完整地址直接交上去。
   * 端口被占用、浏览器被拦下之类的情况不至于让整条流程卡死。
   */
  authLoginSubmit: (url: string) => Promise<Result<AccountProfile>>
  /** 放弃进行中的登录（关掉回环监听，立刻停下轮询） */
  authLoginCancel: () => Promise<void>
  /** 退出登录：清掉凭据管理器里的 token */
  authLogout: (provider: AuthProvider) => Promise<Result<null>>
  /** 日志可能单条推来，也可能是一批（主进程按帧聚合） */
  onLog: (fn: (e: ProcessLogPayload) => void) => () => void
  onStatus: (fn: (e: ProcessStatusEvent) => void) => () => void
  onTerminalOpen: (fn: (e: TerminalOpenEvent) => void) => () => void
  onClear: (fn: (e: { terminal: string }) => void) => () => void
  onProjectChanged: (fn: (project: Project) => void) => () => void
  /** 快捷启动列表被主进程改过（启动一次会刷新最近使用时间），整份推过来 */
  onQuickApps: (fn: (payload: QuickAppList) => void) => () => void
  onSettingsChanged: (fn: (settings: AppSettings) => void) => () => void
  onTheme: (fn: (theme: EffectiveTheme) => void) => () => void
  /** 包管理器安装过程中的输出，一行一行推过来 */
  onPmInstallLog: (fn: (e: PmInstallLogEvent) => void) => () => void
  /** 数据目录切换后，渲染层需要整份重新加载 */
  onDataReload: (fn: () => void) => () => void
  /**
   * 后台的 Token 自动同步跑完一轮（成功失败都算）。
   *
   * 同步不挡出数：数据先显示，别人机器的新分片稍后才到，订阅方据此重取一次即可，
   * 不必干等到下一个轮询周期。手点的同步按钮不走这条 —— 它自己等结果。
   */
  onTokenSynced: (fn: () => void) => () => void
  /** 首页布局被改过（本地保存或别的窗口），整份推过来 */
  onThemeConfig: (fn: (config: ThemeConfig) => void) => () => void
  /** 主进程请求弹出退出确认框（托盘退出且还有项目在运行时） */
  onQuitConfirm: (fn: (payload: QuitConfirmPayload) => void) => () => void
  /** 回传退出确认框里选中的结果 */
  respondQuitConfirm: (choice: QuitChoice) => void
  /** 标题栏自绘窗口按钮：最小化 / 最大化（已最大化时为还原）/ 关闭（仍走托盘那套逻辑） */
  minimizeWindow: () => void
  toggleMaximizeWindow: () => void
  closeWindow: () => void
  /** 窗口当前是否最大化：首帧靠它决定第三个按钮画「最大化」还是「还原」 */
  getWindowState: () => Promise<WindowState>
  /** 最大化 / 还原状态变化（拖窗口边缘、系统快捷键也会走到这里） */
  onWindowState: (fn: (state: WindowState) => void) => () => void
}

/** 自绘标题栏需要知道的窗口状态 */
export interface WindowState {
  maximized: boolean
}

/** 数据文件位置信息 */
export interface DataLocation {
  dir: string
  file: string
  /** 是否是应用默认目录（userData） */
  isDefault: boolean
}

export interface DataLocationPick {
  /** 用户取消选择时为 null */
  dir: string | null
  /** 目标目录里已经有 workbench-data.json */
  conflict: boolean
}

/** 退出确认的结果：停止所有项目再退 / 保留项目直接退 / 取消（不退出） */
export type QuitChoice = 'stop' | 'direct' | 'cancel'

/**
 * 「仍有项目在运行」确认框的载荷。
 * 主进程在托盘「退出」时推给渲染层，由渲染层用应用内弹窗展示，
 * 这样样式能跟界面统一，而不是走系统原生消息框。
 */
export interface QuitConfirmPayload {
  /** 仍在运行的进程数：项目与「命令」卡片启动的，外加启动检测按端口认出的外部服务 */
  count: number
}

export const IPC = {
  pickDirectory: 'system:pick-directory',
  scanProject: 'project:scan',
  listProjects: 'project:list',
  addProject: 'project:add',
  updateProject: 'project:update',
  removeProject: 'project:remove',
  relocateProject: 'project:relocate',
  checkProjectPaths: 'project:check-paths',
  activity: 'stats:activity',
  tokenUsage: 'stats:token-usage',
  tokenSyncUsage: 'stats:token-sync',
  createGroup: 'group:create',
  renameGroup: 'group:rename',
  removeGroup: 'group:remove',
  reorderGroups: 'group:reorder',
  quickList: 'quick:list',
  quickPick: 'quick:pick',
  quickAdd: 'quick:add',
  quickUpdate: 'quick:update',
  quickRemove: 'quick:remove',
  quickReorder: 'quick:reorder',
  quickLaunch: 'quick:launch',
  quickIcon: 'quick:icon',
  eventQuickApps: 'quick:changed',
  commandList: 'command:list',
  commandAdd: 'command:add',
  commandUpdate: 'command:update',
  commandRemove: 'command:remove',
  commandStart: 'command:start',
  commandStop: 'command:stop',
  reveal: 'system:reveal',
  openExternal: 'system:open-external',
  checkPackageManagers: 'system:check-pm',
  installPackageManager: 'system:install-pm',
  checkPort: 'system:check-port',
  killPortProcess: 'system:kill-port',
  checkNodeVersion: 'system:check-node',
  nvmStatus: 'system:nvm-status',
  nrmStatus: 'system:nrm-status',
  nrmInstall: 'system:nrm-install',
  nrmUse: 'system:nrm-use',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  pickBackground: 'settings:pick-background',
  loadBackground: 'settings:load-background',
  listWallpapers: 'settings:list-wallpapers',
  getThemeConfig: 'theme:get',
  updateThemeConfig: 'theme:update',
  eventThemeConfig: 'theme:changed',
  getDataLocation: 'data:location',
  pickDataDir: 'data:pick-dir',
  migrateDataDir: 'data:migrate',
  install: 'process:install',
  start: 'process:start',
  build: 'process:build',
  runCustom: 'process:run-custom',
  stop: 'process:stop',
  eventLog: 'process:log',
  eventStatus: 'process:status',
  eventTerminalOpen: 'process:terminal-open',
  eventClear: 'process:clear',
  eventProjectChanged: 'project:changed',
  eventSettings: 'settings:changed',
  eventTheme: 'settings:theme',
  eventPmInstallLog: 'system:pm-install-log',
  eventDataReload: 'data:reload',
  getBootstrap: 'app:bootstrap',
  eventQuitConfirm: 'app:quit-confirm',
  quitConfirmRespond: 'app:quit-confirm-respond',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowState: 'window:state',
  eventWindowState: 'window:state-changed'
} as const

/**
 * 主进程 → 渲染进程的单向事件通道。
 * `broadcast` 只接受这些通道，拼错通道名在编译期就会报错，而不是运行时静默丢事件。
 */
export type BroadcastChannel =
  | typeof IPC.eventLog
  | typeof IPC.eventStatus
  | typeof IPC.eventTerminalOpen
  | typeof IPC.eventClear
  | typeof IPC.eventProjectChanged
  | typeof IPC.eventQuickApps
  | typeof IPC.eventSettings
  | typeof IPC.eventTheme
  | typeof IPC.eventPmInstallLog
  | typeof IPC.eventDataReload
  | typeof IPC.eventThemeConfig
  | typeof IPC.eventQuitConfirm
  | typeof IPC.eventWindowState

/**
 * 设置默认值。
 *
 * 不再是设计文档 4.8 里的出厂值，而是按当前正在使用的配置固化的：
 * 首次运行 / 数据文件里的 settings 整段缺失时，直接落成这一套。
 * 各项常量（程序名、终端高度、背景浓淡）也一并跟着改，保证「默认值」只有一处口径。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  appName: APP_NAME_DEFAULT,
  launchAtLogin: true,
  theme: 'dark',
  hotkeyEnabled: true,
  hotkey: 'Control+M',
  terminalHeight: TERMINAL_HEIGHT_DEFAULT,
  terminalButtonTop: TERMINAL_BUTTON_TOP_DEFAULT,
  workspaceBackground: builtinReference('二次元美女'),
  workspaceBackgroundOpacity: BACKGROUND_OPACITY_DEFAULT,
  workspaceBackgroundVeil: '',
  accentColor: ACCENT_COLOR_DEFAULT,
  accentInk: ACCENT_INK_DEFAULT,
  topBarStyle: 'clear',
  cardOpacity: CARD_OPACITY_DEFAULT,
  tokenSyncRepo: '',
  activeView: 'home',
  syncAppearance: true,
  useAccountForSync: true
}
