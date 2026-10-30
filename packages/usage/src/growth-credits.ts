/**
 * 成长积分流水 —— 福利页那张「近一个月每天积分」的柱状图。
 *
 * 上游的积分是**逐包记账**：签到、成长任务、猫猫旅行各发一个资源包，包上带发放时刻
 * （`CreateTime`，毫秒）与 `grantSource`。Rust 只把包原样搬回来；「哪些包算福利、
 * 按发放日相加、裁最近 N 天、缺的补 0」这些口径留在这里 —— 与网关用量那张时序图
 * 同一条分工（见 `gateway-usage.ts` 的文件头）。
 *
 * 日期按 **UTC+8** 的墙钟切（上游的发放时刻按北京时间），不读本机时区：机器设在
 * 别的时区时，凌晨的包不会被算到前一天。
 */

/** 一次积分发放（`get-user-resource` 的一个资源包） */
export interface GrowthCreditGrant {
  /** 发放时刻（Unix 秒） */
  createdAt: number
  /** 这个包一共发了多少积分（不是剩余） */
  credit: number
  /** 上游的 `grantSource`（`daily_checkin` / `growth_task_*` / `growth_travel`…） */
  source: string
  /** 包名：没有 `grantSource` 的包（如「国内运营裂变包」里的一部分）靠它认 */
  name: string
  /** `grantReason` 属性（有的包有，有的没有） */
  reason: string
}

/** 一份流水（只取合并要用的那一段；账号名、错误原因归适配层） */
export interface GrowthCreditSource {
  grants: GrowthCreditGrant[]
}

/** 按发放日汇总后的一天 */
export interface GrowthCreditDay {
  date: string
  credit: number
  active: boolean
}

/** 福利页固定看最近 30 天（含今天） */
export const GROWTH_CREDIT_DAYS = 30

const HOUR_SECS = 3600
const DAY_MS = 86_400_000

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Unix 秒 → UTC+8 的日期键（`YYYY-MM-DD`） */
function utc8DayKey(ts: number): string {
  const date = new Date((ts + 8 * HOUR_SECS) * 1000)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** 日期键 → 「浮动的 UTC 零点」，只用来按天加减，不参与时区换算 */
function dayMs(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function msDayKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** 一个包上判断福利积分要用的三样（余额快照与发放流水共用） */
export interface GrowthPerkLike {
  source: string
  name: string
  reason: string
}

/**
 * 这个包算不算「福利积分」：福利栏「已获取福利总积分」与柱状图共用这一条口径 ——
 * 由签到 / 成长任务 / 旅行发放（`grantSource`），或包名带「裂变」，
 * 或 `grantReason` 里写着签到 / 成长 / 活动 / 裂变。
 * 拉新权益包、个人体验版那类一次性赠送不算：否则第一天的礼包会把整月的柱子压平。
 */
export function isGrowthPerkPackage(item: GrowthPerkLike): boolean {
  const source = item.source.toLowerCase()
  if (source.startsWith('daily_checkin') || source.startsWith('growth_task') || source.startsWith('growth_travel'))
    return true
  if (item.name.includes('裂变'))
    return true
  return ['签到', '成长', '活动', '裂变'].some(word => item.reason.includes(word))
}

/** 发放流水里的一个包（见 [`isGrowthPerkPackage`]） */
export function isGrowthPerk(grant: GrowthCreditGrant): boolean {
  return isGrowthPerkPackage({ source: grant.source, name: grant.name, reason: grant.reason })
}

/**
 * 把当前范围内的积分发放按发放日相加，铺成最近 `days` 天的连续序列（旧→新）。
 *
 * - `now` 是当前时刻（Unix 秒），默认取本机时钟；窗口的最后一天是它按 UTC+8 的那一天；
 * - 只算福利包（`isGrowthPerk`），非福利的包不进图；
 * - 缺的日期补 0；负分与非有限值当成没有。
 */
export function dailyGrowthCredits(
  sources: GrowthCreditSource[],
  days: number = GROWTH_CREDIT_DAYS,
  now: number = Date.now() / 1000,
): GrowthCreditDay[] {
  const count = Number.isFinite(days) && days > 0 ? Math.floor(days) : GROWTH_CREDIT_DAYS
  const end = utc8DayKey(Number.isFinite(now) ? now : Date.now() / 1000)
  const endMs = dayMs(end)
  const startMs = endMs - (count - 1) * DAY_MS
  const start = msDayKey(startMs)

  const totals = new Map<string, number>()
  for (const source of sources) {
    for (const grant of source.grants) {
      if (!Number.isFinite(grant.createdAt) || grant.createdAt <= 0)
        continue
      if (!isGrowthPerk(grant))
        continue
      const date = utc8DayKey(grant.createdAt)
      if (date < start || date > end)
        continue
      const credit = Number.isFinite(grant.credit) && grant.credit > 0 ? grant.credit : 0
      totals.set(date, (totals.get(date) ?? 0) + credit)
    }
  }

  const result: GrowthCreditDay[] = []
  for (let index = 0; index < count; index += 1) {
    const date = msDayKey(startMs + index * DAY_MS)
    const credit = totals.get(date) ?? 0
    result.push({ date, credit, active: credit > 0 })
  }
  return result
}
