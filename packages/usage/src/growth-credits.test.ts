import type { GrowthCreditGrant } from './growth-credits'
import { describe, expect, it } from 'vitest'
import { dailyGrowthCredits } from './growth-credits'

/** 2026-10-29 10:00 UTC+8 的 Unix 秒 */
const NOW = Date.UTC(2026, 9, 29, 2) / 1000

function grant(overrides: Partial<GrowthCreditGrant> = {}): GrowthCreditGrant {
  return {
    // 2026-10-29 00:30 UTC+8
    createdAt: Date.UTC(2026, 9, 28, 16, 30) / 1000,
    credit: 100,
    source: 'daily_checkin',
    name: 'CodeBuddy个人版国内运营裂变包',
    reason: '',
    ...overrides,
  }
}

describe('dailyGrowthCredits', () => {
  it('按发放日（UTC+8）相加，窗口是最近 30 天含今天', () => {
    const days = dailyGrowthCredits([
      {
        grants: [
          grant(),
          grant({ credit: 5, source: 'growth_travel' }),
        ],
      },
      {
        grants: [
          grant(),
          // 2026-10-28 00:00 UTC+8
          grant({ createdAt: Date.UTC(2026, 9, 27, 16, 0) / 1000, credit: 2 }),
        ],
      },
    ], 30, NOW)

    expect(days).toHaveLength(30)
    expect(days[0].date).toBe('2026-09-30')
    expect(days.at(-1)).toEqual({ date: '2026-10-29', credit: 205, active: true })
    expect(days.find(item => item.date === '2026-10-28')).toEqual({
      date: '2026-10-28',
      credit: 2,
      active: true,
    })
    expect(days.find(item => item.date === '2026-10-01')).toEqual({
      date: '2026-10-01',
      credit: 0,
      active: false,
    })
  })

  it('凌晨的包按 UTC+8 落到当天，不按本机时区', () => {
    // 2026-10-29 00:30 UTC+8 就是 10-28 16:30 UTC
    const days = dailyGrowthCredits([{ grants: [grant({ credit: 7 })] }], 30, NOW)
    expect(days.at(-1)).toEqual({ date: '2026-10-29', credit: 7, active: true })
  })

  it('窗口外的旧包、非福利包与坏数据都不进图', () => {
    const days = dailyGrowthCredits([
      {
        grants: [
          // 2026-09-29 23:59 UTC+8：窗口（09-30 起）之外
          grant({ createdAt: Date.UTC(2026, 8, 29, 15, 59) / 1000, credit: 999 }),
          grant({ credit: 1500, source: 'welcome_gift', name: 'CodeBuddy个人版拉新权益包' }),
          grant({ credit: 500, source: '', name: 'CodeBuddy个人版个人体验版' }),
          grant({ createdAt: Number.NaN, credit: 100 }),
        ],
      },
    ], 30, NOW)
    expect(days.reduce((sum, item) => sum + item.credit, 0)).toBe(0)
  })

  it('没有 grantSource 的裂变包也算福利', () => {
    const days = dailyGrowthCredits([
      { grants: [grant({ credit: 500, source: '', name: 'CodeBuddy个人版国内运营裂变包' })] },
    ], 30, NOW)
    expect(days.at(-1)?.credit).toBe(500)
  })

  it('一条发放都没有时仍铺满日历，由界面给空态', () => {
    const days = dailyGrowthCredits([], 30, NOW)
    expect(days).toHaveLength(30)
    expect(days.every(item => item.credit === 0 && !item.active)).toBe(true)
    expect(days.at(-1)?.date).toBe('2026-10-29')
  })
})
