/**
 * 适配层的同步入口：**没登录就不该有任何一次推 / 拉**。
 *
 * 这条盯的是一类不会报错、只会静默越界的错误：仓库地址还留在设置里，某条通道忘了过
 * `syncRepo()`，于是没登录的机器照样往仓库推东西（见 workbench/index.ts）。
 * 与 token.test.ts 同一套桩：跑在 node 环境里，导入前先补一个假的 Tauri 桥，
 * 每条用例 `vi.resetModules()` 重新导入（模块级的同步节流状态要清干净）。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountProfile, WorkbenchApi } from '@shared/types'

const REPO = 'git@example.com:me/sync.git'
const ACCOUNT: AccountProfile = {
  provider: 'github',
  id: '1',
  login: 'muyian',
  name: 'MUYIAN',
  avatar: null
}

/** 推上去的那些 publish 调用 */
let published: Array<Record<string, unknown>> = []
/** 读仓库分片的次数 */
let shardReads = 0

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        switch (command) {
          // 设置里已经填了仓库地址：此时该不该同步，只看有没有登录
          case 'data_load':
            return Promise.resolve({ settings: { tokenSyncRepo: REPO } })
          case 'theme_load':
            return Promise.resolve(null)
          case 'token_device':
            return Promise.resolve({ id: 'dev-local', name: '本机' })
          case 'token_load':
            return Promise.resolve(null)
          case 'token_save':
            return Promise.resolve(null)
          // 四个来源各读一遍；都当「这台机器上没装」
          case 'token_zcode_rows':
            return Promise.resolve([])
          case 'token_codebuddy_files':
          case 'token_dsh_sessions':
          case 'token_workbuddy_sessions':
            return Promise.resolve({ found: false })
          case 'token_sync_publish':
            published.push(args ?? {})
            return Promise.resolve({ changed: true, pushed: true, log: '' })
          case 'token_sync_shards':
            shardReads += 1
            return Promise.resolve({ shards: [], configs: [] })
          default:
            return Promise.resolve(null)
        }
      }
    }
  }
})

/** 后台那轮自动同步不挡出数，断言前先把微任务排空（桩里全是已 resolve 的 promise） */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/**
 * 起一遍适配层，装好 `window.workbench`。
 *
 * 返回值只给类型看：**绝不能 `await` 这个 API 对象** —— 它是个 Proxy，未移植的通道
 * 一律回 `notPorted`，连 `.then` 都能取到一个函数，于是 `await` 会把它当 thenable 永远等下去。
 */
async function boot(account: AccountProfile | null): Promise<void> {
  vi.resetModules()
  published = []
  shardReads = 0

  const state = await import('./state')
  await state.initState()
  state.setAccount(account)

  const { installTauriWorkbench } = await import('./index')
  installTauriWorkbench()
}

/** 装完之后的 API（不 await 它，理由见 boot） */
function api(): WorkbenchApi {
  return window.workbench
}

describe('未登录时的同步入口', () => {
  it('取数不推也不读仓库，同步状态是关的', async () => {
    await boot(null)
    const result = await api().getTokenUsage()
    await flush()

    expect(result.ok).toBe(true)
    expect(published).toEqual([])
    expect(shardReads).toBe(0)
    expect(result.data?.sync.enabled).toBe(false)
  })

  it('手动同步与设备列表同样按「没填地址」处理', async () => {
    await boot(null)
    const result = await api().syncTokenUsage()
    await flush()

    expect(published).toEqual([])
    expect(shardReads).toBe(0)
    expect(result.data?.sync.enabled).toBe(false)
    expect(await api().listSyncDevices()).toEqual([])
  })
})

describe('登录之后的同步入口', () => {
  it('仓库地址照旧生效，推的是本机分片', async () => {
    await boot(ACCOUNT)
    const result = await api().getTokenUsage()
    await flush()

    expect(result.data?.sync.enabled).toBe(true)
    expect(published).toHaveLength(1)
    expect(published[0].repo).toBe(REPO)
    expect(published[0].device).toBe('dev-local')
  })
})
