import type { Result, ZentaoBug, ZentaoBugList, ZentaoSession } from '@/types'
import { fail } from '@workbench/core'
import { diffZentaoBugs, mergeZentaoUnread, sanitizeZentaoPollMinutes } from '@workbench/zentao'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { bugs as fetchBugs, session as fetchSession, onCheck, onOpened, openSite, watch as registerWatch, notify as sendNotify, login as zentaoLogin } from '@/workbench/zentao'
import { useSettingsStore } from './settings'

/**
 * 禅道：**只有后台检查与系统通知**。页面本身不在应用里打开 —— 顶栏那颗图标（与通知点击）
 * 直接交给系统浏览器（见 Rust 侧 zentao.rs 的 open_site），这一层不维护任何列表。
 *
 * **数据流**：设置里的检查间隔（`zentaoPollMinutes`，默认 30、0 = 关闭）→ 适配层登记给
 * Rust 的计时线程 → 到点发 `zentao:check` → 这一层取完整列表（分页聚合在 @workbench/zentao）、
 * 与上一轮**编号全集**比出新增 → 有新增才调 `zentaoNotify` 弹系统通知（点通知用浏览器打开禅道，
 * 那一下在 Rust 侧接）。取数间隔与新增判定放在这一侧，是因为窗口收进托盘后
 * WebView 的定时器会被节流 —— 计时必须由 Rust 醒，而分页与判定已经有带单测的域包。
 *
 * **基线（baselineIds）**：第一轮成功只记不报（否则「第一次打开」会把现有 Bug 全报成新增）；
 * 取数失败不推进基线（下一轮照旧能认出中间新增的）；比对的是编号全集而不是最大编号 ——
 * 旧 Bug 重新指派给我照样算新增，消失后再次出现也算。会话换账号或换部署时基线作废重立。
 *
 * **通知失败不吞**：待通知的那批留在 `pendingNotify` 里，下一轮后台检查时重发（成功才清），
 * 因此「弹一次没弹出去」不会变成「永远不知道」，也不会因为重试把同一批报两遍。
 * 失败原因留在 `error` 里（打开站点失败、或后台检查失败都往这里写，界面自己决定怎么说）。
 *
 * **未读角标**：后台比出的新增同时记进 `unreadIds`（落盘在设置的 `zentaoUnreadBugs`），
 * 顶栏那颗图标上的数字就是它的长度。应用看不到浏览器里读没读，所以**点开禅道**
 * （顶栏图标、或点系统通知让 Rust 打开站点）就算这批看过了 —— 清零并作废待发通知；
 * 当前列表里已经不存在的编号（解决了 / 改派了）自动掉出去。跨重启保留。
 */
const AUTH_PREFIX = 'ZENTAO_AUTH_EXPIRED:'

/** 通知只关心「指派给我的」：没有列表之后口径是固定的 */
const BROWSE = 'assigntome' as const

/** 会话身份：换账号 / 换部署之后既有的编号基线不再代表「我已经知道的那批」 */
function identityOf(session: ZentaoSession): string {
  return `${session.baseUrl}\n${session.account}`
}

/** 给用户看的一句话：认证过期的前缀是实现细节，界面上只留后半句 */
function readableError(message: string): string {
  if (!message.startsWith(AUTH_PREFIX))
    return message
  return message.slice(AUTH_PREFIX.length).trim() || '禅道登录已过期'
}

export const useZentaoStore = defineStore('zentao', () => {
  const settings = useSettingsStore()

  /** 只在后台链里用；界面不需要它（窗口里显示的是禅道自己的登录态） */
  let session: ZentaoSession | null = null

  /** 最近一次后台检查 / 通知失败的原因（页面头部落一行字；成功即清） */
  const error = ref('')

  /**
   * 未读角标：后台发现、还没点开禅道的那批 Bug 编号（顶栏那颗图标上的数字）。
   * 落盘在设置的 `zentaoUnreadBugs`（只本机、不参与外观同步）—— 重启后还在，
   * 直到用户点开禅道（顶栏图标或点系统通知）才清零；列表里消失的编号自动掉出去。
   */
  const unreadIds = ref<number[]>(settings.settings.zentaoUnreadBugs ?? [])
  const unread = computed(() => unreadIds.value.length)

  /** 点开禅道的时刻（毫秒）：比它更早开始取数的那一轮不再把已清零的编号加回来 */
  let clearedAt = 0

  /** 写回设置的队列（合并与清零谁后调用谁后落盘：回包乱序也不会互相覆盖） */
  let unreadWrite: Promise<unknown> = Promise.resolve()

  /** 落盘失败不打断后台链路：本地账本已经更新过，下一轮还会重写 */
  function commitUnread(next: number[]): void {
    unreadIds.value = next
    unreadWrite = unreadWrite
      .then(() => settings.updateSettings({ zentaoUnreadBugs: next }))
      .catch(() => {})
  }

  /**
   * 点开禅道 = 这批看过了：角标清零、待发的系统通知也作废（用户已经在看了，
   * 下一轮再弹一次只会吵）。取数途中那一轮由 clearedAt 拦住。
   */
  function clearUnread(): void {
    clearedAt = Date.now()
    pendingNotify = []
    if (unreadIds.value.length)
      commitUnread([])
  }

  /** 设置被回推（另一处改了、或重新载入）时跟上 */
  watch(
    () => settings.settings.zentaoUnreadBugs,
    (ids) => { unreadIds.value = [...ids] },
    { deep: true },
  )

  /** 两份编号清单一样吗（merge 的输出本来就降序去重，逐位比就够） */
  function sameIds(a: readonly number[], b: readonly number[]): boolean {
    return a.length === b.length && a.every((id, index) => id === b[index])
  }

  /** 上一轮成功取回的编号全集；null = 还没建立基线 */
  let baselineIds: number[] | null = null
  let baselineIdentity = ''
  /** 通知失败、等下一轮重发的新增（按编号去重，发成功才清） */
  let pendingNotify: ZentaoBug[] = []
  /** 在途的那一轮取数：后台检查与手动重试共用它，不各自开一轮 */
  let inFlight: Promise<void> | null = null
  /** 在途那一轮的序号：`finally` 里按它清 `inFlight`（不能在自己的初始化式里引用自己） */
  let runSeq = 0

  /** 登记的检查间隔（分钟，0 = 关闭）：收敛口径与后端同一条 */
  const pollMinutes = () => sanitizeZentaoPollMinutes(settings.settings.zentaoPollMinutes)

  /**
   * 认证并取一轮完整列表：本机已有会话就复用；过期（401）只重登一次再取，不循环。
   */
  async function fetchList(): Promise<Result<ZentaoBugList>> {
    if (!session) {
      const existing = await fetchSession()
      if (existing.ok && existing.data)
        session = existing.data
    }
    if (!session) {
      const loginResult = await zentaoLogin()
      if (!loginResult.ok || !loginResult.data)
        return fail(loginResult.error || '禅道登录失败')
      session = loginResult.data
    }
    const current = session
    let result = await fetchBugs(current.id, BROWSE)
    if (!result.ok && (result.error ?? '').startsWith(AUTH_PREFIX)) {
      session = null
      const loginResult = await zentaoLogin()
      if (!loginResult.ok || !loginResult.data)
        return fail(loginResult.error || '禅道重新登录失败')
      session = loginResult.data
      result = await fetchBugs(loginResult.data.id, BROWSE)
    }
    return result
  }

  /** 把这一轮结果并进状态：推进基线，有新增加进待发队列并立刻发一次 */
  async function applyResult(list: ZentaoBugList, startedAt: number): Promise<void> {
    const identity = session ? identityOf(session) : ''
    if (identity !== baselineIdentity) {
      baselineIds = null
      // 真的换了账号 / 部署才作废旧账：首次建立基线（baselineIdentity 还是空）要保留落盘的未读
      if (baselineIdentity)
        clearUnread()
      baselineIdentity = identity
      pendingNotify = []
    }
    const diff = diffZentaoBugs(baselineIds, list.bugs)
    baselineIds = diff.ids
    if (diff.added.length) {
      const seen = new Set(pendingNotify.map(bug => bug.id))
      for (const bug of diff.added) {
        if (!seen.has(bug.id))
          pendingNotify.push(bug)
      }
    }
    // 角标账本：点开禅道之前就开始取数的那一轮，不把已清零的编号加回来
    const addedIds = startedAt < clearedAt ? [] : diff.added.map(bug => bug.id)
    const next = mergeZentaoUnread(unreadIds.value, addedIds, diff.ids)
    if (!sameIds(next, unreadIds.value))
      commitUnread(next)
    await flushNotify()
  }

  /** 把待通知的那批发出去；失败就留着等下一轮，成功才清 */
  async function flushNotify(): Promise<void> {
    if (!session || !pendingNotify.length)
      return
    const first = pendingNotify[0]
    const result = await sendNotify(session.id, pendingNotify.length, first.title)
    if (!result.ok) {
      error.value = result.error || '发送系统通知失败'
      return
    }
    error.value = ''
    pendingNotify = []
  }

  /**
   * 跑一轮取数。失败照实记（页面头部落一行字）——用户切回页面时看到的原因
   * 就是最后一次检查失败的原因。
   */
  function runFetch(): Promise<void> {
    if (inFlight)
      return inFlight
    const seq = ++runSeq
    // 取数开始的那一刻：途中用户点开了禅道，这一轮的结果就不再补进未读账本
    const startedAt = Date.now()
    const task = (async () => {
      try {
        const result = await fetchList()
        if (!result.ok || !result.data) {
          error.value = readableError(result.error || '读取禅道 Bug 列表失败')
          return
        }
        error.value = ''
        await applyResult(result.data, startedAt)
      }
      finally {
        if (seq === runSeq)
          inFlight = null
      }
    })()
    inFlight = task
    return task
  }

  /** 后台线程到点：取数、比新增、必要时弹通知；关着（0）不发请求 */
  function checkInBackground(): void {
    if (pollMinutes() === 0)
      return
    void runFetch()
  }

  /**
   * 用系统浏览器打开禅道；返回错误文案（空串 = 成功）。
   * 顶栏那颗图标调它，失败时给一句提示。
   */
  async function open(): Promise<string> {
    const result = await openSite()
    if (result.ok) {
      error.value = ''
      // 站点已经交给浏览器：这批未读算「点开过」，角标清零
      clearUnread()
      return ''
    }
    error.value = result.error || '在浏览器中打开禅道失败'
    return error.value
  }

  /**
   * 起后台检查（App.vue 挂载时调一次）：订阅要**先挂上**、再登记周期 ——
   * Rust 在启用时会立刻发一次检查（那轮用来建立基线），订阅晚一步就漏掉了
   */
  let watchStarted = false
  function startWatch(): void {
    if (watchStarted)
      return
    watchStarted = true
    void onCheck(checkInBackground)
    // 系统通知被点、站点在浏览器里打开：同样算「看过了」，角标清零
    void onOpened(clearUnread)
    watch(
      () => pollMinutes(),
      (minutes) => {
        void registerWatch(minutes)
      },
      { immediate: true },
    )
  }

  return {
    error,
    unread,
    open,
    startWatch,
  }
})
