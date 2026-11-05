import type { GatewayPerksAutoRun } from '@/workbench/gateway'
import { defineStore } from 'pinia'
import { notifySuccess, notifyWarning } from '@/notify'
import { gatewayPerksAutoRun } from '@/workbench/gateway'

/**
 * 福利自动跑的后台节拍。
 *
 * 真正该不该跑由 Rust 判断（开关 / 本地自然日 / 23:00–08:00 窗口）：这一层只在
 * 启动后问一次、之后每十分钟问一次。关着时命令立刻返回，不产生任何上游请求。
 *
 * 应用进程关着的时候不会跑 —— 桌面应用没有常驻服务，下次打开补跑。
 * 提示走 `@/notify`，不在 store 里直接 import element-plus（见 AGENTS.md 的 store 约定）。
 */
const TICK_MS = 10 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
/** 一轮可能要跑几分钟（多个号串行），在途时不再起第二轮 */
let running = false

export const usePerksAutoStore = defineStore('perks-auto', () => {
  /** 立刻问一次；返回这一轮的结果（没有该跑的事时 `ran` 为 false）。 */
  async function runNow(): Promise<GatewayPerksAutoRun | null> {
    if (running)
      return null
    running = true
    try {
      const result = await gatewayPerksAutoRun()
      if (!result.ok || !result.data)
        return null
      const data = result.data
      if (!data.ran || !data.message)
        return data
      if (data.failed > 0)
        notifyWarning(data.message)
      else
        notifySuccess(data.message)
      return data
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
