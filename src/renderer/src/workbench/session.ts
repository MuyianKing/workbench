/**
 * 进程会话：把「起一条命令」这件事接到 Rust 上，并把输出翻译成渲染层认识的事件。
 *
 * 后端只认 sessionId 与整行命令；起什么命令、状态怎么转、日志落进哪个终端，都在这里决定。
 * 终端键同时充当 sessionId —— 日志与状态都靠它回到正确的终端（见 shared/terminal-key.ts）。
 */
import { parsePortFromLog } from '@shared/dev-port'
import { cleanLogLine } from '@shared/ansi'
import { fail, ok } from '@shared/result'
import { terminalKey } from '@shared/terminal-key'
import type {
  CommandEntry,
  ProcessLogEvent,
  ProcessStatusEvent,
  Project,
  Result,
  TerminalKind,
  TerminalOpenEvent
} from '@shared/types'
import { invoke, listen } from './bridge'
import { emit } from './events'
import * as state from './state'
import * as nvm from './nvm'

interface SessionMeta {
  projectId: string
  terminal: string
  kind: TerminalKind
  label: string
  currentCommand: string
  startedAt: number
  /** 用户主动停止的会话：结束时要落 idle，而不是把它当失败 */
  stopping: boolean
  /** 子进程 PID；起来之后才有，退出时用来摘掉残留记录 */
  pid?: number
  /** 已认出的监听端口：日志里认到之后要推一次给界面，才不重复推 */
  port?: number
}

/** 活跃会话。Rust 侧同样有一份，这里存的是「显示这一侧」需要的信息 */
const live = new Map<string, SessionMeta>()

/**
 * 包管理器安装这类临时会话的 id 前缀。
 * 它们的输出不属于任何项目终端，要单独推给界面（系统状态卡片显示最后一行）。
 */
export const PM_SESSION_PREFIX = 'pm-install:'

/** 临时会话的按行回调与退出等待（不属于 live：它们没有终端、没有状态机） */
const detachedLines = new Map<string, (text: string) => void>()
const detachedExit = new Map<string, (code: number | null) => void>()

/**
 * 起一条「不属于任何项目终端」的临时命令并等它结束。
 *
 * 复用会话通道而不是另写一套：拉起、按批回传、按树终止这三件事都一样，
 * 区别只在输出往哪儿去 —— 由 id 前缀决定。
 */
export async function runDetached(
  sessionId: string,
  line: string,
  onLine?: (text: string) => void
): Promise<number | null> {
  if (onLine) detachedLines.set(sessionId, onLine)
  const exited = new Promise<number | null>((resolve) => detachedExit.set(sessionId, resolve))

  try {
    await invoke('spawn_session', { sessionId, line, cwd: null, pathPrepend: null })
  } catch (error) {
    detachedLines.delete(sessionId)
    detachedExit.delete(sessionId)
    throw error
  }

  const code = await exited
  detachedLines.delete(sessionId)
  return code
}

/** 中止一条临时会话（超时清理用） */
export async function abortDetached(sessionId: string): Promise<void> {
  try {
    await invoke('stop_session', { sessionId })
  } catch {
    // 已经自己结束了：这里只是清理，不必把失败抛给调用方
  }
}

function reason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** 本应用进程的 PID 与创建时间：会话记录里的 ownerPid / ownerCreatedAt，只问一次 */
let cachedAppPid: number | null = null
let cachedAppCreatedAt: number | null = null

async function appPid(): Promise<number> {
  cachedAppPid ??= await invoke<number>('app_pid')
  return cachedAppPid
}

async function appCreatedAt(): Promise<number | null> {
  if (cachedAppCreatedAt === null) {
    const pid = await appPid()
    cachedAppCreatedAt = (await invoke<number | null>('process_created_at', { pid })) ?? -1
  }
  // -1 表示问不到（极少见），返回 null 让记录里不带这个字段
  return cachedAppCreatedAt < 0 ? null : cachedAppCreatedAt
}

/** 日志行的时间戳，与 Electron 版一样只取到秒 */
function nowTime(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/** 实际使用的包管理器：auto 时用扫描锁文件得出的那个 */
function packageManagerOf(project: Project): string {
  return project.packageManager === 'auto' ? project.detectedPackageManager : project.packageManager
}

function statusOf(kind: TerminalKind): ProcessStatusEvent['status'] {
  if (kind === 'build') return 'building'
  if (kind === 'install') return 'installing'
  return 'running'
}

function emitStatus(meta: SessionMeta, status: ProcessStatusEvent['status'], extra: Partial<ProcessStatusEvent> = {}): void {
  emit<ProcessStatusEvent>('status', {
    projectId: meta.projectId,
    terminal: meta.terminal,
    status,
    startedAt: status === 'running' || status === 'building' || status === 'installing' ? meta.startedAt : undefined,
    currentCommand: meta.currentCommand,
    ...extra
  })
}

function pushLog(meta: SessionMeta, stream: ProcessLogEvent['stream'], text: string): void {
  emit<ProcessLogEvent>('log', {
    terminal: meta.terminal,
    projectId: meta.projectId,
    stream,
    text,
    time: nowTime()
  })
}

interface RunInput {
  projectId: string
  kind: TerminalKind
  /** 终端键的 kindKey 部分；自定义命令要带索引，所以与 kind 分开传 */
  kindKey: string
  label: string
  line: string
  cwd?: string
  /** 项目指定的 nvm 版本；有就把该版本目录前置到子进程 PATH */
  nodeVersion?: string
}

/** 起一个会话：先开终端、再落状态、最后真起进程；起不来就把状态落成失败 */
async function run(input: RunInput): Promise<Result<null>> {
  const meta: SessionMeta = {
    projectId: input.projectId,
    terminal: terminalKey(input.projectId, input.kindKey),
    kind: input.kind,
    label: input.label,
    currentCommand: input.line,
    startedAt: Date.now(),
    stopping: false
  }

  live.set(meta.terminal, meta)

  emit<TerminalOpenEvent>('terminalOpen', {
    terminal: meta.terminal,
    projectId: meta.projectId,
    kind: meta.kind,
    label: meta.label
  })

  // 先把「要跑什么」写进终端，用户才知道这条命令是从哪来的
  pushLog(meta, 'cmd', input.line)
  emitStatus(meta, statusOf(meta.kind))

  // 项目选了 nvm 版本就把它前置到 PATH：这样 shell 里的 node / npm 都解析到该版本，
  // 不必去改 nvm 的软链（那需要管理员权限）
  const pathPrepend = await nvm.nodeDirFor(input.nodeVersion)

  try {
    const pid = await invoke<number>('spawn_session', {
      sessionId: meta.terminal,
      line: input.line,
      cwd: input.cwd ?? null,
      pathPrepend
    })
    meta.pid = pid

    // 落一条记录：应用要是被强杀，下次启动就靠它认出该收哪些进程。
    // 创建时间要趁进程刚起就取 —— 它是「这个 PID 还是不是当初那个进程」的判据，
    // 等下才取的话进程可能已经退出、PID 也可能已经被复用。
    const createdAt = await invoke<number | null>('process_created_at', { pid })
    const ownerCreated = await appCreatedAt()
    state.recordSession({
      projectId: meta.projectId,
      pid,
      command: input.line,
      cwd: input.cwd ?? '',
      startedAt: meta.startedAt,
      ownerPid: await appPid(),
      ...(createdAt === null ? {} : { processCreatedAt: createdAt }),
      ...(ownerCreated === null ? {} : { ownerCreatedAt: ownerCreated })
    })
    return ok(null)
  } catch (error) {
    const message = reason(error, '启动失败')
    live.delete(meta.terminal)
    pushLog(meta, 'err', message)
    emitStatus(meta, 'failed', { exitCode: null })
    return fail(message)
  }
}

/** 后端推来的原始行：翻译成渲染层的日志事件（后端已按批聚合，这里整批转发） */
export function installSessionListeners(): void {
  listen<{ sessionId: string; lines: Array<{ stream: string; text: string }> }>(
    'session:lines',
    ({ sessionId, lines: rawLines }) => {
      // 后端交过来的行是子进程的原样输出，控制序列在这里一次清掉：
      // 终端日志与系统面板的安装输出都出自这批行（见 shared/ansi.ts）
      const lines: Array<{ stream: string; text: string }> = []
      for (const line of rawLines) {
        const text = cleanLogLine(line.text)
        // 整行只有控制序列（清行 / 移光标）时清完就空了，这种行本来就不该显示
        if (!text && line.text) continue
        lines.push({ stream: line.stream, text })
      }
      if (!lines.length) return

      // 临时会话（包管理器安装等）：输出交给回调，并推给界面的专属事件
      const isPm = sessionId.startsWith(PM_SESSION_PREFIX)
      const lineHandler = detachedLines.get(sessionId)
      if (isPm || lineHandler) {
        for (const line of lines) {
          lineHandler?.(line.text)
          if (isPm) {
            emit('pmInstallLog', {
              pm: sessionId.slice(PM_SESSION_PREFIX.length),
              text: line.text
            })
          }
        }
        return
      }

      const meta = live.get(sessionId)
      if (!meta) return

      // 从输出里认监听端口：项目没手填端口时，这是唯一的线索
      // （界面据此显示端口，也据此做「端口被占用」的提醒）
      for (const line of lines) {
        const port = parsePortFromLog(line.text)
        if (port !== undefined && port !== meta.port) {
          meta.port = port
          emitStatus(meta, statusOf(meta.kind), { port })
          break
        }
      }

      const time = nowTime()
      const batch: ProcessLogEvent[] = lines.map((line) => ({
        terminal: sessionId,
        projectId: meta.projectId,
        // 后端只区分 out / err，其余一律按系统提示处理
        stream: line.stream === 'out' ? 'out' : line.stream === 'err' ? 'err' : 'sys',
        text: line.text,
        time
      }))
      emit<ProcessLogEvent[]>('log', batch)
    }
  )

  listen<{ sessionId: string; code: number | null }>('session:exit', ({ sessionId, code }) => {
    // 临时会话：唤醒等它的那个调用方
    const waiter = detachedExit.get(sessionId)
    if (waiter) {
      detachedExit.delete(sessionId)
      waiter(code)
      return
    }

    const meta = live.get(sessionId)
    if (!meta) return
    live.delete(sessionId)

    // 正常结束就把残留记录摘掉，别让它下次启动时被当成残留再处理一遍
    if (meta.pid !== undefined) state.dropSession(meta.pid)

    // 用户喊停的：落 idle 而不是失败，否则「停止」按钮点完会显示成出错
    if (meta.stopping) {
      emitStatus(meta, 'idle')
      return
    }

    pushLog(meta, 'sys', code === 0 ? '已结束' : `已退出（退出码 ${code ?? '未知'}）`)
    emitStatus(meta, code === 0 ? 'success' : 'failed', {
      exitCode: code,
      durationMs: Date.now() - meta.startedAt
    })
  })
}

// ---------- 项目操作 ----------

export function startProject(project: Project): Promise<Result<null>> {
  const script = project.scripts.serve
  if (!script) return Promise.resolve(fail('该项目没有可用的启动脚本'))

  const line = `${packageManagerOf(project)} run ${script}`
  return run({
    projectId: project.id,
    kind: 'start',
    kindKey: 'start',
    label: '启动',
    line,
    cwd: project.path,
    nodeVersion: project.nodeVersion
  })
}

export function buildProject(project: Project, script: string): Promise<Result<null>> {
  const line = `${packageManagerOf(project)} run ${script}`
  return run({
    projectId: project.id,
    kind: 'build',
    kindKey: 'build',
    label: '打包',
    line,
    cwd: project.path,
    nodeVersion: project.nodeVersion
  })
}

export function installProject(project: Project): Promise<Result<null>> {
  const line = `${packageManagerOf(project)} install`
  return run({
    projectId: project.id,
    kind: 'install',
    kindKey: 'install',
    label: '安装依赖',
    line,
    cwd: project.path,
    nodeVersion: project.nodeVersion
  })
}

export function runCustom(project: Project, index: number): Promise<Result<null>> {
  const entry = project.scripts.custom?.[index]
  if (!entry) return Promise.resolve(fail(`没有第 ${index + 1} 条自定义命令`))

  return run({
    projectId: project.id,
    kind: 'custom',
    kindKey: `custom:${index}`,
    label: entry.name,
    line: entry.command,
    cwd: project.path,
    nodeVersion: project.nodeVersion
  })
}

export function startCommand(entry: CommandEntry): Promise<Result<null>> {
  return run({
    projectId: entry.id,
    kind: 'command',
    kindKey: 'command',
    label: entry.name,
    line: entry.command
  })
}

// ---------- 停止 ----------

/** 按终端键停止；用户主动停止要标记出来，退出时才能落成 idle */
async function stopTerminal(terminal: string): Promise<Result<null>> {
  const meta = live.get(terminal)
  if (!meta) return fail('该命令已经不在运行')

  meta.stopping = true
  try {
    await invoke('stop_session', { sessionId: terminal })
    return ok(null)
  } catch (error) {
    meta.stopping = false
    return fail(reason(error, '停止失败'))
  }
}

/** 停止某个项目当前在跑的那条命令（启动 / 打包 / 自定义都会命中） */
export function stopOwner(projectId: string): Promise<Result<null>> {
  const target = [...live.values()].find((meta) => meta.projectId === projectId)
  if (!target) return Promise.resolve(fail('该项目当前没有在运行的命令'))
  return stopTerminal(target.terminal)
}

/** 停止某条独立命令 */
export function stopCommand(entryId: string): Promise<Result<null>> {
  return stopTerminal(terminalKey(entryId, 'command'))
}

/** 清空某个终端的显示（后端无事可做，纯界面动作） */
export function clearTerminal(terminal: string): void {
  emit<{ terminal: string }>('clear', { terminal })
}

/** 供退出收尾：结束所有还活着的会话 */
export function stopAll(): Promise<void> {
  return invoke('active_sessions').then(async () => undefined)
}
