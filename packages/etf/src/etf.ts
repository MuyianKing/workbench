/**
 * ETF 资金流的纯逻辑：标的清单、三个数据源的解析、增量缓存合并、每日净买卖计算与聚合。
 *
 * **口径**：追踪 23 只「国家队」（中央汇金）重仓的宽基 ETF 的**全体持有人净申赎** ——
 * 净买入 =（当日份额 − 上一有数据日份额）× 当日单位净值，正 = 净申购、负 = 净赎回。
 * 份额变化里混着所有投资者（汇金、保险、量化、散户）与做市商对冲盘，
 * 只有数百亿级的极端日才大概率是国家队行为；名单锚定汇金 2025 年报披露的持仓（静态，
 * 汇金换战场不会自动跟）。这层口径的局限写在 docs/modules/etf.md，界面上不再重复。
 *
 * **数据与职责边界**：份额与净值经 Rust 侧白名单主机取回原文（src-tauri/src/etf.rs），
 * 解析、合并、计算全在本文件 —— 有单测、改口径走热更新。缓存落在数据目录的
 * `etf.json`（Rust 侧 JsonStore），结构见 `EtfCache`。
 */

/** 一只要追踪的 ETF：代码、展示名、市场与归集的指数类别 */
export interface EtfTarget {
  code: string
  name: string
  market: 'sh' | 'sz'
  category: string
}

/**
 * 标的清单：汇金 2025 年报持仓里的主要宽基（沪 15 只 + 深 8 只）。
 * 换名单只改这里；解析与收敛都按 `etfTargetOf` 过滤，不在此列的代码进不了缓存。
 */
export const ETF_TARGETS: readonly EtfTarget[] = [
  { code: '510300', name: '沪深300ETF 华泰柏瑞', market: 'sh', category: '沪深300' },
  { code: '510310', name: '沪深300ETF 易方达', market: 'sh', category: '沪深300' },
  { code: '510330', name: '沪深300ETF 华夏', market: 'sh', category: '沪深300' },
  { code: '159919', name: '沪深300ETF 嘉实', market: 'sz', category: '沪深300' },
  { code: '510050', name: '上证50ETF 华夏', market: 'sh', category: '上证50' },
  { code: '510100', name: '上证50ETF 易方达', market: 'sh', category: '上证50' },
  { code: '510500', name: '中证500ETF 南方', market: 'sh', category: '中证500' },
  { code: '512500', name: '中证500ETF 华夏', market: 'sh', category: '中证500' },
  { code: '159922', name: '中证500ETF 嘉实', market: 'sz', category: '中证500' },
  { code: '512100', name: '中证1000ETF 南方', market: 'sh', category: '中证1000' },
  { code: '159845', name: '中证1000ETF 华夏', market: 'sz', category: '中证1000' },
  { code: '560010', name: '中证1000ETF 广发', market: 'sh', category: '中证1000' },
  { code: '159629', name: '中证1000ETF 富国', market: 'sz', category: '中证1000' },
  { code: '159915', name: '创业板ETF 易方达', market: 'sz', category: '创业板' },
  { code: '159952', name: '创业板ETF 广发', market: 'sz', category: '创业板' },
  { code: '159977', name: '创业板ETF 天弘', market: 'sz', category: '创业板' },
  { code: '588080', name: '科创板50ETF 易方达', market: 'sh', category: '科创板50' },
  { code: '588050', name: '科创板50ETF 工银', market: 'sh', category: '科创板50' },
  { code: '510180', name: '上证180ETF 华安', market: 'sh', category: '上证180' },
  { code: '510230', name: '上证180金融ETF 国泰', market: 'sh', category: '上证180金融' },
  { code: '159901', name: '深证100ETF 易方达', market: 'sz', category: '深证100' },
  { code: '515800', name: '中证800ETF 汇添富', market: 'sh', category: '中证800' },
  { code: '560050', name: 'MSCI中国A50ETF 汇添富', market: 'sh', category: 'MSCI中国A50' },
]

const TARGET_BY_CODE: ReadonlyMap<string, EtfTarget> = new Map(ETF_TARGETS.map(item => [item.code, item]))

/** 代码在不在这份名单里；解析与收敛都拿它当滤网 */
export function etfTargetOf(code: string): EtfTarget | undefined {
  return TARGET_BY_CODE.get(code)
}

// ---------- 缓存 ----------

/**
 * `etf.json` 的结构。日期一律 `YYYYMMDD`，份额单位是**份**、净值单位是元，
 * 金额在聚合层用**元**计算、展示层才折成亿。
 */
export interface EtfCache {
  version: 1
  /** 交易日 → 代码 → 当日份额（份）。沪深两市的日终口径，节假日不会有键 */
  shares: Record<string, Record<string, number>>
  /** 代码 → 日期 → 单位净值（元） */
  nav: Record<string, Record<string, number>>
  /** 沪市逐日回填推进到的日期（含，无论该日有没有数据）；空串 = 还没开始 */
  sseDone: string
}

export function emptyEtfCache(): EtfCache {
  return { version: 1, shares: {}, nav: {}, sseDone: '' }
}

/** 日期键的硬校验：8 位数字且落在合理年份（回填窗口之外的一律不认） */
function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value))
    return false
  const year = Number(value.slice(0, 4))
  return year >= 2015 && year <= 2100
}

/** 磁盘读回的收敛：结构不对的整块丢、数值不干净的逐条丢，绝不把坏数据带进计算 */
export function sanitizeEtfCache(value: unknown): EtfCache {
  const cache = emptyEtfCache()
  if (!value || typeof value !== 'object')
    return cache
  const source = value as Record<string, unknown>

  if (source.shares && typeof source.shares === 'object') {
    for (const [date, codes] of Object.entries(source.shares)) {
      if (!isDateKey(date) || !codes || typeof codes !== 'object')
        continue
      const day: Record<string, number> = {}
      for (const [code, share] of Object.entries(codes as Record<string, unknown>)) {
        if (!etfTargetOf(code) || typeof share !== 'number' || !Number.isFinite(share) || share < 0)
          continue
        day[code] = share
      }
      if (Object.keys(day).length > 0)
        cache.shares[date] = day
    }
  }

  if (source.nav && typeof source.nav === 'object') {
    for (const [code, days] of Object.entries(source.nav)) {
      if (!etfTargetOf(code) || !days || typeof days !== 'object')
        continue
      const perDay: Record<string, number> = {}
      for (const [date, nav] of Object.entries(days as Record<string, unknown>)) {
        if (isDateKey(date) && typeof nav === 'number' && Number.isFinite(nav) && nav > 0)
          perDay[date] = nav
      }
      if (Object.keys(perDay).length > 0)
        cache.nav[code] = perDay
    }
  }

  if (isDateKey(source.sseDone))
    cache.sseDone = source.sseDone
  return cache
}

/** 把某日解析出的份额合并进缓存（同日重拉直接覆盖，幂等） */
export function mergeSharesInto(cache: EtfCache, date: string, values: Record<string, number>): void {
  const day = cache.shares[date] ?? {}
  for (const [code, share] of Object.entries(values)) {
    if (etfTargetOf(code) && Number.isFinite(share) && share >= 0)
      day[code] = share
  }
  if (Object.keys(day).length > 0)
    cache.shares[date] = day
}

/** 把某只 ETF 的净值序列合并进缓存（整只覆盖：净值来自全历史脚本，不差分） */
export function mergeNavInto(cache: EtfCache, code: string, values: Record<string, number>): void {
  if (!etfTargetOf(code))
    return
  cache.nav[code] = values
}

// ---------- 解析（三个数据源） ----------

/**
 * 上交所「每日基金份额」JSON（commonQuery.do）→ 代码 → 份额（份）。
 * 沪市接口的单日口径：`result` 数组里每行 `SEC_CODE` + `TOT_VOL`（万份，×10000 转份）。
 * 返回 `null` = 回包不是预期结构（多半是风控页 / 半截 JSON），调用方按失败处理；
 * 返回 `{}` = 结构对但当天没有数据（节假日 / 尚未发布），调用方按空日处理。
 */
export function parseSseShares(body: string): Record<string, number> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch {
    return null
  }
  const result = (parsed as { result?: unknown } | null)?.result
  if (!Array.isArray(result))
    return null
  const values: Record<string, number> = {}
  for (const row of result) {
    if (!row || typeof row !== 'object')
      continue
    const record = row as Record<string, unknown>
    const code = String(record.SEC_CODE ?? '').trim()
    const volume = Number(record.TOT_VOL)
    if (etfTargetOf(code)?.market !== 'sh')
      continue
    if (!Number.isFinite(volume) || volume <= 0)
      continue
    values[code] = Math.round(volume * 10000)
  }
  return values
}

/** 深交所「基金每日规模」JSON 的解析结论：按日合并的份额 + 分页数 + 本页行数 */
export interface SzseParseResult {
  days: Record<string, Record<string, number>>
  /** 服务端声明的总页数；0 = 没声明（调用方用「空页」判定收尾） */
  pages: number
  /** 这一页的数据行数：用来区分「翻到空页」与「这页没有目标代码」—— 后者不能当收尾 */
  rows: number
}

/** 行键 → 语义。深交所现在的回包是英文键，旧样本里的中文列名一并认（键名随栏目配置漂移） */
function szseFieldOf(key: string): 'code' | 'share' | 'date' | null {
  if (key === 'fund_code' || key.includes('代码'))
    return 'code'
  if (key === 'current_size' || key.includes('规模'))
    return 'share'
  if (key === 'size_date' || key.includes('日期'))
    return 'date'
  return null
}

/**
 * 份额列的倍数：现在的列是「基金规模(万份)」（`current_size`，值如 998,751.66），
 * 要乘回 10000 才是份；带「份」字样的旧键本来就已经是份。
 */
function szseShareScale(key: string): number {
  return key === 'current_size' || key.includes('万份') ? 1e4 : 1
}

/** 页数：可能挂在 Sheet 顶层（旧样本），也可能在 `metadata` 里（现在的回包是后者） */
function szsePageCount(sheet: Record<string, unknown>): number {
  let pages = 0
  const holders = [sheet, sheet.metadata].filter(
    holder => holder !== null && typeof holder === 'object',
  ) as Record<string, unknown>[]
  for (const holder of holders) {
    for (const [key, value] of Object.entries(holder)) {
      if (/page/i.test(key) && !/size/i.test(key) && typeof value === 'number' && value > pages)
        pages = Math.floor(value)
    }
  }
  return pages
}

/**
 * 深交所 ShowReport JSON → 日期 → 代码 → 份额（份）。
 * 行键按 `szseFieldOf` 认（英文 `size_date` / `fund_code` / `current_size` 与中文列名都行），
 * 千分位逗号（中英文都见得到）先剥掉再转数，份额按列单位折成份。只留名单里的深市代码。
 * 返回 `null` = 回包不是预期结构。
 */
export function parseSzseShares(body: string): SzseParseResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch {
    return null
  }
  if (!Array.isArray(parsed))
    return null
  const sheet = parsed.find(
    entry => entry && typeof entry === 'object' && Array.isArray((entry as Record<string, unknown>).data),
  ) as Record<string, unknown> | undefined
  const rows = sheet?.data
  if (!Array.isArray(rows))
    return null

  const days: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    if (!row || typeof row !== 'object')
      continue
    let code = ''
    let share = Number.NaN
    let scale = 1
    let date = ''
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      const field = szseFieldOf(key)
      if (field === 'code') {
        code = String(value).replace(/\D/g, '')
      }
      else if (field === 'share') {
        share = Number.parseFloat(String(value).replace(/[,，\s]/g, ''))
        scale = szseShareScale(key)
      }
      else if (field === 'date') {
        date = String(value).replace(/\D/g, '')
      }
    }
    if (!code || !isDateKey(date))
      continue
    if (etfTargetOf(code)?.market !== 'sz')
      continue
    if (!Number.isFinite(share) || share <= 0)
      continue
    const day = days[date] ?? {}
    day[code] = Math.round(share * scale)
    days[date] = day
  }

  return { days, pages: szsePageCount(sheet ?? {}), rows: rows.length }
}

/**
 * 天天基金 `pingzhongdata` 脚本 → 日期 → 单位净值（元）。
 * 整个文件是一串 `var xxx = ...;` 赋值，`Data_netWorthTrend` 里是全历史净值点
 * （`{ x: 毫秒时间戳, y: 单位净值 }`）。时间戳按东八区折日期。
 * 返回 `null` = 没摘到那段（页面改版 / 回了个错误页）。
 */
export function parseNavScript(body: string): Record<string, number> | null {
  const match = /Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/.exec(body)
  if (!match)
    return null
  let points: unknown
  try {
    points = JSON.parse(match[1])
  }
  catch {
    return null
  }
  if (!Array.isArray(points))
    return null
  const values: Record<string, number> = {}
  for (const point of points) {
    if (!point || typeof point !== 'object')
      continue
    const { x, y } = point as { x?: unknown, y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(y) || y <= 0)
      continue
    const date = utc8DateKey(x)
    if (date)
      values[date] = y
  }
  return values
}

// ---------- 回填规划 ----------

/** 本地时区的 `YYYYMMDD`（这个应用只跑在中文 Windows 上，按本地日期走） */
export function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}${month}${day}`
}

/** 毫秒时间戳按东八区折 `YYYYMMDD`（净值点的 x 是按中国日期给的） */
function utc8DateKey(ms: number): string {
  const shifted = new Date(ms + 8 * 3600 * 1000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const key = `${shifted.getUTCFullYear()}${month}${day}`
  return isDateKey(key) ? key : ''
}

function keyToDate(key: string): Date {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)))
}

function nextDayKey(key: string): string {
  const date = keyToDate(key)
  date.setDate(date.getDate() + 1)
  return dateKey(date)
}

/** 回填起点：五年前的同一天（覆盖 2024 年初救市以来的完整区间） */
export function backfillFrom(now: Date): string {
  return dateKey(new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()))
}

/**
 * 沪市还要逐日拉哪些日期：从上次推进到的下一天（首次从回填起点）到今天，
 * 只列周一到周五 —— 法定节假日由「拉回来是空且已隔两天」在拉取侧跳过（见 `isStaleEmptyDate`）。
 */
export function planSseDates(cache: EtfCache, now: Date): string[] {
  const today = dateKey(now)
  let cursor = isDateKey(cache.sseDone) ? nextDayKey(cache.sseDone) : backfillFrom(now)
  const dates: string[] = []
  while (cursor <= today) {
    const weekday = keyToDate(cursor).getDay()
    if (weekday >= 1 && weekday <= 5)
      dates.push(cursor)
    cursor = nextDayKey(cursor)
  }
  return dates
}

/** 深市已推进到的最后一天（任一深市代码有数据的最大日期）；没有则 `null` */
export function szseCoveredThrough(cache: EtfCache): string | null {
  let latest: string | null = null
  for (const [date, codes] of Object.entries(cache.shares)) {
    if (Object.keys(codes).some(code => etfTargetOf(code)?.market === 'sz') && (!latest || date > latest))
      latest = date
  }
  return latest
}

/** 一个日期区间按 ≤150 个自然日切批：深市接口对超过 6 个月的区间只回表头 */
export function planSzseRanges(from: string, to: string): { start: string, end: string }[] {
  if (!isDateKey(from) || !isDateKey(to) || from > to)
    return []
  const ranges: { start: string, end: string }[] = []
  let start = from
  while (start <= to) {
    const endDate = keyToDate(start)
    endDate.setDate(endDate.getDate() + 149)
    const end = dateKey(endDate) > to ? to : dateKey(endDate)
    ranges.push({ start, end })
    start = nextDayKey(end)
  }
  return ranges
}

/**
 * 沪市某个工作日拉回来是空的，要不要当作「已处理」跳过：
 * 已隔两天以上的一律跳（法定节假日的文件永远不会来）；今天 / 昨天不跳
 * （多半只是还没发布，停在原地等下次刷新）。
 */
export function isStaleEmptyDate(date: string, now: Date): boolean {
  if (!isDateKey(date))
    return false
  const gap = keyToDate(dateKey(now)).getTime() - keyToDate(date).getTime()
  return gap > 2 * 24 * 3600 * 1000
}

// ---------- 聚合 ----------

/** 一个交易日全表与各类别的净买卖（元） */
export interface EtfDayFlow {
  date: string
  total: number
  byCategory: Record<string, number>
}

/** 单只 ETF 的窗口视图（金额亿元） */
export interface EtfHoldingSummary {
  code: string
  name: string
  market: 'sh' | 'sz'
  category: string
  /** 展示截止日的份额（亿份） */
  lastShareYi: number
  /** 最新一条单位净值（元） */
  lastNav: number
  todayYi: number
  weekYi: number
  monthYi: number
}

/** 一个指数类别的归集视图（金额亿元） */
export interface EtfCategorySummary {
  category: string
  count: number
  todayYi: number
  weekYi: number
  monthYi: number
  lastShareYi: number
  /** 展示截止日的市值（亿元）= Σ 份额 × 净值 */
  lastScaleYi: number
}

/** 页面要的那一份：逐日净买卖、总规模与两张表的行 */
export interface EtfOverview {
  /** 展示截止的共同交易日（沪深两市都有数据的最大日期） */
  dataAsOf: string
  /** 逐日净买卖（元），只含沪深都有数据的日期（回填没到的地方不算数） */
  days: EtfDayFlow[]
  /** 与 days 同序的逐日总规模（元） */
  scaleSeries: number[]
  /** 按近一月净买入降序 */
  etfs: EtfHoldingSummary[]
  /** 按近一月净买入降序 */
  categories: EtfCategorySummary[]
  totals: {
    todayYi: number
    weekYi: number
    monthYi: number
    halfYearYi: number
    yearYi: number
    ytdYi: number
    scaleYi: number
  }
}

/**
 * 从缓存算出页面视图。
 *
 * 展示日 = 沪、深两市**都有份额数据的日期**：一边还在回填时，没覆盖到的日子不进序列
 * （半截的「全表净买卖」比没有更误导）。单只 ETF 的净买卖沿着它自己有数据的日期链算，
 * 中间缺日跳过（前值沿用上一次见到的份额）；份额与净值反向等比联动（折算 / 合并）置 0。
 * 总规模沿同一条链用「最近一次见到的份额 × 净值」补缺日。
 */
export function buildOverview(cache: EtfCache): EtfOverview {
  const allDates = Object.keys(cache.shares).sort()
  const shDays = new Set(allDates.filter(date =>
    Object.keys(cache.shares[date]).some(code => etfTargetOf(code)?.market === 'sh')))
  const szDays = new Set(allDates.filter(date =>
    Object.keys(cache.shares[date]).some(code => etfTargetOf(code)?.market === 'sz')))
  const bothCovered = shDays.size > 0 && szDays.size > 0
  const days = bothCovered
    ? allDates.filter(date => shDays.has(date) && szDays.has(date))
    : allDates

  const flows = days.map(date => ({ date, total: 0, byCategory: {} as Record<string, number> }))
  const scaleSeries: number[] = days.map(() => 0)
  const netsByCode: Record<string, Record<string, number>> = {}

  for (const target of ETF_TARGETS) {
    const navs = cache.nav[target.code] ?? {}
    const navDates = Object.keys(navs).sort()
    let navCursor = -1
    let prevShare: number | null = null
    let prevNav: number | null = null
    let lastShare: number | null = null
    let lastNav: number | null = null
    const nets: Record<string, number> = {}
    for (let i = 0; i < days.length; i++) {
      const date = days[i]
      while (navCursor + 1 < navDates.length && navDates[navCursor + 1] <= date)
        navCursor++
      const nav = navCursor >= 0 ? navs[navDates[navCursor]] : undefined
      const share = cache.shares[date]?.[target.code]
      if (share !== undefined) {
        if (prevShare !== null && nav !== undefined) {
          let net = (share - prevShare) * nav
          // 份额折算 / 合并：份额等比骤变且净值反向联动（乘积≈1）不是真申赎
          if (share !== prevShare && prevNav !== null) {
            const shareRatio = share / prevShare
            const navRatio = nav / prevNav
            if (Math.abs(shareRatio - 1) > 0.3
              && (shareRatio - 1) * (navRatio - 1) < 0
              && shareRatio * navRatio > 0.6 && shareRatio * navRatio < 1.6) {
              net = 0
            }
          }
          nets[date] = net
          flows[i].total += net
          flows[i].byCategory[target.category]
            = (flows[i].byCategory[target.category] ?? 0) + net
        }
        prevShare = share
        if (nav !== undefined)
          prevNav = nav
      }
      lastShare = share ?? lastShare
      lastNav = nav ?? lastNav
      if (lastShare !== null && lastNav !== null)
        scaleSeries[i] += lastShare * lastNav
    }
    netsByCode[target.code] = nets
  }

  const lastDay = days.length > 0 ? days[days.length - 1] : null
  const weekDates = days.slice(-5)
  const monthDates = days.slice(-21)
  const sumNets = (nets: Record<string, number>, dates: string[]): number =>
    dates.reduce((sum, date) => sum + (nets[date] ?? 0), 0)

  const etfs: EtfHoldingSummary[] = ETF_TARGETS.map((target) => {
    const nets = netsByCode[target.code]
    const share = lastDay ? cache.shares[lastDay]?.[target.code] : undefined
    const navDates = Object.keys(cache.nav[target.code] ?? {}).sort()
    const lastNav = navDates.length > 0 ? cache.nav[target.code][navDates[navDates.length - 1]] : 0
    return {
      code: target.code,
      name: target.name,
      market: target.market,
      category: target.category,
      lastShareYi: share !== undefined ? share / 1e8 : 0,
      lastNav,
      todayYi: (lastDay ? nets[lastDay] ?? 0 : 0) / 1e8,
      weekYi: sumNets(nets, weekDates) / 1e8,
      monthYi: sumNets(nets, monthDates) / 1e8,
    }
  }).sort((a, b) => b.monthYi - a.monthYi)

  const categories = new Map<string, EtfCategorySummary>()
  for (const etf of etfs) {
    const row = categories.get(etf.category) ?? {
      category: etf.category,
      count: 0,
      todayYi: 0,
      weekYi: 0,
      monthYi: 0,
      lastShareYi: 0,
      lastScaleYi: 0,
    }
    row.count++
    row.todayYi += etf.todayYi
    row.weekYi += etf.weekYi
    row.monthYi += etf.monthYi
    row.lastShareYi += etf.lastShareYi
    // 亿份 × 元/份 = 亿元
    row.lastScaleYi += etf.lastShareYi * etf.lastNav
    categories.set(etf.category, row)
  }

  const windowTotal = (count: number): number => flows.slice(-count).reduce((sum, flow) => sum + flow.total, 0)
  const year = lastDay ? lastDay.slice(0, 4) : ''

  return {
    dataAsOf: lastDay ?? '',
    days: flows,
    scaleSeries,
    etfs,
    categories: [...categories.values()].sort((a, b) => b.monthYi - a.monthYi),
    totals: {
      todayYi: windowTotal(1) / 1e8,
      weekYi: windowTotal(5) / 1e8,
      monthYi: windowTotal(21) / 1e8,
      halfYearYi: windowTotal(120) / 1e8,
      yearYi: windowTotal(242) / 1e8,
      ytdYi: flows.filter(flow => flow.date.startsWith(year)).reduce((sum, flow) => sum + flow.total, 0) / 1e8,
      scaleYi: scaleSeries.length > 0 ? scaleSeries[scaleSeries.length - 1] / 1e8 : 0,
    },
  }
}

// ---------- 展示格式 ----------

/** 元 → 亿元（`signed` 时带正负号） */
export function formatYi(yuan: number, signed = false): string {
  const yi = yuan / 1e8
  if (!Number.isFinite(yi))
    return '—'
  const text = Math.abs(yi) >= 100 ? yi.toFixed(0) : yi.toFixed(2)
  if (!signed)
    return text
  return yi > 0 ? `+${text}` : text
}

/** 份 → 亿份 */
export function formatShareYi(shares: number): string {
  return Number.isFinite(shares) ? (shares / 1e8).toFixed(2) : '—'
}

/** 已经折成亿元的数值 → 展示串（口径与 `formatYi` 一致：过百取整、带符号时正数补加号） */
export function formatYiNumber(yi: number, signed = false): string {
  if (!Number.isFinite(yi))
    return '—'
  const text = Math.abs(yi) >= 100 ? yi.toFixed(0) : yi.toFixed(2)
  return signed && yi > 0 ? `+${text}` : text
}

/** `YYYYMMDD` 日期键 → `MM-DD`（`withYear` 时 `YYYY-MM-DD`） */
export function formatDayKey(key: string, withYear = false): string {
  if (key.length !== 8)
    return key
  return withYear
    ? `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`
    : `${key.slice(4, 6)}-${key.slice(6, 8)}`
}
