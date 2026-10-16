/**
 * 密码保险库 store：自动同步这条链上「静默出问题」的几条。
 *
 * 同步改成自动之后，几件事都成了「不盯着就看不出来」的：并发触发会不会各推一轮、
 * 失败会不会只是没人说、换密钥时 `adoptKey` 留的墓碑会不会被自动推上去。
 * 挑的就是这几条。
 *
 * 跑在 node 环境里：`window.workbench` 用假桩（按方法名分发），`@/notify` 换成假的。
 * 真加解密不在这里测（那是 packages/vault 的单测），这里只关心「什么时候发起了同步」。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyError } from '@/notify'

vi.mock('@/notify', () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}))

/** 一轮 vaultSync 的收场开关：测试自己决定哪一轮什么时候返回（测「跑着的时候又来了」） */
let pendingSync: Array<() => void>
/** vaultSync 被调了几次 —— 自动同步的合并就看这个数 */
let syncCalls: number
/** 下一轮同步怎么收场 */
let syncFails: boolean
/** 本机密钥状态：`exists` / `unlocked` 决定走哪条路（新机器导入 / 已建库） */
let keyState: { exists: boolean, unlocked: boolean }
/** 导入密钥这个动作本身成不成功（用户取消时是 null） */
let importResult: unknown

function loaded(records: unknown[] = []) {
  return { ok: true, data: { records, unreadable: 0, dropped: 0, updatedAt: 0 } }
}

function syncOutcome() {
  if (syncFails)
    return { ok: false, error: '推送失败：远端拒绝了' }
  return { ok: true, data: { records: [], unreadable: 0, dropped: 0, updatedAt: 0, remoteItems: 0, rounds: 1, keyMismatch: false } }
}

function channels(): Record<string, unknown> {
  return {
    vaultKeyState: () => Promise.resolve({ ok: true, data: { exists: keyState.exists, unlocked: keyState.unlocked, fingerprint: 'AA' } }),
    vaultHello: () => Promise.resolve({ ok: true, data: 'available' }),
    vaultLoad: () => Promise.resolve(loaded()),
    vaultSync: () => {
      syncCalls += 1
      return new Promise(resolve => pendingSync.push(() => resolve(syncOutcome())))
    },
    vaultSaveEntry: (id: string, entry: unknown) => Promise.resolve({ ok: true, data: { ...(entry as object), id, updatedAt: 1, by: 'dev' } }),
    vaultRemoveEntry: () => Promise.resolve({ ok: true, data: null }),
    vaultImportKeyFile: () => {
      // 导入这件事在适配层里成功之后，那把密钥就已经在内存里了 —— 之后的密钥状态是「有、已解锁」
      if (importResult)
        keyState = { exists: true, unlocked: true }
      return Promise.resolve(importResult)
    },
  }
}

beforeEach(() => {
  pendingSync = []
  syncCalls = 0
  syncFails = false
  keyState = { exists: true, unlocked: true }
  importResult = { ok: true, data: { exists: true, unlocked: true, fingerprint: 'AA' } }

  const table = channels()
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false }),
    workbench: new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => {
        const name = String(key)
        if (name === 'getBootstrap')
          return () => null
        return table[name] ?? (() => Promise.resolve({ ok: true, data: {} }))
      },
    }),
  }
  ;(globalThis as { document?: unknown }).document = {
    documentElement: {
      dataset: {},
      classList: { toggle: () => {} },
      style: { setProperty: () => {}, removeProperty: () => {} },
    },
  }
  setActivePinia(createPinia())
})

// 桩必须在 import 之前就位，所以这里用动态导入
const { useVaultStore } = await import('./vault')
const { useSettingsStore } = await import('./settings')
const { useAuthStore } = await import('./auth')

/**
 * 让在途的 async 链跑完。轮次刻意压得低：这些 `setTimeout(0)` 在 Windows 上有十几毫秒的地板，
 * 攒起来会把同批跑的用例（`workbench/index.test.ts` 那几条真起 git 的重用例只有 5 秒）挤到超时。
 */
async function settle() {
  for (let i = 0; i < 6; i++)
    await new Promise(resolve => setTimeout(resolve, 0))
}

/** 登录 + 填了仓库地址 + 已解锁：同步的三个前提都齐了 */
async function bootReady() {
  useSettingsStore().settings.tokenSyncRepo = 'https://gitee.com/me/workbench-data.git'
  useAuthStore().status = {
    configured: true,
    configError: '',
    redirectUri: 'http://127.0.0.1:5274/callback',
    providers: ['gitee'],
    account: { provider: 'gitee', id: '1', login: 'me', name: 'me', avatar: null },
  }
  const store = useVaultStore()
  await store.init()
  await settle()
  return store
}

describe('保险库自动同步', () => {
  it('没登录或没填仓库地址时安静跳过，一次都不发', async () => {
    const store = useVaultStore()
    await store.init()
    await settle()
    store.sync()
    await settle()
    expect(syncCalls).toBe(0)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('一趟跑着的时候再来的请求合成一趟补跑，不并行推同一个基准', async () => {
    const store = await bootReady()

    store.sync()
    await settle()
    expect(syncCalls).toBe(1)

    // 跑着的时候又动了三条：只该记一个标记，等这一轮收场补一趟
    store.sync()
    store.sync()
    store.sync()
    await settle()
    expect(syncCalls).toBe(1)

    pendingSync.shift()!()
    await settle()
    expect(syncCalls).toBe(2)

    // 收场之后不再补：补过的那一趟已经把最后那条改动带上了
    pendingSync.shift()!()
    await settle()
    expect(syncCalls).toBe(2)
  })

  it('增删改之后各自动推一次', async () => {
    const store = await bootReady()

    expect(await store.saveEntry('id-1', { name: 'gitee', password: 'p', notes: '', group: '开发' })).toBe(true)
    expect(syncCalls).toBe(1)
    pendingSync.shift()!()
    await settle()

    await store.removeEntry('id-1')
    expect(syncCalls).toBe(2)
  })

  it('失败只在工具带上留一行（不弹消息），成功一个字都不留', async () => {
    const store = await bootReady()
    syncFails = true

    store.sync()
    pendingSync.shift()!()
    await settle()
    expect(store.syncFailed).toBe(true)
    expect(store.syncNote).toContain('推送失败')
    expect(notifyError).not.toHaveBeenCalled()

    syncFails = false
    store.sync()
    pendingSync.shift()!()
    await settle()
    expect(store.syncFailed).toBe(false)
    expect(store.syncNote).toBe('')
  })

  it('本机原来就有保险库时，导入密钥不自动推（adoptKey 留的墓碑不该自己铺开）', async () => {
    keyState = { exists: true, unlocked: true }
    const store = await bootReady()

    await store.importKeyFile()
    await settle()
    expect(syncCalls).toBe(0)
  })

  it('新机器上导入密钥之后顺手拉一次，不然用户看到的是个空库', async () => {
    keyState = { exists: false, unlocked: false }
    const store = await bootReady()

    await store.importKeyFile()
    await settle()
    expect(syncCalls).toBe(1)
  })
})
