/**
 * 残留进程清理：应用被强杀后，上次留下的 dev server 会在下次启动时收掉。
 *
 * 这里的逻辑是纯的 + IO 注入（`ReapDeps`），与 [scanner.ts](scanner.ts) 同一套路：
 * 生产注入走 Rust 命令的实现，测试注入假实现，于是判断规则能被直接测到
 * ——「PID 被复用」这类安全性判断恰恰是最该有测试的地方。
 */
import type { ActiveSession } from './types'

/**
 * 记一条会话记录：**同一个 PID 只保留最新一条**。
 *
 * PID 会被系统复用，同一条记录重复堆叠会让「上次残留」被处理多次；
 * 抽成纯函数是为了这条规则能被直接测到。
 * 传 undefined（老数据文件没有这个字段）也当空列表处理。
 */
export function withSessionRecorded(
  sessions: ActiveSession[] | undefined,
  entry: ActiveSession
): ActiveSession[] {
  const rest = (sessions ?? []).filter((item) => item.pid !== entry.pid)
  return [...rest, entry]
}

/** 摘掉某个 PID 的记录（进程正常结束时调用） */
export function withoutSession(
  sessions: ActiveSession[] | undefined,
  pid: number
): ActiveSession[] {
  return (sessions ?? []).filter((item) => item.pid !== pid)
}

export interface ReapDeps {
  /** 进程创建时间（毫秒，Unix 纪元）；进程已退出或打不开时返回 null */
  createdAt(pid: number): Promise<number | null>
  /** 按进程树结束 */
  killTree(pid: number): Promise<void>
}

export interface ReapResult {
  killed: number
  /** 判定为「有主」而被保留的会话，调用方要写回去，别把它们丢了 */
  kept: ActiveSession[]
  notes: string[]
}

/**
 * 判断这个 PID 还是不是记录里的那个子进程。
 *
 * 用创建时间而不是命令行：PID 被系统复用后创建时间必然不同，而命令行有可能碰巧相似。
 * 记录里没有这个字段（老数据文件）或进程已经问不到，一律当作「认不出来」——
 * 清理残留宁可漏掉几个，也不能杀错进程。
 */
export function isSameProcess(
  session: Pick<ActiveSession, 'processCreatedAt'>,
  actualCreatedAt: number | null
): boolean {
  if (actualCreatedAt === null) return false
  if (typeof session.processCreatedAt !== 'number') return false
  return session.processCreatedAt === actualCreatedAt
}

/**
 * 宿主应用进程是不是还是当初那个。
 *
 * 必须连创建时间一起比：只判 PID 存不存在的话，一个复用了旧 PID 的新进程
 * 会让这条记录被当成「有主」而永远保留 —— 残留进程也就永远清不掉（踩过）。
 * 老数据文件没有这个字段时按「认不出宿主」处理：接着去核子进程的创建时间，
 * 那个也认不出就跳过，不会误杀。
 */
export function isSameOwner(
  session: Pick<ActiveSession, 'ownerCreatedAt'>,
  actualCreatedAt: number | null
): boolean {
  if (actualCreatedAt === null) return false
  if (typeof session.ownerCreatedAt !== 'number') return false
  return session.ownerCreatedAt === actualCreatedAt
}

/** 启动时调用：清理上次残留的子进程，返回仍有效的会话记录与处理说明 */
export async function reapOrphanSessions(
  sessions: ActiveSession[] | undefined,
  deps: ReapDeps
): Promise<ReapResult> {
  const notes: string[] = []
  const kept: ActiveSession[] = []

  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : []
  if (list.length === 0) return { killed: 0, kept: [], notes }

  let killed = 0
  for (const session of list) {
    // 记录它的应用进程还在跑：这不是残留，别碰，也别把记录丢掉。
    // 这里要连身份一起核（见 isSameOwner），否则 PID 被复用时会把它误判成有主。
    if (session.ownerPid > 0) {
      const ownerCreated = await deps.createdAt(session.ownerPid)
      if (isSameOwner(session, ownerCreated)) {
        kept.push(session)
        continue
      }
    }

    const created = await deps.createdAt(session.pid)
    // 进程早没了，记录一并丢弃
    if (created === null) continue

    if (!isSameProcess(session, created)) {
      notes.push(`PID ${session.pid} 的创建时间与记录不符，已跳过（可能被系统复用）`)
      continue
    }

    try {
      await deps.killTree(session.pid)
      killed += 1
      notes.push(`已结束上次残留的进程 PID ${session.pid}（${session.command}）`)
    } catch (error) {
      notes.push(
        `结束残留进程 PID ${session.pid} 失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return { killed, kept, notes }
}
