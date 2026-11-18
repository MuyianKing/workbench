/**
 * 设备身份认领：重装 / 清数据目录后 `device.json` 被换成新 id，仓库里旧 id 那份被当成
 * 「别人的设备」重复合计。这个模块在用户确认后把旧设备认回来：
 *
 *   1. 读旧 id 在同步仓库里的分片（此时旧 id 是「别的设备」，所有读通道都能读到）；
 *   2. 把各域分片回灌到本机权威文件（**必须在改 id 之前**：改完旧分片会被当成 own 跳过）；
 *   3. 把 `device.json` 的 id 改回旧值（`fresh` 一并抹掉）；
 *   4. 删掉新 id 已经推出的空分片，免得多出一台「幽灵设备」。
 *
 * 业务语义（sanitize / 合并 / 取字段）都在这里、用各域包的函数，Rust 只提供原子命令：
 * 读分片走既有通道，写本机走既有 `*_save`，只有网关 / Qoder 的本机账本没有写回命令，
 * 走 `device_claim_import_*` 两条新增通道。
 */

import type { ActivityShard, Result } from '@workbench/core'
import type { WorkLogFile } from '@workbench/work-log'
import type { DeviceClaimState, DeviceShardsDeleted, SyncDeviceInfo } from '@/types'
import { sanitizeThemeFile } from '@workbench/appearance'
import { mergeActivityBreakdowns, sanitizeActivityShard } from '@workbench/core'
import { mergeEtfCacheInto, sanitizeEtfCache } from '@workbench/etf'
import { sanitizeShard } from '@workbench/usage'
import { mergeWorkLogShards, sanitizeWorkLogShard } from '@workbench/work-log'
import { errorText, guard, invoke } from './bridge'
import { resetLocalDevice } from './token'

/** 认领的结果：各域恢复情况如实带回来，失败的那几域不阻断其余域 */
export interface DeviceClaimOutcome {
  ok: boolean
  error: string
  /** 已回灌的域（用于提示条如实说明） */
  restored: string[]
}

/** 读本机设备身份 + 是否刚生成还没认领（认领向导的检测信号） */
export function claimState(): Promise<Result<DeviceClaimState>> {
  return guard(invoke<DeviceClaimState>('device_claim_state'), '读取设备身份失败')
}

/** 用户「暂不处理」：保留当前 id，只抹掉 fresh，不再提示 */
export function dismissClaim(): Promise<Result<null>> {
  return guard(invoke<null>('device_claim_dismiss'), '忽略失败')
}

/**
 * 认领一台旧设备：回灌各域 → 改 id → 删新分片。
 *
 * 单个域失败只记一条、继续其余域——整机恢复最怕「一处坏、全不干」。但改 id 必须成功，
 * 否则这次认领没完成，报错让用户重试（fresh 还在，下次启动还会提示）。
 */
export async function claimDevice(repo: string, newId: string, old: SyncDeviceInfo): Promise<DeviceClaimOutcome> {
  const restored: string[] = []
  const errors: string[] = []

  // 旧 id 此刻是「别的设备」，下面每一路读通道都会把它当别人的分片返回。
  // 刷新一次克隆，保证读到的是仓库里最新的（用户可能刚在别的机器上推过）。
  try {
    await invoke('gateway_sync_pull', { repo })
  }
  catch (error) {
    errors.push(`刷新同步仓库失败：${errorText(error, '')}`)
  }

  // token_sync_shards 一次返回用量 + 配置两个目录，用量域与外观域共用这一次读取
  let usageRaw: unknown[] = []
  let configRaw: unknown[] = []
  try {
    const files = await invoke<{ usage?: unknown[], config?: unknown[] }>('token_sync_shards', { repo })
    usageRaw = Array.isArray(files?.usage) ? files.usage : []
    configRaw = Array.isArray(files?.config) ? files.config : []
  }
  catch (error) {
    errors.push(`读取用量 / 配置分片失败：${errorText(error, '')}`)
  }

  // ---- 用量：分片与本机文件同结构，直接把旧那份收敛后写回 ----
  try {
    const shard = usageRaw
      .map(item => sanitizeShard(item))
      .find(item => item.device === old.id)
    if (shard) {
      await invoke('token_save', { value: shard })
      restored.push('用量')
    }
  }
  catch (error) {
    errors.push(`用量：${errorText(error, '恢复失败')}`)
  }

  // ---- 外观：config 分片是 theme.json 整份副本 ----
  try {
    const file = configRaw
      .map(item => sanitizeThemeFile(item))
      .find(item => item?.device === old.id)
    if (file?.theme) {
      await invoke('theme_save', { value: file.theme })
      restored.push('外观')
    }
  }
  catch (error) {
    errors.push(`外观：${errorText(error, '恢复失败')}`)
  }

  // ---- 工作日志：把旧设备的分片合并进本机 ----
  try {
    const raw = await invoke<unknown[]>('work_log_sync_pull', { repo, device: newId })
    const shards = (Array.isArray(raw) ? raw : [])
      .map(item => sanitizeWorkLogShard(item))
      .filter((item): item is NonNullable<typeof item> => item !== null && item.device === old.id)
    if (shards.length) {
      const local = sanitizeLocalWorkLog(await invoke<unknown>('work_log_load'))
      const merged = mergeWorkLogShards(local, shards)
      await invoke('work_log_save', { value: merged })
      restored.push('工作日志')
    }
  }
  catch (error) {
    errors.push(`工作日志：${errorText(error, '恢复失败')}`)
  }

  // ---- ETF 缓存：files 是裸缓存（Rust 已跳过 own），全并进本机；公网行情，无害 ----
  try {
    const pulled = await invoke<{ files?: unknown[] }>('etf_sync_pull', { repo, device: newId })
    const files = Array.isArray(pulled?.files) ? pulled.files : []
    if (files.length) {
      const local = sanitizeEtfCache(await invoke<unknown>('etf_load'))
      let changed = false
      for (const file of files) {
        if (mergeEtfCacheInto(local, sanitizeEtfCache(file)))
          changed = true
      }
      if (changed)
        await invoke('etf_save', { value: local })
      restored.push('ETF 缓存')
    }
  }
  catch (error) {
    errors.push(`ETF：${errorText(error, '恢复失败')}`)
  }

  // ---- 活跃度：并进本机 workbench-data.json 的 activity 字段 ----
  try {
    const raw = await invoke<unknown[]>('activity_sync_shards', { repo, device: newId })
    const shard = (Array.isArray(raw) ? raw : [])
      .map(item => sanitizeActivityShard(item))
      .find((item): item is ActivityShard => item !== null && item.device === old.id)
    if (shard) {
      const data = await invoke<Record<string, unknown>>('data_load')
      const merged = mergeActivityBreakdowns([(data?.activity as Record<string, Record<string, number>>) ?? {}, shard.activity])
      await invoke('data_save', { value: { ...data, activity: merged } })
      restored.push('活跃度')
    }
  }
  catch (error) {
    errors.push(`活跃度：${errorText(error, '恢复失败')}`)
  }

  // ---- 网关流水 / Qoder 领取：脱敏副本，Rust 读分片 + 按价表补价 + 去重写回本机 ----
  try {
    const added = await invoke<number>('device_claim_import_gateway', { repo, device: old.id })
    restored.push(`网关流水（${added} 条）`)
  }
  catch (error) {
    errors.push(`网关流水：${errorText(error, '恢复失败')}`)
  }
  try {
    const added = await invoke<number>('device_claim_import_qoder', { repo, device: old.id })
    restored.push(`Qoder 领取（${added} 条）`)
  }
  catch (error) {
    errors.push(`Qoder 领取：${errorText(error, '恢复失败')}`)
  }

  // ---- 回灌完成，才改 id ----
  try {
    await invoke('device_claim_set', { id: old.id })
    resetLocalDevice()
  }
  catch (error) {
    return {
      ok: false,
      error: `回灌已完成，但改回设备标识失败：${errorText(error, '')}。请重试认领。`,
      restored,
    }
  }

  // ---- 删新 id 的空分片 ----
  try {
    await invoke<DeviceShardsDeleted>('device_claim_delete_shards', { repo, device: newId })
  }
  catch (error) {
    errors.push(`清理新设备分片失败：${errorText(error, '')}`)
  }

  return {
    ok: true,
    error: errors.join('；'),
    restored,
  }
}

/** 本机 work-log.json 的原始 JSON → 合并用的本机文件形状（节点已由域包收敛，这里只取数组） */
function sanitizeLocalWorkLog(raw: unknown): { version: number, entries: WorkLogFile['entries'], tombstones: WorkLogFile['tombstones'] } {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    version: 1,
    entries: Array.isArray(input.entries) ? input.entries as WorkLogFile['entries'] : [],
    tombstones: Array.isArray(input.tombstones) ? input.tombstones as WorkLogFile['tombstones'] : [],
  }
}
