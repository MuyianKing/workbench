import type { WorkLogEntry, WorkLogFile, WorkLogShard, WorkLogTombstone } from '@workbench/work-log'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// 每条用例都要 resetModules 重新导入适配层（与 activity.test.ts 同一套桩）：
// 全量跑时机器一忙，这一条很容易撞默认的 5 秒超时，放宽到 20 秒（不是断言变松）
vi.setConfig({ testTimeout: 20_000 })

const REPO = 'git@example.com:me/sync.git'
const DEVICE = { id: 'dev-local', name: '本机' }

let localFile: WorkLogFile
let remoteShards: unknown[] = []
let saved: WorkLogFile[] = []
let published: Array<Record<string, unknown>> = []
let pulls = 0

function entry(
  id: string,
  updatedAt: number,
  by: string,
  overrides: Partial<WorkLogEntry> = {},
): WorkLogEntry {
  return {
    id,
    date: '2026-10-30',
    content: `内容 ${id}`,
    status: 'done',
    createdAt: updatedAt,
    updatedAt,
    by,
    ...overrides,
  }
}

function tombstone(id: string, updatedAt: number, by: string): WorkLogTombstone {
  return { id, updatedAt, by }
}

function shard(
  device: string,
  entries: WorkLogEntry[] = [],
  tombstones: WorkLogTombstone[] = [],
): WorkLogShard {
  return { version: 1, device, name: device, updatedAt: 0, entries, tombstones }
}

function file(entries: WorkLogEntry[] = [], tombstones: WorkLogTombstone[] = []): WorkLogFile {
  return { version: 2, entries, tombstones }
}

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        switch (command) {
          case 'work_log_load':
            return Promise.resolve(localFile)
          case 'work_log_save':
            saved.push(args?.value as WorkLogFile)
            return Promise.resolve()
          case 'token_device':
            return Promise.resolve(DEVICE)
          case 'work_log_sync_pull':
            pulls += 1
            return Promise.resolve(remoteShards)
          case 'work_log_sync_publish':
            published.push(args ?? {})
            return Promise.resolve({ changed: true, pushed: true, log: '' })
          default:
            return Promise.resolve(null)
        }
      },
    },
  }
})

async function boot(initial: WorkLogFile, remote: WorkLogShard[] = []): Promise<void> {
  vi.resetModules()
  localFile = initial
  remoteShards = remote
  saved = []
  published = []
  pulls = 0
}

describe('工作日志的多机同步', () => {
  it('拉回别的设备的条目、写回本机，再把合并后的分片推上去', async () => {
    await boot(file([entry('a', 100, 'dev-local')]), [
      shard('dev-remote', [entry('b', 200, 'dev-remote')]),
    ])
    const workLog = await import('./work-log')

    const result = await workLog.syncWorkLog(REPO, DEVICE)
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ enabled: true, changed: true, device: 'dev-local' })
    expect(result.data?.entries.map(item => item.id)).toEqual(['a', 'b'])
    // 设备清单：本机在第一位，分片带回来的名字原样交出去（切换器显示用）
    expect(result.data?.devices).toEqual([
      { id: 'dev-local', name: '本机' },
      { id: 'dev-remote', name: 'dev-remote' },
    ])

    // 合并结果要落回本机文件（与活跃度「只在内存」不同：条目可编辑）
    expect(saved).toHaveLength(1)
    expect(saved[0].entries.map(item => item.id)).toEqual(['a', 'b'])

    expect(published).toHaveLength(1)
    const shardSent = published[0].shard as WorkLogShard
    expect(published[0]).toMatchObject({ repo: REPO, device: 'dev-local' })
    expect(shardSent.entries.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('墓碑比远端旧条目新时仍然按删除算，不会被读回来复活', async () => {
    await boot(file([], [tombstone('x', 300, 'dev-local')]), [
      shard('dev-remote', [entry('x', 100, 'dev-remote')]),
    ])
    const workLog = await import('./work-log')

    const result = await workLog.syncWorkLog(REPO, DEVICE)
    expect(result.data?.entries).toEqual([])
    expect(result.data?.changed).toBe(false)
    expect(saved).toEqual([])

    const shardSent = published[0].shard as WorkLogShard
    expect(shardSent.entries).toEqual([])
    expect(shardSent.tombstones.map(item => item.id)).toEqual(['x'])
  })

  it('没配仓库时安静跳过：不拉、不推，本机条目照原样回来', async () => {
    await boot(file([entry('a', 100, 'dev-local')]))
    const workLog = await import('./work-log')

    const result = await workLog.syncWorkLog('', DEVICE)
    expect(result.data).toMatchObject({
      enabled: false,
      changed: false,
      devices: [{ id: 'dev-local', name: '本机' }],
    })
    expect(result.data?.entries.map(item => item.id)).toEqual(['a'])
    expect(pulls).toBe(0)
    expect(published).toEqual([])
  })

  it('删除本机条目：写进墓碑，下一轮同步带上', async () => {
    await boot(file([entry('a', 100, 'dev-local', { content: '要删的' })]))
    const workLog = await import('./work-log')

    const result = await workLog.removeWorkLog('a')
    expect(result.ok).toBe(true)

    expect(saved).toHaveLength(1)
    expect(saved[0].entries).toEqual([])
    expect(saved[0].tombstones).toEqual([
      expect.objectContaining({ id: 'a', by: 'dev-local' }),
    ])
    expect(saved[0].tombstones[0].updatedAt).toBeGreaterThan(100)
  })

  it('新增条目带上本机设备 id 与项目名', async () => {
    await boot(file())
    const workLog = await import('./work-log')

    const result = await workLog.addWorkLog({
      date: '2026-10-30',
      content: '新记录',
      projectId: 'p1',
      projectName: '项目甲',
    })
    expect(result.ok).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0].entries[0]).toMatchObject({
      content: '新记录',
      projectId: 'p1',
      projectName: '项目甲',
      by: 'dev-local',
    })
  })
})
