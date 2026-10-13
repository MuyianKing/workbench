/**
 * 活跃度统计：按「本地日期 → 各来源的操作次数」计数，铺成 GitHub 那样的贡献图。
 *
 * 计数只按天聚合（键是 YYYY-MM-DD），不记操作明细 —— 明细在各自的账本里，
 * 而贡献图要的是一整年的范围（项目自己的 history 每项只留最近 10 条，撑不起这张图）。
 *
 * **按来源分项存**（`ActivityKind`）：这张图答的是「这段时间用得勤不勤」，而「启动了 3 次项目」
 * 与「写了 2 篇笔记」不是一回事 —— 深浅只看各来源求和，分项留给格子的悬停提示去说。
 * 旧数据文件里只有一个来源（启动 / 打包）且直接存成一个数字，收敛时按 `run` 收下（见 sanitizeActivity）。
 *
 * 日期一律用本地时区：用户看到的「今天」就是本机时钟上的今天，
 * 用 UTC 会让晚上做的事算到第二天去。
 */
import dayjs from 'dayjs'

/** 活跃度认的几类操作 —— 一个来源一类；落盘时分项就用它当键，改名会让老数据的分项丢掉 */
export type ActivityKind = 'run' | 'log' | 'note' | 'ai' | 'kb'

/** 认得的来源；这个顺序也是悬停提示里分项的排列顺序 */
export const ACTIVITY_KINDS = ['run', 'log', 'note', 'ai', 'kb'] as const

/** 来源的中文名，只给界面用（格子的悬停提示），不进落盘；都以汉字开头，「N 次」接得上 */
const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  run: '启动 / 打包',
  log: '工作日志',
  note: '新建笔记',
  ai: '助手对话',
  kb: '知识库整理',
}

/** 某一天的各来源次数；值为零的来源不出现 */
export type ActivityDayKinds = Partial<Record<ActivityKind, number>>

/** 日期（YYYY-MM-DD）→ 当天各来源的次数；落盘的就是这一份 */
export type ActivityBreakdown = Record<string, ActivityDayKinds>

/** 日期（YYYY-MM-DD）→ 当天的总次数；图上深浅只看它（由分项求和而来，见 totalOf） */
export type ActivityCounts = Record<string, number>

/** 交给界面的一份活跃度：总数画图、分项写悬停提示 */
export interface ActivityView {
  total: ActivityCounts
  days: ActivityBreakdown
}

/** 贡献度等级，0 表示当天没有操作 */
export type ActivityLevel = 0 | 1 | 2 | 3 | 4

export interface ActivityDay {
  /** YYYY-MM-DD */
  date: string
  count: number
  level: ActivityLevel
  /** 晚于今天的格子（网格最后一列补齐用），只占位不参与统计 */
  future: boolean
}

export interface ActivityWeek {
  days: ActivityDay[]
}

export interface ActivityCalendar {
  weeks: ActivityWeek[]
  /** 区间内的操作总次数（各来源求和） */
  total: number
  /** 单日最高次数，用于说明「最多的一天」 */
  max: number
  /** 有记录的天数 */
  activeDays: number
  /** 截至今天（今天没动手则截至昨天）的连续天数 */
  streak: number
  /** 区间内最长的一次连续天数 */
  bestStreak: number
}

/** 图的列数：53 周，与 GitHub 一年视图一致 */
export const ACTIVITY_WEEKS = 53

/** 计数保留的天数上界：超出这个范围的记录不再保留，否则数据文件会一直长 */
export const ACTIVITY_DAYS = ACTIVITY_WEEKS * 7

/**
 * 分级阈值：1-3 / 4-7 / 8-11 / 12+，与 GitHub 的四档一致。
 * 分母是**各来源求和之后**的总次数（启动 / 打包、工作日志、笔记、AI、知识库都算）。
 */
export const LEVEL_THRESHOLDS = [1, 4, 8, 12] as const

const DAY_MS = 86_400_000
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** 这条键是不是 YYYY-MM-DD 的日期键（活跃度、用量快照、工作日志同一条口径） */
export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY.test(value)
}

/** 这个键是不是认得出来的来源（认不出的分项在收敛时丢掉） */
export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value)
}

/** 本地日期键；时间戳非法时返回空串（调用方跳过） */
export function dayKey(value: number | Date): string {
  const day = dayjs(value)
  return day.isValid() ? day.format('YYYY-MM-DD') : ''
}

/** 当天 00:00（本地时区） */
export function startOfDay(value: number | Date): Date {
  const day = dayjs(value)
  return day.isValid() ? day.startOf('day').toDate() : new Date(NaN)
}

/** 所在周的周日 00:00 —— 贡献图的一列从周日开始；不用 startOf('week')，那个跟着 locale 的周起始走 */
export function startOfWeek(value: number | Date): Date {
  const day = dayjs(value)
  if (!day.isValid())
    return new Date(NaN)
  return day.startOf('day').subtract(day.day(), 'day').toDate()
}

/** 按整天位移：走日历日而不是加毫秒，跨月与夏令时才不会错位 */
export function addDays(value: number | Date, days: number): Date {
  const day = dayjs(value)
  if (!day.isValid())
    return new Date(NaN)
  return day.startOf('day').add(days, 'day').toDate()
}

/** 次数 → 等级 */
export function levelOf(count: number): ActivityLevel {
  if (!Number.isFinite(count) || count <= 0)
    return 0
  if (count >= LEVEL_THRESHOLDS[3])
    return 4
  if (count >= LEVEL_THRESHOLDS[2])
    return 3
  if (count >= LEVEL_THRESHOLDS[1])
    return 2
  return 1
}

/** 记一次操作；返回新对象，方便交给响应式系统替换 */
export function bumpDay(
  breakdown: ActivityBreakdown,
  kind: ActivityKind,
  timestamp: number | Date,
): ActivityBreakdown {
  const key = dayKey(timestamp)
  if (!key)
    return breakdown
  const day = breakdown[key] ?? {}
  return { ...breakdown, [key]: { ...day, [kind]: (day[kind] ?? 0) + 1 } }
}

/**
 * 丢掉太老的计数。
 * 键是定长的 YYYY-MM-DD，字典序即时间序，直接比字符串即可。
 */
export function pruneDays(
  breakdown: ActivityBreakdown,
  now: number | Date,
  keepDays: number = ACTIVITY_DAYS,
): ActivityBreakdown {
  const span = Number.isFinite(keepDays) && keepDays > 0 ? Math.floor(keepDays) : ACTIVITY_DAYS
  const cutoff = dayKey(addDays(now, -(span - 1)))
  if (!cutoff)
    return {}

  const next: ActivityBreakdown = {}
  for (const [key, value] of Object.entries(breakdown)) {
    if (key < cutoff)
      continue
    const kinds = sanitizeDayKinds(value)
    if (Object.keys(kinds).length)
      next[key] = kinds
  }
  return next
}

/**
 * 收敛某一天的分项：认不出的来源、非正数、非数字的值一律丢掉。
 *
 * **老数据文件里这一天是一个数字**（那时只记「启动 / 打包」）—— 按 `run` 收下，
 * 迁移就这一处，onload 之后写回去的就是新形状了。
 */
function sanitizeDayKinds(raw: unknown): ActivityDayKinds {
  // 用 Math.floor 而不是先看 Number.isFinite：NaN / Infinity 也被它挡下
  if (typeof raw === 'number') {
    const legacy = Math.floor(raw)
    return Number.isFinite(legacy) && legacy > 0 ? { run: legacy } : {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return {}

  const next: ActivityDayKinds = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isActivityKind(key))
      continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      continue
    next[key] = Math.floor(value)
  }
  return next
}

/**
 * 数据文件里的 activity 可能是旧版本写的、或被手工改过，逐项收敛。
 * 键不是合法日期、分项一个都不剩的条目一律丢掉，坏数据不该让图崩掉。
 */
export function sanitizeActivity(raw: unknown): ActivityBreakdown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return {}

  const next: ActivityBreakdown = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDateKey(key))
      continue
    const kinds = sanitizeDayKinds(value)
    if (Object.keys(kinds).length)
      next[key] = kinds
  }
  return next
}

/**
 * 各来源求和：图上那一格有多深只看这个数。
 *
 * 只在这里求和、不把总数也存一份 —— 两处都存就成两份真源，分项一改就有一个跟不上。
 */
export function totalOf(breakdown: ActivityBreakdown): ActivityCounts {
  const next: ActivityCounts = {}
  for (const [key, kinds] of Object.entries(breakdown ?? {})) {
    let sum = 0
    for (const value of Object.values(kinds ?? {})) {
      if (Number.isFinite(value) && value > 0)
        sum += Math.floor(value)
    }
    if (sum > 0)
      next[key] = sum
  }
  return next
}

/**
 * 一天的分项写成一行字，给格子的悬停提示用。
 *
 * 只有一个来源时按来源说（「3 次启动 / 打包」），多个来源时才先说总数
 * （「5 次操作（3 次启动 / 打包 · 2 次工作日志）」）—— 只有一类还说「操作」等于什么也没说。
 */
export function describeDay(count: number, kinds: ActivityDayKinds): string {
  const parts = ACTIVITY_KINDS
    .filter(kind => (kinds[kind] ?? 0) > 0)
    .map(kind => `${kinds[kind]} 次${ACTIVITY_KIND_LABELS[kind]}`)
  if (!parts.length)
    return '没有操作'
  return parts.length === 1 ? parts[0] : `${count} 次操作（${parts.join(' · ')}）`
}

/** 从 counts 里取某天的次数（键非法或缺失都算 0） */
function countOf(counts: ActivityCounts, date: Date): number {
  const key = dayKey(date)
  if (!key)
    return 0
  const value = counts[key]
  return Number.isFinite(value) ? Math.floor(value) : 0
}

/**
 * 铺出贡献图。
 *
 * 最后一列是本周（含今天），前面的列依次往前推，所以第一列通常只填了一部分；
 * 未来日期照样占格子，否则最后一列会短缺一截、看着像缺数据。
 */
export function buildActivityCalendar(
  counts: ActivityCounts,
  now: number | Date,
): ActivityCalendar {
  const today = startOfDay(now)
  const source: ActivityCounts = counts ?? {}
  const start = addDays(startOfWeek(today), -(ACTIVITY_WEEKS - 1) * 7)

  const weeks: ActivityWeek[] = []
  let total = 0
  let max = 0
  let activeDays = 0

  for (let w = 0; w < ACTIVITY_WEEKS; w += 1) {
    const days: ActivityDay[] = []
    for (let d = 0; d < 7; d += 1) {
      const date = addDays(start, w * 7 + d)
      const future = date.getTime() > today.getTime()
      const count = future ? 0 : countOf(source, date)
      if (count > 0) {
        total += count
        activeDays += 1
        if (count > max)
          max = count
      }
      days.push({ date: dayKey(date), count, level: levelOf(count), future })
    }
    weeks.push({ days })
  }

  return {
    weeks,
    total,
    max,
    activeDays,
    streak: streakOf(source, today),
    bestStreak: bestStreakIn(source, start, today),
  }
}

/**
 * 连续天数：今天跑过就从今天往前数，今天还没跑则从昨天数起 ——
 * 今天没动过手不等于连续中断，那只是今天还没开始。
 *
 * 导出是因为首页顶部那一行也要这个数：它只关心「连着用了多少天」，
 * 为这一个数把整张 371 格的日历铺一遍不值当（见 HomeGreeting.vue）。
 */
export function streakOf(counts: ActivityCounts, today: Date): number {
  let cursor = countOf(counts, today) > 0 ? today : addDays(today, -1)
  let streak = 0
  while (countOf(counts, cursor) > 0) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return streak
}

function bestStreakIn(counts: ActivityCounts, start: Date, today: Date): number {
  const span = Math.round((today.getTime() - start.getTime()) / DAY_MS) + 1
  let best = 0
  let current = 0
  for (let i = 0; i < span; i += 1) {
    if (countOf(counts, addDays(start, i)) > 0) {
      current += 1
      if (current > best)
        best = current
    }
    else {
      current = 0
    }
  }
  return best
}

/**
 * 月份标签：与网格同宽的一行，只在「本月 1 号所在的那列」写字。
 * 相邻两个 1 号至少隔四周，标签不会挤在一起。
 */
export function monthLabels(weeks: ActivityWeek[]): string[] {
  return weeks.map((week) => {
    const first = week.days.find(day => day.date.endsWith('-01'))
    return first ? `${Number(first.date.slice(5, 7))}月` : ''
  })
}
