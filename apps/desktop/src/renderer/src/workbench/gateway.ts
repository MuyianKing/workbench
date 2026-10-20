import type { Result } from '@workbench/core'
import { fail, ok } from '@workbench/core'
import { errorText, invoke } from './bridge'
import { enqueue } from './sync-queue'

/**
 * 网关（WorkBuddy / CodeBuddy 反代）的适配层。
 *
 * 只做形状收敛与命令名对齐：业务规则全在 Rust 侧（`wb_gateway.rs` 那几个命令）。
 * 一条约定要记住：**账号视图里没有 token** —— Rust 侧只回展示用的字段，
 * 这一层也别去凑一个「顺便把令牌读回来」的接口。
 */

/** 网关运行状态 */
export interface GatewayStatus {
  running: boolean
  port: number
  /** 未运行时为 null：地址跟着监听走，没监听就没有地址 */
  baseUrl: string | null
  accounts: number
  ready: number
}

/** 账号行（不含任何凭据） */
export interface GatewayAccount {
  uid: string
  label: string
  /** `workbuddy` / `codebuddy` */
  realm: string
  realmLabel: string
  /** `workbuddy` / `vscode` / `cli` */
  product: string
  enterprise: boolean
  enabled: boolean
  ready: boolean
  needsRefresh: boolean
  /** 选号优先级：数大的先用（1..=100） */
  priority: number
  /** 额度标记还在生效：这个号暂时不会被选中 */
  quotaExhausted: boolean
  /** 额度预计恢复的时刻（Unix 秒）；没标记是 null */
  quotaResetsAt: number | null
  /** 按模型记的额度用完标记（上游按模型限流）：只挡这些模型，别的照用 */
  modelQuotas: GatewayModelQuota[]
  note: string
}

/** 一个模型上的额度用完标记 */
export interface GatewayModelQuota {
  model: string
  /** 预计恢复的时刻（Unix 秒） */
  resetsAt: number
}

/** 发起登录的结果：把 authUrl 交给浏览器，把 state 留着轮询 */
export interface GatewayLoginStart {
  state: string
  authUrl: string
}

/** 一次轮询的结果 */
export interface GatewayLoginPoll {
  done: boolean
  message: string
  account: GatewayAccount | null
}

/** 一个资源包 */
export interface GatewayPackage {
  name: string
  code: string
  remain: number
  used: number
  size: number
  expiresAt: number | null
  noExpiry: boolean
  daysLeft: number | null
}

/** 余额快照 */
export interface GatewayCredits {
  remain: number
  used: number
  size: number
  packages: GatewayPackage[]
  earliestExpiring: GatewayPackage | null
  enterprise: boolean
  updatedAt: number
}

async function call<T>(command: string, args: Record<string, unknown>, fallback: string): Promise<Result<T>> {
  try {
    return ok(await invoke<T>(command, args))
  }
  catch (error) {
    return fail(errorText(error, fallback))
  }
}

export function gatewayStatus(): Promise<Result<GatewayStatus>> {
  return call('wb_gateway_status', {}, '读取网关状态失败')
}

export function gatewayStart(port: number): Promise<Result<number>> {
  return call('wb_gateway_start', { port }, '启动网关失败')
}

export function gatewayStop(): Promise<Result<null>> {
  return call('wb_gateway_stop', {}, '停止网关失败')
}

export function gatewayAccounts(): Promise<Result<GatewayAccount[]>> {
  return call('wb_gateway_accounts', {}, '读取账号失败')
}

export function gatewayReload(): Promise<Result<null>> {
  return call('wb_gateway_reload', {}, '重新载入账号失败')
}

/** `realm` 收 `workbuddy` / `codebuddy` */
export function gatewayLoginStart(realm: string): Promise<Result<GatewayLoginStart>> {
  return call('wb_gateway_login_start', { realm }, '发起登录失败')
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

/** 清单里的一行模型：上游目录 + 本地价表单价。未定价时两个单价字段都是 null */
export interface GatewayModelInfo {
  id: string
  /** 上游给的名字；还没拉过目录时是空串 */
  name: string
  /** 上游给的消费倍率原文（`0.29x`），只用于显示 */
  rate: string
  context: number
  maxOutput: number
  supportsVision: boolean
  supportsTools: boolean
  supportsReasoning: boolean
  /** 支持的思考档位（`low` / `high` / `max`…），空表示上游没说 */
  efforts: string[]
  defaultEffort: string
  inputCny: number | null
  outputCny: number | null
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

/** 接入信息：第三方客户端要填的那三样 */
export interface GatewayAccess {
  baseUrl: string
  apiKey: string
  models: string[]
}

/** 单模型汇总 */
export interface GatewayModelUsage {
  model: string
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  /** 上游 `usage.credit` 累计（只含有观测的请求） */
  credits: number
  /** 积分大于 0 的请求数（0 消耗 / 缺字段都不进样本） */
  creditSamples: number
  /** 积分大于 0 的请求的总 token：积分比率的**分母 */
  creditTokens: number
  /** 积分 / 1M Token = credits / creditTokens */
  creditsPer1MTokens: number
  cacheHitPct: number
  costCny: number
  /** 价表里有价的那部分 token：折算「每百万花多少」的分母 */
  pricedTokens: number
  pricedRequests: number
}

/** 单账号汇总 */
export interface GatewayAccountUsage {
  uid: string
  realm: string
  requests: number
  failed: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  /** 上游 `usage.credit` 累计（只含有观测的请求） */
  credits: number
  /** 积分大于 0 的请求数（0 消耗 / 缺字段都不进样本） */
  creditSamples: number
  /** 积分大于 0 的请求的总 token：积分比率的**分母 */
  creditTokens: number
  /** 积分 / 1M Token = credits / creditTokens */
  creditsPer1MTokens: number
  cacheHitPct: number
  costCny: number
  pricedTokens: number
  pricedRequests: number
  avgTtftMs: number
  tokensPerSec: number
}

/** 时序里的一格：`bucket` 是这格的起点（`2026-10-20 14` 或 `2026-10-20`，本地时间） */
export interface GatewayBucketUsage {
  bucket: string
  requests: number
  totalTokens: number
  costCny: number
}

/** 一段时间内的汇总 */
export interface GatewayUsageSummary {
  requests: number
  failed: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  /** 上游 `usage.credit` 累计（只含有观测的请求） */
  credits: number
  /** 积分大于 0 的请求数（0 消耗 / 缺字段都不进样本） */
  creditSamples: number
  /** 积分大于 0 的请求的总 token：积分比率的**分母 */
  creditTokens: number
  /** 积分 / 1M Token = credits / creditTokens；跨模型时由两个总量直接除 */
  creditsPer1MTokens: number
  avgTtftMs: number
  tokensPerSec: number
  cacheHitPct: number
  successPct: number
  costCny: number
  /** 有价可折的那部分 token 与请求数（见 Rust 的 `Summary`） */
  pricedTokens: number
  pricedRequests: number
  byModel: GatewayModelUsage[]
  byBucket: GatewayBucketUsage[]
  /** 时序粒度：一周以内按小时，长窗口按天（由 Rust 的 `bucket_unit` 定） */
  bucketUnit: 'hour' | 'day'
  byAccount: GatewayAccountUsage[]
}

/** 一条请求流水 */
export interface GatewayUsageRow {
  ts: number
  uid: string
  realm: string
  /** 产生这条流水的机器名；老流水没有这个字段，读出来是空串 */
  machine: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  ttftMs: number
  durationMs: number
  ok: boolean
  error: string
  ua: string
  /** 客户端要求的推理强度，没提是空串 */
  effort: string
  /** 流式与否；老流水没记过这一项，是 null 而不是 false */
  stream: boolean | null
  /** 推理 token（上游没给是 0） */
  reasoningTokens: number
  /** 上游给这次请求扣的积分；没给是 null（不是 0） */
  credit: number | null
  /** 调用方密钥的末四位（`…abcd`），没带密钥是空串 */
  apiKey: string
  /** 按价表折算的估算花费；未定价是 null */
  costCny: number | null
}

export function gatewayAccess(): Promise<Result<GatewayAccess>> {
  return call('wb_gateway_access', {}, '读取接入信息失败')
}

/** 换一个密钥。旧密钥立刻失效。 */
export function gatewayRotateKey(): Promise<Result<string>> {
  return call('wb_gateway_rotate_key', {}, '重新生成密钥失败')
}

/**
 * 用量汇总。`repo` / `device` 由 `index.ts` 用登录态与 `localDevice()` 注入：
 * 空仓库 = 只读本机；非空时 Rust 侧会把同步克隆里别的机器的流水一起合进来。
 */
export function gatewayUsage(days: number, repo = '', device = ''): Promise<Result<GatewayUsageSummary>> {
  return call('wb_gateway_usage', { days, repo, device }, '读取用量失败')
}

/**
 * 窗口内的流水（旧→新）。**只取数**：分组 / 分桶 / 比率的语义在
 * `@workbench/usage` 的 `summarizeGatewayRows`，与 Rust 的 `summarize` 同口径。
 */
export function gatewayUsageRows(days: number, repo = '', device = ''): Promise<Result<GatewayUsageRow[]>> {
  return call('wb_gateway_usage_rows', { days, repo, device }, '读取用量失败')
}

export function gatewayUsageRecent(limit: number, repo = '', device = ''): Promise<Result<GatewayUsageRow[]>> {
  return call('wb_gateway_usage_recent', { limit, repo, device }, '读取最近请求失败')
}

/** 同步开关与设备名：给用量页决定要不要显示「同步」按钮 */
export interface GatewaySyncStatus {
  enabled: boolean
  deviceName: string
}

/** 网关流水同步的结果；`enabled=false` 表示没登录 / 没配仓库，只读本机 */
export interface GatewaySyncResult {
  enabled: boolean
  changed: boolean
  pushed: boolean
  /** 一小时内已经同步过，这次没有真的走 git */
  skipped?: boolean
  rows?: number
  months?: number
}

/** 自动同步的节流窗口：与 token 用量同一个节奏（一小时） */
const GATEWAY_SYNC_INTERVAL_MS = 60 * 60_000
let lastGatewaySyncAt = 0
let lastGatewaySyncRepo = ''
let gatewaySyncing: Promise<Result<GatewaySyncResult>> | null = null

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
    '同步网关流水失败',
  )
  if (!result.ok)
    return fail(result.error ?? '同步网关流水失败')
  if (!result.data)
    return fail('同步网关流水失败')
  return ok({ enabled: true, ...result.data })
}

/** 记下这次同步的时刻：手动按钮与 token 的每小时同步共用这个节流窗口 */
export function markGatewaySynced(repo: string): void {
  lastGatewaySyncAt = Date.now()
  lastGatewaySyncRepo = repo
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

  if (!force && repo === lastGatewaySyncRepo && Date.now() - lastGatewaySyncAt < GATEWAY_SYNC_INTERVAL_MS)
    return Promise.resolve(ok({ enabled: true, changed: false, pushed: false, skipped: true }))

  if (gatewaySyncing)
    return gatewaySyncing

  gatewaySyncing = enqueue(() => gatewaySyncNow(repo, device)).finally(() => {
    gatewaySyncing = null
  })
  return gatewaySyncing.then((result) => {
    if (result.ok)
      markGatewaySynced(repo)
    return result
  })
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
}
