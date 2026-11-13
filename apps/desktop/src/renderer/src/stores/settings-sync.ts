import type { ThemeConfig } from '@workbench/appearance'
import type { Result, SyncDeviceInfo, TokenUsageResult } from '@/types'
import { ref } from 'vue'
import { notifyError, notifySuccess, notifyWarning } from '@/notify'

/**
 * 别台机器的外观：读设备清单、采用某一台的配置，以及两颗手动同步按钮。
 *
 * 从 `settings.ts` 拆出来的一整块。只认「怎么落盘外观」这一个入口（`saveThemeConfig`），
 * 与用量同步 / 外观同步各自的后端通道分开。对外名字与行为完全不变。
 */
export function useSettingsSync(options: {
  saveThemeConfig: (patch: Partial<ThemeConfig>) => Promise<boolean>
}) {
  const { saveThemeConfig } = options

  /**
   * 同步仓库里其它机器（含各自的外观配置快照）。
   *
   * 只读本地那份克隆、不联网，所以设置界面打开时问一次是安全的；内容是上一次同步取回来的样子。
   */
  const syncDevices = ref<SyncDeviceInfo[]>([])

  async function loadSyncDevices(): Promise<void> {
    const result = await window.workbench.listSyncDevices()
    if (result.ok && result.data) {
      syncDevices.value = result.data
      return
    }
    // 取不到就当没有：没填仓库地址、还没同步过都是常态，界面上是一句空态提示
    syncDevices.value = []
    if (!result.ok)
      console.warn('[workbench] 读取同步设备失败', result.error)
  }

  /**
   * 采用另一台机器的配置（设置界面里那一行的「应用」）。
   *
   * **只能由用户点**：配置是「以谁的为准」而不是能合并的数据，两台机器互相自动采用对方的
   * 会来回覆盖、永远收敛不了（详见 packages/appearance/src/sync-config.ts 的文件头）。
   * 走的是既有的 updateThemeConfig 通道 —— 外观与布局在同一个文件里，所以一次写入就够，
   * 主题过渡、终端高度、卡片摆放这些联动不必另写一套。
   */
  async function applySyncAppearance(deviceId: string): Promise<boolean> {
    const device = syncDevices.value.find(item => item.id === deviceId)
    if (!device?.theme) {
      notifyWarning('那台机器没有可用的配置')
      return false
    }

    if (!(await saveThemeConfig(device.theme)))
      return false

    notifySuccess(`已应用「${device.name}」的外观与布局`)
    return true
  }

  /**
   * 手动同步一次 Token 用量（面板上的同步按钮）：绕过自动同步的节流，
   * **只推拉用量分片、不碰外观配置** —— 外观走下面的 syncAppearanceNow。
   *
   * 自动同步在后台跑、失败只体现在状态点上，手动点的这一次必须把原因说清楚。
   * 返回后端结果，让调用方按需再取数字（Token 卡片拿到后会立刻重算展示）。
   */
  async function syncUsageNow(): Promise<Result<TokenUsageResult> | null> {
    try {
      const result = await window.workbench.syncTokenUsage()
      if (!result.ok) {
        notifyError(result.error ?? '同步失败')
        return result
      }

      const error = result.data?.sync.error
      if (error)
        notifyError(error)
      else notifySuccess(`已同步${deviceTextOf(result.data)}`)
      return result
    }
    catch (err) {
      // 版本不一致、后端没起来都可能走到这里：说一声比按钮转完圈什么都不发生强
      notifyError(err instanceof Error ? err.message : '同步失败')
      return null
    }
  }

  /**
   * 手动同步一次外观配置（设置 → 外观 →「同步一次」）：推本机 theme.json、拉回别的机器的。
   * 与用量同步互不相干 —— 不实读用量、不推分片。
   */
  async function syncAppearanceNow(): Promise<boolean> {
    try {
      const result = await window.workbench.syncThemeConfig()
      if (!result.ok) {
        notifyError(result.error ?? '同步外观配置失败')
        return false
      }
      notifySuccess('外观配置已同步')
      return true
    }
    catch (err) {
      notifyError(err instanceof Error ? err.message : '同步外观配置失败')
      return false
    }
  }

  /** 「已同步 · 本机、另一台」里那一段设备名；没开同步就是空串 */
  function deviceTextOf(data: TokenUsageResult | undefined): string {
    const sync = data?.sync
    if (!sync?.enabled)
      return ''
    const others = sync.devices.map(item => item.name).join('、')
    return others ? ` · ${sync.deviceName}、${others}` : ` · ${sync.deviceName}`
  }

  return {
    syncDevices,
    loadSyncDevices,
    applySyncAppearance,
    syncUsageNow,
    syncAppearanceNow,
  }
}
