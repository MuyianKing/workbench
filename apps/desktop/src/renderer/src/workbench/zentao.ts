import type { Result, ZentaoAssignInput, ZentaoBrowse, ZentaoBugDetail, ZentaoBugList, ZentaoBuild, ZentaoResolveInput, ZentaoSession, ZentaoUser } from '@/types'
import { fail } from '@workbench/core'
import { fetchZentaoBugs, normalizeAssignInput, normalizeResolveInput, parseZentaoBugDetail, parseZentaoBuilds, parseZentaoUsers } from '@workbench/zentao'
import { errorText, guard, invoke, listen } from './bridge'

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
      // 产品名按需补：只对真的有 Bug 的产品调一次，取不到就给空串（不挡列表）
      async (productId) => {
        const result = await guard(invoke<{ name?: unknown }>('zentao_product', { sessionId, productId }), '读取禅道产品失败')
        const name = result.ok ? result.data?.name : ''
        return typeof name === 'string' ? name : ''
      },
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

/** 系统通知被点了（Rust 已唤出主窗口）：换到禅道页由 store 接手 */
export function onNotifyClick(handler: () => void): () => void {
  return listen<null>('zentao:notify-click', () => handler())
}

/** Bug 详情（含 actions 历史）：后端回原始 JSON，形状投影在这一侧 */
export async function bugDetail(sessionId: string, bugId: number): Promise<Result<ZentaoBugDetail>> {
  const raw = await guard(invoke<unknown>('zentao_bug', { sessionId, bugId }), '读取禅道 Bug 详情失败')
  if (!raw.ok)
    return fail(raw.error || '读取禅道 Bug 详情失败')
  try {
    return { ok: true, data: parseZentaoBugDetail(raw.data) }
  }
  catch (error) {
    return fail(errorText(error, '禅道 Bug 详情格式不正确'))
  }
}

/** 指派候选人清单 */
export async function users(sessionId: string): Promise<Result<ZentaoUser[]>> {
  const raw = await guard(invoke<unknown>('zentao_users', { sessionId }), '读取禅道用户失败')
  if (!raw.ok)
    return fail(raw.error || '读取禅道用户失败')
  try {
    // 后端回的是 {page,total,users}，真正的数组在 users 里
    const list = (raw.data as { users?: unknown } | null)?.users
    return { ok: true, data: parseZentaoUsers(list) }
  }
  catch (error) {
    return fail(errorText(error, '禅道用户清单格式不正确'))
  }
}

/** 某项目下的构建号（解决 Bug 选版本用） */
export async function builds(sessionId: string, projectId: number): Promise<Result<ZentaoBuild[]>> {
  const raw = await guard(invoke<unknown>('zentao_builds', { sessionId, projectId }), '读取禅道版本失败')
  if (!raw.ok)
    return fail(raw.error || '读取禅道版本失败')
  try {
    const list = (raw.data as { builds?: unknown } | null)?.builds
    return { ok: true, data: parseZentaoBuilds(list) }
  }
  catch (error) {
    return fail(errorText(error, '禅道版本清单格式不正确'))
  }
}

/** 指派一个 Bug（会真实修改禅道数据）；入参在这一侧先校验，不合法不发请求 */
export function assignBug(sessionId: string, input: ZentaoAssignInput): Promise<Result<null>> {
  let normalized: ZentaoAssignInput
  try {
    normalized = normalizeAssignInput(input)
  }
  catch (error) {
    return Promise.resolve(fail(errorText(error, '指派参数不正确')))
  }
  return guard(invoke<null>('zentao_assign', {
    sessionId,
    bugId: normalized.bugId,
    assignedTo: normalized.assignedTo,
    comment: normalized.comment,
  }), '指派失败')
}

/** 解决一个 Bug（会真实修改禅道数据）；入参在这一侧先校验，不合法不发请求 */
export function resolveBug(sessionId: string, input: ZentaoResolveInput): Promise<Result<null>> {
  let normalized: ZentaoResolveInput
  try {
    normalized = normalizeResolveInput(input)
  }
  catch (error) {
    return Promise.resolve(fail(errorText(error, '解决参数不正确')))
  }
  return guard(invoke<null>('zentao_resolve', {
    sessionId,
    bugId: normalized.bugId,
    resolution: normalized.resolution,
    resolvedBuild: normalized.resolvedBuild,
    duplicateBug: normalized.duplicateBug,
    comment: normalized.comment,
  }), '解决失败')
}

/**
 * 账号可见产品的 id 清单。禅道的 `/v1/products` 在本部署下返回空（产品挂在项目集 / 项目下），
 * 所以清单以后端从账号资料里取到的 `view.products` 为准 —— 名字不在这里要，按需再用 `product` 补。
 * （列表聚合里 `readPage(null)` 走的就是它，这里导出只是为了让适配层测试能单独钉住形状。）
 */
export function productIds(sessionId: string): Promise<Result<unknown>> {
  return guard(invoke<unknown>('zentao_products', { sessionId }), '读取禅道产品清单失败')
}

/** 单个产品的名称（补列表里的产品名） */
export async function product(sessionId: string, productId: number): Promise<Result<string>> {
  const raw = await guard(invoke<{ name?: unknown }>('zentao_product', { sessionId, productId }), '读取禅道产品失败')
  if (!raw.ok)
    return fail(raw.error || '读取禅道产品失败')
  const name = raw.data?.name
  return { ok: true, data: typeof name === 'string' ? name : '' }
}

/** Bug 正文里的站内图片：后端带会话取回，这里拼成 data URL 交给界面内联显示 */
export async function image(sessionId: string, path: string): Promise<Result<string>> {
  const raw = await guard(invoke<{ mime?: unknown, data?: unknown }>('zentao_image', { sessionId, path }), '读取禅道图片失败')
  if (!raw.ok)
    return fail(raw.error || '读取禅道图片失败')
  const mime = raw.data?.mime
  const data = raw.data?.data
  if (typeof mime !== 'string' || typeof data !== 'string' || !mime.startsWith('image/') || !data)
    return fail('禅道返回的图片格式不正确')
  return { ok: true, data: `data:${mime};base64,${data}` }
}
