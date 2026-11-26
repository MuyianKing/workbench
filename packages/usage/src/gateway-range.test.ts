import { describe, expect, it } from 'vitest'
import {
  GATEWAY_RANGE_PRESETS,
  gatewayRangeBounds,
  gatewayUtc8DayKey,
  resolveGatewayRange,
  sanitizeGatewayCustomRange,
} from './gateway-range'

/** 某个 UTC+8 墙钟时刻的 Unix 秒（只做测试锚点，不进实现） */
function at(year: number, month: number, day: number, hour = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8) / 1000
}

describe('gatewayUtc8DayKey', () => {
  it('按 UTC+8 出日期键，不跟随本机时区', () => {
    expect(gatewayUtc8DayKey(at(2026, 11, 25, 12))).toBe('2026-11-25')
    // 北京时间 11-25 00:30 是 UTC 11-24 16:30
    expect(gatewayUtc8DayKey(at(2026, 11, 25, 0))).toBe('2026-11-25')
  })
})

describe('resolveGatewayRange', () => {
  const now = at(2026, 11, 25, 12) // 今天 11-25
  const custom = { fromKey: '2026-11-10', toKey: '2026-11-20' }

  it('旧五档与自然日同口径：今日 / 昨日 / 近 3、7、30 天', () => {
    expect(resolveGatewayRange('today', now, custom)).toEqual({ fromKey: '2026-11-25', toKey: '2026-11-25' })
    expect(resolveGatewayRange('yesterday', now, custom)).toEqual({ fromKey: '2026-11-24', toKey: '2026-11-24' })
    expect(resolveGatewayRange('last3', now, custom)).toEqual({ fromKey: '2026-11-23', toKey: '2026-11-25' })
    expect(resolveGatewayRange('last7', now, custom)).toEqual({ fromKey: '2026-11-19', toKey: '2026-11-25' })
    expect(resolveGatewayRange('last30', now, custom)).toEqual({ fromKey: '2026-10-27', toKey: '2026-11-25' })
  })

  it('本月从月初到今天', () => {
    expect(resolveGatewayRange('thisMonth', at(2026, 11, 25), custom)).toEqual({
      fromKey: '2026-11-01',
      toKey: '2026-11-25',
    })
    // 月初第一天：今天就是 1 号，区间只有一天
    expect(resolveGatewayRange('thisMonth', at(2026, 11, 1), custom)).toEqual({
      fromKey: '2026-11-01',
      toKey: '2026-11-01',
    })
  })

  it('上个月是走完的整月，跨年也认', () => {
    expect(resolveGatewayRange('lastMonth', at(2026, 11, 25), custom)).toEqual({
      fromKey: '2026-10-01',
      toKey: '2026-10-31',
    })
    expect(resolveGatewayRange('lastMonth', at(2026, 1, 15), custom)).toEqual({
      fromKey: '2025-12-01',
      toKey: '2025-12-31',
    })
  })

  it('3 月 31 日退一个月不落到 3 月 3 日', () => {
    expect(resolveGatewayRange('lastMonth', at(2026, 3, 31), custom)).toEqual({
      fromKey: '2026-02-01',
      toKey: '2026-02-28',
    })
  })

  it('闰年的 2 月给到 29 日', () => {
    expect(resolveGatewayRange('lastMonth', at(2028, 3, 5), custom)).toEqual({
      fromKey: '2028-02-01',
      toKey: '2028-02-29',
    })
  })

  it('自定义走传入的区间', () => {
    expect(resolveGatewayRange('custom', now, custom)).toEqual(custom)
  })

  it('选项表含本月、上个月与自定义，且自定义在最后', () => {
    expect(GATEWAY_RANGE_PRESETS.map(item => item.label)).toEqual([
      '今日',
      '昨日',
      '近 3 天',
      '近 7 天',
      '近 30 天',
      '本月',
      '上个月',
      '自定义',
    ])
  })
})

describe('sanitizeGatewayCustomRange', () => {
  const now = at(2026, 11, 25, 12)

  it('交换大小，并把上界钳到今天', () => {
    expect(sanitizeGatewayCustomRange('2026-11-20', '2026-11-10', now)).toEqual({
      fromKey: '2026-11-10',
      toKey: '2026-11-20',
    })
    expect(sanitizeGatewayCustomRange('2026-11-20', '2026-12-31', now)).toEqual({
      fromKey: '2026-11-20',
      toKey: '2026-11-25',
    })
  })

  it('无效日期键回退成今天一天', () => {
    expect(sanitizeGatewayCustomRange('', '2026-11-20', now)).toEqual({
      fromKey: '2026-11-25',
      toKey: '2026-11-25',
    })
    // 2 月 30 日这种被 Date 自动进位的日期也认出来
    expect(sanitizeGatewayCustomRange('2026-02-30', '2026-11-20', now)).toEqual({
      fromKey: '2026-11-25',
      toKey: '2026-11-25',
    })
  })
})

describe('gatewayRangeBounds', () => {
  const now = at(2026, 11, 25, 12) // 今天零点 2026-11-25 00:00 UTC+8

  it('since 是 fromKey 零点，until 是 toKey 次日零点（开区间）', () => {
    const bounds = gatewayRangeBounds({ fromKey: '2026-11-24', toKey: '2026-11-24' }, now)
    expect(bounds.since).toBe(at(2026, 11, 24))
    expect(bounds.until).toBe(at(2026, 11, 25))
    expect(bounds.bucketDays).toBe(1)
  })

  it('fetchDays 让 Rust 的 window_start 恰好落在 since', () => {
    expect(gatewayRangeBounds({ fromKey: '2026-11-25', toKey: '2026-11-25' }, now).fetchDays).toBe(1)
    expect(gatewayRangeBounds({ fromKey: '2026-11-24', toKey: '2026-11-24' }, now).fetchDays).toBe(2)
    expect(gatewayRangeBounds({ fromKey: '2026-11-23', toKey: '2026-11-25' }, now).fetchDays).toBe(3)
    // 上个月首日：10-01 到 11-25 共 56 天，fetchDays = 56
    expect(gatewayRangeBounds({ fromKey: '2026-10-01', toKey: '2026-10-31' }, now).fetchDays).toBe(56)
  })

  it('bucketDays 是区间真实跨度，给 gatewayBucketUnit 定粒度', () => {
    expect(gatewayRangeBounds({ fromKey: '2026-11-25', toKey: '2026-11-25' }, now).bucketDays).toBe(1)
    expect(gatewayRangeBounds({ fromKey: '2026-11-19', toKey: '2026-11-25' }, now).bucketDays).toBe(7)
    expect(gatewayRangeBounds({ fromKey: '2026-10-01', toKey: '2026-10-31' }, now).bucketDays).toBe(31)
  })

  it('自定义跨一整年的区间也能换算', () => {
    const bounds = gatewayRangeBounds({ fromKey: '2025-11-25', toKey: '2026-11-25' }, now)
    expect(bounds.fetchDays).toBe(366)
    expect(bounds.bucketDays).toBe(366)
  })
})
