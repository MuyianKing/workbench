import { describe, expect, it } from 'vitest'
import { creditExpiry, creditExpiryDate } from './credit-expiry'

/** `2026-11-03 10:00` 这种 UTC+8 墙钟 → Unix 秒 */
function utc8(text: string): number {
  const [date, clock] = text.split(' ')
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = clock.split(':').map(Number)
  return Date.UTC(year, month - 1, day, hour - 8, minute) / 1000
}

/** 2026-11-03 10:00 UTC+8 */
const NOW = utc8('2026-11-03 10:00')

describe('creditExpiry', () => {
  it('无期限与企业周期重置都不催动作', () => {
    expect(creditExpiry({ expiresAt: null, noExpiry: true }, NOW))
      .toEqual({ tier: 'plain', hint: '无期限', days: null })
    // 企业额度带周期结束日，但那是回满不是作废
    expect(creditExpiry({ expiresAt: utc8('2026-12-01 00:00'), noExpiry: true }, NOW, { enterprise: true }))
      .toEqual({ tier: 'plain', hint: '周期重置', days: null })
  })

  it('上游没给到期时间就是未知，不猜', () => {
    expect(creditExpiry({ expiresAt: null, noExpiry: false }, NOW))
      .toEqual({ tier: 'unknown', hint: '到期未知', days: null })
  })

  it('已过可抵扣窗口算已过期', () => {
    const verdict = creditExpiry({ expiresAt: NOW - 1, noExpiry: false }, NOW)
    expect(verdict.tier).toBe('expired')
    expect(verdict.hint).toBe('已过期')
  })

  it('按 UTC+8 自然日切档：今晚到期是今天，明天凌晨是明天', () => {
    expect(creditExpiry({ expiresAt: utc8('2026-11-03 23:59'), noExpiry: false }, NOW))
      .toMatchObject({ tier: 'today', hint: '今日到期', days: 0 })
    // 只差 14 小时（毫秒差还不到一天），但自然日已经是明天
    expect(creditExpiry({ expiresAt: utc8('2026-11-04 00:30'), noExpiry: false }, NOW))
      .toMatchObject({ tier: 'd3', hint: '剩 1 天', days: 1 })
  })

  it('3 / 5 / 10 天是闭区间边界', () => {
    const tier = (text: string): string =>
      creditExpiry({ expiresAt: utc8(text), noExpiry: false }, NOW).tier
    expect(tier('2026-11-06 10:00')).toBe('d3') // 3 天
    expect(tier('2026-11-07 10:00')).toBe('d5') // 4 天
    expect(tier('2026-11-08 10:00')).toBe('d5') // 5 天
    expect(tier('2026-11-09 10:00')).toBe('d10') // 6 天
    expect(tier('2026-11-13 10:00')).toBe('d10') // 10 天
    expect(tier('2026-11-14 10:00')).toBe('far') // 11 天
  })
})

describe('creditExpiryDate', () => {
  it('按 UTC+8 出日期键，不跟随本机时区', () => {
    expect(creditExpiryDate(utc8('2026-11-04 00:30'))).toBe('2026-11-04')
    expect(creditExpiryDate(utc8('2026-11-03 23:59'))).toBe('2026-11-03')
  })
})
