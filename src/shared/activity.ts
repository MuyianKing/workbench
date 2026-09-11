/**
 * 活跃度统计：按「本地日期 → 启动 / 打包次数」计数，铺成 GitHub 那样的贡献图。
 *
 * 计数只按天聚合（键是 YYYY-MM-DD），不记命令明细 —— 明细在项目自己的 history 里，
 * 而贡献图要的是一整年的范围：history 每个项目只留最近 10 条，撑不起这张图。
 *
 * 日期一律用本地时区：用户看到的「今天」就是本机时钟上的今天，
 * 用 UTC 会让晚上跑的命令算到第二天去。
 */

/** 日期（YYYY-MM-DD）→ 当天的命令执行次数 */
export type ActivityCounts = Record<string, number>

/** 贡献度等级，0 表示当天没有执行 */
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
  /** 区间内的执行总次数 */
  total: number
  /** 单日最高次数，用于说明「最多的一天」 */
  max: number
  /** 有执行记录的天数 */
  activeDays: number
  /** 截至今天（今天没跑则截至昨天）的连续天数 */
  streak: number
  /** 区间内最长的一次连续天数 */
  bestStreak: number
}

/** 图的列数：53 周，与 GitHub 一年视图一致 */
export const ACTIVITY_WEEKS = 53

/** 天数上限：超出这个范围的计数不再保留，否则数据文件会一直长 */
export const ACTIVITY_DAYS = ACTIVITY_WEEKS * 7

/** 分级阈值：1-3 / 4-7 / 8-11 / 12+，与 GitHub 的四档一致 */
export const LEVEL_THRESHOLDS = [1, 4, 8, 12] as const

const DAY_MS = 86_400_000
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期键；时间戳非法时返回空串（调用方跳过） */
export function dayKey(value: number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  if (!Number.isFinite(time)) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 当天 00:00（本地时区） */
export function startOfDay(value: number | Date): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) return new Date(NaN)
  date.setHours(0, 0, 0, 0)
  return date
}

/** 所在周的周日 00:00 —— 贡献图的一列从周日开始 */
export function startOfWeek(value: number | Date): Date {
  const date = startOfDay(value)
  if (!Number.isFinite(date.getTime())) return date
  date.setDate(date.getDate() - date.getDay())
  return date
}

/** 按整天位移：走 setDate 而不是加毫秒，跨月与夏令时才不会错位 */
export function addDays(value: number | Date, days: number): Date {
  const date = startOfDay(value)
  if (!Number.isFinite(date.getTime())) return date
  date.setDate(date.getDate() + days)
  return date
}

/** 次数 → 等级 */
export function levelOf(count: number): ActivityLevel {
  if (!Number.isFinite(count) || count <= 0) return 0
  if (count >= LEVEL_THRESHOLDS[3]) return 4
  if (count >= LEVEL_THRESHOLDS[2]) return 3
  if (count >= LEVEL_THRESHOLDS[1]) return 2
  return 1
}

/** 记一次执行；返回新对象，方便交给响应式系统替换 */
export function bumpDay(counts: ActivityCounts, timestamp: number | Date): ActivityCounts {
  const key = dayKey(timestamp)
  if (!key) return counts
  return { ...counts, [key]: (counts[key] ?? 0) + 1 }
}

/**
 * 丢掉太老的计数。
 * 键是定长的 YYYY-MM-DD，字典序即时间序，直接比字符串即可。
 */
export function pruneDays(
  counts: ActivityCounts,
  now: number | Date,
  keepDays: number = ACTIVITY_DAYS
): ActivityCounts {
  const span = Number.isFinite(keepDays) && keepDays > 0 ? Math.floor(keepDays) : ACTIVITY_DAYS
  const cutoff = dayKey(addDays(now, -(span - 1)))
  if (!cutoff) return {}

  const next: ActivityCounts = {}
  for (const [key, value] of Object.entries(counts)) {
    if (key < cutoff) continue
    if (!Number.isFinite(value) || value <= 0) continue
    next[key] = Math.floor(value)
  }
  return next
}

/**
 * 数据文件里的 activity 可能是旧版本写的、或被手工改过，逐项收敛。
 * 键不是合法日期、值不是正数的条目一律丢掉，坏数据不该让图崩掉。
 */
export function sanitizeActivity(raw: unknown): ActivityCounts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const next: ActivityCounts = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!DAY_KEY.test(key)) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    next[key] = Math.floor(value)
  }
  return next
}

/** 从 counts 里取某天的次数（键非法或缺失都算 0） */
function countOf(counts: ActivityCounts, date: Date): number {
  const key = dayKey(date)
  if (!key) return 0
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
  now: number | Date
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
        if (count > max) max = count
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
    streak: streakFrom(source, today),
    bestStreak: bestStreakIn(source, start, today)
  }
}

/**
 * 连续天数：今天跑过就从今天往前数，今天还没跑则从昨天数起 ——
 * 今天没动过手不等于连续中断，那只是今天还没开始。
 */
function streakFrom(counts: ActivityCounts, today: Date): number {
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
      if (current > best) best = current
    } else {
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
    const first = week.days.find((day) => day.date.endsWith('-01'))
    return first ? `${Number(first.date.slice(5, 7))}月` : ''
  })
}
