/**
 * 网关用量的汇总。
 *
 * Rust 只负责把窗口内的流水取齐（本机 `usage.jsonl` + 同步仓库里别的机器），
 * 分组 / 分桶 / 比率这些**口径**留在这里 —— 与 Rust 的 `wb_usage::summarize` 同口径：
 *
 *  - 积分只认上游 `usage.credit` 明确给过、且大于 0 的行：缺字段与 `credit = 0`
 *    的免费请求都不进样本数、也不进比率分母（零消耗的 token 不参与折算）。
 *  - 比率 = credits / creditTokens × 1_000_000；跨账号 / 跨模型由两个总量**直接除**，
 *    不是各组比率的平均。
 *  - 桶键按 UTC+8 的墙钟（`YYYY-MM-DD HH` / `YYYY-MM-DD`），与网关用量页的分桶时区一致。
 *  - 时间轴把「有数据的第一格 → 最后一格」补满，空闲时段才不会跟下一条并排。
 */

/** 聚合用得到的一条流水（Rust `UsageRow` 的子集，额外字段不影响） */
export interface GatewayUsageRowLike {
  ts: number
  uid: string
  realm: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  /** 首字延迟（毫秒）；非流式时等于总耗时 */
  ttftMs: number
  /** 整段耗时（毫秒） */
  durationMs: number
  ok: boolean
  /** 上游给这次请求扣的积分；没给是 null（不是 0） */
  credit: number | null
  /** 按价表折算的估算花费；未定价是 null */
  costCny: number | null
}

export interface GatewayUsageGroup {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  credits: number
  creditSamples: number
  creditTokens: number
  creditsPer1MTokens: number
  cacheHitPct: number
  costCny: number
  pricedTokens: number
  pricedRequests: number
}

/** 失败数与延迟 / 速度：账号与模型两档都要，明细表同一套列不随维度变 */
export interface GatewayTimingStats {
  failed: number
  avgTtftMs: number
  tokensPerSec: number
}

export interface GatewayModelUsage extends GatewayUsageGroup, GatewayTimingStats {
  model: string
}

export interface GatewayAccountUsage extends GatewayUsageGroup, GatewayTimingStats {
  uid: string
  realm: string
}

export interface GatewayBucketUsage {
  bucket: string
  requests: number
  totalTokens: number
  costCny: number
}

export interface GatewayUsageSummary {
  requests: number
  failed: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  credits: number
  creditSamples: number
  creditTokens: number
  creditsPer1MTokens: number
  avgTtftMs: number
  tokensPerSec: number
  cacheHitPct: number
  successPct: number
  costCny: number
  pricedTokens: number
  pricedRequests: number
  byModel: GatewayModelUsage[]
  byBucket: GatewayBucketUsage[]
  bucketUnit: 'hour' | 'day'
  byAccount: GatewayAccountUsage[]
}

/** 窗口 → 粒度。一周以内按小时（看得到尖峰），再长退回按天（三十天按小时是 720 根柱子） */
export function gatewayBucketUnit(days: number): 'hour' | 'day' {
  return days <= 7 ? 'hour' : 'day'
}

const HOUR_SECS = 3600

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Unix 秒 → UTC+8 的桶键前缀（`2026-10-20 16` / `2026-10-20`） */
function bucketKey(ts: number, unit: 'hour' | 'day'): string {
  const date = new Date((ts + 8 * HOUR_SECS) * 1000)
  const day = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
  return unit === 'hour' ? `${day} ${pad2(date.getUTCHours())}` : day
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 积分 / 1M Token。分母为空就是 0（界面按样本数显示「—」），不是 NaN */
function perMillion(credits: number, tokens: number): number {
  return tokens > 0 ? (credits / tokens) * 1_000_000 : 0
}

/** 命中率 = 缓存 token / 输入 token。没有输入就是 0 */
function hitPct(cached: number, prompt: number): number {
  return prompt > 0 ? (cached / prompt) * 100 : 0
}

interface GroupAccumulator {
  requests: number
  failed: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  credits: number
  creditSamples: number
  creditTokens: number
  costCny: number
  pricedTokens: number
  pricedRequests: number
  /** 成功且首字 > 0 的条数与累计毫秒：组内平均首字延迟 */
  ttftCount: number
  ttftMs: number
  /** 生成阶段耗时（每条至少按 1ms 计）：吐字速度的分母 */
  generationMs: number
}

function emptyAccumulator(): GroupAccumulator {
  return {
    requests: 0,
    failed: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    credits: 0,
    creditSamples: 0,
    creditTokens: 0,
    costCny: 0,
    pricedTokens: 0,
    pricedRequests: 0,
    ttftCount: 0,
    ttftMs: 0,
    generationMs: 0,
  }
}

function accumulate(target: GroupAccumulator, row: GatewayUsageRowLike): void {
  target.requests += 1
  if (!row.ok)
    target.failed += 1
  target.promptTokens += row.promptTokens
  target.completionTokens += row.completionTokens
  target.totalTokens += row.totalTokens
  target.cachedTokens += row.cachedTokens
  target.generationMs += Math.max(1, row.durationMs)
  if (row.ok && row.ttftMs > 0) {
    target.ttftCount += 1
    target.ttftMs += row.ttftMs
  }
  // 积分只认上游明确给的、且大于 0 的数：缺字段与 credit = 0 都不进样本 / 分母
  if (row.credit !== null && row.credit > 0) {
    target.credits += row.credit
    target.creditSamples += 1
    if (row.totalTokens > 0)
      target.creditTokens += row.totalTokens
  }
  if (row.costCny !== null) {
    target.costCny += row.costCny
    target.pricedTokens += row.totalTokens
    target.pricedRequests += 1
  }
}

function finishGroup(target: GroupAccumulator): GatewayUsageGroup {
  return {
    requests: target.requests,
    promptTokens: target.promptTokens,
    completionTokens: target.completionTokens,
    totalTokens: target.totalTokens,
    cachedTokens: target.cachedTokens,
    credits: target.credits,
    creditSamples: target.creditSamples,
    creditTokens: target.creditTokens,
    creditsPer1MTokens: perMillion(target.credits, target.creditTokens),
    cacheHitPct: hitPct(target.cachedTokens, target.promptTokens),
    costCny: round2(target.costCny),
    pricedTokens: target.pricedTokens,
    pricedRequests: target.pricedRequests,
  }
}

/** 组内的失败数与速度指标：账号 / 模型两档共用，免得同一个数在两处各算一遍 */
function finishTiming(target: GroupAccumulator): GatewayTimingStats {
  return {
    failed: target.failed,
    avgTtftMs: target.ttftCount > 0 ? Math.floor(target.ttftMs / target.ttftCount) : 0,
    tokensPerSec: target.generationMs > 0 ? target.completionTokens / (target.generationMs / 1000) : 0,
  }
}

export function summarizeGatewayRows(rows: GatewayUsageRowLike[], unit: 'hour' | 'day'): GatewayUsageSummary {
  const total = emptyAccumulator()
  const byModel = new Map<string, GroupAccumulator>()
  const byAccount = new Map<string, GroupAccumulator & { uid: string, realm: string }>()
  const buckets = new Map<string, GatewayBucketUsage>()

  for (const row of rows) {
    accumulate(total, row)

    const model = byModel.get(row.model) ?? emptyAccumulator()
    accumulate(model, row)
    byModel.set(row.model, model)

    const account = byAccount.get(row.uid) ?? { ...emptyAccumulator(), uid: row.uid, realm: row.realm }
    accumulate(account, row)
    byAccount.set(row.uid, account)

    const bucket = bucketKey(row.ts, unit)
    const cell = buckets.get(bucket) ?? { bucket, requests: 0, totalTokens: 0, costCny: 0 }
    cell.requests += 1
    cell.totalTokens += row.totalTokens
    if (row.costCny !== null)
      cell.costCny = round2(cell.costCny + row.costCny)
    buckets.set(bucket, cell)
  }

  // 时间轴补满：只补「有数据的第一格 → 最后一格」，不把窗口外的空档画出来
  if (rows.length > 0) {
    let first = Number.POSITIVE_INFINITY
    let last = Number.NEGATIVE_INFINITY
    for (const row of rows) {
      first = Math.min(first, row.ts)
      last = Math.max(last, row.ts)
    }
    const step = unit === 'hour' ? HOUR_SECS : 24 * HOUR_SECS
    for (let ts = first; ts <= last; ts += step) {
      const key = bucketKey(ts, unit)
      if (!buckets.has(key))
        buckets.set(key, { bucket: key, requests: 0, totalTokens: 0, costCny: 0 })
    }
  }

  const modelList = [...byModel.entries()]
    .map(([model, value]) => ({ model, ...finishGroup(value), ...finishTiming(value) }))
    .sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens))

  const accountList = [...byAccount.values()]
    .map(value => ({
      uid: value.uid,
      realm: value.realm,
      ...finishGroup(value),
      ...finishTiming(value),
    }))
    .sort((a, b) => b.requests - a.requests)

  const summary = finishGroup(total)
  return {
    requests: total.requests,
    failed: total.failed,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    cachedTokens: summary.cachedTokens,
    credits: summary.credits,
    creditSamples: summary.creditSamples,
    creditTokens: summary.creditTokens,
    creditsPer1MTokens: summary.creditsPer1MTokens,
    avgTtftMs: total.ttftCount > 0 ? Math.floor(total.ttftMs / total.ttftCount) : 0,
    tokensPerSec: total.generationMs > 0 ? total.completionTokens / (total.generationMs / 1000) : 0,
    cacheHitPct: summary.cacheHitPct,
    successPct: total.requests > 0 ? ((total.requests - total.failed) / total.requests) * 100 : 0,
    costCny: summary.costCny,
    pricedTokens: summary.pricedTokens,
    pricedRequests: summary.pricedRequests,
    byModel: modelList,
    byBucket: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    bucketUnit: unit,
    byAccount: accountList,
  }
}

/**
 * 最近 N 小时的逐小时序列（UTC+8 桶）。
 *
 * 图表固定看最近 24 小时，不跟页面上选的时间范围走：从 `now` 所在那一小时往前数 N 格，
 * 空档补 0 —— 横轴的格数与位置因此是稳定的，不会因为这段时间没有请求就把图缩掉。
 * 传入的 `rows` 覆盖住这 N 小时即可：`wb_gateway_usage_rows` 的取数起点至少铺满 24 小时
 * （即使页面上选的是自然日的「今日」也够，见 Rust 的 `wb_usage::fetch_start`）。
 */
export function recentHourBuckets(
  rows: GatewayUsageRowLike[],
  hours: number,
  now: number,
): GatewayBucketUsage[] {
  const count = Math.max(1, Math.floor(hours))
  const end = Math.floor(now / HOUR_SECS) * HOUR_SECS
  const start = end - (count - 1) * HOUR_SECS

  const buckets = new Map<string, GatewayBucketUsage>()
  for (let ts = start; ts <= end; ts += HOUR_SECS) {
    const bucket = bucketKey(ts, 'hour')
    buckets.set(bucket, { bucket, requests: 0, totalTokens: 0, costCny: 0 })
  }

  for (const row of rows) {
    if (row.ts < start || row.ts >= end + HOUR_SECS)
      continue
    const cell = buckets.get(bucketKey(row.ts, 'hour'))
    if (!cell)
      continue
    cell.requests += 1
    cell.totalTokens += row.totalTokens
    if (row.costCny !== null)
      cell.costCny = round2(cell.costCny + row.costCny)
  }

  return [...buckets.values()]
}
