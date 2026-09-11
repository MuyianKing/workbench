import { spawn } from 'node:child_process'
import type { ActiveSession } from '../shared/types'
import { normalizePath } from '../shared/project-path'
import { killProcessTree } from './system'

/**
 * 清理「无主进程」（设计文档 §7 最后一条）。
 *
 * 应用被强杀 / 崩溃时，spawn 出去的 dev server 会活下来继续占端口，下次启动必须收拾掉。
 * 难点全在「别杀错」上，所以这里做了两道校验：
 *
 *   1. 记录会话时连 ownerPid 一起写盘。如果那个应用进程还活着（例如开发态和打包版同时开着），
 *      说明这些子进程有主，一律不动 —— 否则会出现两个实例互相杀对方服务的惨剧。
 *   2. 真要动手前，比对实际进程的命令行与记录：命令行里得出现项目目录或原命令原文。
 *      PID 被系统复用给别的进程时，这一步会失败，于是放弃。
 */

export interface ProcessInfo {
  pid: number
  name: string
  commandLine: string
}

/**
 * 判断某个进程是否就是这条会话记录里的子进程。
 * 抽成纯函数是为了能直接测「PID 被复用」这类判断。
 */
export function matchesSession(
  session: Pick<ActiveSession, 'command' | 'cwd'>,
  commandLine: string | null | undefined
): boolean {
  const line = (commandLine ?? '').trim()
  if (!line) return false

  const normalized = normalizePath(line)
  const cwd = normalizePath(session.cwd ?? '')
  const command = normalizePath(session.command ?? '')

  // shell: true 时命令行里一定带着工作目录
  if (cwd && normalized.includes(cwd)) return true
  return command.length >= 4 && normalized.includes(command)
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true
      })
    } catch {
      resolve('')
      return
    }

    let out = ''
    let settled = false
    const done = (value: string): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => done(''))
    child.on('close', () => done(out))

    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      done('')
    }, 8000)
  })
}

/** 一次问清所有关心的 PID：名称 + 命令行 */
export async function queryProcesses(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const result = new Map<number, ProcessInfo>()
  const targets = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))]
  if (process.platform !== 'win32' || targets.length === 0) return result

  const filter = targets.map((pid) => `ProcessId=${pid}`).join(' or ')
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  const raw = (await runPowerShell(script)).trim()
  if (!raw) return result

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // PowerShell 不可用（被策略禁用等）时宁可什么都不做
    return result
  }

  const list = Array.isArray(parsed) ? parsed : [parsed]
  for (const item of list) {
    const record = item as { ProcessId?: number; Name?: string; CommandLine?: string | null }
    if (typeof record.ProcessId !== 'number') continue
    result.set(record.ProcessId, {
      pid: record.ProcessId,
      name: record.Name ?? '',
      commandLine: record.CommandLine ?? ''
    })
  }
  return result
}

export interface ReapResult {
  killed: number
  /** 判定为「有主」而被保留的会话，调用方要写回去，别把它们丢了 */
  kept: ActiveSession[]
  notes: string[]
}

/** 启动时调用：清理上次残留的子进程，返回仍有效的会话记录与处理说明 */
export async function reapOrphanSessions(sessions: ActiveSession[]): Promise<ReapResult> {
  const notes: string[] = []
  const kept: ActiveSession[] = []

  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : []
  if (process.platform !== 'win32' || list.length === 0) {
    return { killed: 0, kept: [], notes }
  }

  const info = await queryProcesses(list.flatMap((s) => [s.ownerPid, s.pid]))

  let killed = 0
  for (const session of list) {
    // 记录它的应用进程还在跑：这不是残留，别碰，也别把记录丢掉
    if (session.ownerPid > 0 && info.has(session.ownerPid)) {
      kept.push(session)
      continue
    }

    const child = info.get(session.pid)
    if (!child) continue // 进程早没了，记录一并丢弃

    if (!matchesSession(session, child.commandLine)) {
      notes.push(`PID ${session.pid} 与记录的命令行不符，已跳过（可能被系统复用）`)
      continue
    }

    try {
      await killProcessTree(session.pid)
      killed += 1
      notes.push(`已结束上次残留的进程 PID ${session.pid}（${session.command}）`)
    } catch (err) {
      notes.push(`结束残留进程 PID ${session.pid} 失败：${(err as Error).message}`)
    }
  }

  return { killed, kept, notes }
}
