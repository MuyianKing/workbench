import type { TokenUsageResult } from '@workbench/usage'
import type { Result } from '@/types'
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'

interface TokenUsageOptions {
  /** 每次拿到新数据后调一次（面板据此把时间窗口收敛到有数据的那段） */
  onData?: (data: TokenUsageResult) => void
}

/**
 * 首页「Coding 用量」卡片的取数与节奏。
 *
 * 这块逻辑与画法无关，抽出来有三个理由：卡片本身已经一千多行；轮询 / 首屏快照 / 手动同步
 * 三条路共用同一份「整份替换」的语义，散在组件里很容易各写一套；以及它是**单页状态**
 * （只有首页这一张卡片读它），按 ipc-and-state.md 的判据不该为它造 store。
 *
 * 取数顺序是硬约定：**先出本地快照、再实读覆盖**。两条路的结果都是整份替换，
 * 并发发出的话实读可能先落地，然后被更旧的快照盖掉，界面上的数字会往回缩。
 */
export function useTokenUsage(options: TokenUsageOptions = {}) {
  const settings = useSettingsStore()
  const result = ref<TokenUsageResult | null>(null)
  const loading = ref(false)
  const syncing = ref(false)
  /** 每次刷新时更新，驱动「今天 / 本周 / 本月」与相对时间跟着时钟走 */
  const nowTick = ref(Date.now())
  /** 实读是否已经回来过一次：没回来之前不说「暂无记录」 */
  const readOnce = ref(false)

  let timer: number | null = null
  let unsubscribe: (() => void) | null = null

  function applyResult(res: Result<TokenUsageResult>): void {
    if (!res.ok || !res.data)
      return
    result.value = res.data
    nowTick.value = Date.now()
    options.onData?.(res.data)
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      applyResult(await window.workbench.getTokenUsage())
    }
    finally {
      loading.value = false
      readOnce.value = true
    }
  }

  /** 首屏那一步：只读本地快照（几毫秒），应用完再实读覆盖它（顺序见文件头） */
  async function boot(): Promise<void> {
    applyResult(await window.workbench.getTokenUsageSnapshot())
    await refresh()
  }

  /**
   * 手动同步一次。
   *
   * 同步本身（以及「失败原因怎么说」）走 settings store 里那一份共用实现 ——
   * 那颗按钮推拉的是**用量分片**，外观配置是设置界面另一颗按钮的事（`syncAppearanceNow`）。
   * 这里只管界面态：转圈、以及把同步回来的数字立刻显示出来。
   */
  async function syncNow(): Promise<void> {
    syncing.value = true
    try {
      const res = await settings.syncUsageNow()
      if (res)
        applyResult(res)
    }
    finally {
      syncing.value = false
    }
  }

  /**
   * 轮询与同步广播只跟着「这张卡看得见」走。
   *
   * 首页在 KeepAlive 里，切去别的页只是 deactivated、不卸载 —— 定时器若只等卸载才清，
   * 应用开一整天就是一整天的每分钟后台读盘。
   */
  function startPolling(): void {
    if (timer !== null)
      return
    timer = window.setInterval(() => void refresh(), 60_000)
    // 后台的自动同步跑完会广播一次：新读回的别人的分片立刻显示出来
    unsubscribe = window.workbench.onTokenSynced(() => void refresh())
  }

  function stopPolling(): void {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    unsubscribe?.()
    unsubscribe = null
  }

  onMounted(() => void boot())

  /**
   * 切回首页时立刻补读一次，不必等下一个轮询整点。
   * 首次激活时 boot 还在跑（快照 → 实读），用 readOnce 把它让过去，
   * 否则插进去的实读会被先到的快照盖掉（数字往回缩）。
   */
  onActivated(() => {
    if (readOnce.value)
      void refresh()
    startPolling()
  })
  onDeactivated(stopPolling)
  onBeforeUnmount(stopPolling)

  return {
    result,
    loading,
    syncing,
    nowTick,
    readOnce,
    refresh,
    syncNow,
  }
}
