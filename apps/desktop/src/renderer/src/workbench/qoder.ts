import type { Result } from '@workbench/core'
import type { GatewayUsageRow, GatewayUsageSummary } from './gateway'
import { fail, ok } from '@workbench/core'
import { errorText, invoke } from './bridge'

/**
 * Qoder 网关的适配层。
 *
 * 与 `gateway.ts` 同一套约定：只做形状收敛与命令名对齐，业务规则全在 Rust 侧
 * （`qd_gateway.rs` / `qd_relay.rs`）。**账号视图里没有 token**。
 *
 * 端口、密钥与随程序启动都自成一套（与 TBuddy 各一份配置），两个代理可以同时跑；
 * 接入信息只属于这一页。
 */

/** 网关运行状态 */
export interface QoderStatus {
  running: boolean
  port: number
  baseUrl: string | null
  accounts: number
  ready: number
  autoStart: boolean
}

/** 账号行（不含凭据） */
export interface QoderAccount {
  uid: string
  label: string
  enabled: boolean
  ready: boolean
  needsRefresh: boolean
  priority: number
  team: boolean
  organizationName: string
  userType: string
  plan: string
  note: string
  lastError: string
  quotaExhausted: boolean
  quotaResetsAt: number | null
  modelQuotas: QoderModelQuota[]
  creditExpiresAt: number
  lastCheckin: string
  campaignCodes: Record<string, string>
  addedAt: number
}

export interface QoderModelQuota {
  model: string
  resetsAt: number
}

/** 导入结果：新增 / 覆盖 / 跳过各几个 */
export interface QoderAccountImport {
  added: number
  updated: number
  skipped: number
}

export interface QoderLoginStart {
  state: string
  authUrl: string
}

export interface QoderLoginPoll {
  status: 'pending' | 'ok' | 'error' | 'unknown'
  message: string
  account: QoderAccount | null
}

export interface QoderPackage {
  name: string
  kind: string
  remain: number
  size: number
  used: number
  expiresAt: number | null
  available: boolean
}

export interface QoderCredits {
  packages: QoderPackage[]
  remain: number
  size: number
  used: number
  plan: string
  team: boolean
  sharedRemain: number
  sharedUnlimited: boolean
  fetchedAt: number
  error: string
}

export interface QoderModelInfo {
  id: string
  key: string
  displayName: string
  enabled: boolean
  disabledReason: string
  description: string
  contextLength: number
  contextWindows: number[]
  contextWindowLabels: string[]
  contextWindowDefault: string
  reasoning: boolean
  vision: boolean
  toolCalls: boolean
  efforts: string[]
  defaultEffort: string
  priceFactor: number | null
  priceFactorPeak: number | null
  priceFactorValley: number | null
  isFree: boolean
  isNew: boolean
}

export interface QoderAccess {
  baseUrl: string
  apiKey: string
  models: string[]
}

export interface QoderUsageWindow {
  since: number
  rows: GatewayUsageRow[]
}

export interface QoderCheckinStatus {
  ok: boolean
  available: boolean
  todayCheckedIn: boolean
  status: string
  streakDays: number
  totalClaimDays: number
  rewardCredits: number
  nextClaimAt: number
  lastClaimedAt: number
  error: string
}

export interface QoderClaimResult {
  ok: boolean
  already: boolean
  unavailable: boolean
  rewardCredits: number
  message: string
  codes: Record<string, string>
  error: string
}

export interface QoderCampaign {
  id: string
  title: string
  description: string
  status: string
  actionType: string
  benefitKind: string
  benefitAmount: number
  endAt: number
  unavailableReason: string
  code: string
}

export interface QoderTaskSnapshot {
  account: string
  uid: string
  checkin: QoderCheckinStatus
  campaigns: QoderCampaign[]
  credits: QoderCredits | null
  error: string
}

export interface QoderHeatmapPoint {
  date: string
  value: number
}

export interface QoderActivityRow {
  ts: number
  date: string
  uid: string
  nickname: string
  task: string
  ok: boolean
  message: string
  /** 这次动作领到的积分（旧记录没有这一位，读成 0） */
  credits: number
}

/** 某一天领到的积分（本机领取记录，UTC+8 自然日） */
export interface QoderEarningPoint {
  date: string
  credits: number
}

export interface QoderPerksAutoConfig {
  enabled: boolean
}

export interface QoderPerksAutoRun {
  ran: number
  credits: number
  failed: number
  message: string
}

async function call<T>(command: string, args: Record<string, unknown>, fallback: string): Promise<Result<T>> {
  try {
    return ok(await invoke<T>(command, args))
  }
  catch (error) {
    return fail(errorText(error, fallback))
  }
}

export function qoderStatus(): Promise<Result<QoderStatus>> {
  return call('wb_qoder_status', {}, '读取 Qoder 状态失败')
}

export function qoderStart(port: number): Promise<Result<number>> {
  return call('wb_qoder_start', { port }, '启动 Qoder 失败（若 TBuddy 在跑会先停掉它）')
}

export function qoderStop(): Promise<Result<null>> {
  return call('wb_qoder_stop', {}, '停止 Qoder 失败')
}

/** 「随程序启动」：只写 Qoder 自己的配置，不立刻启停（TBuddy 的开关是另一份） */
export function qoderAutoStartSet(enabled: boolean): Promise<Result<null>> {
  return call('wb_qoder_auto_start_set', { enabled }, '保存随程序启动失败')
}

export function qoderAccounts(): Promise<Result<QoderAccount[]>> {
  return call('wb_qoder_accounts', {}, '读取账号失败')
}

export function qoderReload(): Promise<Result<null>> {
  return call('wb_qoder_reload', {}, '重新载入账号失败')
}

export function qoderLoginStart(): Promise<Result<QoderLoginStart>> {
  return call('wb_qoder_login_start', {}, '发起 Qoder 登录失败')
}

export function qoderLoginPoll(loginState: string): Promise<Result<QoderLoginPoll>> {
  return call('wb_qoder_login_poll', { loginState }, '轮询登录失败')
}

export function qoderCredits(uid: string): Promise<Result<QoderCredits>> {
  return call('wb_qoder_credits', { uid }, '查询积分失败')
}

export function qoderAccountSet(uid: string, enabled: boolean): Promise<Result<null>> {
  return call('wb_qoder_account_set', { uid, enabled }, '修改账号失败')
}

export function qoderAccountPriority(uid: string, priority: number): Promise<Result<null>> {
  return call('wb_qoder_account_priority', { uid, priority }, '修改优先级失败')
}

export function qoderAccountDelete(uid: string): Promise<Result<null>> {
  return call('wb_qoder_account_delete', { uid }, '删除账号失败')
}

/** 导出账号：返回一段含明文 token 的 JSON，交给用户自己保管 */
export function qoderAccountsExport(): Promise<Result<string>> {
  return call('wb_qoder_accounts_export', {}, '导出账号失败')
}

/** 导入账号；`overwrite=false` 时同 uid 跳过 */
export function qoderAccountsImport(payload: string, overwrite: boolean): Promise<Result<QoderAccountImport>> {
  return call('wb_qoder_accounts_import', { payload, overwrite }, '导入账号失败')
}

export function qoderAccountNames(): Promise<Result<Record<string, string>>> {
  return call('wb_qoder_account_names', {}, '读取账号名称失败')
}

export function qoderModels(): Promise<Result<QoderModelInfo[]>> {
  return call('wb_qoder_models', {}, '读取模型清单失败')
}

export function qoderModelsRefresh(): Promise<Result<QoderModelInfo[]>> {
  return call('wb_qoder_models_refresh', {}, '拉取模型目录失败')
}

export function qoderAccess(): Promise<Result<QoderAccess>> {
  return call('wb_qoder_access', {}, '读取接入信息失败')
}

export function qoderRotateKey(): Promise<Result<string>> {
  return call('wb_qoder_rotate_key', {}, '重新生成密钥失败')
}

export function qoderUsage(days: number): Promise<Result<GatewayUsageSummary>> {
  return call('wb_qoder_usage', { days }, '读取用量失败')
}

export function qoderUsageRows(days: number): Promise<Result<QoderUsageWindow>> {
  return call('wb_qoder_usage_rows', { days }, '读取用量失败')
}

export function qoderUsageRecent(limit: number): Promise<Result<GatewayUsageRow[]>> {
  return call('wb_qoder_usage_recent', { limit }, '读取最近请求失败')
}

export function qoderPerksStatus(uid?: string): Promise<Result<QoderTaskSnapshot[]>> {
  return call('wb_qoder_perks_status', { uid: uid ?? null }, '读取签到状态失败')
}

export function qoderCheckin(uid: string): Promise<Result<QoderClaimResult>> {
  return call('wb_qoder_checkin', { uid }, '签到失败')
}

export function qoderClaimCampaigns(uid: string): Promise<Result<QoderClaimResult>> {
  return call('wb_qoder_claim_campaigns', { uid }, '领取活动失败')
}

export function qoderCreditHeatmap(uid: string): Promise<Result<QoderHeatmapPoint[]>> {
  return call('wb_qoder_credit_heatmap', { uid }, '读取积分消耗失败')
}

export function qoderActivityToday(): Promise<Result<QoderActivityRow[]>> {
  return call('wb_qoder_activity_today', {}, '读取今日签到记录失败')
}

/** 最近 N 天每天领到的积分（本机 + 同步仓库里别的设备，按日合并去重） */
export function qoderEarnings(days: number, repo = '', device = ''): Promise<Result<QoderEarningPoint[]>> {
  return call('wb_qoder_earnings', { days, repo, device }, '读取积分获取记录失败')
}

/** 把本机领取记录推进同步仓库（只推成功领取的脱敏行） */
export function publishQoderEarnings(repo: string, device: string): Promise<Result<unknown>> {
  return call('qoder_earnings_publish', { repo, device }, '同步领取记录失败')
}

/** 只刷新同步克隆，读完重读领取记录 */
export function pullQoderEarnings(repo: string): Promise<Result<unknown>> {
  return call('qoder_earnings_pull', { repo }, '拉取领取记录失败')
}

export function qoderPerksAutoConfig(): Promise<Result<QoderPerksAutoConfig>> {
  return call('wb_qoder_perks_auto_config', {}, '读取自动签到开关失败')
}

export function qoderPerksAutoSet(enabled: boolean): Promise<Result<QoderPerksAutoConfig>> {
  return call('wb_qoder_perks_auto_set', { enabled }, '保存自动签到开关失败')
}

export function qoderPerksAutoRun(): Promise<Result<QoderPerksAutoRun>> {
  return call('wb_qoder_perks_auto_run', {}, '自动签到失败')
}

/** 展开进 `window.workbench` 的那一组方法 */
export const qoderApi = {
  qoderStatus,
  qoderStart,
  qoderStop,
  qoderAutoStartSet,
  qoderAccounts,
  qoderReload,
  qoderLoginStart,
  qoderLoginPoll,
  qoderCredits,
  qoderAccountSet,
  qoderAccountPriority,
  qoderAccountDelete,
  qoderAccountsExport,
  qoderAccountsImport,
  qoderAccountNames,
  qoderModels,
  qoderModelsRefresh,
  qoderAccess,
  qoderRotateKey,
  qoderUsage,
  qoderUsageRows,
  qoderUsageRecent,
  qoderPerksStatus,
  qoderCheckin,
  qoderClaimCampaigns,
  qoderCreditHeatmap,
  qoderActivityToday,
  qoderEarnings,
  publishQoderEarnings,
  pullQoderEarnings,
  qoderPerksAutoConfig,
  qoderPerksAutoSet,
  qoderPerksAutoRun,
}
