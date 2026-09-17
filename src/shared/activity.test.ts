import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_DAYS,
  ACTIVITY_WEEKS,
  addDays,
  buildActivityCalendar,
  bumpDay,
  dayKey,
  levelOf,
  monthLabels,
  pruneDays,
  sanitizeActivity,
  startOfWeek,
  streakOf
} from './activity'

/** 固定的「今天」，避免测试跑到跨天/跨年就失效 */
const TODAY = new Date(2026, 8, 10) // 2026-09-10
const TODAY_KEY = '2026-09-10'

describe('dayKey', () => {
  it('按本地时区取日期并补零', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dayKey(new Date(2026, 11, 31).getTime())).toBe('2026-12-31')
  })

  it('非法时间戳返回空串', () => {
    expect(dayKey(Number.NaN)).toBe('')
  })
})

describe('startOfWeek', () => {
  it('回到所在周的周日并清零时分秒', () => {
    const sunday = startOfWeek(new Date(2026, 8, 10, 18, 30))
    expect(dayKey(sunday)).toBe(dayKey(addDays(TODAY, -TODAY.getDay())))
    expect(sunday.getDay()).toBe(0)
    expect(sunday.getHours()).toBe(0)
  })
})

describe('levelOf', () => {
  it('按 GitHub 的四档分级', () => {
    expect(levelOf(0)).toBe(0)
    expect(levelOf(-1)).toBe(0)
    expect(levelOf(1)).toBe(1)
    expect(levelOf(3)).toBe(1)
    expect(levelOf(4)).toBe(2)
    expect(levelOf(7)).toBe(2)
    expect(levelOf(8)).toBe(3)
    expect(levelOf(11)).toBe(3)
    expect(levelOf(12)).toBe(4)
    expect(levelOf(999)).toBe(4)
  })
})

describe('bumpDay', () => {
  it('同一天累加，且返回新对象', () => {
    const first = bumpDay({}, TODAY.getTime())
    const second = bumpDay(first, TODAY.getTime())
    expect(first[TODAY_KEY]).toBe(1)
    expect(second[TODAY_KEY]).toBe(2)
    expect(first).not.toBe(second)
  })

  it('时间戳非法时原样返回', () => {
    const counts = { '2026-09-10': 1 }
    expect(bumpDay(counts, Number.NaN)).toBe(counts)
  })
})

describe('pruneDays', () => {
  it('丢掉超出保留范围的旧计数', () => {
    const counts = { [TODAY_KEY]: 2, '2020-01-01': 9 }
    const pruned = pruneDays(counts, TODAY)
    expect(pruned[TODAY_KEY]).toBe(2)
    expect(pruned['2020-01-01']).toBeUndefined()
  })

  it('保留边界上的那一天', () => {
    const edge = dayKey(addDays(TODAY, -(ACTIVITY_DAYS - 1)))
    expect(pruneDays({ [edge]: 1 }, TODAY)[edge]).toBe(1)
  })

  it('丢掉非正数与非法值', () => {
    const pruned = pruneDays({ [TODAY_KEY]: 0, '2026-09-09': -3 }, TODAY)
    expect(pruned).toEqual({})
  })
})

describe('sanitizeActivity', () => {
  it('只留合法日期键与正的次数', () => {
    expect(
      sanitizeActivity({
        [TODAY_KEY]: 4,
        '2026-09-09': 2.7,
        'not-a-date': 5,
        '2026-09-08': 0,
        '2026-09-07': '3'
      })
    ).toEqual({ [TODAY_KEY]: 4, '2026-09-09': 2 })
  })

  it('非对象一律当空处理', () => {
    expect(sanitizeActivity(undefined)).toEqual({})
    expect(sanitizeActivity([])).toEqual({})
    expect(sanitizeActivity('x')).toEqual({})
  })
})

describe('buildActivityCalendar', () => {
  const counts = { '2026-09-09': 3, '2026-09-10': 2, '2020-01-01': 99 }

  it('铺满 53 周 × 7 天', () => {
    const calendar = buildActivityCalendar(counts, TODAY)
    expect(calendar.weeks).toHaveLength(ACTIVITY_WEEKS)
    for (const week of calendar.weeks) expect(week.days).toHaveLength(7)
  })

  it('最后一列是本周，今天之后的格子标记为未来', () => {
    const calendar = buildActivityCalendar(counts, TODAY)
    const flat = calendar.weeks.flatMap((week) => week.days)
    const index = flat.findIndex((day) => day.date === TODAY_KEY)

    expect(index).toBeGreaterThan(-1)
    expect(flat[index].future).toBe(false)
    // 今天之前都不是未来；今天之后全是未来
    expect(flat.slice(0, index).some((day) => day.future)).toBe(false)
    expect(flat.slice(index + 1).every((day) => day.future)).toBe(true)
  })

  it('只统计区间内的次数，更老的记录不算进去', () => {
    const calendar = buildActivityCalendar(counts, TODAY)
    expect(calendar.total).toBe(5)
    expect(calendar.activeDays).toBe(2)
    expect(calendar.max).toBe(3)
  })

  it('连续天数：今天跑过就从今天往前数', () => {
    const calendar = buildActivityCalendar(counts, TODAY)
    expect(calendar.streak).toBe(2)
    expect(calendar.bestStreak).toBe(2)
  })

  it('连续天数：今天还没跑则从昨天数起', () => {
    const calendar = buildActivityCalendar({ '2026-09-09': 1, '2026-09-08': 1 }, TODAY)
    expect(calendar.streak).toBe(2)
  })

  it('昨天也没跑就没有连续', () => {
    expect(buildActivityCalendar({ '2026-09-01': 1 }, TODAY).streak).toBe(0)
  })

  it('最长连续可以比当前连续更长', () => {
    const old = {
      '2026-08-01': 1,
      '2026-08-02': 1,
      '2026-08-03': 1,
      '2026-08-04': 1,
      [TODAY_KEY]: 1
    }
    const calendar = buildActivityCalendar(old, TODAY)
    expect(calendar.streak).toBe(1)
    expect(calendar.bestStreak).toBe(4)
  })

  it('没有数据时全空', () => {
    const calendar = buildActivityCalendar({}, TODAY)
    expect(calendar.total).toBe(0)
    expect(calendar.streak).toBe(0)
    expect(calendar.bestStreak).toBe(0)
    expect(calendar.weeks.flatMap((w) => w.days).every((day) => day.level === 0)).toBe(true)
  })

  it('counts 缺失时不炸', () => {
    expect(buildActivityCalendar(undefined as never, TODAY).total).toBe(0)
  })
})

describe('monthLabels', () => {
  it('只在本月 1 号所在的那列写标签', () => {
    const labels = monthLabels(buildActivityCalendar({}, TODAY).weeks)
    expect(labels).toHaveLength(ACTIVITY_WEEKS)
    expect(labels.filter(Boolean).length).toBeGreaterThanOrEqual(11)
    for (const label of labels.filter(Boolean)) expect(label).toMatch(/^\d{1,2}月$/)
  })
})

/**
 * streakOf 单独导出是为了首页那一行：它只要这一个数，不值得为它铺一遍 371 格的日历
 * （见 HomeGreeting.vue）。日历那边的用例同样覆盖了这套语义，这里钉的是它的入口本身。
 */
describe('streakOf', () => {
  it('今天跑过就从今天往前数', () => {
    expect(streakOf({ [TODAY_KEY]: 1, '2026-09-09': 2, '2026-09-08': 1 }, TODAY)).toBe(3)
  })

  it('今天还没跑则从昨天数起，不算断', () => {
    expect(streakOf({ '2026-09-09': 1, '2026-09-08': 1 }, TODAY)).toBe(2)
  })

  it('昨天也没跑就没有连续', () => {
    expect(streakOf({ '2026-09-01': 1 }, TODAY)).toBe(0)
    expect(streakOf({}, TODAY)).toBe(0)
  })

  it('中间断掉只数到断点', () => {
    expect(streakOf({ [TODAY_KEY]: 1, '2026-09-09': 1, '2026-09-07': 1 }, TODAY)).toBe(2)
  })
})
