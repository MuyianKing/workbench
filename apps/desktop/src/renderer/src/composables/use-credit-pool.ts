import type { Result } from '@workbench/core'
import { ref } from 'vue'

/**
 * 网关账号池的余额快照层，TBuddy 与 Qoder 两页共用。
 *
 * 「查余额」是账号页唯一要打上游的动作（一个号一次往返），它拖着一套自己的状态 ——
 * 快照按 uid 存、单号在途标记、全量查询的节流时刻 —— 原先两边各写一份，口径还悄悄分叉
 * （TBuddy 删号时清快照、Qoder 没清，统计卡的「剩余 / 总额」会凭空多出一个号）。
 * 收到这里之后一套口径：快照跟着账号增删走（调用方在 refresh 里 prune）、
 * 节流时刻由调用方在发车 / 收车时记（两边发车节奏不同）。
 *
 * **这里从不弹提示**：查一个号失败就返回错误串，批量查时十个号不能弹十条红条，
 * 说什么、要不要说由调用方汇总（TBuddy 聚成一条、Qoder 单号就地提示）。
 */
export function useCreditPool<Credits>() {
  /** uid → 最近一次查到的积分快照 */
  const credits = ref<Record<string, Credits>>({})
  /** 按 uid 记的单号在途：行内那枚「查余额」自己转自己的 */
  const pending = ref<Record<string, boolean>>({})
  /** 上一次全量查余额的时刻（毫秒），配合调用方的节流间隔 */
  let lastAllAt = 0

  /** 账号删掉后它的余额快照要一起丢掉：统计卡是把整个 map 求和，留着旧号会凭空多出一个号 */
  function pruneCredits(alive: ReadonlySet<string>): void {
    credits.value = Object.fromEntries(
      Object.entries(credits.value).filter(([uid]) => alive.has(uid)),
    )
  }

  /** 距上次全量查余额是否还在节流窗口内 */
  function throttled(throttleMs: number): boolean {
    return Date.now() - lastAllAt < throttleMs
  }

  /** 记下「刚刚发过一轮全量」的时刻 */
  function markQueried(): void {
    lastAllAt = Date.now()
  }

  /** 清掉节流时刻：右下角那枚「刷新积分」要走，不看一分钟内的旧账 */
  function resetThrottle(): void {
    lastAllAt = 0
  }

  /**
   * 查一个号的余额。成功返回 `null`，失败返回错误串。
   * 在途标记进出各记一次，行内按钮的 loading 跟着它走。
   */
  async function queryCredits(
    uid: string,
    fetchCredits: (uid: string) => Promise<Result<Credits>>,
    fallback = '查询余额失败',
  ): Promise<string | null> {
    pending.value = { ...pending.value, [uid]: true }
    try {
      const result = await fetchCredits(uid)
      if (!result.ok || !result.data)
        return result.error ?? fallback
      credits.value = { ...credits.value, [uid]: result.data }
      return null
    }
    finally {
      const rest = { ...pending.value }
      delete rest[uid]
      pending.value = rest
    }
  }

  return { credits, pending, pruneCredits, throttled, markQueried, resetThrottle, queryCredits }
}
