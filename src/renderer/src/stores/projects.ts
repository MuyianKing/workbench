import { computed, markRaw, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  DEFAULT_SETTINGS,
  type ActivityCounts,
  type AddProjectInput,
  type AppSettings,
  type BuiltinWallpaper,
  type DataLocation,
  type EffectiveTheme,
  type InstallablePackageManager,
  type LogLine,
  type NvmStatus,
  type PackageManager,
  type PackageManagerStatus,
  type ProcessLogEvent,
  type ProcessLogPayload,
  type ProcessStatusEvent,
  type Project,
  type ProjectGroup,
  type ProjectPatch,
  type RuntimeState,
  type TerminalKind,
  type TerminalOpenEvent
} from '@/types'
import { clampTerminalHeight } from '@shared/terminal-height'
import { clampSidePanelWidth } from '@shared/side-panel-width'
import { clampBackgroundOpacity, sanitizeVeilColor } from '@shared/workspace-background'
import { RingLog } from '@shared/log-ring'

const LOG_LIMIT = 5000

/** 本机环境那个终端（npm 全局安装包管理器）的固定键，全局只有一个 */
export const SYSTEM_PM_TERMINAL = 'system::pm'

let logSeq = 0

/**
 * 日志缓冲区每次变化的计数。
 *
 * 缓冲区本身被 markRaw 掉、不参与响应式（5000 行的数组让 Vue 代理它纯属浪费），
 * 所以渲染层靠这个计数器知道「有新日志了」。放在 store 外面：
 * 一份就够 —— 面板同一时刻只渲染一个终端的日志。
 */
const logVersion = ref(0)

/** 未分组项目在筛选栏里的伪分组 id */
export const UNGROUPED = 'ungrouped'

/** 终端键后缀：一种操作一个终端 */
export type TerminalKey = 'start' | 'build' | 'install' | `custom:${number}`

/**
 * 一个终端 = 某个项目的一类操作。
 * 同一个项目的「启动」和「打包」各占一个终端，输出互不覆盖。
 */
export interface TerminalState {
  key: string
  projectId: string
  kind: TerminalKind
  label: string
  status: ProcessStatusEvent['status']
  pid?: number
  currentCommand?: string
  startedAt?: number
  durationMs?: number
  exitCode?: number | null
  port?: number
  /**
   * 输出缓冲：定长环形，且被 markRaw 掉（刻意不参与响应式）。
   * 用 ring 而不是数组，是为了避开写满之后每行一次 `splice(0, 1)` 的整体搬移；
   * 想看它的变化请依赖 `logVersion`。
   */
  logs: RingLog<LogLine>
}

const RUNNING_STATUS: ReadonlyArray<string> = ['running', 'installing', 'building']

/** 今天 00:00 的时间戳（本地时区） */
function startOfToday(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** 主进程推主题之前，先按设置自算一次，避免首帧闪一下白底 */
function resolveTheme(value: AppSettings): EffectiveTheme {
  if (value.theme === 'system') return prefersDark() ? 'dark' : 'light'
  return value.theme
}

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const groups = ref<ProjectGroup[]>([])
  const runtimes = reactive<Record<string, RuntimeState>>({})
  /** 终端表：键是 `${projectId}::${kindKey}` */
  const terminals = reactive<Record<string, TerminalState>>({})
  /** Tab 顺序 = 创建顺序 */
  const terminalOrder = ref<string[]>([])

  const keyword = ref('')
  const groupFilter = ref<string>('all')
  const sortBy = ref<'recent' | 'name' | 'created'>('recent')

  const activeTerminal = ref<string | null>(null)
  /**
   * 终端面板是否收起。
   *
   * 面板本身只在「有终端」时才出现，所以应用刚启动时底部什么都没有（默认隐藏）；
   * 一旦跑过命令，面板条就常驻在底部，由条上的箭头负责展开/收起 —— 不需要额外的顶栏开关。
   */
  const terminalCollapsed = ref(true)

  const drawerProjectId = ref<string | null>(null)
  const addDialogVisible = ref(false)

  const packageManagers = ref<PackageManagerStatus | null>(null)
  /** 正在通过 npm 全局安装的包管理器，null 表示空闲 */
  const pmInstalling = ref<InstallablePackageManager | null>(null)
  /** 安装过程的最新一行 npm 输出，仅安装期间有值 */
  const pmInstallLog = ref('')
  /** nvm 探测结果：可选的项目级 Node 版本来自这里 */
  const nvm = ref<NvmStatus | null>(null)
  const ready = ref(false)
  /** 项目目录是否仍然存在；尚未检查过的项目按有效处理 */
  const pathValidity = ref<Record<string, boolean>>({})
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const dataLocation = ref<DataLocation | null>(null)
  /** 按天聚合的命令执行次数，首页活跃度图的数据源；每次执行结束后由主进程推着刷新 */
  const activity = ref<ActivityCounts>({})

  /**
   * 终端面板展开时的高度（px）。
   * 拖动过程中终端组件只改这个 ref（跟手渲染），松手后才通过 setTerminalHeight 落盘。
   */
  const terminalHeight = ref(DEFAULT_SETTINGS.terminalHeight)

  // 设置是异步载入的（也随时可能被设置窗口 / 数据目录迁移改写），跟着它同步一次
  watch(
    () => settings.value.terminalHeight,
    (value) => {
      terminalHeight.value = clampTerminalHeight(value)
    },
    { immediate: true }
  )

  /** 拖完 / 键盘微调后落地：界面先跟手，磁盘异步写 */
  async function setTerminalHeight(px: number): Promise<void> {
    const next = clampTerminalHeight(px)
    terminalHeight.value = next
    if (next === settings.value.terminalHeight) return

    await updateSettings({ terminalHeight: next })
  }

  /**
   * 首页右栏宽度（px）。
   *
   * 与终端高度同一套做法：滑块拖动过程中只改这个 ref 让布局跟手，
   * 松手（change）才落盘，免得每动一格就写一次数据文件。
   */
  const sidePanelWidth = ref(DEFAULT_SETTINGS.sidePanelWidth)

  watch(
    () => settings.value.sidePanelWidth,
    (value) => {
      sidePanelWidth.value = clampSidePanelWidth(value)
    },
    { immediate: true }
  )

  async function setSidePanelWidth(px: number): Promise<void> {
    const next = clampSidePanelWidth(px)
    sidePanelWidth.value = next
    if (next === settings.value.sidePanelWidth) return

    await updateSettings({ sidePanelWidth: next })
  }

  /**
   * 工作区背景。
   *
   * 设置里存的是磁盘路径，这里拿到的永远是主进程压好的 data URL（见 stores 上方说明与
   * main/background.ts）：图片不进数据文件，换图只是换一个字符串。
   * 图片被删、被换成读不出来的格式时留空并把原因记在 backgroundError 里，设置界面据此提示。
   */
  const backgroundImage = ref('')
  const backgroundName = ref('')
  const backgroundError = ref('')
  /** 已经读进 backgroundImage 的那条路径，用来免掉「刚选完又被设置变化推着读一遍」 */
  const backgroundPath = ref('')

  const backgroundOpacity = ref(DEFAULT_SETTINGS.workspaceBackgroundOpacity)

  watch(
    () => settings.value.workspaceBackgroundOpacity,
    (value) => {
      backgroundOpacity.value = clampBackgroundOpacity(value)
    },
    { immediate: true }
  )

  async function setBackgroundOpacity(percent: number): Promise<void> {
    const next = clampBackgroundOpacity(percent)
    backgroundOpacity.value = next
    if (next === settings.value.workspaceBackgroundOpacity) return

    await updateSettings({ workspaceBackgroundOpacity: next })
  }

  /**
   * 蒙版色：图片渐淡进去的那个颜色，空串表示跟随主题的画布色。
   * 没有背景图时它照样生效 —— 相当于给工作区定一个底色。
   */
  async function setBackgroundVeil(color: string): Promise<boolean> {
    const next = sanitizeVeilColor(color)
    if (next === settings.value.workspaceBackgroundVeil) return true

    return updateSettings({ workspaceBackgroundVeil: next })
  }

  /** 读一张图贴上工作区；读不出来时清空并把原因留在 backgroundError */
  async function applyBackground(path: string): Promise<boolean> {
    if (!path) {
      backgroundImage.value = ''
      backgroundName.value = ''
      backgroundPath.value = ''
      backgroundError.value = ''
      return true
    }

    // 同一张图已经在手上：选完图落盘会再触发一次，没必要把几兆的 data URL 再搬一遍
    if (path === backgroundPath.value && backgroundImage.value) return true

    const result = await window.workbench.loadBackground(path)
    if (!result.ok || !result.data) {
      backgroundImage.value = ''
      backgroundName.value = ''
      backgroundPath.value = ''
      backgroundError.value = result.error ?? '背景图读取失败'
      return false
    }

    backgroundImage.value = result.data.dataUrl
    backgroundName.value = result.data.name
    backgroundPath.value = result.data.path
    backgroundError.value = ''
    return true
  }

  // 设置是异步载入的，也可能被设置窗口改写（甚至被数据目录迁移整份换掉），跟着它同步
  watch(
    () => settings.value.workspaceBackground,
    (value) => void applyBackground(value),
    { immediate: true }
  )

  /**
   * 随应用发布的内置壁纸（resources/backgrounds 下的那几张）。
   *
   * 只在启动时拉一次：它们的缩略图是主进程现压的 data URL，没必要每次开设置都重来一遍。
   * 目录里没有图时是空数组，设置里那一栏自己会收起来。
   */
  const wallpapers = ref<BuiltinWallpaper[]>([])

  async function refreshWallpapers(): Promise<void> {
    wallpapers.value = await window.workbench.listWallpapers()
  }

  /**
   * 换一张工作区背景。
   *
   * target 可以是磁盘路径、`builtin:<id>` 内置引用，或空串（恢复默认画布）。
   * 一律先读通再落盘：免得把一个读不出来的值写进设置，下次启动才发现是一片空白。
   */
  async function chooseBackground(target: string): Promise<boolean> {
    if (!(await applyBackground(target))) {
      ElMessage.error(backgroundError.value || '这张图片读不出来，请换一张')
      return false
    }
    if (target === settings.value.workspaceBackground) return true

    return updateSettings({ workspaceBackground: target })
  }

  /** 从磁盘上挑一张图当背景 */
  async function pickBackground(): Promise<boolean> {
    const picked = await window.workbench.pickBackground()
    if (!picked) return false

    return chooseBackground(picked)
  }

  /** 点选一张内置壁纸 */
  async function useWallpaper(reference: string): Promise<boolean> {
    return chooseBackground(reference)
  }

  /** 恢复默认画布 */
  async function clearBackground(): Promise<boolean> {
    return chooseBackground('')
  }

  /** 驱动运行时长刷新 */
  const clock = ref(Date.now())
  /**
   * 今天 00:00。只在跨天时变一次 —— 活跃度图的横轴末端是今天，
   * 每秒重铺 371 个格子没必要，跨过零点重算一次就够。
   */
  const dayStart = ref(startOfToday())
  window.setInterval(() => {
    const now = Date.now()
    clock.value = now
    const today = startOfToday()
    if (today !== dayStart.value) dayStart.value = today
  }, 1000)

  // ---------- 运行态 ----------

  function runtimeOf(id: string): RuntimeState {
    if (!runtimes[id]) runtimes[id] = { status: 'idle' }
    return runtimes[id]
  }

  // ---------- 终端 ----------

  function terminalKeyOf(projectId: string, key: TerminalKey): string {
    return `${projectId}::${key}`
  }

  function terminalOf(key: string): TerminalState | undefined {
    return terminals[key]
  }

  /** 项目在当前状态下可用的终端键（自定义命令按索引各一个） */
  function terminalsOfProject(projectId: string): TerminalState[] {
    return terminalOrder.value
      .map((key) => terminals[key])
      .filter((item): item is TerminalState => !!item && item.projectId === projectId)
  }

  /**
   * 新建一个终端状态。
   * 日志缓冲必须 markRaw：否则 5000 行的数组会被 Vue 整个包成响应式代理，
   * 每写一行都在触发器里走一遍转换。
   */
  function createTerminal(
    key: string,
    projectId: string,
    kind: TerminalKind,
    label: string
  ): TerminalState {
    return {
      key,
      projectId,
      kind,
      label,
      status: 'idle',
      logs: markRaw(new RingLog<LogLine>(LOG_LIMIT))
    }
  }

  function ensureTerminal(event: TerminalOpenEvent): TerminalState {
    const existing = terminals[event.terminal]
    if (existing) {
      // 名称可能被改过（自定义命令改名），顺手同步
      existing.label = event.label
      return existing
    }

    const created = createTerminal(event.terminal, event.projectId, event.kind, event.label)
    terminals[event.terminal] = created
    terminalOrder.value = [...terminalOrder.value, event.terminal]
    return created
  }

  /**
   * 打开（或复用）本机环境那个终端，并把它切到前台。
   *
   * 它不属于任何项目，所以主进程不会推 terminal-open —— 整个生命周期都在渲染层，
   * 复用同一套 Tab / 日志 / 滚动机制，安装 npm 全局包时用户看到的就是熟悉的面板。
   */
  function openSystemTerminal(label: string): TerminalState {
    const existing = terminals[SYSTEM_PM_TERMINAL]
    if (existing) {
      existing.label = label
      return existing
    }

    const created = createTerminal(SYSTEM_PM_TERMINAL, '', 'system', label)
    terminals[SYSTEM_PM_TERMINAL] = created
    terminalOrder.value = [...terminalOrder.value, SYSTEM_PM_TERMINAL]

    activeTerminal.value = SYSTEM_PM_TERMINAL
    terminalCollapsed.value = false
    return created
  }

  /** 往系统终端补一行输出；走批量通道，与项目日志同一套节奏 */
  function appendSystemLog(text: string, stream: LogLine['stream'] = 'out'): void {
    if (!terminals[SYSTEM_PM_TERMINAL]) return
    pendingLogs.push({
      terminal: SYSTEM_PM_TERMINAL,
      projectId: '',
      stream,
      text,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    })
    scheduleFlush()
  }

  function onTerminalOpen(event: TerminalOpenEvent): void {
    ensureTerminal(event)
    activeTerminal.value = event.terminal
    terminalCollapsed.value = false
  }

  /** 关掉一个终端；正在跑的那个不允许关，否则进程还在却再也看不到输出 */
  function closeTerminal(key: string): void {
    const target = terminals[key]
    if (!target) return
    if (RUNNING_STATUS.includes(target.status)) {
      ElMessage.warning('该终端正在执行命令，请先停止再关闭')
      return
    }

    delete terminals[key]
    terminalOrder.value = terminalOrder.value.filter((item) => item !== key)
    // 丢弃尚未写入的批次，避免关掉后又冒出来
    for (let i = pendingLogs.length - 1; i >= 0; i -= 1) {
      if (pendingLogs[i].terminal === key) pendingLogs.splice(i, 1)
    }

    if (activeTerminal.value === key) {
      activeTerminal.value = terminalOrder.value[terminalOrder.value.length - 1] ?? null
    }
  }

  /**
   * 日志按帧批量写入。
   *
   * 主进程已经按帧聚合过一次（见 main/log-batcher.ts），这里再兜一层是因为
   * 同一条通道上还混着系统提示与安装输出；而且批次到了以后要一次性写进环形缓冲、
   * 只把版本号加一次，让 Vue 每帧至多重新渲染一次。
   */
  const pendingLogs: ProcessLogEvent[] = []
  let flushScheduled = false

  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    requestAnimationFrame(flushLogs)
  }

  function flushLogs(): void {
    flushScheduled = false
    if (!pendingLogs.length) return

    const batch = pendingLogs.splice(0, pendingLogs.length)

    // 同一帧里同一个终端可能来好几条，先归堆再整批写入
    const grouped = new Map<string, LogLine[]>()
    for (const event of batch) {
      // 终端被用户关掉了就丢弃后续输出，不要凭日志把它复活
      if (!terminals[event.terminal]) continue

      let list = grouped.get(event.terminal)
      if (!list) {
        list = []
        grouped.set(event.terminal, list)
      }
      list.push({
        id: ++logSeq,
        time: event.time,
        stream: event.stream,
        text: event.text
      })
    }

    if (!grouped.size) return

    for (const [key, list] of grouped) {
      terminals[key]?.logs.pushMany(list)
    }
    // 版本号只加一次：这一帧新增的所有行共用一个渲染批次
    logVersion.value += 1
  }

  function onLog(payload: ProcessLogPayload): void {
    // 主进程批量通道推的是一整批；单条直发的是系统提示这类零散消息
    const events = Array.isArray(payload) ? payload : [payload]

    for (const event of events) {
      if (terminals[event.terminal]) {
        pendingLogs.push(event)
        continue
      }

      // 系统 / 错误提示可能来自命令之外的动作（如「打开产物目录」），没有绑定到
      // 具体命令终端。落到该项目当前已有的任一终端，免得这些信息凭空消失；
      // 已关闭的终端不在 terminalOrder 里，所以不会把已关的 Tab 复活。
      if (event.stream !== 'sys' && event.stream !== 'err') continue

      const fallback = terminalOrder.value
        .map((key) => terminals[key])
        .find((item) => item && item.projectId === event.projectId)
      if (fallback) pendingLogs.push({ ...event, terminal: fallback.key })
    }

    if (pendingLogs.length) scheduleFlush()
  }

  function onStatus(event: ProcessStatusEvent): void {
    // 项目级状态：卡片 / 抽屉的按钮与指示灯都看这个
    const rt = runtimeOf(event.projectId)
    rt.status = event.status
    rt.pid = event.pid
    rt.currentCommand = event.currentCommand
    rt.startedAt = event.startedAt
    rt.durationMs = event.durationMs
    rt.exitCode = event.exitCode
    rt.port = event.port ?? rt.port

    if (event.status === 'idle' || event.status === 'failed' || event.status === 'success') {
      rt.startedAt = undefined
      if (event.status !== 'failed') rt.pid = undefined
    }

    // 终端级状态：Tab 上的圆点与耗时
    const target = terminals[event.terminal]
    if (!target) return
    target.status = event.status
    target.pid = event.pid
    target.currentCommand = event.currentCommand
    target.startedAt = event.startedAt
    target.durationMs = event.durationMs
    target.exitCode = event.exitCode
    target.port = event.port ?? target.port

    if (event.status === 'idle' || event.status === 'failed' || event.status === 'success') {
      target.startedAt = undefined
      if (event.status !== 'failed') target.pid = undefined
    }

    if (RUNNING_STATUS.includes(event.status)) terminalCollapsed.value = false
  }

  function onClear(payload: { terminal: string }): void {
    // 同时丢弃尚未写入的批次，避免上一轮残留输出混进新一轮
    for (let i = pendingLogs.length - 1; i >= 0; i -= 1) {
      if (pendingLogs[i].terminal === payload.terminal) pendingLogs.splice(i, 1)
    }
    const target = terminals[payload.terminal]
    if (target) {
      target.logs.clear()
      // 清空也是一次变化：面板得跟着重画，否则旧行会留在 DOM 上
      logVersion.value += 1
    }
  }

  /** 切到某个终端并把面板展开 */
  function focusTerminal(projectId: string, key: TerminalKey): void {
    const terminal = terminalKeyOf(projectId, key)
    // 主进程的 terminal-open 会补齐终端；这里先把选中态与展开状态准备好
    activeTerminal.value = terminal
    terminalCollapsed.value = false
  }

  function clearTerminalLogs(key: string): void {
    const target = terminals[key]
    if (!target) return
    target.logs.clear()
    logVersion.value += 1
  }

  /** 主进程更新了项目（执行记录、最近使用时间），同步回本地列表 */
  function onProjectChanged(updated: Project): void {
    const index = projects.value.findIndex((p) => p.id === updated.id)
    if (index === -1) return

    // 先更新落盘快照，避免这次同步又被 watcher 推回主进程
    pushedSnapshot.set(updated.id, JSON.stringify(editableOf(updated)))
    projects.value[index] = updated
    // 这条推送也意味着刚有一条命令跑完，活跃度计数随之 +1
    void refreshActivity()
  }

  /** 项目被移除时，连带清掉它的终端 */
  function dropTerminalsOf(projectId: string): void {
    for (const key of [...terminalOrder.value]) {
      if (terminals[key]?.projectId === projectId) {
        delete terminals[key]
      }
    }
    terminalOrder.value = terminalOrder.value.filter((key) => !!terminals[key])
    if (activeTerminal.value && !terminals[activeTerminal.value]) {
      activeTerminal.value = terminalOrder.value[terminalOrder.value.length - 1] ?? null
    }
  }

  // ---------- 初始化 ----------

  let initialized = false

  /** 主题落在 <html> 上；同时切换 Element Plus 需要的 .dark 类 */
  function applyTheme(theme: EffectiveTheme): void {
    const root = document.documentElement
    root.dataset.theme = theme
    root.classList.toggle('dark', theme === 'dark')
  }

  async function init(): Promise<void> {
    if (initialized) return
    initialized = true

    await loadData()
    await subscribeEvents()

    packageManagers.value = await window.workbench.checkPackageManagers()
    await refreshNvm()
    ready.value = true
    snapshotProjects()

    void refreshPaths()
    // 目录可能在应用之外被移动/删除，窗口重新获得焦点时复查一次
    window.addEventListener('focus', () => void refreshPaths())
  }

  /** 拉一次项目 / 分组 / 设置 / 数据位置 */
  async function loadData(): Promise<void> {
    const data = await window.workbench.listProjects()
    projects.value = data.projects
    groups.value = data.groups
    for (const project of data.projects) runtimeOf(project.id)

    settings.value = await window.workbench.getSettings()
    dataLocation.value = await window.workbench.getDataLocation()
    activity.value = await window.workbench.getActivity()
    await refreshWallpapers()
    applyTheme(resolveTheme(settings.value))
  }

  /** 重新拉一次活跃度计数（命令跑完、数据目录切换后调用） */
  async function refreshActivity(): Promise<void> {
    activity.value = await window.workbench.getActivity()
  }

  let subscribed = false

  async function subscribeEvents(): Promise<void> {
    if (subscribed) return
    subscribed = true

    window.workbench.onLog(onLog)
    window.workbench.onStatus(onStatus)
    window.workbench.onTerminalOpen(onTerminalOpen)
    window.workbench.onClear(onClear)
    window.workbench.onProjectChanged(onProjectChanged)
    window.workbench.onSettingsChanged((value) => {
      settings.value = value
      applyTheme(resolveTheme(value))
    })
    window.workbench.onTheme(applyTheme)
    // 安装包管理器时把 npm 的输出原样透出来：弹层里显示最后一行，完整过程进底部终端
    window.workbench.onPmInstallLog((event) => {
      pmInstallLog.value = event.text
      appendSystemLog(event.text)
    })
    // 数据目录切换后整份重新加载：项目 ID 可能整套换掉，旧终端与选中态都不再成立
    window.workbench.onDataReload(() => {
      void reloadAfterDataMove()
    })
    // 跟随系统时，系统切换主题要即时响应（主进程那条事件是另一重保险）
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (settings.value.theme === 'system') applyTheme(resolveTheme(settings.value))
    })
  }

  async function reloadAfterDataMove(): Promise<void> {
    for (const key of Object.keys(runtimes)) delete runtimes[key]
    for (const key of [...terminalOrder.value]) delete terminals[key]
    terminalOrder.value = []
    activeTerminal.value = null
    terminalCollapsed.value = true
    drawerProjectId.value = null

    await loadData()
    for (const project of projects.value) runtimeOf(project.id)
    snapshotProjects()
    await refreshPaths()
  }

  // ---------- 设置 ----------

  async function updateSettings(patch: Partial<AppSettings>): Promise<boolean> {
    const wantedHotkey = patch.hotkeyEnabled === true
    const result = await window.workbench.updateSettings(patch)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '保存设置失败')
      return false
    }

    settings.value = result.data
    applyTheme(resolveTheme(result.data))

    // 主进程注册失败时会自动把开关关掉，这里替它把原因说清楚
    if (wantedHotkey && !result.data.hotkeyEnabled) {
      ElMessage.warning(`快捷键 ${patch.hotkey ?? result.data.hotkey} 被系统或其他应用占用，已自动停用`)
    }
    return true
  }

  // ---------- 本机环境 ----------

  /** 重新探测包管理器。装上东西之后界面上那一列状态就靠它刷新 */
  async function refreshPackageManagers(): Promise<void> {
    packageManagers.value = await window.workbench.checkPackageManagers()
  }

  /**
   * 用 npm 全局安装 yarn / pnpm。
   *
   * 主进程装完会顺带重探一次并把结果带回来，所以这里只是兜底再刷一遍 ——
   * 失败的情况也一样刷，例如装成功了但 PATH 还没生效，至少状态是准的。
   */
  async function installPackageManager(pm: InstallablePackageManager): Promise<boolean> {
    if (pmInstalling.value) return false

    const terminal = openSystemTerminal(`安装 ${pm}`)
    // 同一轮接一轮地装不同的包时，日志从零开始，别把上一次的输出混进来
    onClear({ terminal: SYSTEM_PM_TERMINAL })

    const startedAt = Date.now()
    terminal.status = 'installing'
    terminal.currentCommand = `npm install -g ${pm}`
    terminal.startedAt = startedAt
    appendSystemLog(`npm install -g ${pm}`, 'cmd')

    pmInstalling.value = pm
    pmInstallLog.value = ''

    const settle = (status: 'success' | 'failed', note?: string): void => {
      terminal.status = status
      terminal.startedAt = undefined
      terminal.durationMs = Date.now() - startedAt
      if (note) appendSystemLog(note, status === 'failed' ? 'err' : 'sys')
    }

    try {
      const result = await window.workbench.installPackageManager(pm)
      await refreshPackageManagers()
      if (!result.ok) {
        settle('failed', result.error ?? `${pm} 安装失败`)
        ElMessage.error(result.error ?? `安装 ${pm} 失败`)
        return false
      }
      settle('success', `${pm} 安装完成，已刷新环境状态`)
      ElMessage.success(`${pm} 安装完成`)
      return true
    } catch (err) {
      await refreshPackageManagers()
      const message = (err as Error).message || `安装 ${pm} 失败`
      settle('failed', message)
      ElMessage.error(message)
      return false
    } finally {
      pmInstalling.value = null
      pmInstallLog.value = ''
    }
  }

  // ---------- 项目与分组 ----------

  /** 重新探测 nvm（装上 / 卸载了 Node 版本后手动刷新用） */
  async function refreshNvm(): Promise<void> {
    nvm.value = await window.workbench.getNvmStatus()
  }

  /**
   * 把配置里的版本映射到 nvm 里真实装了的版本：
   * 精确匹配优先，「20」/「20.20」这类段前缀落到该段内最高的版本（与主进程判定一致）。
   */
  function installedNodeVersion(wanted?: string): string | null {
    const target = (wanted ?? '').trim().replace(/^v/i, '')
    if (!target) return null

    const versions = nvm.value?.versions ?? []
    if (versions.includes(target)) return target
    if (!/^\d+(\.\d+)*$/.test(target)) return null
    // versions 已按版本号降序，find 命中的就是符合前缀的最高版本
    return versions.find((v) => v.startsWith(`${target}.`)) ?? null
  }

  function findProject(id: string): Project | undefined {
    return projects.value.find((p) => p.id === id)
  }

  /** 同一分组内是否已有同名项目（规则：允许重复，但要给提示） */
  function hasDuplicateName(
    name: string,
    groupId: string | undefined,
    excludeId?: string
  ): boolean {
    const target = name.trim().toLowerCase()
    if (!target) return false
    return projects.value.some(
      (p) =>
        p.id !== excludeId &&
        p.name.trim().toLowerCase() === target &&
        (p.groupId ?? undefined) === (groupId ?? undefined)
    )
  }

  /** 改完显示名后调用，重复时只提示不阻断 */
  function warnIfDuplicateName(project: Project): void {
    if (hasDuplicateName(project.name, project.groupId, project.id)) {
      ElMessage.warning('同一分组下已有同名项目，建议改用更易区分的显示名')
    }
  }

  /** 拖拽 / 下拉改分组：真正的落盘交给 projects 的深度 watch */
  function assignGroup(id: string, groupId: string | undefined): void {
    const project = findProject(id)
    if (!project) return
    if ((project.groupId ?? undefined) === (groupId ?? undefined)) return

    project.groupId = groupId
    ElMessage.success(groupId ? `已移入「${groupName(groupId)}」` : '已移出分组')
  }

  async function addProject(input: AddProjectInput): Promise<boolean> {
    // IPC 走结构化克隆，reactive 代理无法被克隆，跨进程前先转成普通对象
    const payload: AddProjectInput = {
      path: input.path,
      name: input.name,
      groupId: input.groupId,
      serve: input.serve,
      build: [...input.build],
      defaultBuild: input.defaultBuild
    }

    const result = await window.workbench.addProject(payload)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '添加项目失败')
      return false
    }
    projects.value.push(result.data)
    runtimeOf(result.data.id)
    pathValidity.value[result.data.id] = true
    ElMessage.success(`已添加 ${result.data.name}`)
    if (hasDuplicateName(result.data.name, result.data.groupId, result.data.id)) {
      ElMessage.warning('同一分组下已有同名项目，建议改用更易区分的显示名')
    }
    return true
  }

  async function removeProject(id: string): Promise<void> {
    const result = await window.workbench.removeProject(id)
    if (!result.ok) {
      ElMessage.error(result.error ?? '移除失败')
      return
    }
    const index = projects.value.findIndex((p) => p.id === id)
    if (index !== -1) projects.value.splice(index, 1)
    delete runtimes[id]
    delete pathValidity.value[id]
    dropTerminalsOf(id)
    if (drawerProjectId.value === id) drawerProjectId.value = null
    ElMessage.success('已从列表移除')
  }

  /** 按 order 排好的分组；筛选栏、抽屉下拉、管理弹窗都用这一份 */
  const sortedGroups = computed(() =>
    [...groups.value].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  )

  /** 拖动排序：先本地生效再落盘，失败则整份回滚 */
  async function reorderGroups(ids: string[]): Promise<void> {
    const snapshot = groups.value.slice()
    const byId = new Map(groups.value.map((group) => [group.id, group]))
    groups.value = ids
      .map((id) => byId.get(id))
      .filter((group): group is ProjectGroup => !!group)
      .map((group, index) => ({ ...group, order: index }))

    const result = await window.workbench.reorderGroups(ids)
    if (!result.ok || !result.data) {
      groups.value = snapshot
      ElMessage.error(result.error ?? '保存分组顺序失败')
      return
    }
    groups.value = result.data
  }

  /** 创建分组，成功时返回新分组，便于调用方直接选中 */
  async function createGroup(name: string): Promise<ProjectGroup | null> {
    const result = await window.workbench.createGroup(name)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '创建分组失败')
      return null
    }
    groups.value.push(result.data)
    return result.data
  }

  /** 重命名分组，成功返回 true */
  async function renameGroup(id: string, name: string): Promise<boolean> {
    const result = await window.workbench.renameGroup(id, name)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '重命名分组失败')
      return false
    }
    const index = groups.value.findIndex((g) => g.id === id)
    if (index !== -1) groups.value[index] = result.data
    return true
  }

  async function removeGroup(id: string): Promise<void> {
    const result = await window.workbench.removeGroup(id)
    if (!result.ok) {
      ElMessage.error(result.error ?? '删除分组失败')
      return
    }
    groups.value = groups.value.filter((g) => g.id !== id)
    for (const project of projects.value) {
      if (project.groupId === id) project.groupId = undefined
    }
    if (groupFilter.value === id) groupFilter.value = 'all'
  }

  // ---------- 配置变更自动落盘 ----------

  /** 同 addProject：patch 会经 IPC 传输，必须转成普通对象 */
  function editableOf(project: Project): ProjectPatch {
    return {
      name: project.name,
      packageManager: project.packageManager,
      scripts: {
        serve: project.scripts.serve,
        build: [...project.scripts.build],
        defaultBuild: project.scripts.defaultBuild,
        custom: project.scripts.custom?.map((item) => ({
          name: item.name,
          command: item.command
        }))
      },
      outputDir: project.outputDir ?? '',
      autoOpenExplorer: project.autoOpenExplorer,
      // 未选择时送空串而不是 undefined：结构化克隆后键仍在，主进程才能识别「清空」
      nodeVersion: project.nodeVersion ?? '',
      groupId: project.groupId
    }
  }

  const pushedSnapshot = new Map<string, string>()

  function snapshotProjects(): void {
    pushedSnapshot.clear()
    for (const project of projects.value) {
      pushedSnapshot.set(project.id, JSON.stringify(editableOf(project)))
    }
  }

  let pushTimer: number | null = null

  watch(
    projects,
    () => {
      if (!ready.value) return
      if (pushTimer) window.clearTimeout(pushTimer)
      pushTimer = window.setTimeout(() => {
        pushTimer = null
        for (const project of projects.value) {
          const next = JSON.stringify(editableOf(project))
          if (pushedSnapshot.get(project.id) === next) continue
          pushedSnapshot.set(project.id, next)
          void window.workbench.updateProject(project.id, editableOf(project))
        }
      }, 400)
    },
    { deep: true }
  )

  // ---------- 操作 ----------

  async function guardProject(id: string): Promise<Project | null> {
    const project = findProject(id)
    if (!project) return null

    if (!isPathValid(id)) {
      ElMessage.error('项目目录不存在，请先重新定位')
      return null
    }

    if (project.manageOnly) {
      ElMessage.error('该项目是「仅管理目录」，package.json 不可用，无法执行命令')
      return null
    }

    // 选了 nvm 版本就必须真的装了，否则命令会悄悄跑在系统 node 上
    const wantedNode = project.nodeVersion?.trim()
    if (wantedNode && nvm.value && !installedNodeVersion(wantedNode)) {
      ElMessage.error(`未在 nvm 中找到 Node v${wantedNode}，请在项目详情「环境」里重新选择`)
      return null
    }

    const pm = resolvedPm(project)
    if (packageManagers.value && !packageManagers.value[pm]) {
      ElMessage.error(`未检测到 ${pm}，请先安装并确保它在系统 PATH 中`)
      return null
    }
    return project
  }

  async function install(id: string): Promise<void> {
    const project = await guardProject(id)
    if (!project) return
    focusTerminal(id, 'install')
    const result = await window.workbench.install(id)
    if (!result.ok) ElMessage.error(result.error ?? '安装依赖失败')
  }

  async function start(id: string): Promise<void> {
    const project = await guardProject(id)
    if (!project) return

    // Node 版本不满足只提示不阻断（F-9.3）
    const node = await window.workbench.checkNodeVersion(id)
    if (!node.ok) {
      ElMessage.warning(
        `项目要求 Node ${node.required}，当前为 ${node.actual}，启动可能失败`
      )
    }

    // 端口不再让用户手填：用上次从启动日志里识别到的那个。知道端口才做占用检测，
    // 不知道就静默跳过 —— 需求上已经去掉了「期望端口」这个配置项。
    const knownPort = runtimeOf(id).port
    if (knownPort) {
      const check = await window.workbench.checkPort(knownPort)
      if (check.inUse) {
        const who = check.processName
          ? `${check.processName}（PID ${check.pid}）`
          : `PID ${check.pid ?? '未知'}`
        try {
          await ElMessageBox.confirm(
            `端口 ${knownPort} 已被 ${who} 占用，是否结束该进程后重新启动？`,
            '端口被占用',
            {
              confirmButtonText: '结束进程并启动',
              cancelButtonText: '取消',
              type: 'warning'
            }
          )
        } catch {
          return
        }
        const killed = await window.workbench.killPortProcess(knownPort)
        if (!killed.ok) {
          ElMessage.error(killed.error ?? '结束占用进程失败')
          return
        }
      }
    }

    focusTerminal(id, 'start')
    const result = await window.workbench.start(id)
    if (!result.ok) ElMessage.error(result.error ?? '启动失败')
  }

  async function build(id: string, script?: string): Promise<void> {
    const project = await guardProject(id)
    if (!project) return

    const target = script ?? project.scripts.defaultBuild ?? project.scripts.build[0]
    if (!target) {
      ElMessage.warning('未配置打包命令，请在项目详情中选择')
      return
    }

    focusTerminal(id, 'build')
    const result = await window.workbench.build(id, target)
    if (!result.ok) ElMessage.error(result.error ?? '打包失败')
  }

  async function stop(id: string): Promise<void> {
    const result = await window.workbench.stop(id)
    if (!result.ok) ElMessage.error(result.error ?? '停止失败')
  }

  /** 执行项目配置里的第 index 条自定义命令（F-2.6） */
  async function runCustom(id: string, index: number): Promise<void> {
    const project = await guardProject(id)
    if (!project) return

    const command = project.scripts.custom?.[index]
    if (!command) {
      ElMessage.warning('该自定义命令已不存在')
      return
    }

    focusTerminal(id, `custom:${index}`)
    const result = await window.workbench.runCustom(id, index)
    if (!result.ok) ElMessage.error(result.error ?? `执行「${command.name}」失败`)
  }

  /** 等待项目离开运行态，避免 stop 之后立刻 start 撞上「该项目已有命令在执行中」 */
  function waitForIdle(id: string, timeoutMs = 8000): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const tick = (): void => {
        const status = runtimes[id]?.status ?? 'idle'
        if (status !== 'running' && status !== 'installing' && status !== 'building') {
          resolve(true)
          return
        }
        if (Date.now() > deadline) {
          resolve(false)
          return
        }
        window.setTimeout(tick, 100)
      }
      tick()
    })
  }

  /** 重启：停止并等进程真正退出后再启动，不再靠固定延时赌时序 */
  async function restart(id: string): Promise<void> {
    const status = runtimes[id]?.status ?? 'idle'
    if (status === 'running' || status === 'installing' || status === 'building') {
      await window.workbench.stop(id)
      if (!(await waitForIdle(id))) {
        ElMessage.error('停止超时，请稍后再试')
        return
      }
    }
    await start(id)
  }

  async function reveal(targetPath: string): Promise<void> {
    const result = await window.workbench.reveal(targetPath)
    if (!result.ok) ElMessage.error(result.error ?? '打开目录失败')
  }

  // ---------- 数据存储位置 ----------

  /**
   * 更换项目数据目录。
   * 由主进程把当前数据写过去并改指针，然后广播 data-reload 让这边整份重载。
   */
  async function changeDataDir(): Promise<boolean> {
    const picked = await window.workbench.pickDataDir()
    if (!picked.dir) return false

    if (picked.conflict) {
      ElMessage.warning('该目录里已经有 workbench-data.json，请换一个空目录')
      return false
    }

    const result = await window.workbench.migrateDataDir(picked.dir)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '迁移数据失败')
      return false
    }

    dataLocation.value = result.data
    ElMessage.success(`数据目录已切换到 ${result.data.dir}`)
    return true
  }

  // ---------- 路径有效性 ----------

  /** 未检查过的项目按有效处理，避免首帧误禁用 */
  function isPathValid(id: string): boolean {
    return pathValidity.value[id] !== false
  }

  async function refreshPaths(): Promise<void> {
    if (!projects.value.length) {
      pathValidity.value = {}
      return
    }
    pathValidity.value = await window.workbench.checkProjectPaths()
  }

  /** 目录被移动或删除后重新选择位置，并重新识别命令/包管理器 */
  async function relocate(id: string): Promise<void> {
    const project = findProject(id)
    if (!project) return

    const picked = await window.workbench.pickDirectory()
    if (!picked) return

    const result = await window.workbench.relocateProject(id, picked)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '重新定位失败')
      return
    }

    const index = projects.value.findIndex((p) => p.id === id)
    if (index !== -1) {
      // 同 onProjectChanged：先登记快照，避免这次替换被 watch 当成用户编辑推回主进程
      pushedSnapshot.set(id, JSON.stringify(editableOf(result.data)))
      projects.value[index] = result.data
    }
    pathValidity.value[id] = true
    ElMessage.success(`已重新定位到 ${result.data.path}`)
  }

  function openDrawer(id: string): void {
    drawerProjectId.value = id
  }

  function closeDrawer(): void {
    drawerProjectId.value = null
  }

  // ---------- 派生数据 ----------

  function resolvedPm(project: Project): PackageManager {
    return project.packageManager === 'auto'
      ? project.detectedPackageManager
      : project.packageManager
  }

  function groupName(groupId?: string): string {
    if (!groupId) return '未分组'
    return groups.value.find((g) => g.id === groupId)?.name ?? '未分组'
  }

  const runningCount = computed(
    () => projects.value.filter((p) => runtimes[p.id]?.status === 'running').length
  )

  function matchesFilter(project: Project): boolean {
    const kw = keyword.value.trim().toLowerCase()
    if (groupFilter.value === 'running') return runtimes[project.id]?.status === 'running'
    if (groupFilter.value === UNGROUPED) return !project.groupId
    if (groupFilter.value !== 'all') return project.groupId === groupFilter.value
    if (!kw) return true
    return project.name.toLowerCase().includes(kw) || project.path.toLowerCase().includes(kw)
  }

  /**
   * 展示顺序的快照键：项目集合 + 排序方式。
   *
   * 故意不含 lastUsedAt —— 否则点一下「启动」，那张卡片立刻跳到第一位，看着像列表被改动了。
   * 只有切换排序方式、增删项目、或重启应用时，才按最新的最近使用时间重排。
   */
  const orderKey = computed(
    () => `${sortBy.value}|${projects.value.map((p) => p.id).join(',')}`
  )

  const displayOrder = ref<string[]>([])

  watch(
    orderKey,
    () => {
      const list = projects.value.slice()
      if (sortBy.value === 'recent') {
        list.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      } else if (sortBy.value === 'name') {
        list.sort((a, b) => a.name.localeCompare(b.name))
      } else {
        list.sort((a, b) => a.createdAt - b.createdAt)
      }
      displayOrder.value = list.map((p) => p.id)
    },
    // sync：避免筛选条件变化后出现一帧旧顺序
    { immediate: true, flush: 'sync' }
  )

  /** 顺序取快照，筛选仍然实时生效（运行状态、关键词、分组都是即时反映的） */
  const filteredProjects = computed(() => {
    const byId = new Map(projects.value.map((p) => [p.id, p]))
    const list: Project[] = []
    for (const id of displayOrder.value) {
      const project = byId.get(id)
      if (project && matchesFilter(project)) list.push(project)
    }
    return list
  })

  /** 终端面板里的 Tab，按创建顺序 */
  const terminalList = computed(() =>
    terminalOrder.value
      .map((key) => terminals[key])
      .filter((item): item is TerminalState => !!item)
  )

  /** 当前选中的终端 */
  const activeTerminalState = computed(() =>
    activeTerminal.value ? terminals[activeTerminal.value] ?? null : null
  )

  /**
   * 当前终端的日志快照。
   *
   * 显式依赖 logVersion：缓冲数组被 markRaw 掉了，Vue 看不见它的写入，
   * 这个计数器就是「有新行」的信号。调用方拿到的是一个新数组，
   * 不该拿去写，只用于渲染与导出。
   */
  const activeLogs = computed<LogLine[]>(() => {
    void logVersion.value
    return activeTerminalState.value?.logs.toArray() ?? []
  })

  const drawerProject = computed(() =>
    drawerProjectId.value ? findProject(drawerProjectId.value) ?? null : null
  )

  return {
    projects,
    groups,
    sortedGroups,
    runtimes,
    terminals,
    terminalList,
    terminalOrder,
    /**
     * 日志缓冲区的变化计数（见文件顶部的 logVersion）。
     * 缓冲区本身不参与响应式，依赖它才能知道「有新的日志行」。
     */
    logVersion,
    activeLogs,
    activeTerminal,
    activeTerminalState,
    terminalCollapsed,
    terminalHeight,
    sidePanelWidth,
    backgroundImage,
    backgroundName,
    backgroundError,
    backgroundOpacity,
    wallpapers,
    refreshWallpapers,
    dataLocation,
    keyword,
    groupFilter,
    sortBy,
    drawerProjectId,
    addDialogVisible,
    packageManagers,
    pmInstalling,
    pmInstallLog,
    nvm,
    ready,
    pathValidity,
    settings,
    clock,
    dayStart,
    activity,
    runningCount,
    filteredProjects,
    drawerProject,
    runtimeOf,
    resolvedPm,
    groupName,
    findProject,
    hasDuplicateName,
    warnIfDuplicateName,
    assignGroup,
    reorderGroups,
    refreshNvm,
    refreshPackageManagers,
    installPackageManager,
    installedNodeVersion,
    init,
    refreshActivity,
    changeDataDir,
    addProject,
    removeProject,
    createGroup,
    removeGroup,
    install,
    start,
    build,
    stop,
    restart,
    runCustom,
    reveal,
    closeTerminal,
    clearTerminalLogs,
    setTerminalHeight,
    setSidePanelWidth,
    setBackgroundOpacity,
    setBackgroundVeil,
    pickBackground,
    useWallpaper,
    clearBackground,
    isPathValid,
    refreshPaths,
    relocate,
    renameGroup,
    updateSettings,
    openDrawer,
    closeDrawer
  }
})
