import type { SyncDeviceInfo } from '@/types'
import { beforeAll, describe, expect, it } from 'vitest'
import { claimDevice, claimState, dismissClaim } from './device-claim'

/** invoke 调用流水：命令名 + 参数，按发生顺序记下来验「回灌先于改 id」 */
let calls: Array<{ command: string, args?: Record<string, unknown> }> = []
let failGatewayImport = false

function usageShard(device: string) {
  return { version: 6, device, name: device, updatedAt: 10, sources: { zcode: { days: {}, projects: {} } } }
}

function workLogShard(device: string) {
  return { version: 2, device, name: device, updatedAt: 10, entries: [], tombstones: [] }
}

const old: SyncDeviceInfo = { id: 'old-device', name: '旧机器', updatedAt: 10, theme: null }

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        calls.push({ command, args })
        switch (command) {
          case 'device_claim_state':
            return Promise.resolve({ id: 'new-device', fresh: true })
          case 'device_claim_dismiss':
            return Promise.resolve(null)
          case 'device_claim_set':
            return Promise.resolve(null)
          case 'device_claim_delete_shards':
            return Promise.resolve({ deleted: 2, changed: true, log: '', paths: [] })
          case 'gateway_sync_pull':
            return Promise.resolve({ changed: false })
          case 'token_sync_shards':
            return Promise.resolve({
              usage: [usageShard('old-device'), usageShard('another-device')],
              config: [{ device: 'old-device', name: '旧机器', theme: { version: 2, updatedAt: 5 } }],
            })
          case 'work_log_sync_pull':
            return Promise.resolve([workLogShard('old-device'), workLogShard('another-device')])
          case 'work_log_load':
            return Promise.resolve({ version: 2, entries: [], tombstones: [] })
          case 'etf_sync_pull':
            return Promise.resolve({ files: [] })
          case 'activity_sync_shards':
            return Promise.resolve([{ version: 1, device: 'old-device', activity: { '2026-01-01': { notes: 2 } } }])
          case 'data_load':
            return Promise.resolve({ activity: {} })
          case 'device_claim_import_gateway':
            if (failGatewayImport)
              return Promise.reject('网关回灌失败')
            return Promise.resolve(3)
          case 'device_claim_import_qoder':
            return Promise.resolve(1)
          case 'token_save':
          case 'theme_save':
          case 'work_log_save':
          case 'etf_save':
          case 'data_save':
            return Promise.resolve(null)
          default:
            return Promise.reject(`未预期的命令 ${command}`)
        }
      },
    },
  }
})

describe('设备认领适配层', () => {
  it('读状态与忽略都走 Result', async () => {
    const state = await claimState()
    expect(state.ok).toBe(true)
    expect(state.data?.fresh).toBe(true)
    const dismissed = await dismissClaim()
    expect(dismissed.ok).toBe(true)
  })

  it('按旧设备 id 回灌，改 id 在全部回灌之后，删分片用新 id', async () => {
    calls = []
    failGatewayImport = false
    const outcome = await claimDevice('git@host:sync.git', 'new-device', old)

    expect(outcome.ok).toBe(true)
    expect(outcome.error).toBe('')

    const names = calls.map(c => c.command)
    // 改 id 必须排在用量 / 外观 / 工作日志 / 活跃度 / 网关 / Qoder 之后
    const setAt = names.indexOf('device_claim_set')
    expect(setAt).toBeGreaterThan(names.indexOf('token_save'))
    expect(setAt).toBeGreaterThan(names.indexOf('theme_save'))
    expect(setAt).toBeGreaterThan(names.indexOf('work_log_save'))
    expect(setAt).toBeGreaterThan(names.indexOf('data_save'))
    expect(setAt).toBeGreaterThan(names.indexOf('device_claim_import_gateway'))
    expect(setAt).toBeGreaterThan(names.indexOf('device_claim_import_qoder'))
    // 删分片在改 id 之后，且删的是「新 id」
    const del = calls.find(c => c.command === 'device_claim_delete_shards')
    expect(names.indexOf('device_claim_delete_shards')).toBeGreaterThan(setAt)
    expect(del?.args?.device).toBe('new-device')

    // 改 id 写回的是旧 id
    const set = calls.find(c => c.command === 'device_claim_set')
    expect(set?.args?.id).toBe('old-device')

    // 恢复列表如实带回来
    expect(outcome.restored).toContain('用量')
    expect(outcome.restored).toContain('外观')
    expect(outcome.restored).toContain('工作日志')
    expect(outcome.restored).toContain('活跃度')

    // 用量/工作日志只写旧设备的分片，没写 another-device 的：看保存进去的 device
    const tokenSave = calls.find(c => c.command === 'token_save')
    expect((tokenSave?.args?.value as { device?: string })?.device).toBe('old-device')
  })

  it('单个域失败不阻断其余域与改 id', async () => {
    calls = []
    failGatewayImport = true
    const outcome = await claimDevice('git@host:sync.git', 'new-device', old)

    expect(outcome.ok).toBe(true)
    expect(outcome.error).toContain('网关流水')
    // 改 id 仍发生
    expect(calls.some(c => c.command === 'device_claim_set')).toBe(true)
    // 其它域照常恢复
    expect(outcome.restored).toContain('用量')
  })
})
