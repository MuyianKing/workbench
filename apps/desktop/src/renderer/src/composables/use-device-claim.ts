/**
 * 设备认领向导的状态机：启动后检测一次，满足条件才弹；弹过（认领 / 忽略）就落 flag，不再打扰。
 *
 * 检测门槛按「宁可不弹也不误认」排：
 *   - 开发模式不弹（开发环境数据目录独立、没有真实的多机历史，见 AGENTS.md）；
 *   - `fresh=false`（不是本次新生成的 id）不弹；
 *   - 设置里的「已处理」flag 为真不弹；
 *   - 没填同步仓库不弹（没有历史可认）；
 *   - 仓库里除本机外没有别的设备不弹（全新装机 / 空仓库）。
 *
 * 认领编排在 `workbench/device-claim.ts`（回灌 7 域 → 改 id → 删新分片），这里只管
 * 「什么时候弹、用户选了谁、结果怎么收尾」。
 */

import type { SyncDeviceInfo } from '@/types'
import { computed, ref } from 'vue'
import { notifyInfo, notifyWarning } from '@/notify'
import { useSettingsStore } from '@/stores/settings'
import { claimDevice, claimState, dismissClaim } from '@/workbench/device-claim'

const open = ref(false)
const candidates = ref<SyncDeviceInfo[]>([])
const checking = ref(false)
const claiming = ref(false)

export function useDeviceClaim() {
  const settings = useSettingsStore()

  /**
   * 启动后调一次。所有失败都静默吞掉：认领是「锦上添花的恢复引导」，绝不能挡住启动。
   */
  async function check(): Promise<void> {
    // 开发环境：数据目录独立（Workbench-dev），没有真实多机历史，也不需要这个引导
    if (import.meta.env.DEV)
      return
    if (checking.value || open.value)
      return
    checking.value = true
    try {
      if (settings.settings.deviceClaimGuideDone)
        return

      const state = await claimState()
      if (!state.ok || !state.data?.fresh)
        return

      const repo = settings.settings.tokenSyncRepo
      if (!repo?.trim())
        return

      const devices = await window.workbench.listSyncDevices()
      if (!devices.ok || !devices.data)
        return

      // 只认「别的设备」：本机的分片没有可认的历史；没有 updatedAt 的残缺项也不列入
      const others = devices.data.filter(device => !device.self && device.id && device.id !== state.data?.id)
      if (!others.length)
        return

      candidates.value = others
      open.value = true
    }
    finally {
      checking.value = false
    }
  }

  /** 用户选了一台旧设备：回灌 + 改 id + 删新分片，然后落 flag、提示重启 */
  async function claim(old: SyncDeviceInfo): Promise<void> {
    if (claiming.value)
      return
    claiming.value = true
    try {
      const state = await claimState()
      const newId = state.ok && state.data ? state.data.id : ''
      if (!newId)
        return

      const result = await claimDevice(settings.settings.tokenSyncRepo, newId, old)
      await settings.updateSettings({ deviceClaimGuideDone: true })

      // 结果如实报：恢复成功的域列出来；网关 / Qoder 是脱敏副本，顺带说明限制
      const restored = result.restored.length ? `（${result.restored.join('、')}）` : ''
      const tip = result.error
        ? `设备已认领${restored}，但有部分没恢复：${result.error}。请重启应用。`
        : `设备已认领${restored}，请重启应用后查看历史数据。`
      if (result.ok)
        notifyInfo(tip)
      else
        notifyWarning(tip)
      open.value = false
    }
    finally {
      claiming.value = false
    }
  }

  /** 用户「暂不处理」：只落 flag，保留当前新 id */
  async function dismiss(): Promise<void> {
    await dismissClaim()
    await settings.updateSettings({ deviceClaimGuideDone: true })
    open.value = false
  }

  return {
    open: computed(() => open.value),
    candidates: computed(() => candidates.value),
    claiming: computed(() => claiming.value),
    check,
    claim,
    dismiss,
  }
}
