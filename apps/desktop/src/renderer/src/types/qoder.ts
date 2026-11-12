/**
 * Qoder 网关（国内版）的通道载荷类型。
 *
 * 原先定义在 workbench/qoder.ts（实现文件）里，WorkbenchApi 契约为了引用它们只能写
 * `import('./workbench/qoder')` 这种反向依赖；现在类型住在这里（契约侧），
 * 实现文件反过来从 `@/types` re-export，既有的 `from '@/workbench/qoder'` 导入一行不用改。
 */

/** 网关运行状态 */
import type { GatewayUsageRow } from './gateway'

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
