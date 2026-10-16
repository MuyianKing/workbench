/**
 * 禅道 store：后台检查这条链上「改坏了不报错」的几条。
 *
 * 挑的都是静默失效类的问题：首轮把存量 Bug 全报成新增、取数失败却推进基线、
 * 手动刷新也弹通知、通知发失败被吞掉不再重试、订阅晚于登记而漏掉启用时那一轮。
 *
 * 跑在 node 环境里：`window.__TAURI__` 用假桩（`invoke` 按命令名分发、
 * `event.listen` 收住事件处理器），`@/notify` 换成假的（底下是 Element Plus）。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@/types'

vi.mock('@/notify', () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}))

/** 每一轮后端返回的 Bug 列表：逐轮换内容，模拟后台拿到的新结果 */
let rounds: Array<{ ok: boolean, bugs: unknown[] }>
let roundIndex = 0
/** zentao_notify 收到的每一次调用（sessionId, count, title） */
let notifyCalls: Array<[string, number, string]>
/** zentao_notify 是否失败（测「失败留待下轮重试」） */
let notifyFails = false
/** 已登记的检查 / 点击事件处理器（适配层的 listen 会把 Tauri 的 { payload } 转一手） */
let checkHandlers: Array<(event: { payload: null }) => void>
let clickHandlers: Array<(event: { payload: null }) => void>
/** zentao_watch 收到的周期（按顺序） */
let watchRegistrations: number[]
let logins: number
/** 每次列页请求带的口径（断言切筛选真的换了 browse） */
let pageBrowses: string[]
/** 产品名补取过的编号 */
let productNameCalls: number[]
/** zentao_login 的返回值：模拟「重登后换了账号」 */
let loginOverride: unknown
/** 让下一次取数报「认证过期」，逼 store 重登 */
let authExpiresOnce = false

/** 假后端的「整份设置」：updateSettings 要回一份完整设置，store 直接拿它当新状态 */
let stubSettings: Record<string, unknown>

const SESSION = { id: 'session-1', baseUrl: 'https://zentao.example/zentao', account: 'alice' }

function bug(id: number, title = `Bug ${id}`) {
  return { id, title, status: 'active', severity: 2, pri: 1, openedDate: '2026-10-15 08:00:00', assignedTo: 'alice' }
}

function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case 'zentao_session':
      return Promise.resolve(null)
    case 'zentao_login':
      logins += 1
      return Promise.resolve(loginOverride ?? SESSION)
    case 'zentao_watch':
      watchRegistrations.push(Number(args?.pollMinutes))
      return Promise.resolve(null)
    case 'zentao_notify':
      notifyCalls.push([String(args?.sessionId), Number(args?.count), String(args?.title)])
      return notifyFails ? Promise.reject('通知渠道不可用') : Promise.resolve(null)
    // 禅道的 /v1/products 在本部署下是空的：产品清单由后端从账号资料取，且只给 id
    case 'zentao_products':
      return Promise.resolve({ page: 1, total: 1, limit: 1, products: [{ id: 7 }] })
    case 'zentao_product':
      productNameCalls.push(Number(args?.productId))
      return Promise.resolve({ id: args?.productId, name: '产品甲' })
    case 'zentao_page': {
      pageBrowses.push(String(args?.browse))
      const round = rounds[Math.min(roundIndex, rounds.length - 1)]
      roundIndex += 1
      if (authExpiresOnce) {
        authExpiresOnce = false
        return Promise.reject('ZENTAO_AUTH_EXPIRED:登录已失效')
      }
      if (!round || !round.ok)
        return Promise.reject('连接禅道失败，请检查地址与网络')
      return Promise.resolve({ bugs: round.bugs, page: 1, total: round.bugs.length, limit: 100 })
    }
    default:
      return Promise.resolve(null)
  }
}

beforeEach(() => {
  rounds = []
  roundIndex = 0
  notifyCalls = []
  notifyFails = false
  checkHandlers = []
  clickHandlers = []
  watchRegistrations = []
  logins = 0
  pageBrowses = []
  productNameCalls = []
  loginOverride = null
  authExpiresOnce = false
  stubSettings = { ...DEFAULT_SETTINGS }

  const event = {
    listen: (name: string, handler: (event: { payload: null }) => void) => {
      if (name === 'zentao:check')
        checkHandlers.push(handler)
      if (name === 'zentao:notify-click')
        clickHandlers.push(handler)
      return Promise.resolve(() => {})
    },
  }
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false }),
    __TAURI__: { core: { invoke }, event },
    // 其余通道兜底（settings store 建好就会推程序名、跟一次背景图之类）；
    // updateSettings 必须回一份**完整**设置 —— store 直接拿它当新状态，
    // 缺字段（如 hiddenViews）会让其它 store 的 watch 抛错
    workbench: new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => {
        if (key === 'getBootstrap')
          return () => null
        if (key === 'updateSettings') {
          return (patch: Record<string, unknown>) => {
            stubSettings = { ...stubSettings, ...patch }
            return Promise.resolve({ ok: true, data: stubSettings })
          }
        }
        return () => Promise.resolve({ ok: true, data: {} })
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
const { useZentaoStore } = await import('./zentao')
const { useSettingsStore } = await import('./settings')

/** 让在途的 async 链跑完：一串 await 与回调要几个宏任务才落地 */
async function settle() {
  for (let i = 0; i < 12; i++)
    await new Promise(resolve => setTimeout(resolve, 0))
}

async function bootStore() {
  const store = useZentaoStore()
  store.startWatch()
  await settle()
  return store
}

describe('禅道后台检查', () => {
  it('启动登记周期，且订阅先于登记（启用时那轮用来立基线，不能漏）', async () => {
    const settings = useSettingsStore()
    settings.settings.zentaoPollMinutes = 30
    const store = await bootStore()
    expect(checkHandlers).toHaveLength(1)
    expect(clickHandlers).toHaveLength(1)
    expect(watchRegistrations).toEqual([30])

    rounds = [{ ok: true, bugs: [bug(1), bug(2)] }]
    checkHandlers[0]({ payload: null })
    await settle()
    expect(store.bugList?.bugs.map(b => b.id)).toEqual([2, 1])
    // 首次建立基线，不弹通知
    expect(notifyCalls).toEqual([])
    expect(logins).toBe(1)
  })

  it('新增才通知：旧编号重新指派也算，且汇总条数与首条标题', async () => {
    const store = await bootStore()
    rounds = [{ ok: true, bugs: [bug(1)] }]
    checkHandlers[0]({ payload: null })
    await settle()
    expect(notifyCalls).toEqual([])

    // 老编号 1 还在，新增 2、5；列表按编号降序，通知正文取排最前的那条（编号最大的新增）
    rounds = [{ ok: true, bugs: [bug(1), bug(2), bug(5)] }]
    checkHandlers[0]({ payload: null })
    await settle()
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0][0]).toBe('session-1')
    expect(notifyCalls[0][1]).toBe(2)
    expect(notifyCalls[0][2]).toBe('Bug 5')
    expect(store.bugList?.bugs.map(b => b.id)).toEqual([5, 2, 1])
  })

  it('取数失败不推进基线：下一轮仍能认出中间新增的', async () => {
    const store = await bootStore()
    rounds = [{ ok: true, bugs: [bug(1)] }]
    checkHandlers[0]({ payload: null })
    await settle()

    rounds = [{ ok: false, bugs: [] }]
    checkHandlers[0]({ payload: null })
    await settle()
    expect(notifyCalls).toEqual([])
    expect(store.error).toContain('禅道')

    rounds = [{ ok: true, bugs: [bug(1), bug(2)] }]
    checkHandlers[0]({ payload: null })
    await settle()
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0][1]).toBe(1)
  })

  it('手动刷新只更新列表与基线，不弹通知', async () => {
    const store = await bootStore()
    rounds = [{ ok: true, bugs: [bug(1)] }]
    await store.refresh()
    expect(notifyCalls).toEqual([])

    rounds = [{ ok: true, bugs: [bug(1), bug(2)] }]
    await store.refresh()
    expect(store.bugList?.bugs.map(b => b.id)).toEqual([2, 1])
    expect(notifyCalls).toEqual([])
  })

  it('通知发失败留着下轮重试，且成功时不会把同一批报两遍', async () => {
    const store = await bootStore()
    rounds = [{ ok: true, bugs: [bug(1)] }]
    checkHandlers[0]({ payload: null })
    await settle()

    notifyFails = true
    rounds = [{ ok: true, bugs: [bug(1), bug(2)] }]
    checkHandlers[0]({ payload: null })
    await settle()
    expect(notifyCalls).toHaveLength(1)
    expect(store.notifyError).toBe('通知渠道不可用')

    // 下一轮：没有新 Bug，但待发的那批还在 —— 重试一次
    notifyFails = false
    checkHandlers[0]({ payload: null })
    await settle()
    expect(notifyCalls).toHaveLength(2)
    expect(notifyCalls[1][1]).toBe(1)
    expect(store.notifyError).toBe('')

    // 再一轮：已经发过了，不再重复
    checkHandlers[0]({ payload: null })
    await settle()
    expect(notifyCalls).toHaveLength(2)
  })

  it('间隔设成 0 就不再后台取数', async () => {
    const settings = useSettingsStore()
    const store = await bootStore()
    settings.settings.zentaoPollMinutes = 0
    await settle()
    rounds = [{ ok: true, bugs: [bug(1)] }]
    checkHandlers[0]({ payload: null })
    await settle()
    expect(store.bugList).toBeNull()
    expect(notifyCalls).toEqual([])
  })

  it('通知点击切到禅道页', async () => {
    await bootStore()
    const { useNavStore } = await import('./nav')
    const nav = useNavStore()
    // 点击监听经适配层的 listen 转一手，事件处理器按 Tauri 的形状收 { payload }
    clickHandlers[0]({ payload: null })
    // setActiveView 同步应用视图（落盘是随后的异步），这里不等 —— 免得落桩把设置冲掉
    expect(nav.activeView).toBe('zentao')
  })

  it('取数在途时并发调用共用同一轮，不各开一条', async () => {
    const store = await bootStore()
    rounds = [{ ok: true, bugs: [bug(1)] }]
    await Promise.all([store.refresh(), store.refresh()])
    // 一次完整取数只读一个 Bug 页：并发两条若各开一轮会是两倍
    expect(roundIndex).toBe(1)
    expect(notifyCalls).toEqual([])
  })
})

describe('禅道列表口径与换账号', () => {
  it('切列表口径会重取，并把 browse 带下去', async () => {
    const store = await bootStore()
    rounds = [{ ok: true, bugs: [bug(1)] }]
    await store.refresh()
    expect(pageBrowses).toContain('assigntome')

    pageBrowses = []
    rounds = [{ ok: true, bugs: [bug(2), bug(1)] }]
    store.setBrowse('unresolved')
    await settle()
    expect(store.browse).toBe('unresolved')
    expect(pageBrowses).toContain('unresolved')
    expect(store.bugList?.bugs.map(b => b.id)).toEqual([2, 1])
  })

  it('换账号重登后基线重立：那一轮不把新账号的存量报成新增', async () => {
    const store = await bootStore()
    rounds = [{ ok: true, bugs: [bug(5)] }]
    await store.refresh()

    // 认证过期 → 重登，回来的却是另一个账号：基线作废，重新建立
    authExpiresOnce = true
    loginOverride = { id: 'session-2', baseUrl: SESSION.baseUrl, account: 'bob' }
    rounds = [{ ok: true, bugs: [bug(9)] }]
    checkHandlers[0]({ payload: null })
    await settle()
    expect(store.session?.account).toBe('bob')
    expect(store.bugList?.bugs.map(b => b.id)).toEqual([9])
    expect(notifyCalls).toEqual([])
  })
})
