/**
 * 终端与运行态：底部面板的每个 Tab、每个项目的运行状态，以及它们的日志缓冲。
 *
 * 这一块从 `projects.ts` 拆出来，是因为它与「项目」本身几乎没有关系 —— 项目、独立命令、
 * 本机环境（npm 全局安装）三种东西共用同一套终端机制，日志的量级（5000 行环形缓冲、
 * 每帧批量写入）也自成一摊。
 *
 * 「检测运行状态」与「停止」的实现也在这里：它们操作的是运行态与端口，
 * 项目与独立命令只是同一件事的两个入口（见 `ProcessTarget`）。
 */
import { computed, markRaw, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { RingLog } from '@shared/log-ring'
import { clampTerminalHeight } from '@shared/terminal-height'
import { clampTerminalButtonTop } from '@shared/terminal-dock'
import { terminalKey } from '@shared/terminal-key'
import {
  DEFAULT_SETTINGS,
  type LogLine,
  type ProcessLogEvent,
  type ProcessLogPayload,
  type ProcessStatusEvent,
  type Result,
  type RuntimeState,
  type TerminalKind,
  type TerminalOpenEvent
} from '@/types'
import { notifyError, notifyInfo, notifySuccess, notifyWarning, confirmAction } from '@/notify'
import { useSettingsStore } from './settings'

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

/** 终端键后缀：一种操作一个终端 */
export type TerminalKey = 'start' | 'build' | 'install' | 'command' | `custom:${number}`

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

/** 处于「正在干活」的几个状态；重启、关闭终端、批量检测都要判它 */
export const RUNNING_STATUS: ReadonlyArray<string> = ['running', 'installing', 'building']

/**
 * 一个「有运行状态、能按端口检测、能被停止」的目标。
 *
 * 项目与独立命令在这三件事上完全是同一回事，差别只在提示文案里怎么称呼它 ——
 * 把这层差异收成下面几个字段（都是数据，不是逻辑），检测与停止的实现就只用写一遍。
 * 拆开之前这是两段各 45 行、只有 6 处字符串不同的镜像代码。
 */
export interface ProcessTarget {
  /** 运行态、终端键都挂在这个 id 上（项目的 id 或命令的 id） */
  id: string
  /** 用户认得出的名字，弹窗里用 */
  name: string
  /** 状态提示里的主语（「项目」「命令」） */
  subject: string
  /** 目标自己配置的监听端口；没配置就退回运行态里记着的那个 */
  port?: number
  /** 没配置监听端口时的提示语 */
  noPortHint: string
  /** 它自己在跑、不必再探时的提示语 */
  busyHint: string
}

/** 端口被谁占着，拼成一句给人看的说明 */
function describeHolder(check: { pid?: number; processName?: string }): string {
  return check.processName ? `${check.processName}（PID ${check.pid}）` : `PID ${check.pid ?? '未知'}`
}

export const useTerminalStore = defineStore('terminal', () => {
  const settingsStore = useSettingsStore()

  /** 项目 / 命令的运行态，键是它们的 id */
  const runtimes = reactive<Record<string, RuntimeState>>({})
  /** 终端表：键是 `${projectId}::${kindKey}` */
  const terminals = reactive<Record<string, TerminalState>>({})
  /** Tab 顺序 = 创建顺序 */
  const terminalOrder = ref<string[]>([])
  const activeTerminal = ref<string | null>(null)

  /**
   * 终端面板是否收起。
   *
   * 面板本身只在「有终端」时才出现，所以应用刚启动时底部什么都没有（默认隐藏）。
   * 收起不是「缩矮」，而是整块收进窗口右侧那颗悬浮按钮里（见 TerminalPanel 的 .dock）——
   * 按钮上带着运行状态点，收起后仍看得出还有命令在跑；点它就把面板放回来。
   */
  const terminalCollapsed = ref(true)

  /** 面板展开时的高度（px）；拖动中只改这个 ref，松手才落盘 */
  const terminalHeight = ref(DEFAULT_SETTINGS.terminalHeight)

  /**
   * 收起后那颗悬浮按钮的纵向位置（占窗口高度的百分比；null = 跟随终端面板）。
   * 与终端高度同一套做法：拖动中只改本地临时值，松手才经这里落盘。
   */
  const terminalButtonTop = ref(DEFAULT_SETTINGS.terminalButtonTop)

  // 设置是异步载入的（也随时可能被设置窗口 / 数据目录迁移改写），跟着它同步一次
  watch(
    () => settingsStore.settings.terminalHeight,
    (value) => {
      terminalHeight.value = clampTerminalHeight(value)
    },
    { immediate: true }
  )

  watch(
    () => settingsStore.settings.terminalButtonTop,
    (value) => {
      terminalButtonTop.value = clampTerminalButtonTop(value)
    },
    { immediate: true }
  )

  /** 拖完 / 键盘微调后落地：界面先跟手，磁盘异步写 */
  async function setTerminalHeight(px: number): Promise<void> {
    const next = clampTerminalHeight(px)
    terminalHeight.value = next
    if (next === settingsStore.settings.terminalHeight) return

    await settingsStore.updateSettings({ terminalHeight: next })
  }

  async function setTerminalButtonTop(top: number | null): Promise<void> {
    const next = clampTerminalButtonTop(top)
    terminalButtonTop.value = next
    if (next === settingsStore.settings.terminalButtonTop) return

    await settingsStore.updateSettings({ terminalButtonTop: next })
  }

  function setActiveTerminal(key: string | null): void {
    activeTerminal.value = key
  }

  function setTerminalCollapsed(value: boolean): void {
    terminalCollapsed.value = value
  }

  // ---------- 运行态 ----------

  function runtimeOf(id: string): RuntimeState {
    if (!runtimes[id]) runtimes[id] = { status: 'idle' }
    return runtimes[id]
  }

  /** 等一个目标离开运行态（重启时用，避免 stop 之后立刻 start 撞上「已有命令在执行中」） */
  function waitForIdle(id: string, timeoutMs = 8000): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const tick = (): void => {
        const status = runtimes[id]?.status ?? 'idle'
        if (!RUNNING_STATUS.includes(status)) {
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

  // ---------- 终端 ----------

  function terminalKeyOf(projectId: string, key: TerminalKey): string {
    return terminalKey(projectId, key)
  }

  function terminalOf(key: string): TerminalState | undefined {
    return terminals[key]
  }

  /** 某个目标当前有哪些终端（自定义命令按索引各一个） */
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
      notifyWarning('该终端正在执行命令，请先停止再关闭')
      return
    }

    delete terminals[key]
    terminalOrder.value = terminalOrder.value.filter((item) => item !== key)
    // 丢弃尚未写入的批次，避免关掉后又冒出来
    dropPendingOf(key)

    if (activeTerminal.value === key) {
      activeTerminal.value = terminalOrder.value[terminalOrder.value.length - 1] ?? null
    }
  }

  /**
   * 日志按帧批量写入。
   *
   * Rust 侧已经按帧聚合过一次（见 src-tauri/src/session.rs），这里再兜一层是因为
   * 同一条通道上还混着系统提示与安装输出；而且批次到了以后要一次性写进环形缓冲、
   * 只把版本号加一次，让 Vue 每帧至多重新渲染一次。
   */
  const pendingLogs: ProcessLogEvent[] = []
  let flushScheduled = false

  function dropPendingOf(key: string): void {
    for (let i = pendingLogs.length - 1; i >= 0; i -= 1) {
      if (pendingLogs[i].terminal === key) pendingLogs.splice(i, 1)
    }
  }

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
    // 终端级状态先取出来：目标级状态要借它认「这次是启动还是打包」（见 RuntimeState.kind）
    const target = terminals[event.terminal]

    // 目标级状态：卡片 / 抽屉的按钮与指示灯都看这个
    const rt = runtimeOf(event.projectId)
    rt.status = event.status
    rt.pid = event.pid
    rt.currentCommand = event.currentCommand
    rt.startedAt = event.startedAt
    rt.durationMs = event.durationMs
    rt.exitCode = event.exitCode
    rt.port = event.port ?? rt.port
    if (target) rt.kind = target.kind
    // 事件只可能来自 Workbench 自己的子进程，探测出来的「外部运行」到此为止
    rt.external = false

    if (event.status === 'idle' || event.status === 'failed' || event.status === 'success') {
      rt.startedAt = undefined
      if (event.status !== 'failed') rt.pid = undefined
    }

    // 终端级状态：Tab 上的圆点与耗时
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
    clearTerminalLogs(payload.terminal)
  }

  /**
   * 清空一个终端的显示。
   *
   * 尚未写入的批次一并丢弃：清空之后又从缓冲里冒出来几行旧输出，看着像没清干净
   * （与 closeTerminal 里同一条道理）。清空本身也是一次变化，版本号要跟着动，
   * 否则旧行会留在 DOM 上。
   */
  function clearTerminalLogs(key: string): void {
    const target = terminals[key]
    if (!target) return

    dropPendingOf(key)
    target.logs.clear()
    logVersion.value += 1
  }

  /** 切到某个终端并把面板展开 */
  function focusTerminal(projectId: string, key: TerminalKey): void {
    const terminal = terminalKeyOf(projectId, key)
    // 主进程的 terminal-open 会补齐终端；这里先把选中态与展开状态准备好
    activeTerminal.value = terminal
    terminalCollapsed.value = false
  }

  /** 目标被移除 / 删除时，连带清掉它的终端 */
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

  /** 数据目录被整份换掉时清空：旧的 id 与选中态都不再成立 */
  function resetAll(): void {
    for (const key of Object.keys(runtimes)) delete runtimes[key]
    for (const key of [...terminalOrder.value]) delete terminals[key]
    terminalOrder.value = []
    activeTerminal.value = null
    terminalCollapsed.value = true
  }

  // ---------- 端口：检测运行状态 / 停止 ----------

  /**
   * 起命令前确认监听端口没有被别人占着。
   *
   * 占着就问一次「结束进程并启动」—— 这多半是上次没关干净的开发服务；用户取消或结束失败都返回
   * false，调用方直接中止启动。端口空着但本地还记着「外部运行中」时，顺手把状态收回来。
   * 项目启动与命令卡片启动共用这一套，两边的确认文案与行为才一致。
   */
  async function ensurePortFree(port: number | undefined, rt: RuntimeState): Promise<boolean> {
    if (!port) return true

    const check = await window.workbench.checkPort(port)
    if (!check.inUse) {
      if (rt.external) {
        // 端口已经空出来，之前探测到的「外部运行中」不再成立
        rt.status = 'idle'
        rt.external = false
        rt.pid = undefined
      }
      return true
    }

    const agreed = await confirmAction(
      `端口 ${port} 已被 ${describeHolder(check)} 占用，是否结束该进程后重新启动？`,
      '端口被占用',
      { confirmButtonText: '结束进程并启动' }
    )
    if (!agreed) return false

    const killed = await window.workbench.killPortProcess(port)
    if (!killed.ok) {
      notifyError(killed.error ?? '结束占用进程失败')
      return false
    }
    return true
  }

  /**
   * 检测一个目标是否已经在运行。判据是端口占用：优先用它配置的端口，
   * 没配置就回退到本次会话里从启动日志识别到的那个。
   *
   * 命中的运行态打上 external 标记 —— 这种进程没有 Workbench 的句柄，也没有日志，
   * 卡片上的「停止」会改成按端口结束。
   *
   * silent 用于启动时的批量检测：只更新状态，不打扰用户。
   */
  async function detectTarget(
    target: ProcessTarget,
    options: { silent?: boolean } = {}
  ): Promise<boolean> {
    const rt = runtimeOf(target.id)
    // Workbench 自己启动的进程，状态本来就准，不必再探；
    // 而探测出来的「外部运行中」只是个快照，要重新确认（服务可能已经被人停了）
    if (!rt.external && RUNNING_STATUS.includes(rt.status)) {
      if (!options.silent) notifyInfo(target.busyHint)
      return true
    }

    const port = target.port ?? rt.port
    if (!port) {
      if (!options.silent) notifyWarning(target.noPortHint)
      return false
    }

    const check = await window.workbench.checkPort(port)
    if (check.inUse) {
      rt.status = 'running'
      rt.external = true
      rt.port = port
      rt.pid = check.pid
      if (!options.silent) {
        notifySuccess(
          `端口 ${port} 已被 ${describeHolder(check)} 占用，${target.subject}已在运行`
        )
      }
      return true
    }

    // 端口空着：之前探测到的外部运行已经结束，把状态收回来
    if (rt.external) {
      rt.status = 'idle'
      rt.external = false
      rt.pid = undefined
      rt.port = undefined
    }
    if (!options.silent) notifyInfo(`端口 ${port} 空闲，${target.subject}未在运行`)
    return false
  }

  /**
   * 停止一个目标。
   *
   * 探测到的外部服务没有进程句柄，只能按端口结束 —— 杀的是 Workbench 之外的进程，
   * 所以先确认一次。真正的停止动作由调用方给：项目与命令走的是不同的通道
   * （项目按「当前在跑的那条」，命令只有一条）。
   */
  async function stopTarget(
    target: ProcessTarget,
    stop: () => Promise<Result<null>>
  ): Promise<boolean> {
    const rt = runtimes[target.id]

    if (rt?.external && rt.port) {
      const agreed = await confirmAction(
        `将结束【${target.name}】占用【${rt.port}】端口。确定吗？`,
        '结束外部进程',
        { confirmButtonText: '结束进程' }
      )
      if (!agreed) return false

      const killed = await window.workbench.killPortProcess(rt.port)
      if (!killed.ok) {
        notifyError(killed.error ?? '结束进程失败')
        return false
      }
      rt.status = 'idle'
      rt.external = false
      rt.pid = undefined
      rt.port = undefined
      return true
    }

    const result = await stop()
    if (!result.ok) {
      notifyError(result.error ?? '停止失败')
      return false
    }
    return true
  }

  // ---------- 事件订阅 ----------

  /** 后端推来的日志 / 状态 / 终端开关都归这里管（由 store 的 init 统一调用） */
  function installListeners(): void {
    window.workbench.onLog(onLog)
    window.workbench.onStatus(onStatus)
    window.workbench.onTerminalOpen(onTerminalOpen)
    window.workbench.onClear(onClear)
    // npm 全局安装的输出原样进系统终端（「最后一行顶在卡片上」那份由环境 store 自己订阅）
    window.workbench.onPmInstallLog((event) => appendSystemLog(event.text))
  }

  // ---------- 派生数据 ----------

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

  return {
    // 运行态
    runtimes,
    runtimeOf,
    waitForIdle,
    // 终端
    terminals,
    terminalList,
    terminalOf,
    terminalsOfProject,
    terminalKeyOf,
    activeTerminal,
    setActiveTerminal,
    activeTerminalState,
    activeLogs,
    /**
     * 日志缓冲区的变化计数（见文件顶部的 logVersion）。
     * 缓冲区本身不参与响应式，依赖它才能知道「有新的日志行」。
     */
    logVersion,
    terminalCollapsed,
    setTerminalCollapsed,
    terminalHeight,
    setTerminalHeight,
    terminalButtonTop,
    setTerminalButtonTop,
    ensureTerminal,
    openSystemTerminal,
    appendSystemLog,
    closeTerminal,
    focusTerminal,
    clearTerminalLogs,
    dropTerminalsOf,
    resetAll,
    installListeners,
    // 端口
    ensurePortFree,
    detectTarget,
    stopTarget
  }
})
