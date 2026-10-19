import type { Result, ZentaoBrowse, ZentaoBugList, ZentaoSession } from '@/types'
import { fetchZentaoBugs } from '@workbench/zentao'
import { guard, invoke } from './bridge'

export function session(): Promise<Result<ZentaoSession | null>> {
  return guard(invoke<ZentaoSession | null>('zentao_session'), '读取禅道登录状态失败')
}

export function login(): Promise<Result<ZentaoSession>> {
  return guard(invoke<ZentaoSession>('zentao_login'), '连接禅道失败')
}

export function logout(sessionId: string): Promise<Result<null>> {
  return guard(invoke<null>('zentao_logout', { sessionId }), '退出禅道失败')
}

export function bugs(sessionId: string, browse: ZentaoBrowse): Promise<Result<ZentaoBugList>> {
  return guard(
    fetchZentaoBugs(
      (productId, page, mode) => {
        // productId 为 null 时后端回「账号可见产品」的 id 清单（禅道的 /v1/products 在
        // 本部署下是空的，见 Rust 侧 products() 的说明）
        if (productId === null)
          return invoke<unknown>('zentao_products', { sessionId })
        return invoke<unknown>('zentao_page', { sessionId, productId, page, browse: mode })
      },
      // 列表已经不显示了，产品名没人要：不传 readProductName，省掉每个产品一次请求
      undefined,
      browse,
    ),
    '读取禅道 Bug 列表失败',
  )
}

/** 登记后台检查周期（分钟，0 = 关闭）；间隔没变时后端不动计时 */
export function watch(pollMinutes: number): Promise<Result<null>> {
  return guard(invoke<null>('zentao_watch', { pollMinutes }), '登记禅道检查周期失败')
}

/** 比出新增之后弹系统通知（title 只是首条 Bug 的纯文本标题，不是机密） */
export function notify(sessionId: string, count: number, title: string): Promise<Result<null>> {
  return guard(invoke<null>('zentao_notify', { sessionId, count, title }), '发送禅道通知失败')
}

/** 后台线程到点（取数、比新增、弹通知都在这一侧接手） */
export function onCheck(handler: () => void): Promise<() => void> {
  const registered = window.__TAURI__?.event?.listen('zentao:check', () => handler())
  return registered ?? Promise.resolve(() => {})
}

/**
 * 打开（或聚焦）禅道窗口：一扇独立窗口加载禅道站点，免登录由 Rust 侧的登录页脚本完成
 * （见 zentao.rs 的 auto_login_script）。已经开着就只是唤到前面。
 */
export function openWindow(): Promise<Result<null>> {
  return guard(invoke<null>('zentao_open_window'), '打开禅道窗口失败')
}
