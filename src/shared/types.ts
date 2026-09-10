/** 主进程与渲染进程共用的类型定义与 IPC 契约 */

import { TERMINAL_HEIGHT_DEFAULT } from './terminal-height'
import type { ActivityCounts } from './activity'

/** 活跃度计数也走这里导出，渲染层统一从 @/types 取类型 */
export type { ActivityCounts }

export type ProjectStatus = 'idle' | 'installing' | 'running' | 'building' | 'success' | 'failed'

export type PackageManager = 'npm' | 'yarn' | 'pnpm'

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

/** 一个终端对应「某个项目的一类操作」，所以同一项目的启动与打包是两个终端 */
export type TerminalKind = 'start' | 'build' | 'install' | 'custom'

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
  /** 项目数据文件所在目录（含是否为默认位置） */
  getDataLocation: () => Promise<DataLocation>
  /** 选择新的数据目录；目标已存在数据文件时返回冲突而不是直接覆盖 */
  pickDataDir: () => Promise<DataLocationPick>
  /** 迁移：把当前数据写到新目录并切过去 */
  migrateDataDir: (dir: string) => Promise<Result<DataLocation>>
  onLog: (fn: (e: ProcessLogEvent) => void) => () => void
  onStatus: (fn: (e: ProcessStatusEvent) => void) => () => void
  onTerminalOpen: (fn: (e: TerminalOpenEvent) => void) => () => void
  onClear: (fn: (e: { terminal: string }) => void) => () => void
  onProjectChanged: (fn: (project: Project) => void) => () => void
  onSettingsChanged: (fn: (settings: AppSettings) => void) => () => void
  onTheme: (fn: (theme: EffectiveTheme) => void) => () => void
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
  checkPort: 'system:check-port',
  killPortProcess: 'system:kill-port',
  checkNodeVersion: 'system:check-node',
  nvmStatus: 'system:nvm-status',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
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
  terminalHeight: TERMINAL_HEIGHT_DEFAULT
}
