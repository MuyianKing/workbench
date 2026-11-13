import { enqueue } from './sync-queue'

/**
 * 「一台机器一份分片」那类同步的公共节流：间隔 + 换仓库即失效 + 同一时刻只跑一条。
 *
 * 用量 / 活跃度 / 网关流水三处原本各写一份同样的状态机（`SYNC_INTERVAL_MS` + `lastSyncAt`
 * + `lastSyncRepo` + `pending`），语义一样、细节各有各的漏法。这里只收拢**调度**：
 * 推什么、读什么、失败怎么记，仍然归各域的 `run` 自己。
 *
 * 三条约定：
 *  - **换仓库立刻跑**：设置里换了地址 / 退出登录再登录，不必等节流窗口过去；
 *  - **一轮只跑一条**：跑着的这一轮结束前，后来的 `schedule` 直接返回 false，`now` 复用同一个 promise；
 *  - **什么时候算「跑过」由调用方定**：默认只要这一轮结束就记时刻；网关那一路要「成功才记」，
 *    失败之后下一次进页面仍会立刻重试（见 `shouldMark`）。
 */
export interface AutoSyncOptions {
  /** 两轮之间的最小间隔（毫秒） */
  intervalMs: number
  /** 一轮结束后调一次（无论成败都算）—— 广播「数据变了」这类事挂在这里 */
  settled?: () => void
  /** 这一轮的结果算不算「跑过」；默认一律算。传 `r => r.ok` 就是「失败不节流」 */
  shouldMark?: (result: unknown) => boolean
}

export interface AutoSync {
  /** 现在该不该跑：换仓库、或过了间隔、或还没跑过 */
  due: (repo: string) => boolean
  /** 到点就排进串行队列跑一轮（后台，不 await）；返回是否真的排了 */
  schedule: (repo: string, task: () => Promise<unknown>) => boolean
  /** 排进队列并等这一轮回来（手动按钮用；已有在跑的那一轮则复用它） */
  now: <T>(repo: string, task: () => Promise<T>) => Promise<T>
  /** 直接记一轮的时刻（例如「拿不到设备标识」：不必反复试，但要进节流窗口） */
  mark: (repo: string) => void
  /** 清掉节流状态（退出登录 / 没配仓库） */
  reset: () => void
  /** 上一次真的跑的时刻（0 = 还没跑过） */
  lastAt: () => number
}

export function createAutoSync(options: AutoSyncOptions): AutoSync {
  const { intervalMs, settled, shouldMark } = options
  let lastAt = 0
  let lastRepo = ''
  let pending: Promise<unknown> | null = null

  function mark(repo: string): void {
    lastAt = Date.now()
    lastRepo = repo
  }

  function due(repo: string): boolean {
    return !lastRepo || repo !== lastRepo || Date.now() - lastAt >= intervalMs
  }

  function start<T>(repo: string, task: () => Promise<T>, notify: boolean): Promise<T> {
    const run = enqueue(async () => {
      const result = await task()
      if (!shouldMark || shouldMark(result))
        mark(repo)
      return result
    })
    pending = run.catch(() => undefined)
    return run.finally(() => {
      pending = null
      // 只有后台那轮广播：手点的那一次调用方自己等结果，界面不必再取一遍
      if (notify)
        settled?.()
    })
  }

  return {
    due,
    schedule(repo, task) {
      if (pending || !due(repo))
        return false
      void start(repo, task, true).catch(() => undefined)
      return true
    },
    now<T>(repo: string, task: () => Promise<T>): Promise<T> {
      if (pending)
        return pending as Promise<T>
      return start(repo, task, false)
    },
    mark,
    reset() {
      lastAt = 0
      lastRepo = ''
    },
    lastAt: () => lastAt,
  }
}
