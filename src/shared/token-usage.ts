/**
 * 用量统计:从 AI 编程工具本地的数据库/日志里读取模型请求的计数,
 * 按「工具 → 天 → 模型」聚合后落盘快照,首页面板据此画趋势与占比。
 *
 * 计数有两套口径(见 UsageAxis):token 计数,与按额度记账的工具报的 credits
 * (目前只有 Qoder)。两者量纲不同,面板上一次只画一个,切换即换一套数字;
 * 但它们**共用这一份快照与同一套合并规则** —— 分片仍是「一台机器一个文件」,
 * 不必为了多一个口径再开一份数据文件。
 *
 * 原始明细不复制:上游工具(ZCode 等)自己的数据库就是明细账本,Workbench 只保留
 * 一层按天聚合的快照 —— 上游会清理旧会话,没有快照长期趋势就无从谈起。
 *
 * 合并规则分两层:分片内取 max,分片之间求和。
 *
 *  - **分片内取 max**:token 计数在一天之内只增不减,但上游清理会让重读出来的历史变小,
 *    所以快照合并时每天每个字段取「已存值与实读值的较大者」,永不缩水;这同时让写入幂等。
 *  - **分片之间求和**:多台机器各写一份设备分片(见 TokenShard),同一天同一个模型上的用量
 *    是两笔独立消耗,取 max 会把另一台机器整个丢掉,必须相加。
 *
 * 分片按设备拆还有个不显眼但关键的好处:每个文件只有一个写者,所以「一台机器一个文件」的
 * 布局丢给任何同步工具都不会产生同文件冲突,同步不需要任何锁或合并策略。
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

/** 接入来源:WorkBuddy(读它会话正文里每次模型调用自带的 usage 记录) */
export const WORKBUDDY_SOURCE_ID = 'workbuddy'

/**
 * 接入来源:Qoder(读它会话文件里每次请求的 credits)。
 *
 * 它**只有额度、没有 token**:Qoder 的客户端压根不产生 token 计数
 * (会话文件与 CLI 日志里的 input_tokens/output_tokens 恒为 0,它自己的上下文快照里
 * 也写着 `tokenCountsAvailable: false`),本地能读到的只有每条请求的 `credits`。
 * 所以这个来源只落在 credits 这一个字段上,在 tokens 口径下它整个不出现。
 */
export const QODER_SOURCE_ID = 'qoder'

/** 接入工具的界面名;将来新增工具在这里登记 */
export const SOURCE_LABELS: Record<string, string> = {
  [ZCODE_SOURCE_ID]: 'ZCode',
  [DSH_SOURCE_ID]: 'DeepSeek Harness',
  [CODEBUDDY_SOURCE_ID]: 'CodeBuddy',
  [WORKBUDDY_SOURCE_ID]: 'WorkBuddy',
  [QODER_SOURCE_ID]: 'Qoder'
}

/** 一组计数(某个工具某天某模型的合计) */
export interface TokenCounters {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * 额度消耗(Qoder 那种按 credits 记账的工具)。
   *
   * 它与上面五类 token 计数**不是一个量纲**,永远不参与 totalTokens ——
   * 面板上按口径(UsageAxis)二选一展示,谁也加不到谁头上。
   */
  credits: number
  /** 产生这些计数的模型请求次数 */
  requests: number
}

/** 日期(YYYY-MM-DD)→ 模型 → 计数 */
export type TokenDays = Record<string, Record<string, TokenCounters>>

/** 单个接入工具的快照 */
export interface TokenSourceSnapshot {
  days: TokenDays
}

/**
 * 一台机器的用量快照:既是本机 token-usage.json 的落盘结构,也是同步仓库里的一份设备分片。
 *
 * device 是机器本地生成的 id(见 Rust 的 paths::device_file),分片文件名就是它。
 * 它**绝不进同步仓库** —— 两台机器拿到同一个 id 就会互相覆盖,
 * 表现成「数据永远只有一台机器的」,而且没有任何报错。
 *
 * 外观配置**不在这里**:它是 theme.json 的整份内容,按同样的「一台机器一个文件」布局
 * 放在仓库的 config/ 目录下(见 sync-config.ts)。两者各走各的目录之后,
 * 用量那边的口径/版本演进不必再带上外观,反之也一样。
 */
export interface TokenShard {
  version: number
  device: string
  /** 设备名(默认取主机名),只当界面上的标签用 */
  name: string
  updatedAt: number
  /** 工具 id → 快照 */
  sources: Record<string, TokenSourceSnapshot>
}

/** 展示用的合计:多台机器合并后的一层,首页面板只认这个 */
export interface TokenDataFile {
  version: number
  updatedAt: number
  /** 工具 id → 快照 */
  sources: Record<string, TokenSourceSnapshot>
}

/** 参与合计的另一台机器(不含本机) */
export interface TokenSyncDevice {
  id: string
  name: string
  /** 那台机器最后一次写分片的时间 */
  updatedAt: number
}

/**
 * Token 同步状态。
 * 未开启同步(设置里没填仓库地址)时只有 enabled=false 有意义,其余字段照旧给默认值,
 * 界面据此决定要不要画同步那一块。
 */
export interface TokenSyncStatus {
  enabled: boolean
  /** 本机设备名,界面上说明这份数据来自哪台机器 */
  deviceName: string
  /**
   * 实际在同步的仓库地址(就是设置里那个)。
   * 显示出来是有用的:同步打到别的仓库时 git 不会报任何错,界面上不写清楚就只能靠猜
   * (踩过一次:改了地址但克隆还指着老仓库,状态一切正常,数据全进了另一个仓库)。
   */
  repo: string
  /** 上次同步尝试(成功或失败都算)的时间;0 表示这次启动还没同步过 */
  lastSyncAt: number
  /** 本次同步的失败原因;空串表示正常 */
  error: string
  /** 已合进来的其它设备 */
  devices: TokenSyncDevice[]
}

/** 实读 + 快照合并后交给渲染层的结果 */
export interface TokenUsageResult {
  data: TokenDataFile
  /** 本次实读失败的来源及原因;不出现在这里即读取正常 */
  sourceErrors: Record<string, string>
  sync: TokenSyncStatus
}

/** token-usage.json 与 workbench-data.json 同目录,文件名在这里当唯一口径 */
export const TOKEN_USAGE_FILE_NAME = 'token-usage.json'

/** 同步仓库地址的长度上限:git 远程地址远短于此,超长多半是贴错了东西 */
export const TOKEN_SYNC_REPO_MAX_LENGTH = 300

/**
 * 同步仓库地址收敛:去掉首尾空白,**空串表示不开启同步**(设置里由它承担开关)。
 *
 * 两条拒绝规则是为「这个值最终会被当成 git 的命令行参数」服务的:
 *  - 含空白:参数要经 Windows 的 shell 词法,带空格的地址容易被拆成两个参数;
 *  - 以 `-` 开头:git 会把它当选项解析(`--upload-pack=...` 那一类),是实打实的参数注入面。
 * 认不出来的一律按没填处理(等于关掉同步),而不是留着一个每次都失败的值。
 */
export function sanitizeSyncRepo(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  if (!value || value.length > TOKEN_SYNC_REPO_MAX_LENGTH) return ''
  if (/\s/.test(value) || value.startsWith('-')) return ''
  return value
}

/** 快照保留窗口:53 周铺满一年,与活跃度图一致 */
export const TOKEN_KEEP_DAYS = 53 * 7

/**
 * v2:去掉 v1 里的「厂商」层(当初误把模型供应商当成了统计维度)。
 * v3:修正 input_tokens 口径 —— ZCode 的输入是含缓存读取的总输入,v2 快照把缓存双算了。
 * v4:包一层设备信息(device / name),逐日计数与 v3 完全一致。
 * v5:多带一份外观配置(appearance),逐日计数与 v4 完全一致。
 * v6:外观搬去 config/ 目录,这个文件只剩用量 —— 逐日计数与 v5 完全一致。
 * v7:计数里多一个 credits 字段(额度型工具),token 口径与 v6 完全一致 ——
 *     v6 的文件读进来时 credits 一律是 0,历史照常留住,下一次实读就把额度补上。
 *
 * 读取时**不能**按「版本不等就整份弃用」处理:v1→v2→v3 是口径修正,弃掉之后能从上游实读自愈;
 * 而 v4 起文件里装着**别的机器**的历史,弃掉就再也读不回来(那台机器不开机就不会重写分片)。
 * 所以兼容版本显式列进下面这张表,新增口径版本要手工往里加,别写成 `version >= 3`。
 */
export const TOKEN_DATA_VERSION = 7

/** 能安全读进来的版本:这几版之间的逐日计数口径相同,多带一份外观、或是把外观搬走都不改变计数 */
export const TOKEN_DATA_COMPATIBLE_VERSIONS: readonly number[] = [3, 4, 5, 6, 7]

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
    credits: 0,
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

/**
 * 面板上的两个口径:token 计数,或额度。
 *
 * 两者量纲不同,既不能相加、也不能画在同一根轴上 —— 面板一次只画一个口径,
 * 切换口径就是换一套数字(总览、趋势、占比都跟着换),这也正是「工具占比」在
 * 两个口径下会给出不同名单的原因(Qoder 只出现在 credits 里)。
 */
export type UsageAxis = 'tokens' | 'credits'

/** 一个口径下这组计数的用量;tokens 是五类之和,credits 就是那一项 */
export function axisTotal(counters: TokenCounters, axis: UsageAxis): number {
  return axis === 'credits' ? counters.credits : totalTokens(counters)
}

/** 合计两组计数:跨模型 / 跨天求和用 */
export function addCounters(a: TokenCounters, b: TokenCounters): TokenCounters {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    credits: a.credits + b.credits,
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
    credits: Math.max(a.credits, b.credits),
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
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    // credits 是小数记账(一条请求不到 1 个额度是常态),取整会把它抹成 0 —— 唯一不取整的字段
    out[key] = key === 'credits' ? value : Math.floor(value)
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
 * 分片里的数据可能是老版本写的或被手工改过的,逐层收敛:
 * 键不是合法日期 / 缺字段 / 非有限正数,一律丢弃或落到默认值,坏数据不能把面板弄崩。
 * 版本不在兼容表里(v1 的厂商层结构)才整份弃用 —— 那几版计数口径不同,迁移不值得做。
 *
 * fallback 用于补设备信息:v3 的文件里没有 device / name 两个字段,
 * 读本机旧文件时由调用方把本机设备填进来,这样老数据升级不用丢历史。
 */
export function sanitizeShard(
  raw: unknown,
  fallback: { device?: string; name?: string } = {}
): TokenShard {
  const input = (raw ?? {}) as Partial<TokenShard>
  const version = typeof input.version === 'number' ? input.version : 0
  if (!TOKEN_DATA_COMPATIBLE_VERSIONS.includes(version)) return emptyShard(fallback)

  const sources: Record<string, TokenSourceSnapshot> = {}
  if (input.sources && typeof input.sources === 'object' && !Array.isArray(input.sources)) {
    for (const [id, source] of Object.entries(input.sources as Record<string, unknown>)) {
      if (!id) continue
      sources[id] = { days: sanitizeDays((source as TokenSourceSnapshot | undefined)?.days) }
    }
  }
  return {
    version: TOKEN_DATA_VERSION,
    device: text(input.device) || fallback.device || '',
    name: text(input.name) || fallback.name || '',
    updatedAt:
      typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : 0,
    sources
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function emptyShard(fallback: { device?: string; name?: string } = {}): TokenShard {
  return {
    version: TOKEN_DATA_VERSION,
    device: fallback.device ?? '',
    name: fallback.name ?? '',
    updatedAt: 0,
    sources: {}
  }
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

/**
 * 两份天级数据是否完全一致。
 *
 * 用途是判断「这次实读有没有带来新东西」：没变就不该刷新快照的时间戳。
 * 同步那边按内容比对决定要不要提交，时间戳每轮都动一下的话，应用开着就会
 * 每 10 分钟往仓库里推一个什么都没改的提交。
 */
export function sameDays(a: TokenDays, b: TokenDays): boolean {
  const dates = Object.keys(a)
  if (dates.length !== Object.keys(b).length) return false

  for (const date of dates) {
    const left = a[date]
    const right = b[date]
    if (!right) return false

    const models = Object.keys(left)
    if (models.length !== Object.keys(right).length) return false

    for (const model of models) {
      const l = left[model]
      const r = right[model]
      if (!r) return false
      for (const key of Object.keys(l) as Array<keyof TokenCounters>) {
        if (l[key] !== r[key]) return false
      }
    }
  }
  return true
}

/**
 * 磁盘上那份(raw)与「这次要写的分片」是否已经一致 —— 决定这一轮要不要落盘。
 *
 * 只看计数是不够的:v3 那种缺 device / name 的老文件,以及所有旧版本号的文件,
 * 读进来时由 sanitizeShard 在**内存里**补齐,不写回去的话永远升不上来(老数据会一直
 * 以旧结构留在磁盘上)。反过来,内容一致时也不该写 —— 用量面板每 60 秒实读一轮,
 * 每轮都整份重写一遍 JSON 是白费的 I/O。
 *
 * 键序不参与比较:两份 JSON 的键序不同不代表内容不同,而这个比较要稳定到
 * 「写回去再读出来一定判等」,否则会退化成每轮都写。
 */
export function sameShardContent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) return false

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false

  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false
    const l = left[key]
    const r = right[key]
    if (typeof l === 'object' && typeof r === 'object' && l !== null && r !== null) {
      if (!sameShardContent(l, r)) return false
      continue
    }
    if (l !== r) return false
  }
  return true
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

/** 合计两组天级数据:键的并集,同天同模型逐字段相加(跨设备合并用)。
 *  名字避开 `addDays` —— 那是 activity 里「日期加减天数」的工具函数,本模块已经在用它推日期。 */
export function sumDays(a: TokenDays, b: TokenDays): TokenDays {
  const next: TokenDays = {}
  for (const date of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[date] ?? {}
    const right = b[date] ?? {}
    const models: Record<string, TokenCounters> = {}
    for (const model of new Set([...Object.keys(left), ...Object.keys(right)])) {
      models[model] = addCounters(left[model] ?? emptyCounters(), right[model] ?? emptyCounters())
    }
    next[date] = models
  }
  return next
}

/**
 * 把多台机器的分片合成一份展示用的合计:同工具、同天、同模型相加,并丢掉窗口外的旧天。
 *
 * 传进来的分片必须**每台机器只有一份**:本机那份要用内存里的最新分片,不能连仓库里的
 * 副本一起传 —— 副本是上次推送时的样子,两份都算就会把本机重复计一遍。
 * 分片内已经是 max 合并后的值(见 mergeDays),这里只负责求和,所以整条链幂等:
 * 同一批分片合多少次结果都一样,反复同步不会让数字慢慢变大。
 */
export function combineShards(
  shards: TokenShard[],
  now: number | Date,
  keepDays: number = TOKEN_KEEP_DAYS
): TokenDataFile {
  const sources: Record<string, TokenSourceSnapshot> = {}
  let updatedAt = 0

  for (const shard of shards) {
    if (shard.updatedAt > updatedAt) updatedAt = shard.updatedAt
    for (const [tool, source] of Object.entries(shard.sources)) {
      const target = (sources[tool] ??= { days: {} })
      target.days = sumDays(target.days, source.days)
    }
  }
  for (const source of Object.values(sources)) {
    source.days = pruneTokenDays(source.days, now, keepDays)
  }

  return { version: TOKEN_DATA_VERSION, updatedAt, sources }
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

/** 日期键的短标签(9/14):图表坐标与区间标题共用 */
export function shortDayLabel(key: string): string {
  if (!isDateKey(key)) return ''
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`
}

function bucketLabel(key: string, granularity: TokenGranularity): string {
  if (granularity === 'month') return `${Number(key.slice(5, 7))}月`
  return shortDayLabel(key)
}

/** firstKey 到 lastKey(含两端)之间的全部桶键;键是定长日期键,字典序即时间序 */
function bucketKeysBetween(
  firstKey: string,
  lastKey: string,
  granularity: TokenGranularity
): string[] {
  const keys: string[] = []
  if (granularity === 'month') {
    const lastYear = Number(lastKey.slice(0, 4))
    const lastMonth = Number(lastKey.slice(5, 7))
    let year = Number(firstKey.slice(0, 4))
    let month = Number(firstKey.slice(5, 7))
    while (year < lastYear || (year === lastYear && month <= lastMonth)) {
      keys.push(`${year}-${pad(month)}`)
      month += 1
      if (month > 12) {
        month = 1
        year += 1
      }
    }
    return keys
  }

  const step = granularity === 'week' ? 7 : 1
  const start = parseDateKey(firstKey)
  for (let index = 0; ; index += 1) {
    const key = dayKey(addDays(start, index * step))
    if (!key || key > lastKey) break
    keys.push(key)
  }
  return keys
}

/**
 * 把天级数据铺成图表序列:按 granularity 从 fromKey 到 toKey(含两端)分桶,顺序从旧到新;
 * 没有数据的桶补零,横轴才连续。区间外的天数不参与累计 ——
 * 周桶与月桶按 fromKey / toKey 所在的周与月对齐,首尾桶可能只覆盖区间内的那几天。
 * 区间不合法(非日期键,或起点晚于终点)返回空序列,调用方据此兜底。
 */
export function buildSeriesRange(
  days: TokenDays,
  granularity: TokenGranularity,
  fromKey: string,
  toKey: string
): TokenSeries {
  if (!isDateKey(fromKey) || !isDateKey(toKey) || fromKey > toKey) {
    return { buckets: [], fromKey: '' }
  }

  const totals = new Map<string, TokenCounters>()
  const bump = (key: string, counters: TokenCounters): void => {
    totals.set(key, addCounters(totals.get(key) ?? emptyCounters(), counters))
  }

  for (const [date, models] of Object.entries(days)) {
    if (date < fromKey || date > toKey) continue
    for (const counters of Object.values(models)) bump(bucketKeyOf(date, granularity), counters)
  }

  const buckets: TokenBucket[] = []
  const keyRange = bucketKeysBetween(
    bucketKeyOf(fromKey, granularity),
    bucketKeyOf(toKey, granularity),
    granularity
  )
  for (const key of keyRange) {
    buckets.push({
      key,
      label: bucketLabel(key, granularity),
      counters: totals.get(key) ?? emptyCounters()
    })
  }

  return { buckets, fromKey }
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

/**
 * 区间内按工具合计(整个 sources 层),按当前口径从大到小。
 *
 * 只收这个口径下真有数的工具:两个口径互不替代,一边有数不代表另一边也算它一份。
 * (早先还允许「请求次数 > 0 但计数为 0」的工具露一行,现在不行了 ——
 * Qoder 在 tokens 口径下正是这副样子:请求次数一堆、token 全是 0。)
 */
export function shareBySource(
  data: TokenDataFile,
  fromKey: string,
  toKey: string,
  axis: UsageAxis
): TokenShare[] {
  return Object.entries(data.sources)
    .map(([key, source]) => ({ key, counters: sumRange(source.days, fromKey, toKey) }))
    .filter((share) => axisTotal(share.counters, axis) > 0)
    .sort((a, b) => axisTotal(b.counters, axis) - axisTotal(a.counters, axis))
}

// ---------- 时间维度预设 ----------

/**
 * 时间筛选的档位:与 DeepSeek 用量页的「时间维度」同款。
 * custom 不携带固定区间,由日历上选出的起止日期决定。
 */
export type TokenRangePreset = 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom'

/** 面板里的固定顺序:自定义放最后,选中它才展开右侧的区间日历 */
export const TOKEN_RANGE_PRESETS: ReadonlyArray<{ key: TokenRangePreset; label: string }> = [
  { key: 'last7', label: '近 7 天' },
  { key: 'last30', label: '近 30 天' },
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'custom', label: '自定义' }
]

/** 预设的界面名;未知值按自定义处理 */
export function presetLabel(preset: TokenRangePreset): string {
  return TOKEN_RANGE_PRESETS.find((option) => option.key === preset)?.label ?? '自定义'
}

/**
 * 预设 → 日期区间(含两端),锚点是「今天」:近 N 天与本月都截至今天,上个月是已经走完的整月。
 * 调用方每次刷新重新解析,跨过午夜后「近 7 天 / 本月」才会跟着走。
 * 自定义没有固定区间,返回 null,由调用方保留已选的那段。
 */
export function resolvePresetRange(
  preset: TokenRangePreset,
  now: number | Date
): { fromKey: string; toKey: string } | null {
  const today = dayKey(now)
  if (!today) return null
  switch (preset) {
    case 'last7':
      return { fromKey: dayKey(addDays(now, -6)), toKey: today }
    case 'last30':
      return { fromKey: dayKey(addDays(now, -29)), toKey: today }
    case 'thisMonth':
      return { fromKey: `${today.slice(0, 7)}-01`, toKey: today }
    case 'lastMonth':
      return lastMonthRange(now)
    default:
      return null
  }
}

/**
 * 上个月的首尾两天:1 号到「本月 0 号」(即上月最后一天)。
 * 先把日期挪到 1 号再退月份,否则 3 月 31 日退一个月会落到 3 月 3 日;跨年由 Date 自己进位。
 */
function lastMonthRange(now: number | Date): { fromKey: string; toKey: string } {
  const source = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  const first = new Date(source.getTime())
  first.setDate(1)
  first.setMonth(first.getMonth() - 1)
  const last = new Date(source.getTime())
  last.setDate(0)
  return { fromKey: dayKey(first), toKey: dayKey(last) }
}

// ---------- 展示 ----------

/** 去掉小数末尾的 0(7.60 → 7.6,7.00 → 7);两个数字格式化函数共用 */
function trimZeroes(text: string): string {
  return text.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')
}

/** token 数的中文数量级短写法:6.92亿 / 4380万 / 7.6万;非法与非正数归零 */
export function formatTokens(value: number): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0'
  const trim = (v: number): string => {
    const text = v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2)
    return trimZeroes(text)
  }
  if (n >= 1e8) return `${trim(n / 1e8)}亿`
  if (n >= 1e4) return `${trim(n / 1e4)}万`
  return String(Math.round(n))
}

/**
 * 额度(credits)的短写法。
 *
 * 与 token 那套的区别在**小数位**:token 动辄上万、取整就够,而额度是小数记账
 * (实测一条请求 0.078 ~ 6.14),一律取整会把一整天的消耗抹成 0 ——
 * 所以 1 以下留两位、1 到 100 留一位,上百才取整;上万再走「万」。
 */
export function formatCredits(value: number): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1e4) return `${trimZeroes(n >= 1e6 ? (n / 1e4).toFixed(0) : (n / 1e4).toFixed(1))}万`
  if (n >= 100) return String(Math.round(n))
  if (n >= 1) return trimZeroes(n.toFixed(1))
  return n.toFixed(2)
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
