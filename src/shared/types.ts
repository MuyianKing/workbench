/** 主进程与渲染进程共用的类型定义与 IPC 契约 */

import { TERMINAL_HEIGHT_DEFAULT } from './terminal-height'
import { SIDE_PANEL_WIDTH_DEFAULT } from './side-panel-width'
import { SIDE_PANEL_POSITION_DEFAULT } from './side-panel-position'
import { BACKGROUND_OPACITY_DEFAULT } from './workspace-background'
import type { ActivityCounts } from './activity'
import type { SidePanelPosition } from './side-panel-position'

/** 活跃度计数、侧栏位置也走这里导出，渲染层统一从 @/types 取类型 */
export type { ActivityCounts, SidePanelPosition }

export type ProjectStatus = 'idle' | 'installing' | 'running' | 'building' | 'success' | 'failed'

export type PackageManager = 'npm' | 'yarn' | 'pnpm'

/**
 * 可以在应用内一键安装的包管理器：走 `npm install -g`。
 * npm 自己随 Node.js 分发，装不了它 —— 系统里没有 npm 说明 Node 就没装好。
 */
export type InstallablePackageManager = Exclude<PackageManager, 'npm'>

export type PackageManagerSetting = 'auto' | PackageManager

export type ThemeSource = 'system' | 'light' | 'dark'

/** 实际生效的主题（system 由主进程解析成 light / dark 再推给渲染层） */
export type EffectiveTheme = 'light' | 'dark'

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
  kind: 'start' | 'build' | 'install' | 'custom'
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

/** 应用级设置（F-8.x） */
export interface AppSettings {
  /** 退出行为：有项目运行时提示确认 / 直接停止全部并退出 */
  closeBehavior: 'confirm' | 'stopAll'
  /** 开机自启，默认关闭 */
  launchAtLogin: boolean
  /** 主题，默认跟随系统 */
  theme: ThemeSource
  /** 全局快捷键是否启用 */
  hotkeyEnabled: boolean
  /** 唤起 / 隐藏主窗口的全局快捷键 */
  hotkey: string
  /**
   * 最小化时收进托盘。
   * 没有「是否常驻托盘」这个开关了 —— 关闭按钮就是隐藏到托盘，托盘是找回窗口的唯一入口。
   */
  minimizeToTray: boolean
  /** 终端面板展开时的高度（px），由拖动面板上沿决定 */
  terminalHeight: number
  /**
   * 首页侧栏的宽度（px），放「系统状态 / 最近使用 / 快捷操作」三块面板。
   * 窗口窄到挤不下两栏时（< 880px）会退化成单列，这个值自动失效。
   */
  sidePanelWidth: number
  /**
   * 首页侧栏放在卡片网格的哪一侧：左 / 右。
   * 换边不换宽度，栏宽始终看 sidePanelWidth。
   */
  sidePanelPosition: SidePanelPosition
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
}

/** 持久化到磁盘的数据结构 */
export interface PersistedData {
  projects: Project[]
  groups: ProjectGroup[]
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
}

/** 添加项目时提交给主进程的数据 */
export interface AddProjectInput {
  path: string
  name: string
  groupId?: string
  serve?: string
  build: string[]
  defaultBuild?: string
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
  groupId?: string
}

/**
 * 一个终端对应「某个项目的一类操作」，所以同一项目的启动与打包是两个终端。
 * system 是不属于任何项目的那类，例如在本机全局安装包管理器。
 */
export type TerminalKind = 'start' | 'build' | 'install' | 'custom' | 'system'

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
 * 但命令输出走数组：狂刷日志时逐行 send 会让主进程和渲染进程互相拖累，
 * 主进程按帧聚合后整批发一次（见 main/log-batcher.ts）。
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
  pm: InstallablePackageManager
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
 * 从 Electron 这类 GUI 进程里 spawn 只会拿到「should be run from a terminal」然后静默退出；
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
  /** data:image/jpeg;base64,… */
  dataUrl: string
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

/** preload 向渲染进程暴露的 API */
export interface WorkbenchApi {
  platform: string
  versions: { electron: string; node: string; chrome: string }
  pickDirectory: () => Promise<string | null>
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
  createGroup: (name: string) => Promise<Result<ProjectGroup>>
  renameGroup: (id: string, name: string) => Promise<Result<ProjectGroup>>
  removeGroup: (id: string) => Promise<Result<null>>
  /** 按给定顺序重排分组（拖动排序） */
  reorderGroups: (ids: string[]) => Promise<Result<ProjectGroup[]>>
  reveal: (targetPath: string) => Promise<Result<null>>
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
  install: (id: string) => Promise<Result<null>>
  start: (id: string) => Promise<Result<null>>
  build: (id: string, script: string) => Promise<Result<null>>
  /** 执行项目配置里的第 index 条自定义命令 */
  runCustom: (id: string, index: number) => Promise<Result<null>>
  stop: (id: string) => Promise<Result<null>>
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<Result<AppSettings>>
  /** 挑一张图片当工作区背景；只返回路径，落盘交给 updateSettings */
  pickBackground: () => Promise<string | null>
  /** 读取背景图（主进程压好尺寸后回传 data URL），文件不在或读不出来时返回失败 */
  loadBackground: (path: string) => Promise<Result<BackgroundImage>>
  /** 内置壁纸清单（含缩略图）；目录里没有图时返回空数组 */
  listWallpapers: () => Promise<BuiltinWallpaper[]>
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
  onSettingsChanged: (fn: (settings: AppSettings) => void) => () => void
  onTheme: (fn: (theme: EffectiveTheme) => void) => () => void
  /** 包管理器安装过程中的输出，一行一行推过来 */
  onPmInstallLog: (fn: (e: PmInstallLogEvent) => void) => () => void
  /** 数据目录切换后，渲染层需要整份重新加载 */
  onDataReload: (fn: () => void) => () => void
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
  createGroup: 'group:create',
  renameGroup: 'group:rename',
  removeGroup: 'group:remove',
  reorderGroups: 'group:reorder',
  reveal: 'system:reveal',
  checkPackageManagers: 'system:check-pm',
  installPackageManager: 'system:install-pm',
  checkPort: 'system:check-port',
  killPortProcess: 'system:kill-port',
  checkNodeVersion: 'system:check-node',
  nvmStatus: 'system:nvm-status',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  pickBackground: 'settings:pick-background',
  loadBackground: 'settings:load-background',
  listWallpapers: 'settings:list-wallpapers',
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
  eventDataReload: 'data:reload'
} as const

/** 设置默认值：与设计文档 4.8 一致 */
export const DEFAULT_SETTINGS: AppSettings = {
  closeBehavior: 'confirm',
  launchAtLogin: false,
  theme: 'system',
  hotkeyEnabled: true,
  hotkey: 'Control+Shift+W',
  minimizeToTray: false,
  terminalHeight: TERMINAL_HEIGHT_DEFAULT,
  sidePanelWidth: SIDE_PANEL_WIDTH_DEFAULT,
  sidePanelPosition: SIDE_PANEL_POSITION_DEFAULT,
  workspaceBackground: '',
  workspaceBackgroundOpacity: BACKGROUND_OPACITY_DEFAULT,
  workspaceBackgroundVeil: ''
}
