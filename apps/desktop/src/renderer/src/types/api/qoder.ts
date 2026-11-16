/**
 * `window.workbench` 上的一组通道：Qoder（国内版反代）。
 * 实现见 `workbench/qoder.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  GatewayUsageRow,
  QoderAccess,
  QoderAccount,
  QoderAccountImport,
  QoderActivityRow,
  QoderClaimResult,
  QoderCredits,
  QoderEarningPoint,
  QoderLoginPoll,
  QoderLoginStart,
  QoderModelInfo,
  QoderPerksAutoConfig,
  QoderPerksAutoRun,
  QoderStatus,
  QoderTaskSnapshot,
  QoderUsageWindow,
} from '../index'

export interface QoderChannel {
  /** Qoder（国内版反代）。端口与密钥与 TBuddy 共用，两个代理同时只能跑一个。 */
  qoderStatus: () => Promise<Result<QoderStatus>>

  qoderStart: (port: number) => Promise<Result<number>>

  qoderStop: () => Promise<Result<null>>

  qoderAutoStartSet: (enabled: boolean) => Promise<Result<null>>

  qoderAccounts: () => Promise<Result<QoderAccount[]>>

  qoderReload: () => Promise<Result<null>>

  qoderLoginStart: () => Promise<Result<QoderLoginStart>>

  qoderLoginPoll: (loginState: string) => Promise<Result<QoderLoginPoll>>

  qoderCredits: (uid: string) => Promise<Result<QoderCredits>>

  qoderAccountSet: (uid: string, enabled: boolean) => Promise<Result<null>>

  qoderAccountPriority: (uid: string, priority: number) => Promise<Result<null>>

  qoderAccountDelete: (uid: string) => Promise<Result<null>>

  /** 导出 Qoder 账号：返回一段含明文 token 的 JSON，交给用户自己保管 */
  qoderAccountsExport: () => Promise<Result<string>>

  /** 导入 Qoder 账号；`overwrite=false` 时同 uid 跳过 */
  qoderAccountsImport: (payload: string, overwrite: boolean) => Promise<Result<QoderAccountImport>>

  qoderAccountNames: () => Promise<Result<Record<string, string>>>

  qoderModels: () => Promise<Result<QoderModelInfo[]>>

  qoderModelsRefresh: () => Promise<Result<QoderModelInfo[]>>

  qoderAccess: () => Promise<Result<QoderAccess>>

  qoderRotateKey: () => Promise<Result<string>>

  qoderUsageRows: (days: number) => Promise<Result<QoderUsageWindow>>

  qoderUsageRecent: (limit: number) => Promise<Result<GatewayUsageRow[]>>

  qoderPerksStatus: (uid?: string) => Promise<Result<QoderTaskSnapshot[]>>

  qoderCheckin: (uid: string) => Promise<Result<QoderClaimResult>>

  qoderClaimCampaigns: (uid: string) => Promise<Result<QoderClaimResult>>

  qoderActivityToday: () => Promise<Result<QoderActivityRow[]>>

  qoderEarnings: (days: number) => Promise<Result<QoderEarningPoint[]>>

  qoderEarningsPublish: () => Promise<Result<unknown>>

  qoderEarningsPull: () => Promise<Result<unknown>>

  qoderPerksAutoConfig: () => Promise<Result<QoderPerksAutoConfig>>

  qoderPerksAutoSet: (enabled: boolean) => Promise<Result<QoderPerksAutoConfig>>

  qoderPerksAutoRun: () => Promise<Result<QoderPerksAutoRun>>
}
