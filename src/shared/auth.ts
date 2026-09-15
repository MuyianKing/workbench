/**
 * 账号登录的纯逻辑：平台清单与账号资料的收敛。
 *
 * **授权 URL 的构造、回调地址的解析、换 token 这些都不在这里**，它们在 Rust 侧
 * （src-tauri/src/oauth.rs）：那几件事和 client_secret、回环监听绑在一起，
 * 渲染层不该、也不需要有第二份实现。这里只留两端都要用的那点东西。
 */
import type { AccountProfile, AuthProvider } from './types'

export const AUTH_PROVIDERS: readonly AuthProvider[] = ['github', 'gitee']

export const AUTH_PROVIDER_LABELS: Record<AuthProvider, string> = {
  github: 'GitHub',
  gitee: 'Gitee'
}

/**
 * 授权范围说明。GitHub 的 scope 是每次授权时申请的，要在这里讲清为什么要 `repo`；
 * Gitee 的权限是注册应用时勾死的，界面上不提 scope。
 */
export const AUTH_PROVIDER_HINTS: Record<AuthProvider, string> = {
  github: '需要 repo 权限，是为了能读写你用来同步 Token 快照的私有仓库。',
  gitee: '授权后即可用该账号读写你用来同步 Token 快照的仓库。'
}

export function isAuthProvider(value: unknown): value is AuthProvider {
  return value === 'github' || value === 'gitee'
}

/**
 * 把磁盘上的账号资料收敛成合法结构；认不出来就当作没登录过。
 *
 * 数据文件可能来自旧版本或被手工改过，所以每一项都要验：
 * provider 与 login 缺一个就没有意义，直接整条丢掉。
 */
export function sanitizeAccount(raw: unknown): AccountProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Partial<AccountProfile>

  if (!isAuthProvider(input.provider)) return null
  const login = typeof input.login === 'string' ? input.login.trim() : ''
  if (!login) return null

  const name = typeof input.name === 'string' ? input.name.trim() : ''

  return {
    provider: input.provider,
    id: typeof input.id === 'string' ? input.id.trim() : '',
    login,
    name: name || null,
    // 头像只认 data URL：Rust 侧拉下来转好的才是这个形状。
    // 别的写法（尤其是外链）一律丢掉 —— 否则一个手改过的数据文件就能让界面去访问外网。
    avatar:
      typeof input.avatar === 'string' && input.avatar.startsWith('data:image/')
        ? input.avatar
        : null
  }
}

/** 界面上显示的名字：昵称优先，没填过就用登录名 */
export function accountLabel(account: AccountProfile): string {
  return account.name || account.login
}
