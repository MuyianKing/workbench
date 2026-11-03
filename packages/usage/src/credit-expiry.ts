/**
 * 积分包的到期档位 —— 积分明细弹层用。
 *
 * 上游按包记账，每个包有自己的可抵扣窗口结束时刻（`expiresAt`，Unix 秒）。
 * 这里只回答一个问题：这个包还剩多久、该不该现在花掉。
 *
 * 档位按 **UTC+8 的自然日**切（与上游的墙钟一致，与 `growth-credits` 同一条口径）：
 * 今晚 23:00 到期算「今天」、明天 01:00 算「明天」——
 * 拿毫秒差直接除一天会把后者算成「今天」。
 */

/** 到期档位：越靠前越急 */
export type CreditExpiryTier = 'today' | 'd3' | 'd5' | 'd10' | 'far' | 'expired' | 'unknown' | 'plain'

export interface CreditExpiry {
  tier: CreditExpiryTier
  /** 右侧那枚标签的文案 */
  hint: string
  /** 距到期还有几个自然日；已过期是负数，无期限 / 未知是 null */
  days: number | null
}

/** 判档只需要这两样（`GatewayPackage` 的一个子集） */
export interface CreditExpiryInput {
  /** Unix 秒；null = 上游没给 */
  expiresAt: number | null
  /** `true` = 上游明确表示无期限（企业额度也走这个标记） */
  noExpiry: boolean
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Unix 秒 → UTC+8 自然日序号（只用来算差几天） */
function utc8DayIndex(ts: number): number {
  return Math.floor((ts * 1000 + 8 * HOUR_MS) / DAY_MS)
}

/**
 * 一个包的到期档位。
 *
 * - `plain`：无期限（个人号）或企业额度的周期重置 —— 不催动作；
 * - `unknown`：上游没给到期时间，不拿「现在 + 24 小时」之类去猜；
 * - `expired`：已经过了可抵扣窗口（包可能还有剩余，但花不出去了）；
 * - `today` / `d3` / `d5` / `d10` / `far`：按自然日差切档。
 *
 * `enterprise` 只影响文案：企业额度的包是「周期结束回满」，不是作废。
 */
export function creditExpiry(
  item: CreditExpiryInput,
  now: number,
  options: { enterprise?: boolean } = {},
): CreditExpiry {
  if (item.noExpiry)
    return { tier: 'plain', hint: options.enterprise ? '周期重置' : '无期限', days: null }

  if (item.expiresAt === null)
    return { tier: 'unknown', hint: '到期未知', days: null }

  const days = utc8DayIndex(item.expiresAt) - utc8DayIndex(now)
  if (item.expiresAt <= now)
    return { tier: 'expired', hint: '已过期', days }

  if (days <= 0)
    return { tier: 'today', hint: '今日到期', days }
  if (days <= 3)
    return { tier: 'd3', hint: `剩 ${days} 天`, days }
  if (days <= 5)
    return { tier: 'd5', hint: `剩 ${days} 天`, days }
  if (days <= 10)
    return { tier: 'd10', hint: `剩 ${days} 天`, days }
  return { tier: 'far', hint: `剩 ${days} 天`, days }
}

/** 包上的 Unix 秒 → UTC+8 日期键（`YYYY-MM-DD`），弹层里那列日期用它 */
export function creditExpiryDate(ts: number): string {
  const date = new Date(ts * 1000 + 8 * HOUR_MS)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}
