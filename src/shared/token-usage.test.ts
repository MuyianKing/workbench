import { describe, expect, it } from 'vitest'
import {
  addCounters,
  sumDays,
  bucketRangeOf,
  buildSeriesRange,
  cacheHitRate,
  combineShards,
  emptyCounters,
  flattenSources,
  formatPercent,
  formatTokens,
  isDateKey,
  maxCounters,
  mergeDays,
  monthKeyOf,
  presetLabel,
  pruneTokenDays,
  resolvePresetRange,
  sanitizeShard,
  shareByModel,
  shareBySource,
  shortDayLabel,
  sumRange,
  TOKEN_RANGE_PRESETS,
  totalTokens,
  weekKeyOf,
  type TokenCounters,
  type TokenDays,
  type TokenShard
} from './token-usage'

function counters(overrides: Partial<TokenCounters> = {}): TokenCounters {
  return { ...emptyCounters(), ...overrides }
}

function makeDays(entries: Array<[string, string, number]>): TokenDays {
  const days: TokenDays = {}
  for (const [date, model, input] of entries) {
    days[date] ??= {}
    days[date][model] = { ...emptyCounters(), inputTokens: input }
  }
  return days
}

describe('计数运算', () => {
  it('addCounters 逐字段求和', () => {
    const sum = addCounters(counters({ inputTokens: 10, requests: 2 }), counters({ inputTokens: 5, requests: 3 }))
    expect(sum.inputTokens).toBe(15)
    expect(sum.requests).toBe(5)
  })

  it('maxCounters 逐字段取较大者', () => {
    const max = maxCounters(
      counters({ inputTokens: 100, outputTokens: 7, requests: 4 }),
      counters({ inputTokens: 60, outputTokens: 9, requests: 2 })
    )
    expect(max).toEqual(counters({ inputTokens: 100, outputTokens: 9, requests: 4 }))
  })

  it('totalTokens 是五类计数之和,不含 requests', () => {
    expect(
      totalTokens(
        counters({ inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, requests: 99 })
      )
    ).toBe(15)
  })

  it('formatTokens 用中文数量级短写法,非法与非正数归零', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(NaN)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(4363000)).toBe('436万')
    expect(formatTokens(12_800_000)).toBe('1280万')
    expect(formatTokens(331_900_000)).toBe('3.32亿')
    expect(formatTokens(692_000_000)).toBe('6.92亿')
    expect(formatTokens(2_100_000_000)).toBe('21亿')
    expect(formatTokens(76_000)).toBe('7.6万')
  })

  it('formatPercent 不足 1 显示 <1%,四舍五入到整数', () => {
    expect(formatPercent(0, 100)).toBe('0%')
    expect(formatPercent(1, 100)).toBe('1%')
    expect(formatPercent(0.5, 100)).toBe('<1%')
    expect(formatPercent(358_307_648, 361_844_917)).toBe('99%')
    expect(formatPercent(2_989_575, 361_844_917)).toBe('<1%')
    expect(formatPercent(1, 0)).toBe('0%')
    expect(formatPercent(NaN, 100)).toBe('0%')
  })

  it('cacheHitRate 是缓存读取占「读取 + 未命中输入」的比例', () => {
    expect(cacheHitRate(counters({ cacheReadTokens: 358, inputTokens: 2 }))).toBeCloseTo(0.994)
    expect(cacheHitRate(counters({ cacheReadTokens: 0, inputTokens: 10 }))).toBe(0)
    // 没有输入就没有命中率可言
    expect(cacheHitRate(emptyCounters())).toBe(0)
  })
})

describe('落盘收敛', () => {
  it('sanitizeShard 对坏数据逐层丢弃,缺字段补默认', () => {
    const clean = sanitizeShard({
      version: 3,
      updatedAt: 123,
      sources: {
        zcode: {
          days: {
            '2026-09-13': { 'glm-5': { inputTokens: 10, requests: 2 } },
            'not-a-date': { 'glm-5': { inputTokens: 5 } },
            '2026-09-14': { 'glm-5': { inputTokens: 'oops' } }
          }
        },
        '': { days: {} }
      }
    })

    expect(clean.updatedAt).toBe(123)
    expect(Object.keys(clean.sources)).toEqual(['zcode'])
    const day13 = clean.sources.zcode.days['2026-09-13']
    expect(day13['glm-5'].inputTokens).toBe(10)
    expect(day13['glm-5'].requests).toBe(2)
    // 非法日期被丢弃;计数非法落成 0
    expect(clean.sources.zcode.days['not-a-date']).toBeUndefined()
    expect(clean.sources.zcode.days['2026-09-14']['glm-5'].inputTokens).toBe(0)
  })

  it('v3 老文件照常读进来,设备信息由 fallback 补齐', () => {
    const shard = sanitizeShard(
      {
        version: 3,
        updatedAt: 7,
        sources: { zcode: { days: { '2026-09-13': { 'glm-5': { inputTokens: 10 } } } } }
      },
      { device: 'dev-1', name: '办公室' }
    )

    // 口径没变,历史必须留住 —— 这里要是整份弃用,用户攒下的一年快照就没了
    expect(shard.version).toBe(6)
    expect(shard.device).toBe('dev-1')
    expect(shard.name).toBe('办公室')
    expect(shard.sources.zcode.days['2026-09-13']['glm-5'].inputTokens).toBe(10)
  })

  it('v5 分片也照常读进来,多出来的外观字段被忽略', () => {
    // 外观已经搬去 config/ 目录(见 sync-config.ts),老分片里那份不再需要:
    // 读它只会让同一份配置有两处来源,而那边是整份采用、这边根本没法合
    const shard = sanitizeShard({
      version: 5,
      device: 'dev-3',
      name: '书房',
      updatedAt: 9,
      sources: {},
      appearance: { settings: { theme: 'light' } }
    })

    expect(shard.version).toBe(6)
    expect(shard).not.toHaveProperty('appearance')
  })

  it('分片自带的设备信息优先于 fallback', () => {
    const shard = sanitizeShard(
      { version: 4, device: 'dev-2', name: '笔记本', sources: {} },
      { device: 'dev-1', name: '办公室' }
    )
    expect(shard.device).toBe('dev-2')
    expect(shard.name).toBe('笔记本')
  })

  it('版本不在兼容表里(v1 的厂商层结构)整份弃用,下次实读自愈', () => {
    const v1 = {
      version: 1,
      updatedAt: 123,
      sources: { zcode: { days: { '2026-09-13': { zhipu: { 'glm-5': { inputTokens: 10 } } } } } }
    }
    expect(sanitizeShard(v1)).toEqual({
      version: 6,
      device: '',
      name: '',
      updatedAt: 0,
      sources: {}
    })
  })

  it('sanitizeShard 对 null / 数组 / 数字等整份坏数据回空分片', () => {
    const empty = { version: 6, device: '', name: '', updatedAt: 0, sources: {} }
    expect(sanitizeShard(null)).toEqual(empty)
    expect(sanitizeShard([1, 2])).toEqual(empty)
    expect(sanitizeShard(42)).toEqual(empty)
  })

  it('isDateKey 只认 YYYY-MM-DD', () => {
    expect(isDateKey('2026-09-13')).toBe(true)
    expect(isDateKey('2026-9-3')).toBe(false)
    expect(isDateKey('2026-09')).toBe(false)
    expect(isDateKey(20260913)).toBe(false)
  })
})

describe('快照合并与修剪', () => {
  it('mergeDays 取并集且逐字段取大者:上游清理后重读变小不缩水', () => {
    const existing = makeDays([
      ['2026-09-12', 'glm-5', 500],
      ['2026-09-13', 'glm-5', 100]
    ])
    const incoming = makeDays([
      // 12 日的记录被上游清理,重读只剩 300
      ['2026-09-12', 'glm-5', 300],
      // 13 日正常增长
      ['2026-09-13', 'glm-5', 180]
    ])

    const merged = mergeDays(existing, incoming)
    expect(merged['2026-09-12']['glm-5'].inputTokens).toBe(500)
    expect(merged['2026-09-13']['glm-5'].inputTokens).toBe(180)
  })

  it('mergeDays 合并双方各自独有的日期与模型', () => {
    const existing = makeDays([['2026-09-12', 'glm-5', 10]])
    const incoming = makeDays([['2026-09-13', 'glm-flash', 20]])

    const merged = mergeDays(existing, incoming)
    expect(merged['2026-09-12']['glm-5'].inputTokens).toBe(10)
    expect(merged['2026-09-13']['glm-flash'].inputTokens).toBe(20)
  })

  it('pruneTokenDays 丢掉窗口外的天数', () => {
    const days = makeDays([
      ['2020-01-01', 'glm-5', 1],
      ['2026-09-01', 'glm-5', 2]
    ])
    const pruned = pruneTokenDays(days, new Date(2026, 8, 13))
    expect(pruned['2020-01-01']).toBeUndefined()
    expect(pruned['2026-09-01']).toBeDefined()
  })
})

describe('跨工具合并', () => {
  it('flattenSources 跨工具同天同模型相加', () => {
    const data = sanitizeShard({
      version: 3,
      sources: {
        zcode: { days: { '2026-09-13': { 'glm-5': { inputTokens: 10 } } } },
        claude: { days: { '2026-09-13': { 'glm-5': { inputTokens: 5 }, claude: { inputTokens: 7 } } } }
      }
    })

    const days = flattenSources(data)
    expect(days['2026-09-13']['glm-5'].inputTokens).toBe(15)
    expect(days['2026-09-13'].claude.inputTokens).toBe(7)
  })
})

describe('跨设备合并', () => {
  /** 造一份设备分片;days 直接给「天 → 模型 → 输入量」 */
  function shard(device: string, updatedAt: number, days: TokenDays): TokenShard {
    return { version: 4, device, name: device, updatedAt, sources: { zcode: { days } } }
  }

  it('sumDays 同天同模型相加,各自独有的日期与模型都留着', () => {
    const a = makeDays([['2026-09-13', 'glm-5', 10]])
    const b = makeDays([
      ['2026-09-13', 'glm-5', 5],
      ['2026-09-13', 'glm-flash', 3],
      ['2026-09-14', 'glm-5', 7]
    ])

    const sum = sumDays(a, b)
    expect(sum['2026-09-13']['glm-5'].inputTokens).toBe(15)
    expect(sum['2026-09-13']['glm-flash'].inputTokens).toBe(3)
    expect(sum['2026-09-14']['glm-5'].inputTokens).toBe(7)
  })

  it('combineShards 跨设备求和而不是取最大:两台机器同一天的用量是两笔', () => {
    const now = new Date(2026, 8, 14)
    const data = combineShards(
      [
        shard('dev-a', 100, makeDays([['2026-09-13', 'glm-5', 1000]])),
        shard('dev-b', 200, makeDays([['2026-09-13', 'glm-5', 400]]))
      ],
      now
    )

    expect(data.sources.zcode.days['2026-09-13']['glm-5'].inputTokens).toBe(1400)
    // updatedAt 取最新那台机器的时间,用于界面上的「更新于」
    expect(data.updatedAt).toBe(200)
  })

  it('combineShards 丢掉窗口外的旧天:长期关机的那台机器不往图里塞陈年数据', () => {
    const now = new Date(2026, 8, 14)
    const data = combineShards(
      [shard('dev-a', 1, makeDays([['2020-01-01', 'glm-5', 1]]))],
      now
    )
    expect(data.sources.zcode.days['2020-01-01']).toBeUndefined()
  })

  it('反复合并同一批分片不会让数字越加越多(面板每轮刷新都重算,合计必须稳定)', () => {
    const now = new Date(2026, 8, 14)
    const shards = [
      shard('dev-a', 1, makeDays([['2026-09-13', 'glm-5', 10]])),
      shard('dev-b', 2, makeDays([['2026-09-13', 'glm-5', 20]]))
    ]
    const first = combineShards(shards, now)
    const second = combineShards(shards, now)

    expect(first.sources.zcode.days['2026-09-13']['glm-5'].inputTokens).toBe(30)
    expect(second).toEqual(first)
  })

  it('combineShards 没有任何分片时给一份空合计', () => {
    const data = combineShards([], new Date(2026, 8, 14))
    expect(data.sources).toEqual({})
    expect(data.updatedAt).toBe(0)
  })
})

describe('周期与聚合', () => {
  it('weekKeyOf 回到所在周的周一', () => {
    // 2026-09-13 是周日,所在周的周一是 09-07
    expect(weekKeyOf('2026-09-13')).toBe('2026-09-07')
    expect(weekKeyOf('2026-09-07')).toBe('2026-09-07')
    expect(weekKeyOf('2026-09-06')).toBe('2026-08-31')
  })

  it('monthKeyOf 取年月段', () => {
    expect(monthKeyOf('2026-09-13')).toBe('2026-09')
    expect(monthKeyOf('oops')).toBe('')
  })

  it('shortDayLabel 去掉前导零', () => {
    expect(shortDayLabel('2026-09-04')).toBe('9/4')
    expect(shortDayLabel('2026-12-31')).toBe('12/31')
    expect(shortDayLabel('oops')).toBe('')
  })

  it('buildSeriesRange 天视图:补零、从旧到新、区间外不累计', () => {
    const days = makeDays([
      ['2026-08-14', 'glm-5', 100], // 区间(08-15 起)之外
      ['2026-09-12', 'glm-5', 7],
      ['2026-09-13', 'glm-5', 8],
      ['2026-09-14', 'glm-5', 9] // 区间之外
    ])

    const { buckets, fromKey } = buildSeriesRange(days, 'day', '2026-08-15', '2026-09-13')
    expect(buckets).toHaveLength(30)
    expect(fromKey).toBe('2026-08-15')
    expect(buckets[0].key).toBe('2026-08-15')
    expect(buckets[0].counters.inputTokens).toBe(0)
    expect(buckets.at(-1)?.key).toBe('2026-09-13')
    expect(buckets.at(-1)?.counters.inputTokens).toBe(8)
    expect(buckets.at(-2)?.counters.inputTokens).toBe(7)
    expect(buckets.at(-2)?.label).toBe('9/12')
  })

  it('buildSeriesRange 周视图按周一分桶,首尾桶只统计区间内的天', () => {
    const days = makeDays([
      ['2026-09-06', 'glm-5', 8], // 上一周的周日,区间之外
      ['2026-09-07', 'glm-5', 1], // 周一,但早于区间起点(09-08),不进首桶
      ['2026-09-10', 'glm-5', 2], // 周四,首桶
      ['2026-09-15', 'glm-5', 5] // 下周二,末桶(09-14 那一周)
    ])

    const { buckets } = buildSeriesRange(days, 'week', '2026-09-08', '2026-09-15')
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-09-07', '2026-09-14'])
    expect(buckets[0].counters.inputTokens).toBe(2)
    expect(buckets[1].counters.inputTokens).toBe(5)
  })

  it('buildSeriesRange 月视图按自然月分桶', () => {
    const days = makeDays([
      ['2026-07-15', 'glm-5', 1],
      ['2026-08-02', 'glm-5', 2],
      ['2026-09-13', 'glm-5', 3]
    ])

    const { buckets, fromKey } = buildSeriesRange(days, 'month', '2026-07-10', '2026-09-13')
    expect(fromKey).toBe('2026-07-10')
    expect(buckets.map((bucket) => bucket.key)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(buckets.map((bucket) => bucket.label)).toEqual(['7月', '8月', '9月'])
    expect(buckets[0].counters.inputTokens).toBe(1)
    expect(buckets[2].counters.inputTokens).toBe(3)
  })

  it('buildSeriesRange 单天区间只有一根柱,跨年月份不出错', () => {
    const days = makeDays([
      ['2026-09-13', 'glm-5', 5],
      ['2027-01-02', 'glm-5', 6]
    ])

    const single = buildSeriesRange(days, 'day', '2026-09-13', '2026-09-13')
    expect(single.buckets).toHaveLength(1)
    expect(single.buckets[0].counters.inputTokens).toBe(5)

    const acrossYear = buildSeriesRange(days, 'month', '2026-11-05', '2027-01-20')
    expect(acrossYear.buckets.map((bucket) => bucket.key)).toEqual(['2026-11', '2026-12', '2027-01'])
    expect(acrossYear.buckets.at(-1)?.counters.inputTokens).toBe(6)
  })

  it('buildSeriesRange 区间不合法返回空序列', () => {
    const days = makeDays([['2026-09-13', 'glm-5', 5]])
    expect(buildSeriesRange(days, 'day', '2026-09-14', '2026-09-13').buckets).toEqual([])
    expect(buildSeriesRange(days, 'day', 'oops', '2026-09-13').buckets).toEqual([])
    expect(buildSeriesRange(days, 'day', '2026-09-13', '').buckets).toEqual([])
  })

  it('sumRange 含两端', () => {
    const days = makeDays([
      ['2026-09-11', 'glm-5', 1],
      ['2026-09-12', 'glm-5', 2],
      ['2026-09-13', 'glm-5', 4]
    ])
    expect(sumRange(days, '2026-09-11', '2026-09-12').inputTokens).toBe(3)
    expect(sumRange(days, '2026-09-12', '2026-09-13').inputTokens).toBe(6)
    expect(sumRange(days, '2020-01-01', '2020-12-31').inputTokens).toBe(0)
  })

  it('bucketRangeOf 给出桶覆盖的日期区间:天当天、周到周日、月到月末', () => {
    expect(bucketRangeOf('2026-09-13', 'day')).toEqual({ fromKey: '2026-09-13', toKey: '2026-09-13' })
    // 2026-09-13 是周日,所在周桶的键是周一 09-07,区间到周日 09-13
    expect(bucketRangeOf('2026-09-07', 'week')).toEqual({ fromKey: '2026-09-07', toKey: '2026-09-13' })
    // 平月与闰年的月末:2026-02 非闰年到 28 号
    expect(bucketRangeOf('2026-09', 'month')).toEqual({ fromKey: '2026-09-01', toKey: '2026-09-30' })
    expect(bucketRangeOf('2026-02', 'month')).toEqual({ fromKey: '2026-02-01', toKey: '2026-02-28' })
    expect(bucketRangeOf('2024-02', 'month')).toEqual({ fromKey: '2024-02-01', toKey: '2024-02-29' })
    // 非法键返回空区间,调用方据此兜底
    expect(bucketRangeOf('oops', 'day')).toEqual({ fromKey: '', toKey: '' })
    expect(bucketRangeOf('2026-13', 'month')).toEqual({ fromKey: '', toKey: '' })
  })

  it('占比统计按模型合计并按总量降序', () => {
    const days: TokenDays = {
      '2026-09-13': {
        'glm-5': { ...emptyCounters(), inputTokens: 10, outputTokens: 2 },
        'glm-flash': { ...emptyCounters(), inputTokens: 50 }
      }
    }

    const models = shareByModel(days, '2026-09-01', '2026-09-30')
    expect(models.map((share) => share.key)).toEqual(['glm-flash', 'glm-5'])
    expect(models[0].counters.inputTokens).toBe(50)
  })

  it('shareBySource 按工具合计:跨工具各自成行,零用量的工具不出现', () => {
    const data = sanitizeShard({
      version: 3,
      sources: {
        zcode: { days: { '2026-09-13': { 'glm-5': { inputTokens: 10, outputTokens: 2 } } } },
        claude: { days: { '2026-09-13': { claude: { inputTokens: 30 } } } },
        codex: { days: { '2026-09-13': { codex: { inputTokens: 0 } } } }
      }
    })

    const shares = shareBySource(data, '2026-09-01', '2026-09-30')
    expect(shares.map((share) => share.key)).toEqual(['claude', 'zcode'])
    expect(shares[0].counters.inputTokens).toBe(30)
    expect(shares[1].counters.outputTokens).toBe(2)
  })
})

describe('时间维度预设', () => {
  /** 固定锚点:2026-09-14 下午,跨天与跨月都由这个时刻推 */
  const NOW = new Date(2026, 8, 14, 15, 30)

  it('近 7 天 / 近 30 天含今天,长度分别是 7 与 30 天', () => {
    expect(resolvePresetRange('last7', NOW)).toEqual({ fromKey: '2026-09-08', toKey: '2026-09-14' })
    expect(resolvePresetRange('last30', NOW)).toEqual({ fromKey: '2026-08-16', toKey: '2026-09-14' })
  })

  it('本月从 1 号起算,上月是整月', () => {
    expect(resolvePresetRange('thisMonth', NOW)).toEqual({ fromKey: '2026-09-01', toKey: '2026-09-14' })
    expect(resolvePresetRange('lastMonth', NOW)).toEqual({ fromKey: '2026-08-01', toKey: '2026-08-31' })
  })

  it('上月跨年、月末三十一天、闰年二月都对', () => {
    // 3 月 31 日退一个月是 2 月,不能落到 3 月 3 日
    expect(resolvePresetRange('lastMonth', new Date(2026, 2, 31))).toEqual({
      fromKey: '2026-02-01',
      toKey: '2026-02-28'
    })
    expect(resolvePresetRange('lastMonth', new Date(2027, 0, 5))).toEqual({
      fromKey: '2026-12-01',
      toKey: '2026-12-31'
    })
    expect(resolvePresetRange('lastMonth', new Date(2028, 2, 10))).toEqual({
      fromKey: '2028-02-01',
      toKey: '2028-02-29'
    })
  })

  it('自定义没有固定区间,时间戳非法时返回 null', () => {
    expect(resolvePresetRange('custom', NOW)).toBeNull()
    expect(resolvePresetRange('last7', new Date(NaN))).toBeNull()
  })

  it('面板里的五档与界面名一一对应', () => {
    expect(TOKEN_RANGE_PRESETS.map((option) => option.key)).toEqual([
      'last7',
      'last30',
      'thisMonth',
      'lastMonth',
      'custom'
    ])
    for (const option of TOKEN_RANGE_PRESETS) {
      expect(presetLabel(option.key)).toBe(option.label)
    }
  })
})
