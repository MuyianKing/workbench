/**
 * `window.workbench` 上的一组通道：账号登录（GitHub / Gitee）。
 * 实现见 `workbench/auth.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  AccountProfile,
  AuthProvider,
  AuthStatus,
  LoginOutcome,
} from '../index'

export interface AuthChannel {
  /**
   * 账号登录状态：能不能登录、回调地址、已登录哪些平台。
   * **不返回任何 token** —— 它在 Rust 侧，渲染层碰不到（见 AccountProfile）。
   */
  authStatus: () => Promise<Result<AuthStatus>>

  /** 重新拉一次账号资料（启动时刷新头像与昵称） */
  authRefreshAccount: (provider: AuthProvider) => Promise<Result<AccountProfile>>

  /**
   * 走完一次完整登录：起回环监听 → 打开浏览器 → 轮询等回调 → 回来时给账号资料。
   *
   * `onAuthUrl` 在浏览器被打开的那一刻回调一次，第二个参数说明自动打开成没成功 ——
   * 没成功时界面要把那个地址露出来让用户自己点，否则这一步就彻底卡死了。
   */
  authLogin: (
    provider: AuthProvider,
    onAuthUrl?: (authUrl: string, opened: boolean) => void,
  ) => Promise<LoginOutcome>

  /**
   * 手动兜底：回调没跳回来时，把浏览器地址栏里那条完整地址直接交上去。
   * 端口被占用、浏览器被拦下之类的情况不至于让整条流程卡死。
   */
  authLoginSubmit: (url: string) => Promise<Result<AccountProfile>>

  /** 放弃进行中的登录（关掉回环监听，立刻停下轮询） */
  authLoginCancel: () => Promise<void>

  /** 退出登录：清掉凭据管理器里的 token */
  authLogout: (provider: AuthProvider) => Promise<Result<null>>
}
