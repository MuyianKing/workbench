/**
 * Token 用量统计:从 AI 编程工具本地的数据库里读取模型请求的 token 计数,
 * 按「工具 → 天 → 模型」聚合后落盘快照,首页面板据此画趋势与占比。
 *
 * 原始明细不复制:上游工具(ZCode 等)自己的数据库就是明细账本,Workbench 只保留
 * 一层按天聚合的快照 —— 上游会清理旧会话,没有快照长期趋势就无从谈起。
 *
 * 合并规则(max):token 计数在一天之内只增不减,但上游清理会让重读出来的历史变小,
 * 所以快照合并时每天每个字段取「已存值与实读值的较大者」,永不缩水;这同时让写入幂等。
 *
 * 结构为多工具设计:sources 的键是工具 id(zcode,将来可以是 claude、codex…),
 * 各工具独立聚合、互不干扰,新增接入方不动既有数据;「工具占比」就是这一层的占比。
 *
 * 日期一律本地时区(与活跃度图同一约定);周按周一起始,月按自然月。
 */

import { addDays, dayKey } from './activity'

/** 接入来源:ZCode(读它的 ~/.zcode/cli/db/db.sqlite) */
export const ZCODE_SOURCE_ID = 'zcode'

/** 接入来源:DeepSeek Harness(读它的 ~/.dsh/sessions 多帧 zstd 会话) */
export const DSH_SOURCE_ID = 'dsh'

/** 接入来源:CodeBuddy(读它的 IDE 扩展日志里的逐步 usage 记录) */
export const CODEBUDDY_SOURCE_ID = 'codebuddy'

/** 接入工具的界面名;将来新增工具在这里登记 */
export const SOURCE_LABELS: Record<string, string> = {
  [ZCODE_SOURCE_ID]: 'ZCode',
  [DSH_SOURCE_ID]: 'DeepSeek Harness',
  [CODEBUDDY_SOURCE_ID]: 'CodeBuddy'
}

/** 一组 token 计数(某个工具某天某模型的合计) */
export interface TokenCounters {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 产生这些计数的模型请求次数 */
  requests: number
}

/** 日期(YYYY-MM-DD)→ 模型 → 计数 */
export type TokenDays = Record<string, Record<string, TokenCounters>>

/** 单个接入工具的快照 */
export interface TokenSourceSnapshot {
  days: TokenDays
}

/** token-data.json 的落盘结构 */
export interface TokenDataFile {
  version: number
  updatedAt: number
  /** 工具 id → 快照 */
  sources: Record<string, TokenSourceSnapshot>
}

/** 实读 + 快照合并后交给渲染层的结果 */
export interface TokenUsageResult {
  data: TokenDataFile
  /** 本次实读失败的来源及原因;不出现在这里即读取正常 */
  sourceErrors: Record<string, string>
}

/** token-data.json 与 workbench-data.json 同目录,文件名在这里当唯一口径 */
export const TOKEN_DATA_FILE_NAME = 'token-data.json'

/** 快照保留窗口:53 周铺满一年,与活跃度图一致 */
export const TOKEN_KEEP_DAYS = 53 * 7

/**
 * v2:去掉 v1 里的「厂商」层(当初误把模型供应商当成了统计维度)。
 * v3:修正 input_tokens 口径 —— ZCode 的输入是含缓存读取的总输入,v2 快照把缓存双算了。
 * 快照本来就会从上游实读自愈,版本不匹配整份弃用、下次实读即重建。
 */
export const TOKEN_DATA_VERSION = 3

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && DATE_KEY.test(value)
}

export function emptyCounters(): TokenCounters {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0
  }
}

/** 五类计数之和:展示与排序用的「总量」口径(缓存读取往往是大头,构成拆分交给界面) */
export function totalTokens(counters: TokenCounters): number {
  return (
    counters.inputTokens +
    counters.outputTokens +
    counters.reasoningTokens +
    counters.cacheReadTokens +
    counters.cacheWriteTokens
  )
}

/** 合计两组计数:跨模型 / 跨天求和用 */
export function addCounters(a: TokenCounters, b: TokenCounters): TokenCounters {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    requests: a.requests + b.requests
  }
}

/** 每个字段取较大者:快照合并用(永不缩水,见文件头说明) */
export function maxCounters(a: TokenCounters, b: TokenCounters): TokenCounters {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    requests: Math.max(a.requests, b.requests)
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

// ---------- 落盘收敛 ----------

function sanitizeCounters(raw: unknown): TokenCounters {
  const input = (raw ?? {}) as Record<string, unknown>
  const out = emptyCounters()
  for (const key of Object.keys(out) as Array<keyof TokenCounters>) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[key] = Math.floor(value)
    }
  }
  return out
}

function sanitizeDays(raw: unknown): TokenDays {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const next: TokenDays = {}
  for (const [date, models] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDateKey(date)) continue
    const modelDays: Record<string, TokenCounters> = {}
    const input = (models ?? {}) as Record<string, unknown>
    for (const [model, counters] of Object.entries(input)) {
      if (!model) continue
      modelDays[model] = sanitizeCounters(counters)
    }
    next[date] = modelDays
  }
  return next
}

/**
 * token-data.json 里的数据可能是老版本写的或被手工改过的,逐层收敛:
 * 键不是合法日期 / 缺字段 / 非有限正数,一律丢弃或落到默认值,坏数据不能把面板弄崩。
 * 版本不匹配(比如 v1 的厂商层结构)整份弃用 —— 快照会从上游实读自愈,不值得做迁移。
 */
export function sanitizeTokenData(raw: unknown): TokenDataFile {
  const input = (raw ?? {}) as Partial<TokenDataFile>
  if (input.version !== TOKEN_DATA_VERSION) return emptyTokenData()

  const sources: Record<string, TokenSourceSnapshot> = {}
  if (input.sources && typeof input.sources === 'object' && !Array.isArray(input.sources)) {
    for (const [id, source] of Object.entries(input.sources as Record<string, unknown>)) {
      if (!id) continue
      sources[id] = { days: sanitizeDays((source as TokenSourceSnapshot | undefined)?.days) }
    }
  }
  return {
    version: TOKEN_DATA_VERSION,
    updatedAt:
      typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : 0,
    sources
  }
}

export function emptyTokenData(): TokenDataFile {
  return { version: TOKEN_DATA_VERSION, updatedAt: 0, sources: {} }
}

// ---------- 快照合并与修剪 ----------

/**
 * 实读结果合并进快照:取键的并集,每组计数逐字段取较大者。
 * 返回新对象,不动入参。
 */
export function mergeDays(existing: TokenDays, incoming: TokenDays): TokenDays {
  const next: TokenDays = {}
  const dates = new Set([...Object.keys(existing), ...Object.keys(incoming)])
  for (const date of dates) {
    const a = existing[date] ?? {}
    const b = incoming[date] ?? {}
    const models: Record<string, TokenCounters> = {}
    for (const model of new Set([...Object.keys(a), ...Object.keys(b)])) {
      models[model] = maxCounters(a[model] ?? emptyCounters(), b[model] ?? emptyCounters())
    }
    next[date] = models
  }
  return next
}

/** 丢掉超出保留窗口的旧天数:键是定长 YYYY-MM-DD,字典序即时间序 */
export function pruneTokenDays(
  days: TokenDays,
  now: number | Date,
  keepDays: number = TOKEN_KEEP_DAYS
): TokenDays {
  const span = Number.isFinite(keepDays) && keepDays > 0 ? Math.floor(keepDays) : TOKEN_KEEP_DAYS
  const cutoff = dayKey(addDays(now, -(span - 1)))
  if (!cutoff) return {}
  const next: TokenDays = {}
  for (const [date, models] of Object.entries(days)) {
    if (date < cutoff) continue
    next[date] = models
  }
  return next
}

/** 把所有工具的天级数据合并成一份(跨工具同天同模型直接相加),供模型占比与趋势使用 */
export function flattenSources(data: TokenDataFile): TokenDays {
  const next: TokenDays = {}
  for (const source of Object.values(data.sources)) {
    for (const [date, models] of Object.entries(source.days)) {
      const target = (next[date] ??= {})
      for (const [model, counters] of Object.entries(models)) {
        target[model] = addCounters(target[model] ?? emptyCounters(), counters)
      }
    }
  }
  return next
}

// ---------- 周期与聚合 ----------

export type TokenGranularity = 'day' | 'week' | 'month'

/** 解析 YYYY-MM-DD 为本地当天 00:00;不合法返回无效 Date */
function parseDateKey(key: string): Date {
  if (!isDateKey(key)) return new Date(NaN)
  const date = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
  return Number.isFinite(date.getTime()) ? date : new Date(NaN)
}

/** 所在周的周一(周一起始);入参必须是合法日期键 */
export function weekKeyOf(key: string): string {
  const date = parseDateKey(key)
  if (!Number.isFinite(date.getTime())) return ''
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return dayKey(date)
}

/** 所在月份的键 'YYYY-MM';入参必须是合法日期键 */
export function monthKeyOf(key: string): string {
  if (!isDateKey(key)) return ''
  return key.slice(0, 7)
}

/** 一个统计桶:一个天 / 一周 / 一个自然月 */
export interface TokenBucket {
  /** 天与周是日期键,月是 'YYYY-MM' */
  key: string
  /** 图表坐标标签 */
  label: string
  counters: TokenCounters
}

export interface TokenSeries {
  buckets: TokenBucket[]
  /** 时间窗口第一天的日期键(含当天),供同窗口的占比统计复用 */
  fromKey: string
}

function bucketKeyOf(dateKey: string, granularity: TokenGranularity): string {
  if (granularity === 'day') return dateKey
  if (granularity === 'week') return weekKeyOf(dateKey)
  return monthKeyOf(dateKey)
}

function bucketLabel(key: string, granularity: TokenGranularity): string {
  if (granularity === 'month') return `${Number(key.slice(5, 7))}月`
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`
}

/** 当前周期往前数第 index 个桶的日期键(index 0 即当前桶) */
function currentBucketStart(granularity: TokenGranularity, now: Date): Date {
  if (granularity === 'week') {
    const monday = parseDateKey(dayKey(now))
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    return monday
  }
  if (granularity === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1)
  }
  return parseDateKey(dayKey(now))
}

function bucketKeyAt(start: Date, granularity: TokenGranularity, index: number): string {
  if (granularity === 'month') {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1)
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
  }
  const step = granularity === 'week' ? 7 : 1
  return dayKey(addDays(start, index * step))
}

/**
 * 把天级数据铺成图表序列:当前周期往前数 periods 个桶(含当前),顺序从旧到新;
 * 没有数据的桶补零,横轴才连续。窗口外的天数不参与累计。
 */
export function buildSeries(
  days: TokenDays,
  granularity: TokenGranularity,
  now: number | Date,
  periods: number
): TokenSeries {
  const today = new Date(now)
  if (!Number.isFinite(today.getTime()) || periods <= 0) {
    return { buckets: [], fromKey: '' }
  }

  const start = currentBucketStart(granularity, today)
  // 从当前桶往前数 periods-1 个,窗口起点(含)到当前桶(含)共 periods 个
  const firstOffset = -(periods - 1)
  const windowStartKey = bucketKeyAt(start, granularity, firstOffset)
  const windowFrom = granularity === 'month' ? `${windowStartKey}-01` : windowStartKey

  const totals = new Map<string, TokenCounters>()
  const bump = (key: string, counters: TokenCounters): void => {
    totals.set(key, addCounters(totals.get(key) ?? emptyCounters(), counters))
  }

  for (const [date, models] of Object.entries(days)) {
    if (date < windowFrom) continue
    const key = bucketKeyOf(date, granularity)
    for (const counters of Object.values(models)) bump(key, counters)
  }

  const buckets: TokenBucket[] = []
  for (let index = firstOffset; index <= 0; index += 1) {
    const key = bucketKeyAt(start, granularity, index)
    buckets.push({
      key,
      label: bucketLabel(key, granularity),
      counters: totals.get(key) ?? emptyCounters()
    })
  }

  return { buckets, fromKey: windowFrom }
}

/**
 * 一个桶覆盖的日期区间(含两端):天就是当天,周桶从周一到周日,月桶从月初到月末。
 * 点击柱状图选中某个桶后,占比统计用这个区间去 sumRange / shareBy*。
 */
export function bucketRangeOf(
  key: string,
  granularity: TokenGranularity
): { fromKey: string; toKey: string } {
  if (granularity === 'month') {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return { fromKey: '', toKey: '' }
    const year = Number(key.slice(0, 4))
    const month = Number(key.slice(5, 7))
    // 下个月的第 0 天即本月最后一天
    const lastDay = new Date(year, month, 0).getDate()
    return { fromKey: `${key}-01`, toKey: `${key}-${pad(lastDay)}` }
  }
  if (!isDateKey(key)) return { fromKey: '', toKey: '' }
  if (granularity === 'week') return { fromKey: key, toKey: dayKey(addDays(parseDateKey(key), 6)) }
  return { fromKey: key, toKey: key }
}

/** 一段日期区间(含两端)内的计数合计 */
export function sumRange(days: TokenDays, fromKey: string, toKey: string): TokenCounters {
  let total = emptyCounters()
  for (const [date, models] of Object.entries(days)) {
    if (date < fromKey || date > toKey) continue
    for (const counters of Object.values(models)) {
      total = addCounters(total, counters)
    }
  }
  return total
}

/** 区间内的一项占比(模型或工具) */
export interface TokenShare {
  key: string
  counters: TokenCounters
}

/** 区间内按模型合计(跨工具),按总量从大到小 */
export function shareByModel(days: TokenDays, fromKey: string, toKey: string): TokenShare[] {
  const totals = new Map<string, TokenCounters>()
  const bump = (key: string, counters: TokenCounters): void => {
    totals.set(key, addCounters(totals.get(key) ?? emptyCounters(), counters))
  }
  for (const [date, models] of Object.entries(days)) {
    if (date < fromKey || date > toKey) continue
    for (const [model, counters] of Object.entries(models)) bump(model, counters)
  }
  return [...totals.entries()]
    .map(([key, counters]) => ({ key, counters }))
    .sort((a, b) => totalTokens(b.counters) - totalTokens(a.counters))
}

/** 区间内按工具合计(整个 sources 层),按总量从大到小 */
export function shareBySource(
  data: TokenDataFile,
  fromKey: string,
  toKey: string
): TokenShare[] {
  return Object.entries(data.sources)
    .map(([key, source]) => ({ key, counters: sumRange(source.days, fromKey, toKey) }))
    .filter((share) => totalTokens(share.counters) > 0 || share.counters.requests > 0)
    .sort((a, b) => totalTokens(b.counters) - totalTokens(a.counters))
}

// ---------- 展示 ----------

/** token 数的中文数量级短写法:6.92亿 / 4380万 / 7.6万;非法与非正数归零 */
export function formatTokens(value: number): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0'
  const trim = (v: number): string => {
    const text = v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)
    return text.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')
  }
  if (n >= 1e8) return `${trim(n / 1e8)}亿`
  if (n >= 1e4) return `${trim(n / 1e4)}万`
  return String(Math.round(n))
}

/** 占比百分数:大于 0 但不足 1% 显示 <1%(四舍五入成 1% 会高估),其余取整数 */
export function formatPercent(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part <= 0) return '0%'
  const ratio = part / total
  if (ratio < 0.01) return '<1%'
  return `${Math.min(Math.round(ratio * 100), 100)}%`
}

/** 缓存命中率:缓存读取占「缓存读取 + 未命中输入」的比例(ZCode 的 input_tokens 不含缓存部分) */
export function cacheHitRate(counters: TokenCounters): number {
  const base = counters.cacheReadTokens + counters.inputTokens
  if (base <= 0) return 0
  return counters.cacheReadTokens / base
}
