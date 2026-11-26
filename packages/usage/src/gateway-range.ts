/**
 * 网关用量页的时间范围。
 *
 * 页面顶上那一排药丸（今日 / 昨日 / 近 N 天 / 上个月 / 自定义）只回答「看哪段」，
 * 与 Rust 侧 `wb_usage::window_start(days)` 的窗口模型对齐：**UTC+8 自然日**，
 * 一段区间就是 `[fromKey, toKey]` 两头都含的日期键。
 *
 * Rust 的命令只收一个 `days`（从今天零点往前数几天，含今天），不收起止日期。
 * 任意一段区间都能换算成等价的 `fetchDays`：让 `window_start(fetchDays)` 落在 `fromKey`
 * 当日零点 —— `fetch_start` 只会更早（给最近 24 小时图留数据），所以这段区间里的行
 * 一定都被取回来了。组件用自己算出的 `since` / `until` 再裁一次，Rust 与契约都不用动。
 *
 * 「本月」「上个月」「自定义」与 token 用量页那套预设同口径（「上个月」先挪到 1 号再退月，避开 3/31→3/3），
 * 但这一页的档位固定、也不持久化：每次刷新都按当前时钟重算，跨过午夜自动跟着走。
 */

/** 时间档位。自定义那一档的区间由调用方保留并传进来 */
export type GatewayRangePreset
  = | 'today'
    | 'yesterday'
    | 'last3'
    | 'last7'
    | 'last30'
    | 'thisMonth'
    | 'lastMonth'
    | 'custom'

/** 选项表直接喂给 `el-segmented`，自定义放最后 */
export const GATEWAY_RANGE_PRESETS: ReadonlyArray<{ value: GatewayRangePreset, label: string }> = [
  { value: 'today', label: '今日' },
  { value: 'yesterday', label: '昨日' },
  { value: 'last3', label: '近 3 天' },
  { value: 'last7', label: '近 7 天' },
  { value: 'last30', label: '近 30 天' },
  { value: 'thisMonth', label: '本月' },
  { value: 'lastMonth', label: '上个月' },
  { value: 'custom', label: '自定义' },
]

/** 一段 UTC+8 自然日区间（含两端），日期键是 `YYYY-MM-DD` */
export interface GatewayRange {
  fromKey: string
  toKey: string
}

/** 区间换算出的几个窗口边界，Unix 秒（除 `fetchDays` / `bucketDays`） */
export interface GatewayRangeBounds {
  /** `fromKey` 当日零点（UTC+8） */
  since: number
  /** `toKey` 次日零点（UTC+8），统计时是开区间上界 */
  until: number
  /** 传给 Rust 的窗口天数，使 `window_start(fetchDays) == since` */
  fetchDays: number
  /** 区间真实跨度天数，给 `gatewayBucketUnit` 定粒度 */
  bucketDays: number
}

const HOUR_SECS = 3600
const DAY_SECS = 86_400
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Unix 秒 → UTC+8 日期键（`YYYY-MM-DD`），与分桶 / 积分总账同一条墙钟口径 */
export function gatewayUtc8DayKey(ts: number): string {
  const date = new Date((ts + 8 * HOUR_SECS) * 1000)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** 日期键 → UTC+8 当日零点的 Unix 秒；无效日期键返回 null */
function dayStartSec(key: string): number | null {
  if (!DATE_KEY.test(key))
    return null
  const [year, month, day] = key.split('-').map(Number)
  const ms = Date.UTC(year, month - 1, day)
  // 拒绝 2026-02-30 这种被 Date 自动进位的日期
  if (gatewayUtc8DayKey(ms / 1000) !== key)
    return null
  return ms / 1000 - 8 * HOUR_SECS
}

/** 月初（`YYYY-MM-01`）往前退一个自然月，跨年交给 Date 自己进位 */
function shiftMonthFirst(key: string, delta: number): string {
  const [year, month] = key.slice(0, 7).split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-01`
}

/** 上个月的首尾两天：先把锚点挪到 1 号再退月，否则 3/31 退一个月会落到 3/3 */
function lastMonthRange(now: number): GatewayRange {
  const today = gatewayUtc8DayKey(now)
  const first = shiftMonthFirst(today, -1)
  const [year, month] = first.slice(0, 7).split('-').map(Number)
  const last = gatewayUtc8DayKey(Date.UTC(year, month, 0) / 1000)
  return { fromKey: first, toKey: last }
}

/**
 * 收敛自定义区间：校验两头日期键、交换大小、把上界钳到今天（未来的日子没有数据）。
 * 任意一头无效时回退成今天一天，不让界面拿一段坏区间去取数。
 */
export function sanitizeGatewayCustomRange(fromKey: string, toKey: string, now: number): GatewayRange {
  const today = gatewayUtc8DayKey(now)
  const from = dayStartSec(fromKey)
  const to = dayStartSec(toKey)
  if (from === null || to === null)
    return { fromKey: today, toKey: today }
  const lowKey = from <= to ? fromKey : toKey
  const highKey = from <= to ? toKey : fromKey
  return { fromKey: lowKey, toKey: highKey > today ? today : highKey }
}

/**
 * 预设 → UTC+8 日期区间（含两端）。`now` 是 Unix 秒。
 * 旧五档与原实现等价：昨日 = 今天的前一天，近 N 天 = 今天往前 N-1 天到今天。
 */
export function resolveGatewayRange(
  preset: GatewayRangePreset,
  now: number,
  custom: GatewayRange,
): GatewayRange {
  const today = gatewayUtc8DayKey(now)
  switch (preset) {
    case 'today':
      return { fromKey: today, toKey: today }
    case 'yesterday': {
      const yesterday = gatewayUtc8DayKey(now - DAY_SECS)
      return { fromKey: yesterday, toKey: yesterday }
    }
    case 'last3':
      return { fromKey: gatewayUtc8DayKey(now - 2 * DAY_SECS), toKey: today }
    case 'last7':
      return { fromKey: gatewayUtc8DayKey(now - 6 * DAY_SECS), toKey: today }
    case 'last30':
      return { fromKey: gatewayUtc8DayKey(now - 29 * DAY_SECS), toKey: today }
    case 'thisMonth':
      return { fromKey: `${today.slice(0, 7)}-01`, toKey: today }
    case 'lastMonth':
      return lastMonthRange(now)
    case 'custom':
      return sanitizeGatewayCustomRange(custom.fromKey, custom.toKey, now)
  }
}

/**
 * 区间 → Rust 命令参数与统计边界。
 *
 * `fetchDays` 取「今天零点 - fromKey 零点」的天数加一，正好让 Rust 的
 * `window_start(fetchDays)` 落在 `since`（`days = 1` 是今天，所以加一）。
 * 自定义区间可能跨越未来，`until` 已是钳过的上界。
 */
export function gatewayRangeBounds(range: GatewayRange, now: number): GatewayRangeBounds {
  // `gatewayUtc8DayKey(now)` 一定是合法日期键，`dayStartSec` 不会失败
  const todayStart = dayStartSec(gatewayUtc8DayKey(now)) ?? 0
  const since = dayStartSec(range.fromKey) ?? todayStart
  const until = (dayStartSec(range.toKey) ?? todayStart) + DAY_SECS
  return {
    since,
    until,
    fetchDays: Math.max(1, Math.round((todayStart - since) / DAY_SECS) + 1),
    bucketDays: Math.max(1, Math.round((until - since) / DAY_SECS)),
  }
}
