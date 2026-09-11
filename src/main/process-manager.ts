import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type {
  ActiveSession,
  PackageManager,
  ProcessLogEvent,
  ProcessStatusEvent,
  Project,
  ProjectStatus,
  RunRecord
} from '../shared/types'
import { terminalKey } from '../shared/terminal-key'
import { isValidScriptName } from './scanner'
import { nodeEnvFor } from './nvm'
import { killProcessTree } from './system'

const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g

/** 日志里出现的完整 http(s) 地址（Vite / Vue CLI / Next 等都会打印 Local: http://…） */
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{}]+)/
/** 只有 host:port 时的兜底匹配 */
const HOST_PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/

/**
 * 从一行日志里提取 dev server 地址（F-9.1 ①）。
 * 提取不到返回 null —— 绝大多数日志行都会走到这里，保持廉价。
 */
export function detectServerAddress(line: string): { url: string; port: number } | null {
  const matched = URL_RE.exec(line)
  if (matched) {
    // 句尾标点通常是日志排版，不属于 URL
    const raw = matched[1].replace(/[.,;:!?]+$/, '')
    try {
      const parsed = new URL(raw)
      const port = parsed.port
        ? Number(parsed.port)
        : parsed.protocol === 'https:'
          ? 443
          : 80
      if (port > 0 && port < 65536) return { url: raw, port }
    } catch {
      /* 落回 host:port 匹配 */
    }
  }

  const hostPort = HOST_PORT_RE.exec(line)
  if (hostPort) {
    const port = Number(hostPort[1])
    if (port > 0 && port < 65536) return { url: `http://localhost:${port}`, port }
  }

  return null
}

/** 发出停止指令后等待进程真正退出的上限，超时强制释放状态 */
const STOP_TIMEOUT_MS = 6000
/** 应用退出时等待全部子进程结束的上限 */
const SHUTDOWN_TIMEOUT_MS = 4000

type Kind = 'start' | 'build' | 'install' | 'custom'

type RunOutcome = 'success' | 'failed' | 'stopped'

interface Session {
  child: ChildProcess
  projectId: string
  /** 终端键：一个项目的一类操作一个终端 */
  terminal: string
  /** Tab 上的操作名 */
  terminalLabel: string
  kind: Kind
  command: string
  cwd: string
  startedAt: number
  stdoutBuf: string
  stderrBuf: string
  stopping: boolean
  finished: boolean
  /** dev server 地址只推送一次，避免刷屏时反复触发开浏览器 */
  readyEmitted: boolean
}

/** 一次启动要落到哪个终端上 */
interface LaunchTarget {
  kind: Kind
  /** 终端键后缀：start / build / install / custom:<index> */
  key: string
  /** Tab 标题里的操作名 */
  label: string
}

/** 自定义命令是一整行命令原文，长度给个上限，也禁止换行（换行等于偷偷执行多条命令） */
const CUSTOM_COMMAND_MAX = 500

interface Invocation {
  bin: string
  args: string[]
  label: string
}

export function resolvePackageManager(project: Project): PackageManager {
  return project.packageManager === 'auto'
    ? project.detectedPackageManager
    : project.packageManager
}

export function buildInvocation(
  pm: PackageManager,
  kind: Kind,
  script?: string
): Invocation {
  if (kind === 'install') {
    return pm === 'yarn'
      ? { bin: 'yarn', args: [], label: 'yarn' }
      : { bin: pm, args: ['install'], label: `${pm} install` }
  }
  const name = script ?? ''
  return { bin: pm, args: ['run', name], label: `${pm} run ${name}` }
}

/**
 * 子进程管理：状态机、按行日志、进程树终止
 *
 * `flushLogs` 用来在顺序敏感的事件（清空终端输出）之前，把攒批中的日志先发出去。
 * 逐行发送时不需要它 —— 那是「改按帧聚合」才引入的时序窗口，
 * 不排空就会让上一轮的最后几行落到清屏之后（见 launch 里的 clear）。
 */
export class ProcessManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  constructor(private readonly flushLogs?: () => void) {
    super()
  }

  isActive(projectId: string): boolean {
    return this.sessions.has(projectId)
  }

  activeProjectIds(): string[] {
    return [...this.sessions.keys()]
  }

  /**
   * 当前活跃会话的快照，交给上层落盘。
   * 应用被强杀时这些记录会留在磁盘上，下次启动据此清理残留进程。
   */
  liveSessions(): ActiveSession[] {
    const list: ActiveSession[] = []
    for (const [projectId, session] of this.sessions) {
      const pid = session.child.pid
      if (!pid) continue
      list.push({
        projectId,
        pid,
        command: session.command,
        cwd: session.cwd,
        startedAt: session.startedAt,
        ownerPid: process.pid
      })
    }
    return list
  }

  start(project: Project, script: string): string | null {
    if (!isValidScriptName(script)) return '启动脚本名不合法'
    const pm = resolvePackageManager(project)
    const inv = buildInvocation(pm, 'start', script)
    return this.launch(project, { kind: 'start', key: 'start', label: '启动' }, 'running', inv)
  }

  build(project: Project, script: string): string | null {
    if (!isValidScriptName(script)) return '打包脚本名不合法'
    const pm = resolvePackageManager(project)
    const inv = buildInvocation(pm, 'build', script)
    return this.launch(project, { kind: 'build', key: 'build', label: '打包' }, 'building', inv)
  }

  install(project: Project): string | null {
    const pm = resolvePackageManager(project)
    const inv = buildInvocation(pm, 'install')
    return this.launch(
      project,
      { kind: 'install', key: 'install', label: '安装依赖' },
      'installing',
      inv
    )
  }

  /** 执行项目配置里的自定义命令（F-2.6）；每条自定义命令各自一个终端 */
  runCustom(project: Project, command: string, index: number, name?: string): string | null {
    const text = (command ?? '').trim()
    if (!text) return '自定义命令为空'
    if (text.length > CUSTOM_COMMAND_MAX) return `自定义命令过长（上限 ${CUSTOM_COMMAND_MAX} 字符）`
    if (/[\r\n]/.test(text)) return '自定义命令不能包含换行'

    return this.launch(
      project,
      { kind: 'custom', key: `custom:${index}`, label: name?.trim() || '自定义命令' },
      'running',
      { bin: text, args: [], label: text }
    )
  }

  stop(projectId: string): void {
    const session = this.sessions.get(projectId)
    if (!session) return

    session.stopping = true
    const pid = session.child.pid

    if (!pid) {
      // 没有 pid 说明进程从未真正起来；仍要走一遍会话清理，否则磁盘上的
      // activeSessions 会留下一条失效记录，下次启动被当成残留进程处理。
      session.finished = true
      this.sessions.delete(projectId)
      this.emit('sessions-changed')
      this.emitStatus(session, { status: 'idle' })
      return
    }

    if (process.platform === 'win32') {
      // shell: true 时 pid 是 cmd.exe，必须结束整棵进程树，否则会残留子进程占端口。
      // 走共享的 killProcessTree，与残留清理、按端口杀进程保持同一套语义。
      void killProcessTree(pid).catch(() => {
        try {
          session.child.kill()
        } catch {
          /* 已退出 */
        }
      })
    } else {
      // POSIX 先给 SIGTERM 留出优雅退出的机会，卡住由 armStopWatchdog 兜底强杀
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        session.child.kill('SIGTERM')
      }
    }

    this.armStopWatchdog(projectId, session)
  }

  /** taskkill 失败或子进程卡死时兜底，避免项目永远停在「运行中」而无法再操作 */
  private armStopWatchdog(projectId: string, session: Session): void {
    setTimeout(() => {
      if (session.finished || this.sessions.get(projectId) !== session) return
      this.emitLog(session, 'err', '停止超时，已强制释放运行状态')
      try {
        session.child.kill()
      } catch {
        /* 已退出 */
      }
      this.finish(projectId, session, null, '停止超时')
    }, STOP_TIMEOUT_MS)
  }

  stopAll(): void {
    for (const id of this.activeProjectIds()) this.stop(id)
  }

  /** 退出前停止所有子进程并等待它们真正结束，避免 dev server 残留占用端口 */
  async shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.sessions.size === 0) return

    this.stopAll()

    const deadline = Date.now() + timeoutMs
    while (this.sessions.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })
    }

    // 仍未结束的强制释放，防止 app.quit() 被无限拦住
    for (const [id, session] of [...this.sessions]) {
      try {
        session.child.kill()
      } catch {
        /* 已退出 */
      }
      this.finish(id, session, null, '应用退出，已强制结束')
    }
  }

  /** 真正拉起子进程：决定这次输出落到哪个终端，并把状态推给上层 */
  private launch(
    project: Project,
    target: LaunchTarget,
    status: ProjectStatus,
    inv: Invocation
  ): string | null {
    if (this.sessions.has(project.id)) {
      return '该项目已有命令在执行中'
    }

    // 项目选定了 nvm 的某个 Node 版本时，把它的目录前置到 PATH：
    // 只影响这个子进程，不动 NVM_SYMLINK，也不需要管理员权限。
    const requestedNode = project.nodeVersion?.trim()
    const nodeRuntime = nodeEnvFor(requestedNode)

    let child: ChildProcess
    try {
      child = spawn(inv.bin, inv.args, {
        cwd: project.path,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: {
          ...(nodeRuntime ? nodeRuntime.env : process.env),
          NO_COLOR: '1',
          FORCE_COLOR: '0'
        }
      })
    } catch (err) {
      return `无法启动命令：${(err as Error).message}`
    }

    const terminal = terminalKey(project.id, target.key)
    const session: Session = {
      child,
      projectId: project.id,
      terminal,
      terminalLabel: target.label,
      kind: target.kind,
      command: inv.label,
      cwd: project.path,
      startedAt: Date.now(),
      stdoutBuf: '',
      stderrBuf: '',
      stopping: false,
      finished: false,
      readyEmitted: false
    }
    this.sessions.set(project.id, session)
    this.emit('sessions-changed')

    // 先把终端建出来（渲染层据此新增/切换 Tab），再清空这个终端上一轮的输出。
    // clear 之前必须排空待发日志：否则上一轮最后几行会排在 clear 之后送达，
    // 落在新一轮的输出里（改按帧聚合后才有的窗口）。
    this.emit('terminal-open', {
      terminal,
      projectId: project.id,
      kind: target.kind,
      label: target.label
    })
    if (this.flushLogs) this.flushLogs()
    this.emit('clear', { terminal })
    this.emitLog(session, 'cmd', inv.label)

    // 把生效的 Node 版本摊开写在日志里，免得排查「为什么跑的还是全局那个版本」
    if (nodeRuntime) {
      this.emitLog(session, 'sys', `使用 Node v${nodeRuntime.version}（nvm，仅本项目）`)
    } else if (requestedNode) {
      this.emitLog(session, 'err', `未找到 nvm 的 Node v${requestedNode}，本次回退到系统 node`)
    }

    this.emitStatus(session, {
      status,
      pid: child.pid,
      currentCommand: inv.label,
      startedAt: session.startedAt
    })

    child.stdout?.on('data', (chunk: Buffer) => this.consume(project.id, session, 'out', chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.consume(project.id, session, 'err', chunk))

    child.on('error', (err) => {
      this.emitLog(session, 'err', `无法启动进程：${err.message}`)
      this.finish(project.id, session, null, '命令未能执行，请确认包管理器已安装并在 PATH 中')
    })

    child.on('close', (code) => {
      this.flushBuffers(project.id, session)
      this.finish(project.id, session, code, null)
    })

    return null
  }

  private consume(
    projectId: string,
    session: Session,
    stream: 'out' | 'err',
    chunk: Buffer
  ): void {
    const key = stream === 'out' ? 'stdoutBuf' : 'stderrBuf'
    session[key] += chunk.toString('utf8')
    const parts = session[key].split(/\r?\n/)
    session[key] = parts.pop() ?? ''
    for (const line of parts) this.handleLine(projectId, session, stream, line)
  }

  private flushBuffers(projectId: string, session: Session): void {
    for (const stream of ['out', 'err'] as const) {
      const key = stream === 'out' ? 'stdoutBuf' : 'stderrBuf'
      const rest = session[key].trim()
      session[key] = ''
      if (rest) this.handleLine(projectId, session, stream, rest)
    }
  }

  private handleLine(
    projectId: string,
    session: Session,
    stream: 'out' | 'err',
    rawLine: string
  ): void {
    const text = rawLine.replace(ANSI_RE, '').replace(/\s+$/, '')
    this.emitLog(session, stream, text)

    // 端口只从标准输出里认，错误信息里出现的端口不算服务就绪。
    // 认出来只是为了显示与「端口被占用」的启动前提醒 —— 浏览器一律交给项目脚本自己开。
    if (stream !== 'out') return
    if (session.kind !== 'start' && session.kind !== 'custom') return
    if (session.readyEmitted) return

    const server = detectServerAddress(text)
    if (!server) return

    session.readyEmitted = true
    this.emitStatus(session, {
      status: 'running',
      pid: session.child.pid,
      currentCommand: session.command,
      startedAt: session.startedAt,
      port: server.port
    })
  }

  private finish(
    projectId: string,
    session: Session,
    code: number | null,
    errorText: string | null
  ): void {
    if (session.finished) return
    session.finished = true
    this.sessions.delete(projectId)
    this.emit('sessions-changed')

    const durationMs = Date.now() - session.startedAt
    if (errorText) this.emitLog(session, 'err', errorText)

    let outcome: RunOutcome
    if (session.stopping) outcome = 'stopped'
    else if (errorText) outcome = 'failed'
    else outcome = code === 0 ? 'success' : 'failed'

    this.emit('run-finished', {
      projectId,
      record: {
        id: `${session.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        kind: session.kind,
        command: session.command,
        startedAt: session.startedAt,
        durationMs,
        result: outcome
      } satisfies RunRecord
    })

    if (outcome === 'stopped') {
      this.emitLog(session, 'sys', '进程已停止')
      this.emitStatus(session, { status: 'idle' })
      return
    }

    const failed = outcome === 'failed'
    const exitLabel = code === null ? '未知' : String(code)

    if (session.kind === 'install') {
      if (failed) {
        this.emitLog(session, 'err', `依赖安装失败，退出码 ${exitLabel}`)
        this.emitStatus(session, { status: 'failed', exitCode: code })
      } else {
        this.emitLog(session, 'sys', '依赖安装完成')
        this.emitStatus(session, { status: 'idle', exitCode: 0 })
      }
      return
    }

    if (session.kind === 'build') {
      if (failed) {
        this.emitLog(session, 'err', `打包失败，退出码 ${exitLabel}`)
        this.emitStatus(session, { status: 'failed', exitCode: code })
      } else {
        this.emitLog(session, 'sys', `打包完成，用时 ${(durationMs / 1000).toFixed(1)}s`)
        this.emitStatus(session, { status: 'success', durationMs, exitCode: 0 })
        // 带上 terminal：上层要用它把「产物目录」提示写进打包终端，而不是另拼一个 key
        this.emit('build-done', { projectId, terminal: session.terminal })
        setTimeout(() => {
          if (!this.sessions.has(projectId)) {
            this.emitStatus(session, { status: 'idle' })
          }
        }, 3000)
      }
      return
    }

    if (failed) {
      this.emitLog(session, 'err', `进程异常退出，退出码 ${exitLabel}`)
      this.emitStatus(session, { status: 'failed', exitCode: code })
    } else {
      this.emitLog(session, 'sys', '进程已退出')
      this.emitStatus(session, { status: 'idle', exitCode: 0 })
    }
  }

  private emitLog(session: Session, stream: ProcessLogEvent['stream'], text: string): void {
    const payload: ProcessLogEvent = {
      terminal: session.terminal,
      projectId: session.projectId,
      stream,
      // 命令输出在 handleLine 里已经剥过 ANSI；这里是纯文本提示，不必再扫一遍
      text,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    this.emit('log', payload)
  }

  private emitStatus(session: Session, patch: Omit<ProcessStatusEvent, 'projectId' | 'terminal'>): void {
    // 日志按帧聚合、状态是同步直发，两者走不同通道：不先排空的话，「打包完成」这类
    // 状态会早于它上面最后几行日志到达，界面可能先跳到成功态再补上输出。
    // 状态变更本就稀疏，这里排空不会把批处理的意义抵消掉。
    if (this.flushLogs) this.flushLogs()
    this.emit('status', {
      projectId: session.projectId,
      terminal: session.terminal,
      ...patch
    } satisfies ProcessStatusEvent)
  }
}
