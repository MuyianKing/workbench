import { defineStore } from 'pinia'
import { notifySuccess, notifyWarning } from '@/notify'
import { gatewayPerksAutoRun } from '@/workbench/gateway'
import { qoderPerksAutoRun } from '@/workbench/qoder'

/**
 * 福利自动跑的后台节拍（TBuddy 与 Qoder 共用设置·通用里的「福利每天自动」）。
 *
 * 真正该不该跑由 Rust 判断（两边各自的开关 / 本地自然日 / 23:00–08:00 窗口）：这一层只在
 * 启动后问一次、之后每十分钟问一次。配置关着时命令立刻返回，不产生任何上游请求。
 *
 * 应用进程关着的时候不会跑 —— 桌面应用没有常驻服务，下次打开补跑。
 * 提示走 `@/notify`，不在 store 里直接 import element-plus（见 AGENTS.md 的 store 约定）。
 */
const TICK_MS = 10 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
/** 一轮可能要跑几分钟（多个号串行），在途时不再起第二轮 */
let running = false

export const usePerksAutoStore = defineStore('perks-auto', () => {
  /** 立刻问一次两边的自动跑；没有该跑的事时什么也不提示。 */
  async function runNow(): Promise<void> {
    if (running)
      return
    running = true
    try {
      const results = await Promise.all([gatewayPerksAutoRun(), qoderPerksAutoRun()])
      for (const result of results) {
        if (!result.ok || !result.data)
          continue
        const data = result.data
        if (!data.ran || !data.message)
          continue
        if (data.failed > 0)
          notifyWarning(data.message)
        else
          notifySuccess(data.message)
      }
    }
    finally {
      running = false
    }
  }

  function startWatch(): void {
    if (timer)
      return
    void runNow()
    timer = setInterval(() => {
      void runNow()
    }, TICK_MS)
  }

  function stopWatch(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { runNow, startWatch, stopWatch }
})
