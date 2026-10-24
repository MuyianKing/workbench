import type { EtfCache } from './etf'
import { describe, expect, it } from 'vitest'
import {
  backfillFrom,
  buildOverview,
  dateKey,
  emptyEtfCache,
  formatDayKey,
  formatYi,
  formatYiNumber,
  isStaleEmptyDate,
  mergeNavInto,
  mergeSharesInto,
  parseNavScript,
  parseSseShares,
  parseSzseShares,
  planSseDates,
  planSzseRanges,
  sanitizeEtfCache,
  szseCoveredThrough,
} from './etf'

function cacheWith(fix: Partial<EtfCache>): EtfCache {
  return { ...emptyEtfCache(), ...fix }
}

// ---------- 上交所份额 ----------

describe('parseSseShares', () => {
  it('把 result 里的万份转成份，只留名单里的沪市代码', () => {
    const body = JSON.stringify({
      result: [
        { SEC_CODE: '510300', SEC_NAME: '沪深300ETF', TOT_VOL: 123456.78 },
        { SEC_CODE: '159919', SEC_NAME: '深市代码不该进来', TOT_VOL: 100 },
        { SEC_CODE: '511990', SEC_NAME: '不在名单里', TOT_VOL: 100 },
        { SEC_CODE: '510050', SEC_NAME: '', TOT_VOL: 0 },
      ],
    })
    expect(parseSseShares(body)).toEqual({ 510300: 123456.78 * 10000 })
  })

  it('结构对但没有数据（节假日 / 未发布）返回空对象而不是 null', () => {
    expect(parseSseShares('{"result":[]}')).toEqual({})
  })

  it('回包不是预期结构（风控页 / 半截 JSON）返回 null', () => {
    expect(parseSseShares('<html>403</html>')).toBeNull()
    expect(parseSseShares('{"unexpected":1}')).toBeNull()
  })
})

// ---------- 深交所份额 ----------

describe('parseSzseShares', () => {
  it('按中文列名宽松认键，剥千分位逗号，只留名单里的深市代码', () => {
    const body = JSON.stringify([
      {
        name: '基金每日规模',
        PagesCount: 3,
        data: [
          { '基金代码': '159919', '基金简称': '沪深300ETF', '基金规模(份)': '9,987,516,676', '日期': '2026-10-23' },
          { '基金代码': '159915', '基金简称': '创业板ETF', '基金规模(份)': '33,759,000,000', '日期': '2026-10-23' },
          { '基金代码': '510300', '基金简称': '沪市代码不该进来', '基金规模(份)': '1', '日期': '2026-10-23' },
          { '基金代码': '159901', '基金简称': '全角逗号也剥', '基金规模(份)': '1，234', '日期': '2026/10/22' },
        ],
      },
    ])
    const parsed = parseSzseShares(body)
    expect(parsed).not.toBeNull()
    expect(parsed?.pages).toBe(3)
    expect(parsed?.days['20261023']).toEqual({ 159919: 9987516676, 159915: 33759000000 })
    expect(parsed?.days['20261022']).toEqual({ 159901: 1234 })
  })

  it('回包不是预期结构返回 null', () => {
    expect(parseSzseShares('[]')).toBeNull()
    expect(parseSzseShares('{"a":1}')).toBeNull()
  })
})

// ---------- 净值脚本 ----------

describe('parseNavScript', () => {
  it('从 pingzhongdata 脚本里摘出单位净值序列，时间戳按东八区折日期', () => {
    // 2024-01-02 00:00 +08:00 = 2024-01-01T16:00Z；2024-01-03 00:00Z 也应折成同一天口径下的 0103
    const body = 'var f_sname = "沪深300ETF";\nvar Data_netWorthTrend = [{"x":1704153600000,"y":3.9,"equityReturn":0.01},{"x":1704230400000,"y":3.92,"equityReturn":0.005}];\nvar Data_currentFundManager = ...'
    expect(parseNavScript(body)).toEqual({ 20240102: 3.9, 20240103: 3.92 })
  })

  it('脚本里没有那段（改版 / 错误页）返回 null', () => {
    expect(parseNavScript('var a = 1;')).toBeNull()
    expect(parseNavScript('var Data_netWorthTrend = [broken')).toBeNull()
  })
})

// ---------- 缓存收敛与合并 ----------

describe('sanitizeEtfCache', () => {
  it('坏日期、坏数值、名单外的代码一律丢，好数据原样保留', () => {
    const sanitized = sanitizeEtfCache({
      version: 1,
      shares: {
        20240102: { 510300: 1e10, badcode: 5, 159919: Number.NaN },
        notADate: { 510300: 1 },
        20240103: { 510050: -1 },
      },
      nav: { 510300: { 20240102: 3.9, 20240103: -2, 20240104: 3.91 } },
      // 旧版缓存带的指数对照块，现在不用了：读回时直接丢
      index: { dates: ['20240102'], closes: [4600] },
      sseDone: '20240102',
    })
    expect(sanitized.shares).toEqual({ 20240102: { 510300: 1e10 } })
    expect(sanitized.nav).toEqual({ 510300: { 20240102: 3.9, 20240104: 3.91 } })
    expect(sanitized).not.toHaveProperty('index')
    expect(sanitized.sseDone).toBe('20240102')
  })

  it('整个值不是对象时给一份空缓存', () => {
    expect(sanitizeEtfCache(null)).toEqual(emptyEtfCache())
    expect(sanitizeEtfCache('junk')).toEqual(emptyEtfCache())
  })
})

describe('合并', () => {
  it('份额按日合并、重拉覆盖；净值整只覆盖', () => {
    const cache = emptyEtfCache()
    mergeSharesInto(cache, '20240102', { 510300: 100e8 })
    mergeSharesInto(cache, '20240102', { 510300: 101e8, 159919: 50e8 })
    expect(cache.shares['20240102']).toEqual({ 510300: 101e8, 159919: 50e8 })

    mergeNavInto(cache, '510300', { 20240102: 3.9 })
    mergeNavInto(cache, '510300', { 20240103: 3.92 })
    expect(cache.nav['510300']).toEqual({ 20240103: 3.92 })
  })
})

// ---------- 回填规划 ----------

describe('planSseDates', () => {
  it('空缓存从五年前同日起，跳过周末，到今天为止', () => {
    const now = new Date(2024, 0, 10) // 周三；起点 2019-01-10 也是周三
    const dates = planSseDates(emptyEtfCache(), now)
    expect(dates[0]).toBe('20190110')
    expect(dates[dates.length - 1]).toBe('20240110')
    // 2019-01-12 / 13 是周末，不该出现；紧接着的周一 14 号要出现
    expect(dates).not.toContain('20190112')
    expect(dates).not.toContain('20190113')
    expect(dates).toContain('20190114')
  })

  it('有进度时从推进到的下一天继续', () => {
    const now = new Date(2024, 0, 10) // 周三
    const dates = planSseDates(cacheWith({ sseDone: '20240105' }), now) // 上个周五
    expect(dates).toEqual(['20240108', '20240109', '20240110'])
  })
})

describe('planSzseRanges', () => {
  it('区间按 ≤150 个自然日切批，首尾衔接、完整覆盖', () => {
    const ranges = planSzseRanges('20210101', '20211231')
    expect(ranges[0].start).toBe('20210101')
    expect(ranges[ranges.length - 1].end).toBe('20211231')
    const dayOf = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)))
    for (let i = 0; i < ranges.length; i++) {
      const span = (dayOf(ranges[i].end).getTime() - dayOf(ranges[i].start).getTime()) / 86400000 + 1
      expect(span).toBeLessThanOrEqual(150)
      if (i > 0) {
        const prevEnd = dayOf(ranges[i - 1].end)
        prevEnd.setDate(prevEnd.getDate() + 1)
        expect(ranges[i].start).toBe(dateKey(prevEnd))
      }
    }
  })

  it('短区间一批就够，倒置或坏日期给空数组', () => {
    expect(planSzseRanges('20210101', '20210430')).toHaveLength(1)
    expect(planSzseRanges('20210430', '20210101')).toEqual([])
    expect(planSzseRanges('bad', '20210101')).toEqual([])
  })
})

describe('isStaleEmptyDate', () => {
  it('隔两天以上才算「早已过去」（节假日），今天与昨天不算', () => {
    const now = new Date(2024, 0, 5)
    expect(isStaleEmptyDate('20240101', now)).toBe(true)
    expect(isStaleEmptyDate('20240103', now)).toBe(false)
    expect(isStaleEmptyDate('20240104', now)).toBe(false)
    expect(isStaleEmptyDate('20240105', now)).toBe(false)
  })
})

describe('szseCoveredThrough', () => {
  it('取任一深市代码有数据的最大日期', () => {
    const cache = cacheWith({
      shares: {
        20240102: { 510300: 1 },
        20240103: { 159919: 2 },
        20240104: { 510050: 3, 159915: 4 },
      },
    })
    expect(szseCoveredThrough(cache)).toBe('20240104')
    expect(szseCoveredThrough(emptyEtfCache())).toBeNull()
  })
})

describe('backfillFrom / dateKey', () => {
  it('回填起点是五年前的同一天；日期键补零', () => {
    expect(backfillFrom(new Date(2024, 0, 10))).toBe('20190110')
    expect(backfillFrom(new Date(2026, 9, 25))).toBe('20211025')
    expect(dateKey(new Date(2024, 2, 5))).toBe('20240305')
  })
})

// ---------- 聚合 ----------

/** 两只沪深300（一沪一深）、净值恒为 4 元的三天基础夹具 */
function threeDayCache(): EtfCache {
  return cacheWith({
    shares: {
      20240102: { 510300: 100e8, 159919: 50e8 },
      20240103: { 510300: 101e8, 159919: 50e8 },
      20240104: { 510300: 101e8, 159919: 51e8 },
    },
    nav: {
      510300: { 20240102: 4, 20240103: 4, 20240104: 4 },
      159919: { 20240102: 4, 20240103: 4, 20240104: 4 },
    },
  })
}

describe('buildOverview', () => {
  it('净买卖 = 份额差 × 当日净值，首日不算；逐日合计、类别与窗口都对', () => {
    const overview = buildOverview(threeDayCache())
    expect(overview.dataAsOf).toBe('20240104')
    expect(overview.days.map(day => day.total)).toEqual([0, 4e8, 4e8])
    expect(overview.days[1].byCategory).toEqual({ 沪深300: 4e8 })
    expect(overview.totals.todayYi).toBe(4)
    expect(overview.totals.weekYi).toBe(8)
    expect(overview.totals.monthYi).toBe(8)
    // 总规模 = (101 + 51) 亿份 × 4 元 = 608 亿
    expect(overview.totals.scaleYi).toBe(608)
    expect(overview.scaleSeries).toEqual([600e8, 604e8, 608e8])
    expect(overview.etfs.find(etf => etf.code === '510300')?.monthYi).toBe(4)
    expect(overview.etfs.find(etf => etf.code === '159919')?.monthYi).toBe(4)
    const hs300 = overview.categories.find(row => row.category === '沪深300')
    // count 是名单内该类别的只数（沪深300 共四只在名单里），金额只来自有数据的那两只
    expect(hs300).toMatchObject({ count: 4, monthYi: 8, lastScaleYi: 608 })
  })

  it('份额等比骤变且净值反向联动（折算 / 合并）不算净买卖', () => {
    const cache = cacheWith({
      shares: {
        20240102: { 510300: 100e8, 159919: 50e8 },
        20240103: { 510300: 50e8, 159919: 50e8 }, // 份额减半
      },
      nav: {
        510300: { 20240102: 4, 20240103: 8 }, // 净值翻倍
        159919: { 20240102: 4, 20240103: 4 },
      },
    })
    const overview = buildOverview(cache)
    expect(overview.days[1].total).toBe(0)
  })

  it('只取沪深两市都有数据的日期：单边日子不进序列', () => {
    const cache = threeDayCache()
    cache.shares['20240105'] = { 510300: 102e8 } // 只有沪市
    const overview = buildOverview(cache)
    expect(overview.days.map(day => day.date)).toEqual(['20240102', '20240103', '20240104'])
    expect(overview.dataAsOf).toBe('20240104')
  })

  it('净值缺日用最近一条补（链上前值），某只完全没有净值则不产生净买卖也不计规模', () => {
    const cache = threeDayCache()
    delete cache.nav['510300']['20240103'] // 0103 当天净值缺失，沿用 0102 的 4
    const overview = buildOverview(cache)
    expect(overview.days[1].total).toBe(4e8)

    const noNav = threeDayCache()
    delete noNav.nav['159919']
    const withoutNav = buildOverview(noNav)
    // 0103 的 +4 亿来自 510300；0104 只有 159919 变动但它没有净值，不算
    expect(withoutNav.days[1].total).toBe(4e8)
    expect(withoutNav.days[2].total).toBe(0)
    expect(withoutNav.totals.scaleYi).toBe(404) // 只有 510300 的 101 亿份 × 4
  })

  it('今年以来按展示截止日所在年份算', () => {
    const overview = buildOverview(threeDayCache())
    expect(overview.totals.ytdYi).toBe(8)
  })

  it('空缓存给一份可渲染的空视图', () => {
    const overview = buildOverview(emptyEtfCache())
    expect(overview.dataAsOf).toBe('')
    expect(overview.days).toEqual([])
    expect(overview.totals.todayYi).toBe(0)
    expect(overview.etfs).toHaveLength(23)
    expect(overview.categories.length).toBeGreaterThan(0)
  })
})

// ---------- 展示格式 ----------

describe('formatYi', () => {
  it('亿元两位小数，过百取整；带符号时正数补加号', () => {
    expect(formatYi(4e8)).toBe('4.00')
    expect(formatYi(1.234e10)).toBe('123')
    expect(formatYi(-4e8, true)).toBe('-4.00')
    expect(formatYi(4e8, true)).toBe('+4.00')
    expect(formatYi(Number.NaN)).toBe('—')
  })
})

describe('formatYiNumber / formatDayKey', () => {
  it('亿元数值的展示口径与 formatYi 一致', () => {
    expect(formatYiNumber(4.006)).toBe('4.01')
    expect(formatYiNumber(123.4)).toBe('123')
    expect(formatYiNumber(-8.2, true)).toBe('-8.20')
    expect(formatYiNumber(8.2, true)).toBe('+8.20')
  })

  it('日期键默认折成 MM-DD，带年份时是 YYYY-MM-DD', () => {
    expect(formatDayKey('20261023')).toBe('10-23')
    expect(formatDayKey('20261023', true)).toBe('2026-10-23')
    expect(formatDayKey('junk')).toBe('junk')
  })
})
