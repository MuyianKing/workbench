/**
 * 界面上的时间/时长格式化。
 *
 * 原先散在 ProjectCard（运行时长）、RecentPanel（相对时间）、ProjectDrawer（历史时间与耗时）
 * 各写一份，同一个「毫秒 → 秒」有多种写法，风格也不统一。集中到这里。
 */

/** 耗时：1.2s */
export function formatDurationMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** 耗时，没有值时给破折号（历史记录里的空值） */
export function formatDurationOrDash(ms?: number): string {
  return ms ? formatDurationMs(ms) : '—'
}

/** 运行时长：不足一小时是 m:ss，否则 h:mm:ss */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 历史记录时间戳：MM-DD HH:mm */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 时刻：HH:mm（日期已由所在分组给出，例如工作日志的时间轴） */
export function formatTimeOfDay(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 */
export function formatRelative(timestamp: number | undefined, now: number): string {
  if (!timestamp) return '未使用过'

  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const diff = Math.max(0, now - timestamp)

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return `${Math.floor(diff / (30 * day))} 个月前`
}
