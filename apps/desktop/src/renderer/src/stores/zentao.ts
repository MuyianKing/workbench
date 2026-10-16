import type { ZentaoBugDiff } from '@workbench/zentao'
import type { Result, ZentaoBrowse, ZentaoBug, ZentaoBugList, ZentaoSession } from '@/types'
import { fail } from '@workbench/core'
import { diffZentaoBugs, sanitizeZentaoPollMinutes, zentaoBugUrl } from '@workbench/zentao'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { bugs as fetchBugs, session as fetchSession, onCheck, onNotifyClick, watch as registerWatch, notify as sendNotify, login as zentaoLogin } from '@/workbench/zentao'
import { useNavStore } from './nav'
import { useSettingsStore } from './settings'
/**
 * 禅道页与后台检查的状态。
 *
 * **数据流**：设置里的检查间隔（`zentaoPollMinutes`，默认 30、0 = 关闭）→ 适配层登记给
 * Rust 的计时线程 → 到点发 `zentao:check` → 这一层取完整列表（分页聚合在 @workbench/zentao）、
 * 与上一轮**编号全集**比出新增 → 有新增才调 `zentaoNotify` 弹系统通知（点击唤出主窗口并切回本页）。
 * 取数间隔与新增判定放在这一侧，是因为窗口收进托盘后 WebView 的定时器会被节流 ——
 * 计时必须由 Rust 醒，而分页与判定已经有带单测的域包，不在 Rust 里重写一份。
 *
 * **只看列表，不开详情**：Bug 的正文与历史都在禅道页面里看 —— 点标题交给系统浏览器
 * （`zentaoBugUrl` 只造站内链接，见 openBug）。改动禅道数据同样在浏览器里做。
 *
 * **基线（baselineIds）**：第一轮成功只记不报（否则「第一次打开」会把现有 Bug 全报成新增）；
 * 取数失败不推进基线（下一轮照旧能认出中间新增的）；比对的是编号全集而不是最大编号 ——
 * 旧 Bug 重新指派给我照样算新增，消失后再次出现也算。会话换账号或换部署时基线作废重立。
 *
 * **通知失败不吞**：待通知的那批留在 `pendingNotify` 里，下一轮后台检查时重发（成功才清），
 * 因此「弹一次没弹出去」不会变成「永远不知道」，也不会因为重试把同一批报两遍。
 * 手动刷新只更新列表与基线、不弹通知：用户既然已经看见列表了，再弹一条只是噪声。
 */
const AUTH_PREFIX = 'ZENTAO_AUTH_EXPIRED:'

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

  const session = ref<ZentaoSession | null>(null)
  const bugList = ref<ZentaoBugList | null>(null)
  /** 手动取数 / 首次进页面的转圈；后台检查不碰它（不打扰界面） */
  const loading = ref(false)
  const error = ref('')
  /** 列表取回来了、但系统通知没发出去（下一轮后台检查会重试） */
  const notifyError = ref('')

  /** 列表口径：指派给我的 / 未解决 / 未关闭（切换即重取） */
  const browse = ref<ZentaoBrowse>('assigntome')

  /** 上一轮成功取回的编号全集；null = 还没建立基线 */
  let baselineIds: number[] | null = null
  let baselineIdentity = ''
  /** 通知失败、等下一轮重发的新增（按编号去重，发成功才清） */
  let pendingNotify: ZentaoBug[] = []
  /** 在途的那一轮取数：后台检查、进页面与手动刷新共用它，不各自开一轮 */
  let inFlight: Promise<void> | null = null
  /** 在途那一轮的序号：`finally` 里按它清 `inFlight`（不能在自己的初始化式里引用自己） */
  let runSeq = 0

  /** 登记的检查间隔（分钟，0 = 关闭）：收敛口径与后端同一条 */
  const pollMinutes = () => sanitizeZentaoPollMinutes(settings.settings.zentaoPollMinutes)

  /**
   * 认证并取一轮完整列表：本机已有会话就复用；过期（401）只重登一次再取，不循环。
   */
  async function fetchList(): Promise<Result<ZentaoBugList>> {
    if (!session.value) {
      const existing = await fetchSession()
      if (existing.ok && existing.data)
        session.value = existing.data
    }
    if (!session.value) {
      const loginResult = await zentaoLogin()
      if (!loginResult.ok || !loginResult.data)
        return fail(loginResult.error || '禅道登录失败')
      session.value = loginResult.data
    }
    const current = session.value
    let result = await fetchBugs(current.id, browse.value)
    if (!result.ok && (result.error ?? '').startsWith(AUTH_PREFIX)) {
      session.value = null
      const loginResult = await zentaoLogin()
      if (!loginResult.ok || !loginResult.data)
        return fail(loginResult.error || '禅道重新登录失败')
      session.value = loginResult.data
      result = await fetchBugs(loginResult.data.id, browse.value)
    }
    return result
  }

  /** 把这一轮结果并进状态：推进基线，后台那一轮再顺手把新增通知出去 */
  async function applyResult(list: ZentaoBugList, background: boolean): Promise<void> {
    const current = session.value
    const identity = current ? identityOf(current) : ''
    if (identity !== baselineIdentity) {
      baselineIds = null
      baselineIdentity = identity
      pendingNotify = []
    }
    const diff: ZentaoBugDiff = diffZentaoBugs(baselineIds, list.bugs)
    bugList.value = list
    baselineIds = diff.ids
    if (!background)
      return
    if (diff.added.length) {
      const seen = new Set(pendingNotify.map(bug => bug.id))
      for (const bug of diff.added) {
        if (!seen.has(bug.id))
          pendingNotify.push(bug)
      }
    }
    await flushNotify()
  }

  /** 把待通知的那批发出去；失败就留着等下一轮，成功才清 */
  async function flushNotify(): Promise<void> {
    const current = session.value
    if (!current || !pendingNotify.length)
      return
    const first = pendingNotify[0]
    const result = await sendNotify(current.id, pendingNotify.length, first.title)
    if (!result.ok) {
      notifyError.value = result.error || '发送系统通知失败'
      return
    }
    notifyError.value = ''
    pendingNotify = []
  }

  /**
   * 跑一轮取数。`background` 为真时是后台检查：不转圈、失败照实记 ——
   * 用户回到页面时看到的原因就是最后一次检查失败的原因。
   */
  function runFetch(background: boolean): Promise<void> {
    if (inFlight)
      return inFlight
    const seq = ++runSeq
    const task = (async () => {
      try {
        const result = await fetchList()
        if (!result.ok || !result.data) {
          error.value = readableError(result.error || '读取禅道 Bug 列表失败')
          return
        }
        error.value = ''
        await applyResult(result.data, background)
      }
      finally {
        if (seq === runSeq)
          inFlight = null
      }
    })()
    inFlight = task
    return task
  }

  /** 进页面 / 手动刷新：转圈，等的是同一轮在途取数（后台那轮在跑就不另开一条） */
  async function refresh(): Promise<void> {
    loading.value = true
    try {
      await runFetch(false)
    }
    finally {
      loading.value = false
    }
  }

  /** 进页面时调：已经有列表或已经有一轮在跑就不重复请求（KeepAlive 切回也不重拉） */
  function ensureLoaded(): void {
    if (bugList.value || inFlight)
      return
    void refresh()
  }

  /** 后台线程到点：取数、比新增、必要时弹通知；关着（0）不发请求 */
  function checkInBackground(): void {
    if (pollMinutes() === 0)
      return
    void runFetch(true)
  }

  /** 打开禅道：不带 bug 就开部署首页，带了就开那条 Bug 的页面（正文与历史都在那边看） */
  async function openBug(bug?: ZentaoBug): Promise<void> {
    const current = session.value
    if (!current)
      return
    try {
      const url = bug ? zentaoBugUrl(current.baseUrl, bug.id) : current.baseUrl
      const result = await window.workbench.openExternal(url)
      if (!result.ok)
        error.value = result.error || '打开禅道失败'
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '打开禅道失败'
    }
  }

  /** 切列表口径：不一样才重取（指派给我的 / 未解决 / 未关闭） */
  function setBrowse(next: ZentaoBrowse): void {
    if (browse.value === next)
      return
    browse.value = next
    baselineIds = null
    bugList.value = null
    void refresh()
  }

  /**
   * 起后台检查（App.vue 挂载时调一次）：订阅要**先挂上**、再登记周期 ——
   *  Rust 在启用时会立刻发一次检查（那轮用来建立基线），订阅晚一步就漏掉了
   */
  let watchStarted = false
  function startWatch(): void {
    if (watchStarted)
      return
    watchStarted = true
    void (async () => {
      await onCheck(checkInBackground)
      onNotifyClick(() => {
        const nav = useNavStore()
        void nav.setActiveView('zentao')
      })
      let registered = -1
      watch(
        () => pollMinutes(),
        (minutes) => {
          if (minutes === registered)
            return
          registered = minutes
          void registerWatch(minutes)
        },
        { immediate: true },
      )
    })()
  }

  return {
    session,
    bugList,
    loading,
    error,
    notifyError,
    browse,
    setBrowse,
    refresh,
    ensureLoaded,
    startWatch,
    openBug,
  }
})
