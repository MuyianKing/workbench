/** 适配层与渲染层共用的类型定义与 IPC 契约 */

import { ACCENT_COLOR_DEFAULT, ACCENT_INK_DEFAULT, type AccentInkMode } from './accent-color'
import { APP_NAME_DEFAULT } from './app-name'
import { TERMINAL_HEIGHT_DEFAULT } from './terminal-height'
import { CARD_OPACITY_DEFAULT } from './card-opacity'
import { BACKGROUND_OPACITY_DEFAULT } from './workspace-background'
import { builtinReference } from './wallpaper'
import type { ActivityCounts } from './activity'
import type { BuildTool, PortSource } from './dev-port'
import type { ThemeConfig } from './theme'
import type { TokenUsageResult } from './token-usage'

/** 活跃度计数、首页布局也走这里导出，渲染层统一从 @/types 取类型 */
export type { ActivityCounts, ThemeConfig }
export type { TokenUsageResult } from './token-usage'

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

/** 应用级设置（F-8.x） */
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
}

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
  settings: AppSettings
  /** 上次运行期间启动、尚未确认结束的子进程 */
  activeSessions?: ActiveSession[]
  /**
   * 按本地日期聚合的命令执行次数，首页活跃度图的数据源。
   * 与项目各自的 history 分开存：history 每个项目只留最近 10 条，撑不起一整年的图。
   */
  activity?: ActivityCounts
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
   * 立刻同步一次 Token 快照并返回合并后的结果（面板上的手动同步按钮）。
   * 自动同步按间隔节流，这个入口不受节流限制。
   */
  syncTokenUsage: () => Promise<Result<TokenUsageResult>>
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
  /** 首页布局配置（theme.json）：七块卡片的位置 / 尺寸与拖动步进 */
  getThemeConfig: () => Promise<ThemeConfig>
  /** 合并保存首页布局；返回收敛后的最终值 */
  updateThemeConfig: (patch: Partial<ThemeConfig>) => Promise<Result<ThemeConfig>>
  /** 项目数据文件所在目录（含是否为默认位置） */
  getDataLocation: () => Promise<DataLocation>
  /** 选择新的数据目录；目标已存在数据文件时返回冲突而不是直接覆盖 */
  pickDataDir: () => Promise<DataLocationPick>
  /** 迁移：把当前数据写到新目录并切过去 */
  migrateDataDir: (dir: string) => Promise<Result<DataLocation>>
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
  workspaceBackground: builtinReference('二次元美女'),
  workspaceBackgroundOpacity: BACKGROUND_OPACITY_DEFAULT,
  workspaceBackgroundVeil: '',
  accentColor: ACCENT_COLOR_DEFAULT,
  accentInk: ACCENT_INK_DEFAULT,
  topBarStyle: 'clear',
  cardOpacity: CARD_OPACITY_DEFAULT,
  tokenSyncRepo: ''
}
