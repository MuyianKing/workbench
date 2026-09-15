/**
 * 账号登录的适配层。
 *
 * 换 token、回环监听、凭据落盘全在 Rust 侧（`src-tauri/src/oauth.rs` 与 `credentials.rs`）。
 * 这一层只做三件事：驱动轮询节奏、把账号资料写进持久化数据、启动时和凭据管理器对账。
 *
 * **token 不会经过这里**：它从授权码换出来之后直接落在 Windows 凭据管理器里，
 * 只有昵称头像这类显示用的东西会回到渲染层。
 */
import { AUTH_PROVIDERS, sanitizeAccount } from '@shared/auth'
import { fail, ok } from '@shared/result'
import type {
  AccountProfile,
  AuthProvider,
  AuthStatus,
  LoginOutcome,
  LoginPoll,
  LoginStart,
  Result
} from '@shared/types'
import { guard, invoke } from './bridge'
import * as state from './state'

/**
 * 轮询间隔。Rust 侧每收一次回调是非阻塞的（没等到就立刻回 pending），
 * 所以节奏完全由这里定：太快是白费 IPC，太慢是用户授权完了还盯着界面发呆。
 */
const POLL_INTERVAL_MS = 1200

/**
 * 进行中的登录编号。
 *
 * 取消、重新发起、登录完成都会让它 +1，正在跑的轮询循环下一轮发现编号变了就自己退出 ——
 * 比在循环里塞一堆布尔标志清楚，也不会出现两个循环同时对着一个会话说话。
 */
let session = 0

/**
 * 最近一次成功的结果。
 *
 * 等待循环发现编号被改掉时要能分清「是被取消了」还是「手动粘贴那条路先拿到了结果」，
 * 光看编号分不出来，所以成功时在这里留一份。取消会把它清掉。
 */
let finished: AccountProfile | null = null

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 凭据管理器是「是否已登录」的权威来源，数据文件里那份资料只是显示用的缓存。
 *
 * 两边对不上就说明凭据已经没了（在控制面板里手工删掉、换了 Windows 用户…），
 * 这时把残留资料一并清掉 —— 否则界面会显示一个其实已经不能用的账号。
 */
function reconcile(status: AuthStatus): AccountProfile | null {
  const stored = state.account()
  if (!stored) return null
  if (status.providers.includes(stored.provider)) return stored

  state.setAccount(null)
  return null
}

/**
 * `settle` 只会给出这两档 —— 它不会「取消」，取消是等待循环那边的事。
 * 收紧返回类型是为了调用方不必再排一次 cancelled。
 */
type SettledLogin =
  | { status: 'ok'; account: AccountProfile }
  | { status: 'failed'; error: string }

/** 收下一次结果，成功时落资料 */
async function settle(poll: LoginPoll): Promise<SettledLogin> {
  if (poll.status !== 'ok') return { status: 'failed', error: poll.error ?? '登录未完成' }

  const account = sanitizeAccount(poll.account)
  if (!account) return { status: 'failed', error: '登录回包不完整，请重试' }

  // 一次只保留一个账号：这一层的用途是授权同步仓库，同时登录两家不会多出能力，
  // 反而让界面要回答「现在到底是哪个账号」。换账号时顺手把上一个清掉，
  // 免得凭据管理器里留着一个界面上看不见、也无从退出的 token。
  for (const other of AUTH_PROVIDERS) {
    if (other !== account.provider) {
      await guard<null>(invoke('auth_logout', { provider: other }), '清理上一个账号失败')
    }
  }

  state.setAccount(account)
  finished = account
  // 结束可能还在跑的等待循环
  session += 1
  return { status: 'ok', account }
}

/** 轮询到出结果为止 */
async function waitForCallback(): Promise<LoginOutcome> {
  const mine = ++session
  finished = null

  for (;;) {
    await delay(POLL_INTERVAL_MS)

    if (mine !== session) {
      // 会话被别人结束了：要么是取消，要么是「手动粘贴」先拿到了结果
      return finished ? { status: 'ok', account: finished } : { status: 'cancelled' }
    }

    let poll: LoginPoll
    try {
      poll = await invoke<LoginPoll>('auth_login_poll')
    } catch (error) {
      // 轮询本身出错（后端异常）就别继续空转了
      if (mine === session) await cancel()
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : '登录状态查询失败'
      }
    }

    if (poll.status === 'pending') continue
    return await settle(poll)
  }
}

/** 读取登录状态，并对账一次残留资料（只读凭据管理器，不联网） */
export async function authStatus(): Promise<AuthStatus> {
  const status = await invoke<AuthStatus>('auth_status')
  return { ...status, account: reconcile(status) }
}

/** 重新拉一次账号资料（联网）；账号弹窗打开时调用，头像改了就能看到 */
export async function refreshAccount(provider: AuthProvider): Promise<Result<AccountProfile>> {
  const result = await guard<unknown>(
    invoke('auth_refresh_account', { provider }),
    '刷新账号信息失败'
  )
  if (!result.ok) return fail(result.error ?? '刷新账号信息失败')

  const account = sanitizeAccount(result.data)
  if (!account) return fail('账号信息不完整，请重新登录')

  state.setAccount(account)
  return ok(account)
}

/**
 * 走完一次登录：起回环监听 → 打开浏览器 → 轮询等回调。
 *
 * `onAuthUrl` 在浏览器被打开的那一刻回调一次，第二个参数说明自动打开成没成功 ——
 * 没成功时界面要把那个地址露出来让用户自己点，否则这一步就彻底卡死了。
 */
export async function login(
  provider: AuthProvider,
  onAuthUrl?: (authUrl: string, opened: boolean) => void
): Promise<LoginOutcome> {
  const started = await guard<LoginStart>(
    invoke('auth_login_start', { provider }),
    '发起登录失败'
  )
  if (!started.ok || !started.data) {
    return { status: 'failed', error: started.error ?? '发起登录失败' }
  }

  const { authUrl } = started.data
  const opened = await guard<null>(invoke('open_external', { url: authUrl }), '打开浏览器失败')
  onAuthUrl?.(authUrl, opened.ok)

  return await waitForCallback()
}

/**
 * 手动兜底：把用户粘贴的那条回调地址直接交上去。
 *
 * 拿到结果时会让等待中的循环一起收尾，所以界面上只该由 `login()` 那边报一次成功。
 */
export async function submit(url: string): Promise<Result<AccountProfile>> {
  const result = await guard<LoginPoll>(
    invoke('auth_login_submit', { url }),
    '提交回调地址失败'
  )
  if (!result.ok || !result.data) return fail(result.error ?? '提交回调地址失败')

  const outcome = await settle(result.data)
  return outcome.status === 'ok' ? ok(outcome.account) : fail(outcome.error)
}

/** 放弃进行中的登录：让轮询循环退出，并关掉后端的回环监听 */
export async function cancel(): Promise<void> {
  finished = null
  session += 1
  await guard<null>(invoke('auth_login_cancel'), '取消登录失败')
}

/** 退出登录：清掉凭据管理器里的 token，连带清掉显示用的资料 */
export async function logout(provider: AuthProvider): Promise<Result<null>> {
  const result = await guard<null>(invoke('auth_logout', { provider }), '退出登录失败')
  if (!result.ok) return result

  const stored = state.account()
  if (stored?.provider === provider) state.setAccount(null)
  return ok(null)
}

/** 当前保存的账号资料（不做任何网络或凭据访问） */
export function currentAccount(): AccountProfile | null {
  return state.account()
}
