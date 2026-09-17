/**
 * 工作日志（本地 `work-log.json`）：类型、默认值、收敛，以及时间轴要用的纯逻辑。
 *
 * **这份数据只在本机**：它不进同步仓库，也不在 `workbench-data.json` 里（见 AGENTS.md 第 5 节
 * 的出口约定）—— 工作内容是最贴近「个人记录」的东西，默认不往外发；
 * 文件与数据目录同进同出（迁移数据目录时会一起搬），但不会跟着 Token 同步被推上去。
 *
 * 落点分工与其它数据一致：Rust 只把 JSON 安全读写到磁盘，收敛、分组、分页都在这里，
 * 于是这些规则能被单测直接覆盖，也不需要为了改一版显示口径去重编 Rust。
 *
 * 时间的最小刻度是**天**：一条记录只属于某一天（`date`），一天可以有多条；
 * 同日之内的先后由 `createdAt` 决定，界面上按时间倒序排。
 */

import { addDays, dayKey, startOfDay } from './activity'
import { isDateKey } from './token-usage'

/** 文件口径版本。只在本机流转，不参与跨设备合并，所以版本只用来标记格式 */
export const WORK_LOG_VERSION = 1

export interface WorkLogEntry {
  id: string
  /** 所属日期（YYYY-MM-DD，本地时区）—— 时间轴按它分组 */
  date: string
  /** 所属项目 id；非必填，项目被删掉后这里就成了悬空引用（界面按「已删除的项目」显示） */
  projectId?: string
  /** 工作内容，markdown 原文 */
  content: string
  /** 待办 / 已完成；老数据文件里没有这个字段，一律按「已完成」算（见 WORK_STATUS_DEFAULT） */
  status: WorkLogStatus
  createdAt: number
  updatedAt: number
}

/**
 * 一条记录的状态。
 *
 * 只有两档，而且**默认是「已完成」**：写下这条记录时多数事情已经做完了，
 * 回来处理待办才需要额外一次操作（时间轴上点一下即切换）。
 */
export const WORK_STATUSES = ['done', 'todo'] as const
export type WorkLogStatus = (typeof WORK_STATUSES)[number]

export const WORK_STATUS_LABELS: Record<WorkLogStatus, string> = {
  done: '已完成',
  todo: '待办'
}

export const WORK_STATUS_DEFAULT: WorkLogStatus = 'done'

export function isWorkLogStatus(value: unknown): value is WorkLogStatus {
  return typeof value === 'string' && (WORK_STATUSES as readonly string[]).includes(value)
}

/** 认不出来的取值按默认处理：手改坏的数据文件不该让一条记录既不是待办也不是已完成 */
export function sanitizeWorkLogStatus(value: unknown): WorkLogStatus {
  return isWorkLogStatus(value) ? value : WORK_STATUS_DEFAULT
}

/** 点一下就是这两档之间来回切（时间轴上点记录即用它） */
export function toggleWorkLogStatus(status: WorkLogStatus): WorkLogStatus {
  return status === 'done' ? 'todo' : 'done'
}

/** 新增一条记录时提交的数据 */
export interface WorkLogInput {
  date: string
  projectId?: string
  content: string
  /** 不传就是「已完成」（见 WORK_STATUS_DEFAULT） */
  status?: WorkLogStatus
}

/** 可编辑的字段；未给的项保持原值 */
export interface WorkLogPatch {
  date?: string
  /** 显式传 null 表示清掉所属项目 */
  projectId?: string | null
  content?: string
  status?: WorkLogStatus
}

export interface WorkLogFile {
  version: number
  entries: WorkLogEntry[]
}

/**
 * 时间轴的范围档位。
 * 刻意不做「自定义区间」：日常最多的就是这四问，多一个日期选择器只是多一步操作。
 */
export const WORK_RANGES = ['today', 'yesterday', 'week', 'month'] as const
export type WorkRange = (typeof WORK_RANGES)[number]

export const WORK_RANGE_LABELS: Record<WorkRange, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  month: '本月'
}

/** 每页显示几天（不是几条）：一天的多条记录不该被分页切开 */
export const WORK_PAGE_DAYS = 7

/**
 * 时间轴的排序维度。
 *
 *   time    —— 按时间：一天一栏，天与天、天内的记录都从新到旧（默认，记流水账用）
 *   project —— 按项目：一个项目一栏，栏内仍然从新到旧（回看「这个项目这几周做了什么」用）
 *
 * 两种维度都会先把范围外的记录筛掉，分页也共用同一套（页大小就是上面那个天数，
 * 项目模式下自然变成「每页 7 个项目」）。
 */
export const WORK_SORTS = ['time', 'project'] as const
export type WorkSort = (typeof WORK_SORTS)[number]

export const WORK_SORT_LABELS: Record<WorkSort, string> = {
  time: '时间',
  project: '项目'
}

export function isWorkSort(value: unknown): value is WorkSort {
  return typeof value === 'string' && (WORK_SORTS as readonly string[]).includes(value)
}

export function isWorkRange(value: unknown): value is WorkRange {
  return typeof value === 'string' && (WORK_RANGES as readonly string[]).includes(value)
}

/**
 * 默认档位：范围「今天」、维度「按时间」—— 与工作页原本的初始取值一致
 * （记流水账最常看的就是今天）。
 *
 * 这两个是**设置项**（数据文件里的 `workRange` / `workSort`，见 types.ts 的
 * 「行为记忆」那一段）：上次看的那一档，下次打开还停在那儿。
 */
export const WORK_RANGE_DEFAULT: WorkRange = 'today'
export const WORK_SORT_DEFAULT: WorkSort = 'time'

/**
 * 认不出来的一律回默认。
 *
 * 这一项会被写回界面上的选中值（分段控件与下拉），留一个认不出的值在那儿，
 * 控件会是「一个都没选中」的样子。
 */
export function sanitizeWorkRange(value: unknown): WorkRange {
  return isWorkRange(value) ? value : WORK_RANGE_DEFAULT
}

export function sanitizeWorkSort(value: unknown): WorkSort {
  return isWorkSort(value) ? value : WORK_SORT_DEFAULT
}

export function emptyWorkLog(): WorkLogFile {
  return { version: WORK_LOG_VERSION, entries: [] }
}

// ---------- 收敛 ----------

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * 把磁盘上的一条记录收敛成合法结构；内容为空、日期又推不出来的条目直接丢掉（返回 null）。
 *
 * 日期缺失或写坏时回落到 `createdAt` 那一天：那是这条记录唯一还能确定的时间信息，
 * 丢掉整条会把用户写过的内容一起删没。
 */
export function sanitizeWorkLogEntry(
  raw: unknown,
  uuid: () => string,
  now: number = Date.now()
): WorkLogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const input = raw as Partial<WorkLogEntry>
  const content = text(input.content)
  if (!content) return null

  const createdAt = stamp(input.createdAt, now)
  const date = isDateKey(input.date) ? input.date : dayKey(createdAt)
  if (!date) return null

  const id = text(input.id)
  const projectId = text(input.projectId)

  return {
    id: id || uuid(),
    date,
    // 空串按「没有所属项目」落盘，不留一个指向空的字段
    ...(projectId ? { projectId } : {}),
    content,
    // 老数据文件里没有这个字段 —— 缺了就是「已完成」，界面因此不会把它标成待办
    status: sanitizeWorkLogStatus(input.status),
    createdAt,
    updatedAt: stamp(input.updatedAt, createdAt)
  }
}

/**
 * 磁盘 → 内存。文件缺失（首次使用）、损坏、被手工改坏都退化成一份空日志，不影响启动。
 * id 重复的条目只留第一条：列表 key 靠它，重复会让界面上两条记录一起动。
 */
export function parseWorkLog(
  raw: unknown,
  uuid: () => string,
  now: number = Date.now()
): WorkLogFile {
  const parsed = (raw ?? {}) as Partial<WorkLogFile>
  const source = Array.isArray(parsed.entries) ? parsed.entries : []

  const entries: WorkLogEntry[] = []
  const seen = new Set<string>()
  for (const item of source) {
    const entry = sanitizeWorkLogEntry(item, uuid, now)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }

  return { version: WORK_LOG_VERSION, entries }
}

// ---------- 增删改 ----------

/** 新建一条；内容为空（必填项没填）时返回 null，调用方据此给失败提示 */
export function createWorkLogEntry(
  input: WorkLogInput,
  uuid: () => string,
  now: number = Date.now()
): WorkLogEntry | null {
  const content = text(input.content)
  if (!content) return null

  const date = isDateKey(input.date) ? input.date : dayKey(now)
  if (!date) return null

  const projectId = text(input.projectId)
  return {
    id: uuid(),
    date,
    ...(projectId ? { projectId } : {}),
    content,
    // 不传就是「已完成」：写下这条时事情多半已经做完了
    status: sanitizeWorkLogStatus(input.status),
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 改一条。
 *
 * 内容（含状态、日期、所属项目）真的变过才刷新 `updatedAt` —— 它表示「这条记录最后一次改动是什么时候」，
 * 打开编辑框又原样保存不该把它推到当下（与 theme.json 的 updatedAt 同一条口径）。
 * 反过来，在时间轴上点一下把它标成待办 / 已完成也是一次真实改动，时间戳照样要跟着走。
 */
export function patchWorkLogEntry(
  entry: WorkLogEntry,
  patch: WorkLogPatch,
  now: number = Date.now()
): WorkLogEntry {
  const content = patch.content === undefined ? entry.content : text(patch.content)
  // 必填项被清空时按无效处理：保持原值，而不是存下一条空记录
  const nextContent = content || entry.content

  const nextDate = patch.date === undefined ? entry.date : patch.date
  const date = isDateKey(nextDate) ? nextDate : entry.date

  const status =
    patch.status === undefined ? entry.status : sanitizeWorkLogStatus(patch.status)

  const projectId =
    patch.projectId === undefined
      ? entry.projectId
      : patch.projectId === null || !text(patch.projectId)
        ? undefined
        : text(patch.projectId)

  if (
    nextContent === entry.content &&
    date === entry.date &&
    projectId === entry.projectId &&
    status === entry.status
  ) {
    return entry
  }

  return {
    id: entry.id,
    date,
    ...(projectId ? { projectId } : {}),
    content: nextContent,
    status,
    createdAt: entry.createdAt,
    updatedAt: now
  }
}

// ---------- 时间轴 ----------

export interface WorkLogDay {
  /** YYYY-MM-DD */
  day: string
  /** 同一天里的多条记录，新的在前 */
  entries: WorkLogEntry[]
}

/** 日期键 → 当天 00:00（本地时区）；键非法时返回 Invalid Date，调用方自己兜 */
export function dateOfDayKey(day: string): Date {
  if (!isDateKey(day)) return new Date(NaN)
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date)
}

/**
 * 某一档范围覆盖的起止日期（含两端，本地日期键）。
 *
 * 「本周」从**周一**起算：项目里另一处 startOfWeek 是按周日切的（贡献图那一列的起点），
 * 那是网格的排版约定，跟用户嘴里的「本周」不是一回事，别把两者合并。
 */
export function rangeBounds(range: WorkRange, now: number): { from: string; to: string } {
  const today = startOfDay(now)

  switch (range) {
    case 'yesterday': {
      const day = dayKey(addDays(today, -1))
      return { from: day, to: day }
    }
    case 'week': {
      const monday = addDays(today, -((today.getDay() + 6) % 7))
      return { from: dayKey(monday), to: dayKey(addDays(monday, 6)) }
    }
    case 'month': {
      const first = startOfDay(today)
      first.setDate(1)
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
      return { from: dayKey(first), to: dayKey(last) }
    }
    default: {
      const day = dayKey(today)
      return { from: day, to: day }
    }
  }
}

/**
 * 铺出时间轴：只留范围内的记录，按天分组。
 *
 * 没有记录的日子不占一栏 —— 本月按自然日铺会有大半是空行，滚起来像翻日历而不是看日志。
 */
export function timelineOf(
  entries: readonly WorkLogEntry[],
  range: WorkRange,
  now: number
): WorkLogDay[] {
  const byDay = new Map<string, WorkLogEntry[]>()

  for (const entry of entriesInRange(entries, range, now)) {
    const group = byDay.get(entry.date)
    if (group) group.push(entry)
    else byDay.set(entry.date, [entry])
  }

  return [...byDay.entries()]
    // 日期键是定长的，字典序即时间序：新的在前
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, list]) => ({ day, entries: list.slice().sort(byRecentFirst) }))
}

/** 关联的项目已经被删掉时归到这一组（键值刻意不可能与真实 id 相同） */
export const DELETED_PROJECT_ID = '#deleted'

export interface WorkLogProjectGroup {
  /** 项目 id；null 表示这条记录没关联项目（未分组），见 DELETED_PROJECT_ID */
  projectId: string | null
  entries: WorkLogEntry[]
}

/** 按项目分组时只需要名字：排序与栏头都用它，颜色由界面自己按 id 找 */
export interface WorkLogProjectRef {
  id: string
  name: string
}

/**
 * 按项目铺开：一个项目一栏，栏内从新到旧。
 *
 * 关联的项目已经被删掉的记录**合并成一栏**（否则会按那串悬空 id 裂成好几栏，
 * 看上去像好几个不同的项目，其实都是同一种情况）。
 * 栏的顺序：已知项目按名字排，其后是「未关联」，最后是「已删除」——
 * 名字序是可预期的，用户找某个项目时不用猜它在哪儿。
 */
export function groupByProject(
  entries: readonly WorkLogEntry[],
  range: WorkRange,
  now: number,
  projects: readonly WorkLogProjectRef[]
): WorkLogProjectGroup[] {
  const known = new Map(projects.map((project) => [project.id, project.name]))
  const groups = new Map<string, WorkLogEntry[]>()

  for (const entry of entriesInRange(entries, range, now)) {
    const key = !entry.projectId
      ? ''
      : known.has(entry.projectId)
        ? entry.projectId
        : DELETED_PROJECT_ID
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }

  /** 0 = 已知项目，1 = 未关联，2 = 已删除 */
  const rankOf = (key: string): number => (key === '' ? 1 : key === DELETED_PROJECT_ID ? 2 : 0)

  return [...groups.entries()]
    .sort((a, b) => {
      const rank = rankOf(a[0]) - rankOf(b[0])
      if (rank !== 0) return rank
      const left = known.get(a[0]) ?? ''
      const right = known.get(b[0]) ?? ''
      return left.localeCompare(right)
    })
    .map(([key, list]) => ({
      projectId: key === '' ? null : key,
      entries: list.slice().sort(byRecentFirst)
    }))
}

/** 范围内的记录（两端闭区间） */
function entriesInRange(
  entries: readonly WorkLogEntry[],
  range: WorkRange,
  now: number
): WorkLogEntry[] {
  const { from, to } = rangeBounds(range, now)
  return entries.filter((entry) => entry.date >= from && entry.date <= to)
}

/** 从新到旧：先比日期，同一天再比写入时间 */
function byRecentFirst(a: WorkLogEntry, b: WorkLogEntry): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  return b.createdAt - a.createdAt
}

/** 某一天里**已完成**的记录，新的在前 —— 首页「今日完成」那张卡片的数据源 */
export function completedEntriesOn(
  entries: readonly WorkLogEntry[],
  day: string
): WorkLogEntry[] {
  return entries
    // 待办是还欠着的，不算进「今天做完了什么」
    .filter((entry) => entry.date === day && entry.status === 'done')
    .sort(byRecentFirst)
}

export interface Page<T> {
  items: T[]
  /** 收敛后的页码（越界会夹到有效范围内） */
  page: number
  /** 总页数，至少 1 —— 空列表也是「第 1 页，共 1 页」 */
  pages: number
}

/** 通用分页：页码越界（换了范围之后页数变少）自动夹回来，不让界面停在空页上 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const size = Math.max(1, Math.floor(pageSize) || 1)
  const pages = Math.max(1, Math.ceil(items.length / size))
  const wanted = Math.floor(page)
  const current = Math.min(Math.max(1, Number.isFinite(wanted) ? wanted : 1), pages)
  const start = (current - 1) * size

  return { items: items.slice(start, start + size), page: current, pages }
}

// ---------- 展示 ----------

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export interface WorkLogDayMeta {
  /** 9月15日 */
  title: string
  /** 周二 */
  weekday: string
  /** 今天 / 昨天 / 前天 / 明天；更远的日子为空串 */
  relative: string
}

/** 一天在时间轴上的标题：日期 + 星期 + 相对今天。 */
export function dayMeta(day: string, now: number): WorkLogDayMeta {
  const date = dateOfDayKey(day)
  if (Number.isNaN(date.getTime())) return { title: day, weekday: '', relative: '' }

  const diff = Math.round(
    (startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000
  )
  const relative =
    diff === 0 ? '今天' : diff === -1 ? '昨天' : diff === -2 ? '前天' : diff === 1 ? '明天' : ''

  return {
    title: `${date.getMonth() + 1}月${date.getDate()}日`,
    weekday: WEEKDAY_LABELS[date.getDay()],
    relative
  }
}
