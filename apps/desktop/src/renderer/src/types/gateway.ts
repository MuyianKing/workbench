/**
 * TBuddy 网关（CodeBuddy 反代）的通道载荷类型。
 *
 * 原先定义在 workbench/gateway.ts（实现文件）里，WorkbenchApi 契约为了引用它们只能写
 * `import('./workbench/gateway')` 这种反向依赖；现在类型住在这里（契约侧），
 * 实现文件反过来从 `@/types` re-export，既有的 `from '@/workbench/gateway'` 导入一行不用改。
 */

/** 网关运行状态 */
/** 一个账号的积分发放流水（界面按发放日汇总成近一个月） */
import type { GrowthCreditGrant } from '@workbench/usage'

export interface GatewayStatus {
  running: boolean
  port: number
  /** 未运行时为 null：地址跟着监听走，没监听就没有地址 */
  baseUrl: string | null
  accounts: number
  ready: number
  /** 设置·通用里的「随程序启动」开关 */
  autoStart: boolean
}

/** 账号行（不含任何凭据） */
export interface GatewayAccount {
  uid: string
  label: string
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

/** 导入结果：新增 / 覆盖 / 跳过各几个 */
export interface GatewayAccountImport {
  added: number
  updated: number
  skipped: number
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
  /** 发放原因（上游 `AccountAttributes.grantReason`），没给是空串 */
  grantReason: string
  /** 发放来源（上游 `AccountAttributes.grantSource`：`daily_checkin` / `growth_task_*`…），没给是空串 */
  grantSource: string
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

/**
 * 一段流水：统计窗口的起点 + 覆盖到它的行（旧→新）。
 *
 * `rows` 里可能比 `since` **更早**：时序图固定看最近 24 小时，取数窗口至少铺满它，
 * 而「今日」的自然日窗口在上午比 24 小时短。KPI 与明细表要按 `since` 再裁一次。
 */
export interface GatewayUsageWindow {
  /** 统计窗口的起点（Unix 秒，UTC+8 自然日 0 点） */
  since: number
  rows: GatewayUsageRow[]
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

/** 只拉一次克隆的结果；`skipped=true` 表示一分钟内刚拉过，这次没走 git */
export interface GatewayPullResult {
  pulled: boolean
  changed: boolean
  skipped?: boolean
}

/** 一个成长任务 */
export interface GatewayGrowthTask {
  taskCode: string
  name: string
  description: string
  jumpUrl: string
  /** `not_accepted` / `accepted` / `completed` / `claimed`… */
  status: string
  taskType: string
  current: number
  target: number
  rewardCredit: number
  rewardEnergy: number
  /** 需真实操作才能完成，事件伪造不会推进度 */
  unforgeable: boolean
  reason: string
}

/** 猫猫旅行状态 */
export interface GatewayTravelState {
  state: string
  dailyLimitReached: boolean
  rewardCredit: number
}

/** 连续打卡 / 补签卡 / 抽奖次数 / 能量 / 猫猫旅行 */
export interface GatewayGrowthSummary {
  energy: number
  streakDays: number
  /** 成长连登 7d 档还差几天 */
  nextTierRemaining: number
  makeupCards: number
  lotteryChances: number
  travel: GatewayTravelState
}

/** Buddy 加油站签到状态（服务端 `checkin-activity-status`） */
export interface GatewayCheckinStatus {
  active: boolean
  checkedInToday: boolean
  /** 当前连续签到天数（从 checkin_dates 算；不是赛季累计） */
  currentStreak: number
  /** 本赛季累计签到天数（上游 `streak_days` 原值） */
  seasonDays: number
  weekDays: number
  todayCredit: number
  totalCredits: number
  activityName: string
}

/** 福利页顶上的账号选项 */
export interface GatewayTaskAccount {
  uid: string
  label: string
}

/** 当前选中账号的成长任务快照 */
export interface GatewayTasksSnapshot {
  tasks: GatewayGrowthTask[]
  summary: GatewayGrowthSummary
  /** Buddy 加油站的签到状态（当前汇总账号） */
  checkin: GatewayCheckinStatus
  /** 这份快照属于哪个号；没有可用账号时是空串 */
  account: string
  accounts: GatewayTaskAccount[]
  msg: string
}

/** 一轮成长任务的执行结果 */
export interface GatewayTaskRun {
  ok: boolean
  logs: string[]
  creditAdded: number
}

/** 签到 / 每日活跃 / 猫猫旅行 / 成长连登：每个号一条 */
export interface GatewayActionResult {
  uid: string
  nickname: string
  ok: boolean
  message: string
  /** 猫猫旅行的动作名，其余动作是空串 */
  action: string
  credit: number
}

/** 今天的一次签到尝试 */
export interface GatewayActivityRow {
  ts: number
  date: string
  uid: string
  nickname: string
  /** `checkin` */
  task: string
  ok: boolean
  message: string
}

export interface GatewayGrantAccount {
  uid: string
  nickname: string
  grants: GrowthCreditGrant[]
  /** 这次没读到时的原因；空串表示读到了 */
  error: string
}

/** 福利自动跑的开关（设置·通用 → TBuddy） */
export interface GatewayPerksAutoConfig {
  enabled: boolean
}

/** 一轮自动跑的结果。`ran` 为 false 表示当前没有该跑的事（已跑过 / 不在夜间窗口）。 */
export interface GatewayPerksAutoRun {
  ran: boolean
  accounts: number
  /** 签到成功（含「今天已签到」）的账号数 */
  checkin: number
  creditAdded: number
  /** 夜间轮推进的账号数 */
  night: number
  /** 这一轮里没成功的动作数（签到 / 任务 / 夜猫子 / 续期） */
  failed: number
  /** 给用户的一句话；空串表示无事发生 */
  message: string
}
