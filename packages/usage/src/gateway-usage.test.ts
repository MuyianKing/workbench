import type { GatewayUsageRowLike } from './gateway-usage'
import { describe, expect, it } from 'vitest'
import { gatewayBucketUnit, recentHourBuckets, summarizeGatewayRows } from './gateway-usage'

function row(overrides: Partial<GatewayUsageRowLike> = {}): GatewayUsageRowLike {
  return {
    ts: 1_792_483_989,
    uid: 'a',
    model: 'm',
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    cachedTokens: 900,
    ttftMs: 100,
    durationMs: 1000,
    ok: true,
    credit: 0.5,
    costCny: 0.01,
    ...overrides,
  }
}

describe('summarizeGatewayRows', () => {
  it('积分只认大于 0 的行，0 与缺字段都不进样本', () => {
    const summary = summarizeGatewayRows([
      row({ credit: 0.5 }),
      row({ credit: 0 }),
      row({ credit: null }),
    ], 'hour')

    expect(summary.requests).toBe(3)
    expect(summary.credits).toBe(0.5)
    expect(summary.creditSamples).toBe(1)
    // 免费与缺积分的 token 都不进分母
    expect(summary.creditTokens).toBe(1100)
    expect(summary.creditsPer1MTokens).toBeCloseTo(0.5 / 1100 * 1_000_000)
  })

  it('命中率与分数各算各的', () => {
    const summary = summarizeGatewayRows([
      row({ uid: 'a', promptTokens: 1000, cachedTokens: 900 }),
      row({ uid: 'a', promptTokens: 1000, cachedTokens: 0 }),
      row({ uid: 'b', promptTokens: 500, cachedTokens: 100 }),
    ], 'hour')

    expect(summary.cacheHitPct).toBeCloseTo(1000 / 2500 * 100)
    const a = summary.byAccount.find(item => item.uid === 'a')
    expect(a?.cacheHitPct).toBeCloseTo(45)
    expect(a?.requests).toBe(2)
    const b = summary.byAccount.find(item => item.uid === 'b')
    expect(b?.cacheHitPct).toBeCloseTo(20)
  })

  it('按小时分桶并补满空档', () => {
    const base = 1_792_483_989 // 2026-10-20 16:13:09 UTC+8
    const summary = summarizeGatewayRows([
      row({ ts: base }),
      row({ ts: base + 3 * 3600 }),
    ], 'hour')

    expect(summary.byBucket.map(item => item.bucket)).toEqual([
      '2026-10-20 16',
      '2026-10-20 17',
      '2026-10-20 18',
      '2026-10-20 19',
    ])
    expect(summary.byBucket[1].requests).toBe(0)
    expect(summary.byBucket[1].totalTokens).toBe(0)
  })

  it('按天分桶只写日期', () => {
    const summary = summarizeGatewayRows([row()], 'day')
    expect(summary.byBucket[0].bucket).toBe('2026-10-20')
    expect(summary.bucketUnit).toBe('day')
  })

  it('吐字速度按整段耗时算', () => {
    const summary = summarizeGatewayRows([
      row({ completionTokens: 100, durationMs: 2000, ttftMs: 1000 }),
    ], 'hour')
    expect(summary.tokensPerSec).toBeCloseTo(50)
    const account = summary.byAccount[0]
    expect(account.tokensPerSec).toBeCloseTo(50)
    expect(account.avgTtftMs).toBe(1000)
    // 模型档与账号档同一套字段：明细表只有一张，切到按模型时不缺列
    const model = summary.byModel[0]
    expect(model.tokensPerSec).toBeCloseTo(50)
    expect(model.avgTtftMs).toBe(1000)
    expect(model.failed).toBe(0)
  })

  it('失败数与首字延迟按组统计，模型档也有', () => {
    const summary = summarizeGatewayRows([
      row({ model: 'm1', ok: false, ttftMs: 0 }),
      row({ model: 'm1', ok: true, ttftMs: 600 }),
      row({ model: 'm2', ok: true }),
    ], 'hour')

    const m1 = summary.byModel.find(item => item.model === 'm1')
    expect(m1?.requests).toBe(2)
    expect(m1?.failed).toBe(1)
    expect(m1?.avgTtftMs).toBe(600)
  })

  it('窗口决定分桶粒度', () => {
    expect(gatewayBucketUnit(1)).toBe('hour')
    expect(gatewayBucketUnit(7)).toBe('hour')
    expect(gatewayBucketUnit(30)).toBe('day')
  })
})

describe('recentHourBuckets', () => {
  // 2026-10-20 16:00:00 UTC+8
  const hourStart = 1_792_483_200

  it('固定 24 格，从当前小时往前数，空档补 0', () => {
    const buckets = recentHourBuckets([], 24, hourStart + 13 * 60 + 9)
    expect(buckets).toHaveLength(24)
    expect(buckets[0].bucket).toBe('2026-10-19 17')
    expect(buckets[23].bucket).toBe('2026-10-20 16')
    expect(buckets.every(item => item.totalTokens === 0)).toBe(true)
  })

  it('窗口内的行按小时落格，窗口外的不算', () => {
    const buckets = recentHourBuckets([
      row({ ts: hourStart - 25 * 3600, totalTokens: 999 }),
      row({ ts: hourStart - 23 * 3600, totalTokens: 10 }),
      row({ ts: hourStart + 30, totalTokens: 5 }),
    ], 24, hourStart + 60)

    expect(buckets[0].totalTokens).toBe(10)
    expect(buckets[0].requests).toBe(1)
    expect(buckets[23].totalTokens).toBe(5)
    expect(buckets.reduce((sum, item) => sum + item.totalTokens, 0)).toBe(15)
  })
})
