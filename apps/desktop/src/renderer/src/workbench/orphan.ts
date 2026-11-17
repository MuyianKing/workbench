import type { ReapDeps, ReapResult } from '@workbench/core'
/**
 * 残留进程清理的生产侧：把 `@workbench/core` 的判定接到 Rust 上。
 *
 * 判定规则一行都没有重复 —— 那些留在 shared 里，连同「PID 被复用」这类安全性判断的测试。
 */
import { reapOrphanSessions } from '@workbench/core'
import { invoke } from './bridge'
import * as state from './state'

const rustDeps: ReapDeps = {
  /** 进程创建时间：Rust 侧一次 OpenProcess + GetProcessTimes，不起任何外部进程 */
  createdAt: async (pid) => {
    try {
      return await invoke<number | null>('process_created_at', { pid })
    }
    catch {
      // 问不到就当作认不出来，清理流程会跳过它
      return null
    }
  },

  killTree: async (pid) => {
    await invoke('kill_process_tree', { pid })
  },

  /** 项目记着的监听端口：接管判断只认这一个值（它本来就是启动时认出外部服务的线索） */
  projectPort: projectId => state.projects().find(project => project.id === projectId)?.port,

  /** 端口探测与「外部运行中」同源，一次 TCP 连接，不起子进程 */
  portInUse: async (port) => {
    try {
      const result = await invoke<{ inUse: boolean }>('check_port', { port })
      return result.inUse
    }
    catch {
      // 问不到占用情况就按「没在听」处理：保留一个界面认不出来的进程比多清一个更糟
      return false
    }
  },
}

/**
 * 启动时调用一次：处理上次被强杀 / 更新安装时留下的子进程。
 * 开发服务还在监听端口的不杀，交给端口探测接管（见 `@workbench/core` 的规则）；
 * 保留下来的记录要写回盘 —— 那些是「有主」的会话，丢了下次就认不出来了。
 */
export async function reap(): Promise<ReapResult> {
  const result = await reapOrphanSessions(state.activeSessions(), rustDeps)
  state.setActiveSessions(result.kept)
  return result
}
