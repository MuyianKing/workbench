/**
 * 应用级类型契约（迁移前那份 `src/shared/types.ts`，monorepo 化后落到渲染层）。
 *
 * 域类型（笔记 / 知识库 / AI / 用量 / 外观…）住在各自的包（packages/*）里，这里聚合
 * re-export，渲染层照旧从 `@/types` 一站式取类型。应用级形状按用途分了两份：
 * 设置与默认值在 [settings.ts](./settings.ts)，`window.workbench` 的通道在 [api.ts](./api.ts)；
 * 本文件只剩项目 / 终端 / 窗口 / 事件这些零散形状。
 */

import type { AiImagePayload, AiSkillRef } from '@workbench/ai'
import type { EffectiveTheme, ThemeConfig } from '@workbench/appearance'
import type { AccountProfile, AuthProvider } from '@workbench/auth'
import type { ActiveSession, ActivityBreakdown, CommandEntry, IconCacheEntry, PackageManager, ProjectColor, QuickApp } from '@workbench/core'
import type { VaultRecord } from '@workbench/vault'
import type { VideoSource } from '@workbench/video'
// 网关 / Qoder / ETF 的通道载荷类型：住在隔壁的 gateway.ts / qoder.ts / etf.ts（契约侧），
// 这里导入并 re-export —— WorkbenchApi 直接引用，老代码从本文件或各自适配文件取都行。

import type { AppSettings, StoredSettings } from './settings'

export * from './api'
export * from './etf'
export * from './gateway'
export * from './qoder'
export * from './settings'
export type {
  AiNewsArticle,
  AiNewsCache,
  AiNewsItem,
  AiNewsRefreshResult,
  AiNewsSourceInfo,
  AiNewsView,
} from '@workbench/ai'
export type { ThemeConfig } from '@workbench/appearance'
export type {
  AppearanceSettings,
  EffectiveTheme,
  ThemeSource,
  TopBarStyle,
} from '@workbench/appearance'
export { TOP_BAR_STYLES } from '@workbench/appearance'
export type { SyncDeviceInfo } from '@workbench/appearance'
export type { AccountProfile, AuthProvider } from '@workbench/auth'
export type {
  Annotation,
  AnnotationStylePatch,
  AnnotationTool,
  CaptureContext,
  CaptureMonitorFrame,
  CaptureOptions,
  HandleId,
  MagnifierView,
  MonitorGeometry,
  OcrLine,
  OcrWord,
  PinPatch,
  PinRecord,
  Point,
  Rect,
  Size,
} from '@workbench/capture'
/** 活跃度计数、首页布局、同步的其它设备也走这里导出，渲染层统一从 @/types 取类型 */
export type { ActivityBreakdown, ActivityCounts, ActivityKind, ActivityView } from '@workbench/core'
export type { ProjectColor } from '@workbench/core'
// 下面这几样原先定义在本文件，monorepo 化后类型跟着自己的域走（Result / PackageManager /
// ScanResult / CommandEntry / QuickApp / IconCacheEntry / ActiveSession 在 core，
// 账号那两样在 auth，主题与顶栏那批在 appearance），这里保留原来的出口形状。
export type {
  ActiveSession,
  CommandEntry,
  IconCacheEntry,
  PackageManager,
  QuickApp,
  Result,
  ScanResult,
} from '@workbench/core'
export type {
  GitBranchList,
  GitChangedFile,
  GitCommitDetail,
  GitCommitPage,
  GitCompare,
  GitFileStatus,
  GitPatch,
  GitRepoInfo,
  GitTreeEntry,
  GitTreeEntryType,
  GitTreePage,
} from '@workbench/git'
export type {
  KbEntryMeta,
  KbIndexInfo,
  KbRawItem,
  KbRawSource,
  KbRawSourceRow,
  KbRawSourceScan,
  KbRawStatus,
  KbRepoState,
  KbScanEntry,
  KbScanResult,
  KbStats,
  KbSyncInput,
  KbSyncSummary,
} from '@workbench/kb'
export type { BallContext, NetCounters, NetRate } from '@workbench/net-meter'
export type {
  NoteChange,
  NoteCreateInput,
  NoteDocument,
  NoteEntry,
  NoteKind,
  NoteNode,
  NoteRepoState,
  NoteSyncInput,
  NoteSyncSummary,
} from '@workbench/notes'
export type {
  NoteImage,
  NoteImageAsset,
  NoteImageDeleted,
  NoteImageDeleteInput,
  NoteImageList,
  NoteImageListInput,
  NoteImageUploaded,
  NoteImageUploadInput,
  NoteTextScan,
} from '@workbench/notes'
export type {
  SkillCommit,
  SkillCreateInput,
  SkillEntry,
  SkillFileInfo,
  SkillInstalledScan,
  SkillLibraryState,
  SkillSyncSummary,
} from '@workbench/skills'
export type { TokenUsageResult } from '@workbench/usage'
export type { VideoNode, VideoSource } from '@workbench/video'
export type { GitCommit, GitCommitLog, GitWorkLogDraft, WorkLogEntry, WorkLogInput, WorkLogPatch, WorkLogSource } from '@workbench/work-log'
export type { ZentaoBrowse, ZentaoBug, ZentaoBugList, ZentaoSession } from '@workbench/zentao'

export type ProjectStatus = 'idle' | 'installing' | 'running' | 'building' | 'success' | 'failed'

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
   * 存的是主题色名（见 packages/core/src/project-color.ts），不是色值 —— 明暗切换与用户自定义主题色
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
   * 开发服务上一次的监听端口 —— **由应用自动维护，不是用户配置**。
   *
   * 启动后从日志里认出实际监听的那个就写回来；点「停止」时清空。应用是直接关掉、
   * 服务还在跑的时候它会留到下次启动，用来认出「在 Workbench 之外还跑着」的服务
   * （见 packages/core/src/dev-port.ts）。
   */
  port?: number
  /**
   * 该项目执行命令时使用的 nvm Node 版本（如 20.20.2）。
   * 留空表示跟随系统 PATH 里的 node；只影响本项目的子进程，不修改全局软链。
   */
  nodeVersion?: string
  groupId?: string
  /**
   * 在首页展示：首页那张项目卡（我的项目）**只画勾了这一项的项目**。
   *
   * 缺省与老数据（没有这个字段）都是「不展示」—— 首页是挑出来的一份，
   * 不是全量列表照搬（全量在项目页）。开关有三处：添加项目时勾、项目卡「⋯」菜单、
   * 详情抽屉「基本信息」。
   */
  home?: boolean
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
 * 保险库密钥的状态。
 *
 * **这里没有密钥本身**：`fingerprint` 是公钥的摘要（`A1B2-C3D4-E5F6` 那种），
 * 用来核对两台机器拿的是不是同一把；对不上时界面会说「该重新导出一次密钥」。
 * 私钥只在本机内存与 Windows 凭据管理器之间走（那一条 `vault_key_write` 通道），
 * 除此之外任何地方都拿不到它。
 */
export interface VaultKeyState {
  /** 这台机器上有没有一把密钥（凭据管理器里那条记录在不在） */
  exists: boolean
  /** 密钥这会儿在不在内存里。锁上之后要重新解锁才看得到条目 */
  unlocked: boolean
  /** 公钥指纹；没解锁时是空串（它得先有公钥才算得出来） */
  fingerprint: string
}

/**
 * 这台机器的 Windows 验证（Hello）配没配好，解锁屏据此分流两条路：
 *
 * - `available`：已配好，解锁弹系统自己的验证框（PIN / 指纹 / 人脸）—— 默认路；
 * - `unconfigured`：机器配得上但还没配，界面给一句去哪儿配（微软账户的机器上，
 *   输本机账户密码那条路永远走不通，只有这一句能救回来）；
 * - `unavailable`：没有验证手段（连 PIN 都配不了，或被策略关了），只能输本机账户密码。
 */
export type VaultHelloState = 'available' | 'unconfigured' | 'unavailable'

/**
 * 推给仓库的结果。
 *
 * `pushed: false` **不是失败**：那是「远端在这一轮里被另一台机器推过」，
 * 携带回来的 `remote` 是要重新合进去的那一份，适配层会自动重走一遍。
 */
export interface VaultPushOutcome {
  pushed: boolean
  /** 远端现在的那份（没推成时交回来，推成了就是刚写上去那份） */
  remote: unknown
  /** 没推成时 git 的那句话，只用于排查 */
  reason?: string
}

/** 解开本机那份的结果：条目 + 两类读不出来的条数 */
export interface VaultLoaded {
  records: VaultRecord[]
  /** 本机解不开的条数（仓库里那份是用别的密钥加的密时，这里会等于它的条数） */
  unreadable: number
  /** 文件里认不出来被丢掉的条数 */
  dropped: number
  /** 最近一次改动时刻（毫秒） */
  updatedAt: number
}

/** 一轮同步之后的结果：解开的内容 + 这次同步的实情 */
export interface VaultSyncOutcome extends VaultLoaded {
  /** 合并时远端那份里有几条 */
  remoteItems: number
  /** 走了几遍才落定（远端一直被改时大于 1） */
  rounds: number
  /** 仓库里那份与本机这把密钥对不上 —— 界面必须如实说一句，否则「同步成功却没多出东西」说不通 */
  keyMismatch: boolean
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
  /** 凭据管理器里确实有 token 的那些平台。**这才是「已登录」的判据。 */
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
export type LoginOutcome
  = | { status: 'ok', account: AccountProfile }
    | { status: 'cancelled' }
    | { status: 'failed', error: string }

/** 持久化到磁盘的数据结构 */
export interface PersistedData {
  projects: Project[]
  groups: ProjectGroup[]
  /** 首页「快捷启动」的常用软件 */
  quickApps: QuickApp[]
  /**
   * 程序图标的 base64 缓存，key 是程序路径。
   * 省掉每次启动重新抽取一遍图标（见 packages/core/src/icon-cache.ts）。
   */
  iconCache?: Record<string, IconCacheEntry>
  /** 首页「命令」卡片里的命令，与项目相互独立 */
  commands: CommandEntry[]
  /** 这里只有「换台机器就不成立」的那些设置；外观与首页布局在 theme.json（见 StoredSettings） */
  settings: StoredSettings
  /** 上次运行期间启动、尚未确认结束的子进程 */
  activeSessions?: ActiveSession[]
  /**
   * 首页活跃度图的数据源：按本地日期聚合的**各来源**操作次数（启动 / 打包、工作日志、
   * 新建笔记、助手对话、知识库整理）。与项目各自的 history 分开存 —— history 每个项目
   * 只留最近 10 条，撑不起一整年的图。
   *
   * 分来源存、不另存一份总数：图上那一格的深浅由 `totalOf()` 现算（两份真源迟早对不上）。
   */
  activity?: ActivityBreakdown
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
  /**
   * 最近一条状态来自哪一类命令（启动 / 打包 / 安装…）。
   * 「命令正常退出」的文案要按它区分：只有打包才谈得上「打包成功」（见 @/status 的 statusLabel）。
   */
  kind?: TerminalKind
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
  /** 加入后是否放到首页展示（见 Project.home）；缺省不展示 */
  home?: boolean
}

/** 可编辑的项目配置项 */
export interface ProjectPatch {
  name?: string
  packageManager?: PackageManagerSetting
  scripts?: ProjectScripts
  outputDir?: string
  autoOpenExplorer?: boolean
  nodeVersion?: string
  /** 监听端口由应用自己维护（启动时写回、停止时清空）；null 表示清空 */
  port?: number | null
  groupId?: string
  /** 标识色（见 Project.color） */
  color?: ProjectColor
  /** 是否在首页展示（见 Project.home） */
  home?: boolean
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

/** 写 DESIGN.md 的回执：落在哪、原本是否已有这个文件（据此换提示文案） */
export interface DesignWriteOutcome {
  path: string
  existed: boolean
}

/**
 * 一次 AI 任务的入参（`aiRun`）。
 *
 * `program` 与 `args` 由渲染层的纯函数拼（@workbench/ai 的 piLaunch，有单测）：
 * 直启 `node <内置 cli.js>` 或全局 `pi`，**不经 cmd 的整行解析** —— 行内层引号会被
 * cmd 的引号剥离规则拆坏（踩过）。用哪个模型、挂在哪个会话上也在这组参数里
 * （`--provider` / `--model` / `--session-id`：Pi 不读 PI_MODEL 环境变量，只认参数）。
 * **提示词不在这里**：Pi 跑 RPC 模式，提示词是 stdin 上的一行 JSON，由 Rust 写进去
 * （见 src-tauri/src/ai.rs）。**密钥也不在这里** —— 它在凭据管理器里，Rust 按提供方名
 * 取出来注入环境变量。
 */
export interface AiRunInput {
  /** 子进程会话 id（`ai:<会话 id>`）：输出与退出靠它回到这个会话 */
  sessionId: string
  /** 工作目录（子进程的工作目录，也是提示词里写明的那个目录） */
  dir: string
  /**
   * 提示词全文（Rust 写成 stdin 的一行 JSON）。**空串 = 只把进程起起来、不发提示词** ——
   * 打开一个旧会话读历史（`get_messages`）走的就是这条路；同一条会话已经有活着的进程时，
   * 这一句就是接着聊的那一轮。
   */
  prompt: string
  /**
   * 这一句附的图（用户贴在输入框里的那些，shape 见 @workbench/ai 的 AI_IMAGE_TYPES 一段）。
   * 它们与提示词一起进**同一行** JSON（Pi 的 `prompt` 命令带 `images`）——
   * 空数组就是没有。**只把进程起起来那趟（prompt 空串）当然是空的。**
   */
  images: AiImagePayload[]
  /** 要直启的程序：`node`（内置模式）或 `pi`（全局退路） */
  program: string
  /** 参数数组（不含提示词；自动编辑时 Rust 会追加 `-e <权限扩展>`） */
  args: string[]
  /** 提供方名：取密钥用的凭据名（模型在 args 里） */
  provider: string
  /** 工具权限模式（@workbench/ai 的 AI_PERMISSION_MODES；只有 `full` 是「不问」） */
  permission: string
  /**
   * 这一轮启用的技能（根 + 技能名，见 @workbench/ai 的 pi-skills）：Rust 逐条拼成 `--skill <目录>`
   * 交给 Pi。**关掉的技能不在里面** —— Pi 这条启动路径不扫任何默认技能目录，
   * 参数里没有的它就看不见（「没启用」与「不存在」是同一种结果）。
   */
  skills: AiSkillRef[]
}

/**
 * 独立视频窗口的一集（播放列表里的一项）。
 *
 * 只带相对路径与显示名：窗口拿到 `root` 后自己调 `loadVideo` 换下一个，
 * URL 与 asset 授权仍在进程内按文件走（见 @workbench/video 与 video.md）。
 */
export interface VideoWindowItem {
  rel: string
  name: string
}

/**
 * 开独立视频窗口时主窗口交过去的那份上下文。
 *
 * `time` 是主窗口播放器暂停时的秒数 —— 窗口从同一秒接上；`playing` 决定它到了
 * 元数据之后要不要直接开播（暂停态保持暂停）。`playlist` 是视频树按展示顺序摊平的一
 * 整份，播完自动接续时窗口按它在里面找下一个。
 */
export interface VideoWindowOpen {
  root: string
  source: VideoSource
  rate: number
  time: number
  playing: boolean
  playlist: VideoWindowItem[]
}

/** 窗口向 Rust 问回的上下文：开窗时那份 + 本次运行的置顶状态（不落盘） */
export interface VideoWindowContext extends VideoWindowOpen {
  onTop: boolean
}

/**
 * 独立 Markdown 编辑窗口启动时取到的上下文。
 *
 * 只有文件名、正文与 mtime：完整路径留在 Rust 会话里，渲染层不需要、也拿不到
 * （下一笔写盘按这个 mtime 做冲突判断，见 notes.rs 的 write）。
 */
export interface MarkdownWindowContext {
  /** 文件名（不带目录），窗口标题用的也是它 */
  name: string
  /** 读盘时的正文 */
  text: string
  /** 读盘那一刻文件的 mtime，保存时当基准 */
  mtimeMs: number
}

/** 主窗口 → 独立视频窗口的命令（Rust 转成 `video-window:command` 事件） */
export type VideoWindowCommand
  = | { action: 'load', source: VideoSource, rate: number, time: number, playing: boolean, playlist: VideoWindowItem[] }
    | { action: 'dock' }
    | { action: 'close' }

/** 独立视频窗口 → 主窗口的回报（`dock` / `close` 由 Rust 处理完窗口再转发） */
export type VideoWindowReport
  = | { kind: 'active', source: VideoSource, rate: number }
    | { kind: 'rate', rate: number }
    | { kind: 'dock', source: VideoSource, rate: number, time: number, playing: boolean }
    | { kind: 'close' }

/** 主窗口收到的独立视频窗口事件（Rust 发 `video-window:event`） */
export type VideoWindowEvent
  = | { kind: 'active', source: VideoSource, rate: number }
    | { kind: 'rate', rate: number }
    | { kind: 'dock', source: VideoSource, rate: number, time: number, playing: boolean }
    | { kind: 'closed', docked: boolean }

/** 自绘标题栏需要知道的窗口状态 */
export interface WindowState {
  maximized: boolean
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

/** 邮件系统通知被点击时的载荷：哪个账户的哪一封（uid 是通知时最新那封新邮件） */
export interface MailNotifyPayload {
  account: string
  uid: number
}
