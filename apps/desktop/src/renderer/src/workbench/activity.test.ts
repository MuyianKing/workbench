import type { AccountProfile } from '@/types'
/**
 * 活跃度的多机合并（`workbench/activity.ts`）：本机账本 + 同步仓库里别的机器那份。
 *
 * 盯两件事：
 *  1. 读回来的分片要合进界面（按天按来源求和）；
 *  2. **推上去的只有本机账本** —— 把别人的数写回本机文件，下一次推送就会两台机器互相翻倍。
 * 与 index.test.ts 同一套桩：跑在 node 环境里，导入前先补一个假的 Tauri 桥，
 * 每条用例 `vi.resetModules()` 重新导入（模块级的同步节流状态要清干净）。
 */
import { dayKey } from '@workbench/core'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const REPO = 'git@example.com:me/sync.git'
const REMOTE_DAY = '2026-10-30'
const ACCOUNT: AccountProfile = {
  provider: 'github',
  id: '1',
  login: 'muyian',
  name: 'MUYIAN',
  avatar: null,
}
/** 另一台机器推上来的那份：同一天五类里的两笔 */
const REMOTE_SHARD = {
  version: 1,
  device: 'dev-remote',
  activity: { [REMOTE_DAY]: { run: 5, note: 1 } },
}

/** 推上去的分片 */
let published: Array<Record<string, unknown>> = []
/** 读仓库分片的次数 */
let shardReads = 0

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        switch (command) {
          case 'data_load':
            return Promise.resolve({ settings: { tokenSyncRepo: REPO } })
          case 'theme_load':
            return Promise.resolve(null)
          case 'token_device':
            return Promise.resolve({ id: 'dev-local', name: '本机' })
          case 'activity_sync_publish':
            published.push(args ?? {})
            return Promise.resolve({ changed: true, pushed: true, log: '' })
          case 'activity_sync_shards':
            shardReads += 1
            return Promise.resolve([REMOTE_SHARD])
          default:
            return Promise.resolve(null)
        }
      },
    },
  }
})

/** 后台那轮同步不挡出数，断言前先把微任务排空（桩里全是已 resolve 的 promise） */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

async function boot(): Promise<void> {
  vi.resetModules()
  published = []
  shardReads = 0

  const state = await import('./state')
  await state.initState()
  state.setAccount(ACCOUNT)
}

describe('活跃度的多机合并', () => {
  it('别的机器那份合进界面，推上去的只有本机账本', async () => {
    await boot()
    const state = await import('./state')
    const activity = await import('./activity')

    state.recordActivity('run')
    state.recordActivity('run')

    const view = await activity.activityView(REPO)
    const today = dayKey(Date.now())
    expect(view.days[today]).toEqual({ run: 2 })
    expect(view.days[REMOTE_DAY]).toEqual({ run: 5, note: 1 })
    expect(view.total[REMOTE_DAY]).toBe(6)
    expect(shardReads).toBe(1)

    await flush()
    expect(published).toHaveLength(1)
    expect(published[0].repo).toBe(REPO)
    expect(published[0].device).toBe('dev-local')
    const shard = published[0].shard as { activity: Record<string, unknown> }
    expect(shard.activity[today]).toEqual({ run: 2 })
    // 别人的那几天不许混进本机分片：混进去下一轮就会被当成自己的再推上去
    expect(shard.activity[REMOTE_DAY]).toBeUndefined()
  })

  it('没配仓库 / 退出登录时只剩本机，也不推不读', async () => {
    await boot()
    const state = await import('./state')
    const activity = await import('./activity')
    state.recordActivity('run')

    const view = await activity.activityView('')
    const today = dayKey(Date.now())
    expect(view.days[today]).toEqual({ run: 1 })
    expect(view.days[REMOTE_DAY]).toBeUndefined()

    await flush()
    expect(shardReads).toBe(0)
    expect(published).toEqual([])
  })

  it('从同步切回本机时，之前读回来的那份立刻撤掉', async () => {
    await boot()
    const activity = await import('./activity')

    const merged = await activity.activityView(REPO)
    expect(merged.days[REMOTE_DAY]).toBeDefined()

    const local = await activity.activityView('')
    expect(local.days[REMOTE_DAY]).toBeUndefined()
  })
})
