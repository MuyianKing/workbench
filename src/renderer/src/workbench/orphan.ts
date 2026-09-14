/**
 * 残留进程清理的生产侧：把 `@shared/orphan` 的判定接到 Rust 上。
 *
 * 判定规则一行都没有重复 —— 那些留在 shared 里，连同「PID 被复用」这类安全性判断的测试。
 */
import { reapOrphanSessions, type ReapDeps, type ReapResult } from '@shared/orphan'
import { invoke } from './bridge'
import * as state from './state'

const rustDeps: ReapDeps = {
  /** 进程创建时间：Rust 侧一次 OpenProcess + GetProcessTimes，不起任何外部进程 */
  createdAt: async (pid) => {
    try {
      return await invoke<number | null>('process_created_at', { pid })
    } catch {
      // 问不到就当作认不出来，清理流程会跳过它
      return null
    }
  },

  killTree: async (pid) => {
    await invoke('kill_process_tree', { pid })
  }
}

/**
 * 启动时调用一次：收掉上次被强杀后留下的 dev server。
 * 保留下来的记录要写回盘 —— 那些是「有主」的会话，丢了下次就认不出来了。
 */
export async function reap(): Promise<ReapResult> {
  const result = await reapOrphanSessions(state.activeSessions(), rustDeps)
  state.setActiveSessions(result.kept)
  return result
}
