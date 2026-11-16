/**
 * `window.workbench` 上的一组通道：网关（CodeBuddy 反代）。
 * 实现见 `workbench/gateway.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  GatewayAccess,
  GatewayAccount,
  GatewayAccountImport,
  GatewayActionResult,
  GatewayActivityRow,
  GatewayCredits,
  GatewayGrantAccount,
  GatewayLoginPoll,
  GatewayLoginStart,
  GatewayModelInfo,
  GatewayPerksAutoConfig,
  GatewayPerksAutoRun,
  GatewayPullResult,
  GatewayStatus,
  GatewaySyncResult,
  GatewaySyncStatus,
  GatewayTaskRun,
  GatewayTasksSnapshot,
  GatewayUsageRow,
  GatewayUsageWindow,
} from '../index'

export interface GatewayChannel {
  /**
   * 网关（CodeBuddy 反代）。
   *
   * 这一段整体是新增的一处**网络出口**：只有用户自己点「登录」或「启动」之后才会
   * 连上游；默认不启动、不监听。账号视图里不含 token，余额查询是显式动作
   * （原项目把它做成了一个带副作用的 GET）。
   */
  gatewayStatus: () => Promise<Result<GatewayStatus>>

  gatewayStart: (port: number) => Promise<Result<number>>

  gatewayStop: () => Promise<Result<null>>

  /** 「随程序启动」：只改配置，下次应用启动时生效 */
  gatewayAutoStartSet: (enabled: boolean) => Promise<Result<null>>

  gatewayAccounts: () => Promise<Result<GatewayAccount[]>>

  gatewayReload: () => Promise<Result<null>>

  gatewayLoginStart: () => Promise<Result<GatewayLoginStart>>

  gatewayLoginPoll: (loginState: string) => Promise<Result<GatewayLoginPoll>>

  gatewayCredits: (uid: string) => Promise<Result<GatewayCredits>>

  gatewayModels: () => Promise<Result<GatewayModelInfo[]>>

  /** 从上游拉一次真实目录并落盘（手动触发，没有定时器） */
  gatewayModelsRefresh: () => Promise<Result<GatewayModelInfo[]>>

  gatewayAccess: () => Promise<Result<GatewayAccess>>

  gatewayRotateKey: () => Promise<Result<string>>

  gatewayUsageRows: (days: number) => Promise<Result<GatewayUsageWindow>>

  gatewayUsageRecent: (limit: number) => Promise<Result<GatewayUsageRow[]>>

  /** 手动同步网关流水；`force=false` 时一小时内的重复调用会被节流跳过 */
  gatewayUsageSync: (force?: boolean) => Promise<Result<GatewaySyncResult>>

  /** 只拉一次远端克隆（不推送）；读路径只读本地副本，靠它补上别的机器的新流水 */
  gatewayUsagePull: () => Promise<Result<GatewayPullResult>>

  gatewaySyncStatus: () => Promise<Result<GatewaySyncStatus>>

  gatewayAccountSet: (uid: string, enabled: boolean) => Promise<Result<null>>

  /** 选号优先级：1..=100，数大的先用 */
  gatewayAccountPriority: (uid: string, priority: number) => Promise<Result<null>>

  gatewayAccountDelete: (uid: string) => Promise<Result<null>>

  /** 导出账号：返回一段含明文 token 的 JSON，交给用户自己保管（不进同步仓库） */
  gatewayAccountsExport: () => Promise<Result<string>>

  /** 导入账号；`overwrite=false` 时同 uid 跳过 */
  gatewayAccountsImport: (payload: string, overwrite: boolean) => Promise<Result<GatewayAccountImport>>

  /** 福利页：当前号的成长任务 + 汇总（`uid` 为空取第一个已启用的国内号） */
  gatewayTasks: (uid?: string) => Promise<Result<GatewayTasksSnapshot>>

  /** 一键做任务领积分；`uid` 为空时跑全部已启用的国内账号 */
  gatewayTasksRun: (uid?: string) => Promise<Result<GatewayTaskRun>>

  gatewayTasksTravel: (uid?: string) => Promise<Result<GatewayActionResult[]>>

  gatewayTasksStreak: (uid?: string) => Promise<Result<GatewayActionResult[]>>

  /** Buddy 加油站签到 */
  gatewayCheckin: (uid?: string) => Promise<Result<GatewayActionResult[]>>

  gatewayActivityToday: () => Promise<Result<GatewayActivityRow[]>>

  /** 福利页：积分发放流水（`uid` 为空时取全部已启用账号，界面按发放日汇总近 30 天） */
  gatewayCreditGrants: (uid?: string) => Promise<Result<GatewayGrantAccount[]>>

  /** 福利自动跑：开关（默认关；日期标记由后端维护） */
  gatewayPerksAutoConfig: () => Promise<Result<GatewayPerksAutoConfig>>

  gatewayPerksAutoSet: (enabled: boolean) => Promise<Result<GatewayPerksAutoConfig>>

  /** 按自然日与夜间窗口判断该不该跑；关着时不发请求 */
  gatewayPerksAutoRun: () => Promise<Result<GatewayPerksAutoRun>>
}
