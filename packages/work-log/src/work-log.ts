/**
 * 工作日志（本地 `work-log.json`）：类型、默认值、收敛，以及时间轴要用的纯逻辑。
 *
 * **数据在本机落盘；配了同步仓库时按设备分片共享**（`work-log/<设备id>.json`，见
 * `work-log-sync.ts`）：同步走 Token 同步那个仓库（登录 + 设置里的地址），不新增网络出口；
 * 条目按 id 做「后写胜出」，删除留墓碑，合并结果写回本机。
 *
 * 落点分工与其它数据一致：Rust 只把 JSON 安全读写到磁盘，收敛、分组、分页都在这里，
 * 于是这些规则能被单测直接覆盖，也不需要为了改一版显示口径去重编 Rust。
 *
 * 时间的最小刻度是**天**：一条记录只属于某一天（`date`），一天可以有多条；
 * 同日之内的先后由 `createdAt` 决定，界面上按时间倒序排。
 */

import { addDays, dayKey, isDateKey, startOfDay } from '@workbench/core'

/** 文件口径版本。v2 起带删除墓碑与设备 id；v1 旧文件照常读（缺的字段按空补齐） */
export const WORK_LOG_VERSION = 2

/**
 * 一条记录的生成来源（目前只有 git 提交）。
 *
 * 存哈希的唯一用处是**去重**：再点一次「从提交生成」时，已经并进某条记录的提交
 * 不再重复写入。手写的记录没有这个字段。
 */
export interface WorkLogSource {
  kind: 'git'
  /** 已并入这条记录的提交哈希（小写、去重） */
  commits: string[]
}

export interface WorkLogEntry {
  id: string
  /** 所属日期（YYYY-MM-DD，本地时区）—— 时间轴按它分组 */
  date: string
  /** 所属项目 id；非必填，项目被删掉后这里就成了悬空引用（界面按「已删除的项目」显示） */
  projectId?: string
  /**
   * 所属项目名的冗余副本：项目列表本身不跨设备同步，别的机器按 id 找不到项目时
   * 用这个名字显示，而不是一律显示「项目已删除」。本地项目还在时以本地名字为准。
   */
  projectName?: string
  /** 创建它的设备 id（多机合并时同毫秒破平；也用来判断条目是不是别的设备来的）。编辑不改它 */
  by?: string
  /** 工作内容，markdown 原文 */
  content: string
  /** 待办 / 已完成；老数据文件里没有这个字段，一律按「已完成」算（见 WORK_STATUS_DEFAULT） */
  status: WorkLogStatus
  createdAt: number
  updatedAt: number
  /** 来源；手写的记录没有 */
  source?: WorkLogSource
}

/**
 * 删除墓碑：一条记录被删掉时留下的空壳，随分片同步到别的设备。
 *
 * **不清理**（与保险库同一条口径）：清掉之后，离线很久的设备回来会把旧条目
 * 当「只有我这边有」再推回来，用户会看到删掉的记录自己复活。
 */
export interface WorkLogTombstone {
  /** 与被删条目同一个 id */
  id: string
  /** 删除发生的本地时间（毫秒） */
  updatedAt: number
  /** 执行删除的设备 id（同毫秒破平用） */
  by: string
}

/** 比较条目 / 墓碑新旧只看这两项 */
export interface WorkLogStamp {
  updatedAt: number
  by?: string
}

/** 同 id 的两份谁更新：先比 updatedAt，再比 by（设备 id 大的赢） */
export function newerWorkLogStamp(a: WorkLogStamp, b: WorkLogStamp): boolean {
  if (a.updatedAt !== b.updatedAt)
    return a.updatedAt > b.updatedAt
  return (a.by ?? '') > (b.by ?? '')
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
  todo: '待办',
}

export const WORK_STATUS_DEFAULT: WorkLogStatus = 'done'

/** git 提交哈希：7 位短哈希到 64 位（sha256 仓库）都认 */
const COMMIT_HASH = /^[0-9a-f]{7,64}$/i

export function isWorkLogStatus(value: unknown): value is WorkLogStatus {
  return typeof value === 'string' && (WORK_STATUSES as readonly string[]).includes(value)
}

/** 认不出来的取值按默认处理：手改坏的数据文件不该让一条记录既不是待办也不是已完成 */
export function sanitizeWorkLogStatus(value: unknown): WorkLogStatus {
  return isWorkLogStatus(value) ? value : WORK_STATUS_DEFAULT
}

/**
 * 一批提交哈希的收敛：去空、转小写、只留像哈希的、按原顺序去重。
 *
 * 7 位短哈希到 64 位（sha256 仓库）都认。手改坏的数据文件里混进来的任意字符串
 * 不该被当成「已导入」而挡掉真正的提交。
 */
export function sanitizeCommitHashes(raw: unknown): string[] {
  if (!Array.isArray(raw))
    return []

  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string')
      continue
    const hash = value.trim().toLowerCase()
    if (!COMMIT_HASH.test(hash) || seen.has(hash))
      continue
    seen.add(hash)
    out.push(hash)
  }
  return out
}

/** 生成来源的收敛：kind 认不出来、或一个合法哈希都没有时整块丢掉 */
export function sanitizeWorkLogSource(raw: unknown): WorkLogSource | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return undefined

  const input = raw as Partial<WorkLogSource>
  if (input.kind !== 'git')
    return undefined

  const commits = sanitizeCommitHashes(input.commits)
  return commits.length ? { kind: 'git', commits } : undefined
}

/** 点一下就是这两档之间来回切（时间轴上点记录即用它） */
export function toggleWorkLogStatus(status: WorkLogStatus): WorkLogStatus {
  return status === 'done' ? 'todo' : 'done'
}

/** 新增一条记录时提交的数据 */
export interface WorkLogInput {
  date: string
  projectId?: string
  projectName?: string
  content: string
  /** 不传就是「已完成」（见 WORK_STATUS_DEFAULT） */
  status?: WorkLogStatus
  /** 生成来源；普通手记不传 */
  source?: WorkLogSource
  /** 写入这条记录的设备 id（多机合并用；适配层统一打上） */
  by?: string
}

/** 可编辑的字段；未给的项保持原值 */
export interface WorkLogPatch {
  date?: string
  /** 显式传 null 表示清掉所属项目 */
  projectId?: string | null
  /** 项目名冗余副本；显式 null / 空串表示清掉。项目没变时不要传，免得用占位名覆盖旧值 */
  projectName?: string | null
  content?: string
  status?: WorkLogStatus
}

export interface WorkLogFile {
  version: number
  entries: WorkLogEntry[]
  /** 本机删掉的 id：随文件落盘、随分片同步（见 work-log-sync.ts） */
  tombstones: WorkLogTombstone[]
}

/**
 * 顶栏那排档位（数组顺序就是控件里的顺序）。
 *
 * 最左的「待办」不是一个时间段，而是**所有还没做完的事**（不分日期铺开），其余几档才是日期范围；
 * 最右的「自定义」用页面上那枚日期范围选择器的两端。
 */
export const WORK_RANGES = ['todo', 'today', 'yesterday', 'week', 'month', 'custom'] as const
export type WorkRange = (typeof WORK_RANGES)[number]

export const WORK_RANGE_LABELS: Record<WorkRange, string> = {
  todo: '待办',
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  month: '本月',
  custom: '自定义',
}

/** 每页显示几天（不是几条）：一天的多条记录不该被分页切开 */
export const WORK_PAGE_DAYS = 7

/**
 * 时间轴的排序维度。
 *
 *   project —— 按项目：一个项目一栏，栏内仍然从新到旧（回看「这个项目这几周做了什么」用；默认）
 *   time    —— 按时间：一天一栏，天与天、天内的记录都从新到旧（记流水账用）
 *
 * 两种维度都会先把范围外的记录筛掉，分页也共用同一套（页大小就是上面那个天数，
 * 项目模式下自然变成「每页 7 个项目」）。数组顺序就是下拉里的顺序，默认那一档排在最前。
 */
export const WORK_SORTS = ['project', 'time'] as const
export type WorkSort = (typeof WORK_SORTS)[number]

export const WORK_SORT_LABELS: Record<WorkSort, string> = {
  time: '时间',
  project: '项目',
}

export function isWorkSort(value: unknown): value is WorkSort {
  return typeof value === 'string' && (WORK_SORTS as readonly string[]).includes(value)
}

export function isWorkRange(value: unknown): value is WorkRange {
  return typeof value === 'string' && (WORK_RANGES as readonly string[]).includes(value)
}

/**
 * 默认档位：范围「今天」、维度「按项目」—— 一个项目一栏，先看「手头这几件事各做到哪儿了」
 * （按天排的那一档留给记流水账，切过去也会被记住）。
 *
 * 这两个是**设置项**（数据文件里的 `workRange` / `workSort`，见 types.ts 的
 * 「行为记忆」那一段）：上次看的那一档，下次打开还停在那儿。
 */
export const WORK_RANGE_DEFAULT: WorkRange = 'today'
export const WORK_SORT_DEFAULT: WorkSort = 'project'

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

/** 自定义区间：两端都是本地日期键（YYYY-MM-DD，含两端） */
export interface WorkRangeBounds {
  from: string
  to: string
}

/**
 * 自定义区间收敛：两端都必须是合法日期键；反着填的换回来，缺一端 / 认不出就是 null。
 *
 * 手改过的数据文件、以及选中「自定义」但还没挑过日期的第一次打开都会走到这里。
 */
export function sanitizeWorkRangeBounds(from: unknown, to: unknown): WorkRangeBounds | null {
  const left = typeof from === 'string' && isDateKey(from) ? from : ''
  const right = typeof to === 'string' && isDateKey(to) ? to : ''
  if (!left || !right)
    return null
  return left <= right ? { from: left, to: right } : { from: right, to: left }
}

/** 还没挑过自定义区间时的默认值：今天一天 */
export function defaultWorkRangeBounds(now: number): WorkRangeBounds {
  const today = dayKey(now)
  return { from: today, to: today }
}

export function emptyWorkLog(): WorkLogFile {
  return { version: WORK_LOG_VERSION, entries: [], tombstones: [] }
}

// ---------- 收敛 ----------

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** 墓碑收敛：id 为空或时间不合法就丢掉（缺一条墓碑最多让一条删除传不出去，不会把整份文件弄坏） */
export function sanitizeWorkLogTombstone(raw: unknown): WorkLogTombstone | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null

  const input = raw as Partial<WorkLogTombstone>
  const id = text(input.id)
  const updatedAt = stamp(input.updatedAt, 0)
  if (!id || !updatedAt)
    return null

  return { id, updatedAt, by: text(input.by) }
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
  now: number = Date.now(),
): WorkLogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null

  const input = raw as Partial<WorkLogEntry>
  const content = text(input.content)
  if (!content)
    return null

  const createdAt = stamp(input.createdAt, now)
  const date = isDateKey(input.date) ? input.date : dayKey(createdAt)
  if (!date)
    return null

  const id = text(input.id)
  const projectId = text(input.projectId)
  const projectName = text(input.projectName)
  const by = text(input.by)
  const source = sanitizeWorkLogSource(input.source)

  return {
    id: id || uuid(),
    date,
    // 空串按「没有所属项目」落盘，不留一个指向空的字段
    ...(projectId ? { projectId } : {}),
    ...(projectId && projectName ? { projectName } : {}),
    ...(by ? { by } : {}),
    content,
    // 老数据文件里没有这个字段 —— 缺了就是「已完成」，界面因此不会把它标成待办
    status: sanitizeWorkLogStatus(input.status),
    createdAt,
    updatedAt: stamp(input.updatedAt, createdAt),
    ...(source ? { source } : {}),
  }
}

/**
 * 磁盘 → 内存。文件缺失（首次使用）、损坏、被手工改坏都退化成一份空日志，不影响启动。
 * id 重复的条目只留第一条：列表 key 靠它，重复会让界面上两条记录一起动。
 *
 * v1 老文件没有墓碑与设备 id：照常读，缺的按空补齐。同一 id 的条目与墓碑同时存在时
 * 只留新的那份（墓碑更新 = 这条已被删；条目更新 = 删除之后又被改过，以条目为准）。
 */
export function parseWorkLog(
  raw: unknown,
  uuid: () => string,
  now: number = Date.now(),
): WorkLogFile {
  const parsed = (raw ?? {}) as Partial<WorkLogFile>
  const source = Array.isArray(parsed.entries) ? parsed.entries : []

  const entries: WorkLogEntry[] = []
  const seen = new Set<string>()
  for (const item of source) {
    const entry = sanitizeWorkLogEntry(item, uuid, now)
    if (!entry || seen.has(entry.id))
      continue
    seen.add(entry.id)
    entries.push(entry)
  }

  const tombById = new Map<string, WorkLogTombstone>()
  for (const item of Array.isArray(parsed.tombstones) ? parsed.tombstones : []) {
    const tombstone = sanitizeWorkLogTombstone(item)
    if (!tombstone)
      continue
    const current = tombById.get(tombstone.id)
    if (!current || newerWorkLogStamp(tombstone, current))
      tombById.set(tombstone.id, tombstone)
  }

  const live: WorkLogEntry[] = []
  for (const entry of entries) {
    const tombstone = tombById.get(entry.id)
    if (!tombstone) {
      live.push(entry)
      continue
    }
    if (newerWorkLogStamp(tombstone, entry))
      continue
    tombById.delete(entry.id)
    live.push(entry)
  }

  return {
    version: WORK_LOG_VERSION,
    entries: live,
    tombstones: [...tombById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  }
}

// ---------- 增删改 ----------

/** 新建一条；内容为空（必填项没填）时返回 null，调用方据此给失败提示 */
export function createWorkLogEntry(
  input: WorkLogInput,
  uuid: () => string,
  now: number = Date.now(),
): WorkLogEntry | null {
  const content = text(input.content)
  if (!content)
    return null

  const date = isDateKey(input.date) ? input.date : dayKey(now)
  if (!date)
    return null

  const projectId = text(input.projectId)
  const projectName = text(input.projectName)
  const by = text(input.by)
  const source = sanitizeWorkLogSource(input.source)
  return {
    id: uuid(),
    date,
    ...(projectId ? { projectId } : {}),
    ...(projectId && projectName ? { projectName } : {}),
    ...(by ? { by } : {}),
    content,
    // 不传就是「已完成」：写下这条时事情多半已经做完了
    status: sanitizeWorkLogStatus(input.status),
    createdAt: now,
    updatedAt: now,
    ...(source ? { source } : {}),
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
  now: number = Date.now(),
): WorkLogEntry {
  const content = patch.content === undefined ? entry.content : text(patch.content)
  // 必填项被清空时按无效处理：保持原值，而不是存下一条空记录
  const nextContent = content || entry.content

  const nextDate = patch.date === undefined ? entry.date : patch.date
  const date = isDateKey(nextDate) ? nextDate : entry.date

  const status
    = patch.status === undefined ? entry.status : sanitizeWorkLogStatus(patch.status)

  const projectId
    = patch.projectId === undefined
      ? entry.projectId
      : patch.projectId === null || !text(patch.projectId)
        ? undefined
        : text(patch.projectId)

  // 项目名只在「跟着项目一起改」时动：没选项目就清掉；换了项目但没给名字（认不出的 id）也清掉，
  // 不拿旧项目的名字张冠李戴
  let projectName = entry.projectName
  if (!projectId)
    projectName = undefined
  else if (patch.projectName !== undefined)
    projectName = text(patch.projectName) || undefined
  else if (patch.projectId !== undefined && projectId !== entry.projectId)
    projectName = undefined

  if (
    nextContent === entry.content
    && date === entry.date
    && projectId === entry.projectId
    && projectName === entry.projectName
    && status === entry.status
  ) {
    return entry
  }

  return {
    id: entry.id,
    date,
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(entry.by ? { by: entry.by } : {}),
    content: nextContent,
    status,
    createdAt: entry.createdAt,
    // 同一条记录在同一毫秒里连改两次时也保证时间戳严格递增：合并靠它分先后
    updatedAt: Math.max(Math.floor(now), entry.updatedAt + 1),
    // 手工编辑不动来源：改过正文的记录仍然知道自己是哪几笔提交生成的（去重靠它）
    ...(entry.source ? { source: entry.source } : {}),
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
  if (!isDateKey(day))
    return new Date(NaN)
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date)
}

/**
 * 某一档**日期**范围覆盖的起止日期（含两端，本地日期键）。
 *
 * 只收四档预置范围：「待办」筛的是状态、不看日期（见 `entriesInRange`）；
 * 「自定义」的两端由用户在界面上选（见 `resolveWorkRangeBounds`），拿它们算边界没有意义。
 *
 * 「本周」从**周一**起算：项目里另一处 startOfWeek 是按周日切的（贡献图那一列的起点），
 * 那是网格的排版约定，跟用户嘴里的「本周」不是一回事，别把两者合并。
 */
export function rangeBounds(
  range: Exclude<WorkRange, 'todo' | 'custom'>,
  now: number,
): WorkRangeBounds {
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
 * 某一档实际覆盖的日期区间（含两端）。
 *
 * 「待办」筛的是状态、不看日期，返回 null；「自定义」用界面上选的那一段，
 * 没选过或值坏了就退回今天 —— 这一段永远有边界可用。
 */
export function resolveWorkRangeBounds(
  range: WorkRange,
  now: number,
  custom?: WorkRangeBounds | null,
): WorkRangeBounds | null {
  if (range === 'todo')
    return null
  if (range === 'custom')
    return sanitizeWorkRangeBounds(custom?.from, custom?.to) ?? defaultWorkRangeBounds(now)
  return rangeBounds(range, now)
}

/**
 * 铺出时间轴：只留这一档里的记录，按天分组（「待办」档是所有待办，不分日期）。
 *
 * 没有记录的日子不占一栏 —— 本月按自然日铺会有大半是空行，滚起来像翻日历而不是看日志。
 */
export function timelineOf(
  entries: readonly WorkLogEntry[],
  range: WorkRange,
  now: number,
  custom?: WorkRangeBounds | null,
): WorkLogDay[] {
  const byDay = new Map<string, WorkLogEntry[]>()

  for (const entry of entriesInRange(entries, range, now, custom)) {
    const group = byDay.get(entry.date)
    if (group)
      group.push(entry)
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
 * 按项目铺开：一个项目一栏，栏内从新到旧（「待办」档是所有待办，不分日期）。
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
  projects: readonly WorkLogProjectRef[],
  custom?: WorkRangeBounds | null,
): WorkLogProjectGroup[] {
  const known = new Map(projects.map(project => [project.id, project.name]))
  const groups = new Map<string, WorkLogEntry[]>()

  for (const entry of entriesInRange(entries, range, now, custom)) {
    const key = !entry.projectId
      ? ''
      : known.has(entry.projectId)
        ? entry.projectId
        : DELETED_PROJECT_ID
    const group = groups.get(key)
    if (group)
      group.push(entry)
    else groups.set(key, [entry])
  }

  /** 0 = 已知项目，1 = 未关联，2 = 已删除 */
  const rankOf = (key: string): number => (key === '' ? 1 : key === DELETED_PROJECT_ID ? 2 : 0)

  return [...groups.entries()]
    .sort((a, b) => {
      const rank = rankOf(a[0]) - rankOf(b[0])
      if (rank !== 0)
        return rank
      const left = known.get(a[0]) ?? ''
      const right = known.get(b[0]) ?? ''
      return left.localeCompare(right)
    })
    .map(([key, list]) => ({
      projectId: key === '' ? null : key,
      entries: list.slice().sort(byRecentFirst),
    }))
}

/** 这一档里的记录：「待办」不看日期、只要还欠着的，其余档按日期闭区间收 */
function entriesInRange(
  entries: readonly WorkLogEntry[],
  range: WorkRange,
  now: number,
  custom?: WorkRangeBounds | null,
): WorkLogEntry[] {
  if (range === 'todo')
    return entries.filter(entry => entry.status !== 'done')

  const bounds = resolveWorkRangeBounds(range, now, custom)
  if (!bounds)
    return []
  return entries.filter(entry => entry.date >= bounds.from && entry.date <= bounds.to)
}

/** 从新到旧：先比日期，同一天再比写入时间 */
function byRecentFirst(a: WorkLogEntry, b: WorkLogEntry): number {
  if (a.date !== b.date)
    return a.date < b.date ? 1 : -1
  return b.createdAt - a.createdAt
}

/** 某一天里**已完成**的记录，新的在前 —— 首页「今日完成」那张卡片的数据源 */
export function completedEntriesOn(
  entries: readonly WorkLogEntry[],
  day: string,
): WorkLogEntry[] {
  return entries
    // 待办是还欠着的，不算进「今天做完了什么」
    .filter(entry => entry.date === day && entry.status === 'done')
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
  if (Number.isNaN(date.getTime()))
    return { title: day, weekday: '', relative: '' }

  const diff = Math.round(
    (startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000,
  )
  const relative
    = diff === 0 ? '今天' : diff === -1 ? '昨天' : diff === -2 ? '前天' : diff === 1 ? '明天' : ''

  return {
    title: `${date.getMonth() + 1}月${date.getDate()}日`,
    weekday: WEEKDAY_LABELS[date.getDay()],
    relative,
  }
}
