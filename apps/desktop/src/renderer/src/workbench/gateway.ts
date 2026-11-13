import type { Result } from '@workbench/core'

import type { GatewayAccess, GatewayAccount, GatewayAccountImport, GatewayActionResult, GatewayActivityRow, GatewayCredits, GatewayGrantAccount, GatewayLoginPoll, GatewayLoginStart, GatewayModelInfo, GatewayPerksAutoConfig, GatewayPerksAutoRun, GatewayPullResult, GatewayStatus, GatewaySyncResult, GatewayTaskRun, GatewayTasksSnapshot, GatewayUsageRow, GatewayUsageWindow } from '@/types'
import { fail, ok } from '@workbench/core'
import { createAutoSync } from './auto-sync'
import { errorText, invoke } from './bridge'
// 载荷类型搬到 @\/types（契约侧）了；这里 re-export，老导入不动
export type { GatewayAccess, GatewayAccount, GatewayAccountImport, GatewayAccountUsage, GatewayActionResult, GatewayActivityRow, GatewayBucketUsage, GatewayCheckinStatus, GatewayCredits, GatewayGrantAccount, GatewayGrowthSummary, GatewayGrowthTask, GatewayLoginPoll, GatewayLoginStart, GatewayModelInfo, GatewayModelQuota, GatewayModelUsage, GatewayPackage, GatewayPerksAutoConfig, GatewayPerksAutoRun, GatewayPullResult, GatewayStatus, GatewaySyncResult, GatewaySyncStatus, GatewayTaskAccount, GatewayTaskRun, GatewayTasksSnapshot, GatewayTravelState, GatewayUsageRow, GatewayUsageSummary, GatewayUsageWindow } from '@/types'

/**
 * 网关（CodeBuddy 反代）的适配层。
 *
 * 只做形状收敛与命令名对齐：业务规则全在 Rust 侧（`wb_gateway.rs` 那几个命令）。
 * 一条约定要记住：**账号视图里没有 token** —— Rust 侧只回展示用的字段，
 * 这一层也别去凑一个「顺便把令牌读回来」的接口。
 */

async function call<T>(command: string, args: Record<string, unknown>, fallback: string): Promise<Result<T>> {
  try {
    return ok(await invoke<T>(command, args))
  }
  catch (error) {
    return fail(errorText(error, fallback))
  }
}

export function gatewayStatus(): Promise<Result<GatewayStatus>> {
  return call('wb_gateway_status', {}, '读取 TBuddy 状态失败')
}

export function gatewayStart(port: number): Promise<Result<number>> {
  return call('wb_gateway_start', { port }, '启动 TBuddy 失败')
}

export function gatewayStop(): Promise<Result<null>> {
  return call('wb_gateway_stop', {}, '停止 TBuddy 失败')
}

/** 「随程序启动」：只改配置，下次应用启动时生效；不立刻启停 */
export function gatewayAutoStartSet(enabled: boolean): Promise<Result<null>> {
  return call('wb_gateway_auto_start_set', { enabled }, '保存随程序启动失败')
}

export function gatewayAccounts(): Promise<Result<GatewayAccount[]>> {
  return call('wb_gateway_accounts', {}, '读取账号失败')
}

export function gatewayReload(): Promise<Result<null>> {
  return call('wb_gateway_reload', {}, '重新载入账号失败')
}

export function gatewayLoginStart(): Promise<Result<GatewayLoginStart>> {
  return call('wb_gateway_login_start', {}, '发起登录失败')
}

/** `loginState` 是 `gatewayLoginStart` 回来的那个 state */
export function gatewayLoginPoll(loginState: string): Promise<Result<GatewayLoginPoll>> {
  return call('wb_gateway_login_poll', { loginState }, '轮询登录失败')
}

export function gatewayCredits(uid: string): Promise<Result<GatewayCredits>> {
  return call('wb_gateway_credits', { uid }, '查询余额失败')
}

export function gatewayAccountSet(uid: string, enabled: boolean): Promise<Result<null>> {
  return call('wb_gateway_account_set', { uid, enabled }, '修改账号失败')
}

/** 选号优先级：1..=100，数大的先用 */
export function gatewayAccountPriority(uid: string, priority: number): Promise<Result<null>> {
  return call('wb_gateway_account_priority', { uid, priority }, '修改优先级失败')
}

export function gatewayModels(): Promise<Result<GatewayModelInfo[]>> {
  return call('wb_gateway_models', {}, '读取模型清单失败')
}

/**
 * 从上游拉一次真实目录（用户点「重新获取」才走这里，没有定时器）。
 * 拉到的清单由 Rust 落盘，之后 `gatewayModels()` 读的就是那一份。
 */
export function gatewayModelsRefresh(): Promise<Result<GatewayModelInfo[]>> {
  return call('wb_gateway_models_refresh', {}, '拉取模型目录失败')
}

export function gatewayAccountDelete(uid: string): Promise<Result<null>> {
  return call('wb_gateway_account_delete', { uid }, '删除账号失败')
}

/** 导出账号：返回一段含明文 token 的 JSON，交给用户自己保管 */
export function gatewayAccountsExport(): Promise<Result<string>> {
  return call('wb_gateway_accounts_export', {}, '导出账号失败')
}

/** 导入账号；`overwrite=false` 时同 uid 跳过 */
export function gatewayAccountsImport(payload: string, overwrite: boolean): Promise<Result<GatewayAccountImport>> {
  return call('wb_gateway_accounts_import', { payload, overwrite }, '导入账号失败')
}

export function gatewayAccess(): Promise<Result<GatewayAccess>> {
  return call('wb_gateway_access', {}, '读取接入信息失败')
}

/** 换一个密钥。旧密钥立刻失效。 */
export function gatewayRotateKey(): Promise<Result<string>> {
  return call('wb_gateway_rotate_key', {}, '重新生成密钥失败')
}

/**
 * 窗口内的流水（旧→新），连统计窗口的起点一起回。**只取数**：分组 / 分桶 / 比率的语义在
 * `@workbench/usage` 的 `summarizeGatewayRows`（Rust 只按窗口把行取齐）。
 *
 * 窗口是**自然日**（UTC+8 零点起算）：`days = 1` 是今天，`days = 3` 是今天加前两天。
 */
export function gatewayUsageRows(days: number, repo = '', device = ''): Promise<Result<GatewayUsageWindow>> {
  return call('wb_gateway_usage_rows', { days, repo, device }, '读取用量失败')
}

export function gatewayUsageRecent(limit: number, repo = '', device = ''): Promise<Result<GatewayUsageRow[]>> {
  return call('wb_gateway_usage_recent', { limit, repo, device }, '读取最近请求失败')
}

/** 拉取的节流窗口：每次进页面都 fetch 一次太费，一分钟内不重复 */
const GATEWAY_PULL_INTERVAL_MS = 60_000
let lastGatewayPullAt = 0
let gatewayPulling: Promise<Result<GatewayPullResult>> | null = null

/**
 * 只拉不推：把同步克隆更新到最新，别的机器推上来的流水才读得到。
 *
 * 用量页的读路径只读本地克隆，而克隆平时只有在本机推送时才会被顺带 pull ——
 * 本机一天没有流水时，别的机器推的今天就永远进不来。这里不排队、不写本机那份，
 * 也不会自己等自己（与推送用的是不同入口，但 git 侧仍有同一把工作流锁）。
 */
export function pullGatewayUsage(repo: string): Promise<Result<GatewayPullResult>> {
  if (!repo)
    return Promise.resolve(ok({ pulled: false, changed: false }))
  if (gatewayPulling)
    return gatewayPulling
  if (Date.now() - lastGatewayPullAt < GATEWAY_PULL_INTERVAL_MS)
    return Promise.resolve(ok({ pulled: false, changed: false, skipped: true }))

  gatewayPulling = call<{ changed: boolean }>('gateway_sync_pull', { repo }, '刷新 TBuddy 流水失败')
    .then(result => (result.ok
      ? ok({ pulled: true, changed: result.data?.changed === true })
      : fail(result.error ?? '刷新 TBuddy 流水失败')))
    .finally(() => {
      gatewayPulling = null
    })
  return gatewayPulling.then((result) => {
    if (result.ok)
      lastGatewayPullAt = Date.now()
    return result
  })
}

/** 自动同步的节流窗口：与 token 用量同一个节奏（一小时） */
/**
 * 自动同步的节流窗口：与 token 用量同一个节奏（一小时）。
 * 失败不进节流窗口（`shouldMark`）：下一次进页面会立刻重试。
 */
const gatewaySyncGate = createAutoSync({
  intervalMs: 60 * 60_000,
  shouldMark: result => (result as Result<GatewaySyncResult>).ok,
})

/**
 * 直接推一次（不排队、不节流）。
 *
 * 给已经在同步队列里的调用方用 —— 例如 token 用量的每小时同步，
 * 在它那一轮 `enqueue` 里顺带把网关流水推上去；再调 `syncGatewayUsage`
 * 会自己等自己，形成死锁。
 */
export async function gatewaySyncNow(repo: string, device: string): Promise<Result<GatewaySyncResult>> {
  const result = await call<Omit<GatewaySyncResult, 'enabled'>>(
    'gateway_sync_publish',
    { repo, device },
    '同步 TBuddy 流水失败',
  )
  if (!result.ok)
    return fail(result.error ?? '同步 TBuddy 流水失败')
  if (!result.data)
    return fail('同步 TBuddy 流水失败')
  return ok({ enabled: true, ...result.data })
}

/** 记下这次同步的时刻：手动按钮与 token 的每小时同步共用这个节流窗口 */
export function markGatewaySynced(repo: string): void {
  gatewaySyncGate.mark(repo)
}

/**
 * 手动 / 按需同步：一小时节流 + 与 token 用量共用同一个 git 队列。
 * `force` 给页面上的「同步」按钮用，绕过节流。
 */
export function syncGatewayUsage(
  repo: string,
  device: string,
  force = false,
): Promise<Result<GatewaySyncResult>> {
  if (!repo)
    return Promise.resolve(ok({ enabled: false, changed: false, pushed: false }))

  if (!force && !gatewaySyncGate.due(repo))
    return Promise.resolve(ok({ enabled: true, changed: false, pushed: false, skipped: true }))

  return gatewaySyncGate.now(repo, () => gatewaySyncNow(repo, device))
}

/**
 * uid → 账号名。
 *
 * 用量明细与请求流水里只有 `uid`（流水记的是它，改名也不该动历史），而界面要显示的是当初登录
 * 下来的那个名字 —— 名字只在账号文件里（`wb_gateway_accounts`），所以这里顺带问一次。
 * 查不到就由调用方退回 uid 前八位：数字难看，但比空着强。
 */
export async function gatewayAccountNames(): Promise<Record<string, string>> {
  const result = await gatewayAccounts()
  if (!result.ok || !result.data)
    return {}
  return Object.fromEntries(result.data.map(item => [item.uid, item.label]))
}

/** 挂进 `window.workbench` 的那一份。字段名与 `WorkbenchApi` 一一对应。 */
export const gatewayApi = {
  gatewayStatus,
  gatewayStart,
  gatewayStop,
  gatewayAutoStartSet,
  gatewayAccounts,
  gatewayReload,
  gatewayLoginStart,
  gatewayLoginPoll,
  gatewayCredits,
  gatewayModels,
  gatewayModelsRefresh,
  gatewayAccess,
  gatewayRotateKey,
  gatewayAccountSet,
  gatewayAccountPriority,
  gatewayAccountDelete,
  gatewayAccountsExport,
  gatewayAccountsImport,
  gatewayTasks,
  gatewayTasksRun,
  gatewayTasksTravel,
  gatewayTasksStreak,
  gatewayCheckin,
  gatewayActivityToday,
  gatewayCreditGrants,
  gatewayPerksAutoConfig,
  gatewayPerksAutoSet,
  gatewayPerksAutoRun,
}

// ---------- 任务福利 ----------

/** 当前号的成长任务 + 汇总。`uid` 为空时后端取第一个已启用的号。 */
export function gatewayTasks(uid?: string): Promise<Result<GatewayTasksSnapshot>> {
  return call('wb_gateway_tasks', { uid: uid ?? null }, '读取成长任务失败')
}

/** 一键做任务领积分。`uid` 为空时对全部已启用的账号逐个跑。 */
export function gatewayTasksRun(uid?: string): Promise<Result<GatewayTaskRun>> {
  return call('wb_gateway_tasks_run', { uid: uid ?? null }, '执行成长任务失败')
}

export function gatewayTasksTravel(uid?: string): Promise<Result<GatewayActionResult[]>> {
  return call('wb_gateway_tasks_travel', { uid: uid ?? null }, '猫猫旅行失败')
}

export function gatewayTasksStreak(uid?: string): Promise<Result<GatewayActionResult[]>> {
  return call('wb_gateway_tasks_streak', { uid: uid ?? null }, '成长连登失败')
}

/** Buddy 加油站签到 */
export function gatewayCheckin(uid?: string): Promise<Result<GatewayActionResult[]>> {
  return call('wb_gateway_checkin', { uid: uid ?? null }, '签到失败')
}

/** 今天的签到尝试 */
export function gatewayActivityToday(): Promise<Result<GatewayActivityRow[]>> {
  return call('wb_gateway_activity_today', {}, '读取今日打卡记录失败')
}

/**
 * 积分发放流水（整段包历史）。`uid` 为空时取全部已启用的号，
 * 每个号一次只读 POST；某个号失败只在它自己那一条上带 `error`。
 */
export function gatewayCreditGrants(uid?: string): Promise<Result<GatewayGrantAccount[]>> {
  return call('wb_gateway_credit_grants', { uid: uid ?? null }, '读取积分流水失败')
}

/** 福利自动跑的开关 */
export function gatewayPerksAutoConfig(): Promise<Result<GatewayPerksAutoConfig>> {
  return call('wb_gateway_perks_auto_config', {}, '读取福利自动跑配置失败')
}

export function gatewayPerksAutoSet(enabled: boolean): Promise<Result<GatewayPerksAutoConfig>> {
  return call('wb_gateway_perks_auto_set', { enabled }, '保存福利自动跑配置失败')
}

/**
 * 按本地自然日与 23:00–08:00 窗口判断该不该跑；关着时直接返回。
 * 白天轮 = 签到 + 一键做任务，夜间轮只跑夜猫子。
 */
export function gatewayPerksAutoRun(): Promise<Result<GatewayPerksAutoRun>> {
  return call('wb_gateway_perks_auto_run', {}, '自动福利执行失败')
}
