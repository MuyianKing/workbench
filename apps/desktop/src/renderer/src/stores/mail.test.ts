/**
 * 邮箱 store 的角标账本：后台事件 / 清单同步 / 本地读信三条路对同一个未读数。
 *
 * 挑的都是静默错账的场景：推广段与黑名单顶高角标、读完不减、慢半拍的轮询把旧数刷回来。
 * 跑在 node 环境里：`window.__TAURI__` 与 `window.workbench` 用假桩（invoke 按命令名分发，
 * 两个事件订阅各收住自己的处理器）。
 */
import type { MailUnreadPayload } from '@/types'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/types'

/** mail_list 的返回：每个用例自己布置这一份收件箱摘要 */
let listRows: Array<{
  uid: number
  subject: string
  from: string
  to: string
  date: string
  seen: boolean
  hasAttachment: boolean
}>
/** mail_set_seen 收到的参数（按顺序） */
let seenCalls: Array<Record<string, unknown>>
/** 后台监视推进来的处理器（store 在 startWatch 里挂上） */
let unreadHandler: ((payload: MailUnreadPayload) => void) | null

/** 假后端的「整份设置」：updateSettings 要回一份完整设置，store 直接拿它当新状态 */
let stubSettings: Record<string, unknown>

const ACCOUNT = {
  address: 'me@163.com',
  imapHost: 'imap.163.com',
  imapPort: 993,
  smtpHost: 'smtp.163.com',
  smtpPort: 465,
}

function summary(uid: number, subject: string, from: string, seen: boolean) {
  return {
    uid,
    subject,
    from,
    to: 'me@163.com',
    date: '2026-11-16 08:00:00',
    seen,
    hasAttachment: false,
  }
}

function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case 'mail_list':
      return Promise.resolve(listRows)
    case 'mail_set_seen':
      seenCalls.push({ ...args })
      return Promise.resolve(null)
    default:
      return Promise.resolve(null)
  }
}

beforeEach(() => {
  listRows = []
  seenCalls = []
  unreadHandler = null
  stubSettings = { ...DEFAULT_SETTINGS }

  const event = {
    listen: () => Promise.resolve(() => {}),
  }
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false }),
    __TAURI__: { core: { invoke }, event },
    workbench: new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => {
        if (key === 'getBootstrap')
          return () => null
        if (key === 'onMailUnread') {
          return (handler: (payload: MailUnreadPayload) => void) => {
            unreadHandler = handler
            return () => {}
          }
        }
        if (key === 'onMailNotifyClick')
          return () => () => {}
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
const { useMailStore } = await import('./mail')
const { useSettingsStore } = await import('./settings')

/** 让在途的 async 链跑完：一串 await 与回调要几个宏任务才落地（`setImmediate` 没有 Windows 那 15.6ms 的定时器地板） */
async function settle() {
  for (let i = 0; i < 12; i++)
    await new Promise(resolve => setImmediate(resolve))
}

/** 模拟 Rust 的后台推包（没订阅就直接失败，别让用例悄悄空转） */
function sendUnread(payload: MailUnreadPayload): void {
  if (!unreadHandler)
    throw new Error('store 没有订阅 mail:unread')
  unreadHandler(payload)
}

describe('邮箱角标', () => {
  it('后台推来的未读按账户记账：推广段与黑名单发件人不计入', async () => {
    const settings = useSettingsStore()
    settings.settings.mailAccounts = [ACCOUNT]
    const store = useMailStore()
    store.startWatch()
    expect(unreadHandler).toBeTypeOf('function')

    sendUnread({
      // 比任何本地改动都新的一轮
      checkedAt: Math.floor(Date.now() / 1000) + 5,
      accounts: [{
        address: ACCOUNT.address,
        mails: [
          { uid: 1, subject: '项目排期', from: '张三 <zhang@corp.com>' },
          { uid: 2, subject: '促销 双11 狂欢', from: 'shop@jd.com' },
          { uid: 3, subject: '账单确认', from: 'boss@corp.com' },
        ],
      }],
    })
    expect(store.unread).toBe(2)

    // 用户把这封标成广告：角标立刻跟着掉（不用等下一轮轮询）
    settings.settings.mailBulkSenders = ['boss@corp.com']
    await settle()
    expect(store.unread).toBe(1)
  })

  it('进页面拉清单重建账本；标已读递减、标回未读加回', async () => {
    const settings = useSettingsStore()
    settings.settings.mailAccounts = [ACCOUNT]
    const store = useMailStore()
    listRows = [
      summary(1, '项目排期', 'zhang@corp.com', false),
      summary(2, '已读的信', 'li@corp.com', true),
      summary(3, '大促 狂欢', 'shop@jd.com', false),
    ]
    await store.refreshList()
    expect(store.unread).toBe(1)

    const read = await store.markSeen({ folder: 'inbox', account: ACCOUNT.address, uid: 1 }, true)
    expect(read.ok).toBe(true)
    expect(seenCalls).toHaveLength(1)
    expect(store.unread).toBe(0)

    const unread = await store.markSeen({ folder: 'inbox', account: ACCOUNT.address, uid: 1 }, false)
    expect(unread.ok).toBe(true)
    expect(store.unread).toBe(1)
  })

  it('比本地改动更早开始取数的后台结果整批丢掉，新的照常采用', async () => {
    const settings = useSettingsStore()
    settings.settings.mailAccounts = [ACCOUNT]
    const store = useMailStore()
    store.startWatch()
    listRows = [summary(1, '项目排期', 'zhang@corp.com', false)]
    await store.refreshList()
    expect(store.unread).toBe(1)

    // 这一轮在清单同步之前就开始了：它看不到刚才的读信动作，整批作废
    sendUnread({
      checkedAt: Math.floor((Date.now() - 60_000) / 1000),
      accounts: [{
        address: ACCOUNT.address,
        mails: [
          { uid: 1, subject: '项目排期', from: 'zhang@corp.com' },
          { uid: 2, subject: '旧快照里的新信', from: 'li@corp.com' },
        ],
      }],
    })
    await settle()
    expect(store.unread).toBe(1)

    // 比本地改动新的一轮：照常采用
    sendUnread({
      checkedAt: Math.floor(Date.now() / 1000) + 60,
      accounts: [{
        address: ACCOUNT.address,
        mails: [
          { uid: 1, subject: '项目排期', from: 'zhang@corp.com' },
          { uid: 2, subject: '新到的信', from: 'li@corp.com' },
        ],
      }],
    })
    await settle()
    expect(store.unread).toBe(2)
  })
})
