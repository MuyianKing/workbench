import type { EtfCache, EtfOverview } from '@workbench/etf'

import type { EtfProgress, EtfRefreshOutcome, EtfSyncPullOutcome } from '@/types'
/**
 * ETF 资金流（导航「ETF」页）的适配层实现：拉取编排与落盘。
 *
 * **数据流**：缓存住在数据目录的 `etf.json`（Rust 侧 JsonStore 管读写），三个数据源的
 * 主机白名单住在 Rust 的 `etf.rs` —— 这一层只能给日期 / 代码 / 页码，拼不出地址。
 * 策略全在 `packages/etf/src/etf.ts`（解析、合并、窗口计算），这里只做「读缓存 → 规划缺口 →
 * 拉取 → 合并 → 落盘 → 出视图」的编排：
 *
 * - **深市先行**（按代码过滤、区间批量）：从五年前回填起点拉到今天，拉完就能出完整序列；
 * - **沪市逐日**：一天一个请求，串行小间隔（交易所的接口别连打）；进度记在 `sseDone`，
 *   **断点续传** —— 中断后下次从推进到的下一天继续；
 * - **净值**：一只一份全历史，超过 5 天没更新才重拉，日常刷新零请求。
 *
 * **为什么会出网**：只在用户打开 ETF 页（或点页面上的刷新）时走这一趟。开同步时先经
 * `pullEtfCache` 把别的机器推在用户仓库里的那份并进来，再规划缺口 —— 已经有人跑过回填的
 * 机器不会再把同一批日期向交易所要一遍；这一轮真拉到了东西，结束时 `publishEtfCache` 推回去。
 */
import {
  backfillFrom,
  buildOverview,
  dateKey,
  ETF_TARGETS,
  isStaleEmptyDate,
  mergeEtfCacheInto,
  mergeNavInto,
  mergeSharesInto,
  parseNavScript,
  parseSseShares,
  parseSzseShares,
  planSseDates,
  planSzseRanges,
  sanitizeEtfCache,
  szseCoveredThrough,
} from '@workbench/etf'
import { errorText, invoke } from './bridge'
// 载荷类型搬到 /types（契约侧）了；这里 re-export，老导入不动
export type { EtfProgress, EtfRefreshOutcome, EtfSyncPullOutcome } from '@/types'

/** Rust 回来的原始取数结果（与 etf.rs 的 EtfFetchResult 一致） */
interface EtfFetchResult {
  status: number
  body: string
}

/** 沪市逐日请求之间的间隔：交易所的接口，别连打 */
const SSE_GAP_MS = 150
/** 深市逐只、逐页请求之间的间隔（同一个交易所，同一口径） */
const SZSE_GAP_MS = 150
/** 同一个请求的重试：偶发抖动不该让整轮回填停下来 */
const RETRIES = 2
const RETRY_GAP_MS = 1200
/** 净值超过这个天数没更新才重拉（全历史一份，日常增量走份额那条路） */
const REFRESH_STALE_DAYS = 5

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function loadCache(): Promise<EtfCache> {
  const raw = await invoke<unknown>('etf_load')
  return sanitizeEtfCache(raw)
}

async function saveCache(cache: EtfCache): Promise<void> {
  await invoke('etf_save', { value: cache })
}

/** 带重试地取一个源的原文；始终拿不到时抛带原因的错误 */
async function fetchBody(command: string, args: Record<string, unknown>): Promise<string> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const fetched = await invoke<EtfFetchResult>(command, args)
      if (fetched.status === 200)
        return fetched.body
      lastError = new Error(`HTTP ${fetched.status}`)
    }
    catch (error) {
      lastError = error
    }
    if (attempt < RETRIES)
      await sleep(RETRY_GAP_MS)
  }
  throw new Error(errorText(lastError, '取数失败'))
}

function daysAgoKey(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return dateKey(date)
}

function nextDayKeyOf(key: string): string {
  const date = new Date(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)))
  date.setDate(date.getDate() + 1)
  return dateKey(date)
}

/** 只读缓存：不联网。页面首屏先摆上次的内容，再交给 refresh 后台更新 */
export async function loadEtfOverview(): Promise<EtfOverview> {
  const cache = await loadCache()
  return buildOverview(cache)
}

/** 净值：只拉「没有净值」或「最新一条净值已超过 5 天」的代码（全历史一份，日常不用动） */
async function refreshNavs(cache: EtfCache, staleBefore: string, onProgress: (p: EtfProgress) => void, notes: string[]): Promise<boolean> {
  const stale = ETF_TARGETS.filter(({ code }) => {
    const dates = Object.keys(cache.nav[code] ?? {}).sort()
    return dates.length === 0 || dates[dates.length - 1] < staleBefore
  })
  onProgress({ phase: 'nav', done: 0, total: stale.length })
  let changed = false
  for (let i = 0; i < stale.length; i++) {
    const { code, name } = stale[i]
    try {
      const values = parseNavScript(await fetchBody('etf_fetch_nav', { code }))
      if (values) {
        mergeNavInto(cache, code, values)
        changed = true
      }
      else {
        notes.push(`${name} 的净值脚本解析不出来`)
      }
    }
    catch (error) {
      notes.push(`${name} 的净值没拉到：${errorText(error, '取数失败')}`)
    }
    onProgress({ phase: 'nav', done: i + 1, total: stale.length })
  }
  return changed
}

/**
 * 深市份额：报表的「代码或简称」过滤（`txtDm`）只认单个代码，所以按「区间 → 标的」拉：
 * 区间 ≤150 天（接口自身限 6 个月），一只一页 20 个交易日 —— 五年回填八只加起来几百个请求，
 * 比不带过滤地翻全市场（一天 39 页、前后几万个请求）小两个数量级。
 * 一个区间内八只全收齐才合并（半批合并会留洞）；失败就停在这里，已成功的区间照留，
 * 下次刷新从已推进到的位置接着来，断点续传。
 */
async function refreshSzse(cache: EtfCache, today: string, onProgress: (p: EtfProgress) => void, notes: string[]): Promise<boolean> {
  const covered = szseCoveredThrough(cache)
  const start = covered ? nextDayKeyOf(covered) : backfillFrom(new Date())
  const ranges = planSzseRanges(start, today)
  if (ranges.length === 0)
    return false
  const codes = ETF_TARGETS.filter(target => target.market === 'sz')
  const total = ranges.length * codes.length
  onProgress({ phase: 'szse', done: 0, total })
  let changed = false
  let done = 0
  for (const { start: rangeStart, end } of ranges) {
    try {
      const merged: Record<string, Record<string, number>> = {}
      for (const { code } of codes) {
        for (let page = 1; ; page++) {
          const parsed = parseSzseShares(await fetchBody('etf_fetch_szse', { code, start: rangeStart, end, page }))
          if (!parsed)
            throw new Error(`${code} 的回包不是预期的结构`)
          for (const [date, values] of Object.entries(parsed.days))
            merged[date] = { ...(merged[date] ?? {}), ...values }
          // 服务端声明了页数就按页数收尾；没声明就翻到空页为止（这页没有目标代码不算空页）
          const pages = parsed.pages > 0 ? parsed.pages : page + 1
          if (page >= pages || parsed.rows === 0)
            break
          await sleep(SZSE_GAP_MS)
        }
        done++
        onProgress({ phase: 'szse', done, total })
        await sleep(SZSE_GAP_MS)
      }
      for (const [date, values] of Object.entries(merged))
        mergeSharesInto(cache, date, values)
      changed = true
    }
    catch (error) {
      notes.push(`深市份额（${rangeStart} ~ ${end}）没拉全：${errorText(error, '取数失败')}`)
      break
    }
  }
  return changed
}

/**
 * 沪市份额：一天一个请求，串行小间隔。推进到的日期记在 `sseDone`：
 * 拉到数据推进；节假日（空且已隔两天）也推进；今天 / 昨天的空多半是还没发布，
 * 停在原地等下次。中途失败（网络 / 风控）同样停在原地，断点续传。
 */
async function refreshSse(cache: EtfCache, onProgress: (p: EtfProgress) => void, notes: string[]): Promise<boolean> {
  const dates = planSseDates(cache, new Date())
  if (dates.length === 0)
    return false
  onProgress({ phase: 'sse', done: 0, total: dates.length })
  let changed = false
  let done = 0
  for (const date of dates) {
    try {
      const values = parseSseShares(await fetchBody('etf_fetch_sse', { date }))
      if (values === null)
        throw new Error('回包不是预期的结构')
      if (Object.keys(values).length > 0) {
        mergeSharesInto(cache, date, values)
        cache.sseDone = date
        changed = true
      }
      else if (isStaleEmptyDate(date, new Date())) {
        cache.sseDone = date
      }
      else {
        break // 今天 / 昨天还没发布：停在原地，下次刷新再来
      }
    }
    catch (error) {
      notes.push(`沪市份额停在 ${date}：${errorText(error, '取数失败')}`)
      break
    }
    done++
    onProgress({ phase: 'sse', done, total: dates.length })
    await sleep(SSE_GAP_MS)
  }
  return changed
}

/**
 * 刷新一次：净值（过期才拉）→ 深市（区间批量）→ 沪市（逐日回填，大头）。
 * 每个阶段完成都落一次盘 —— 首次回填沪市要上千个请求，中途关掉应用不丢进度。
 */
export async function refreshEtf(onProgress: (p: EtfProgress) => void): Promise<EtfRefreshOutcome> {
  const cache = await loadCache()
  const notes: string[] = []
  const staleBefore = daysAgoKey(REFRESH_STALE_DAYS)
  const today = dateKey(new Date())
  let updated = false

  if (await refreshNavs(cache, staleBefore, onProgress, notes))
    updated = true
  if (updated)
    await saveCache(cache)

  if (await refreshSzse(cache, today, onProgress, notes)) {
    updated = true
    await saveCache(cache)
  }

  if (await refreshSse(cache, onProgress, notes)) {
    updated = true
  }
  await saveCache(cache)

  return { overview: buildOverview(cache), updated, notes }
}

/**
 * 把同步仓库里**别的机器**推上来的 ETF 缓存并进本机。
 *
 * 「一台机器同步过，其他机器直接复用」就靠这一步：合并进来的份额与 `sseDone` 会让下面的
 * 刷新计划发现没有缺口，于是这一轮**一个交易所请求都不发**（净值同理）。
 * 联网只有 git 这一路（用户自己的同步仓库），三个行情主机一个都不碰。
 */
export async function pullEtfCache(repo: string, device: string): Promise<EtfSyncPullOutcome> {
  if (!repo || !device)
    return { enabled: false, own: false, changed: false }

  const remote = await invoke<{ own?: unknown, files?: unknown }>('etf_sync_pull', { repo, device })
  const cache = await loadCache()
  let changed = false
  for (const file of Array.isArray(remote?.files) ? remote.files : []) {
    if (mergeEtfCacheInto(cache, sanitizeEtfCache(file)))
      changed = true
  }
  if (changed)
    await saveCache(cache)

  return { enabled: true, own: remote?.own === true, changed }
}

/** 把本机缓存写进 `etf/<设备id>.json` 并推送；内容没变时 git 那边不产生提交 */
export async function publishEtfCache(repo: string, device: string): Promise<null> {
  if (!repo || !device)
    return null
  await invoke('etf_sync_publish', { repo, device, cache: await loadCache() })
  return null
}
