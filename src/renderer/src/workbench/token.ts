/**
 * Token 用量的读取、快照合并与多机同步。
 *
 * 分工：Rust 只把 ZCode 的 sqlite 原始聚合行取回来（`token_zcode_rows`）、
 * 把本机分片推给 git（`token_sync_publish`）、把别人的分片读回来（`token_sync_shards`）；
 * 合并 / 取最大值 / 求和 / 修剪 / 落盘 / 同步节流都在这里 —— 与 `src/shared/token-usage.ts`
 * 共用同一套函数，所以那段逻辑的既有单测全部继续有效。
 *
 * 两台机器怎么合到一起（细节见 shared/token-usage.ts 的文件头）：
 *   本机实读 → 与本机分片 mergeDays（取 max，抗上游清理）→ 落盘本机分片
 *          → 推送到同步仓库 → 读回所有分片 → combineShards（跨设备求和）→ 交给界面
 *
 * 同步是**节流**的：界面每 60 秒拉一次数据，但 git 只在间隔到点或用户手点时才动。
 * 没变化的分片不会产生提交 —— 时间戳只在计数真的变了之后才刷新，否则开着应用就会
 * 每小时往仓库里堆一个「什么都没改」的提交。
 *
 * 同步也**不挡出数**：一轮同步里只有「推 + 拉」要联网，而「读回别人的分片」只碰本地克隆，
 * 所以取数时先本地读一遍分片（首屏就带上别的机器），网络那一段丢到后台跑完再广播一次。
 * 手点的同步按钮是例外 —— 它要等结果回来才能给出成功 / 失败的提示。
 *
 * 首屏还有一条更早的路：`getTokenUsageSnapshot` 只读本地那份快照（几毫秒），
 * 让面板先把上次的数据摆出来，再被实读结果覆盖。它不实读、不落盘，只是一个先手。
 */
import {
  CODEBUDDY_SOURCE_ID,
  DSH_SOURCE_ID,
  TOKEN_DATA_VERSION,
  TOKEN_KEEP_DAYS,
  WORKBUDDY_SOURCE_ID,
  ZCODE_SOURCE_ID,
  combineShards,
  isDateKey,
  mergeDays,
  pruneTokenDays,
  sameDays,
  sanitizeShard,
  sanitizeSyncRepo,
  sumDays,
  type TokenCounters,
  type TokenDataFile,
  type TokenDays,
  type TokenShard,
  type TokenSyncStatus,
  type TokenSourceSnapshot,
  type TokenUsageResult
} from '@shared/token-usage'
import {
  captureThemeFile,
  sanitizeThemeFile,
  type SyncDeviceInfo,
  type ThemeFile
} from '@shared/sync-config'
import { collectCodeBuddyLogText, createCodeBuddyParseState } from '@shared/codebuddy-log'
import { collectDshSessionText } from '@shared/dsh-log'
import { collectWorkBuddySessionText } from '@shared/workbuddy-log'
import { invoke } from './bridge'
import { emit } from './events'
import * as state from './state'

/** Rust 侧 `token_zcode_rows` 回来的行：SUM 在无数据时是 NULL，所以全部可空 */
interface UsageRow {
  day: string | null
  model: string | null
  input: number | null
  output: number | null
  reasoning: number | null
  cacheRead: number | null
  cacheWrite: number | null
  requests: number | null
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * ZCode 的 input_tokens 是「含缓存读取」的总输入，这里拆开落字段：
 * inputTokens 只存未命中的输入，总量(sum)与命中率(cacheRead / (cacheRead + input))才不会双算。
 */
function toCounters(row: UsageRow): TokenCounters {
  const cacheRead = finite(row.cacheRead)
  return {
    inputTokens: Math.max(0, finite(row.input) - cacheRead),
    outputTokens: finite(row.output),
    reasoningTokens: finite(row.reasoning),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: finite(row.cacheWrite),
    requests: finite(row.requests)
  }
}

type LiveRead = { ok: true; days: TokenDays } | { ok: false; error: string; missing?: boolean }

/** 实读 ZCode：按天 × 模型聚合后交给共享逻辑去合并 */
async function readZcodeLive(): Promise<LiveRead> {
  try {
    const rows = await invoke<UsageRow[]>('token_zcode_rows')
    const days: TokenDays = {}

    for (const row of rows) {
      if (!isDateKey(row.day) || !row.model) continue
      const modelDays = (days[row.day] ??= {})
      modelDays[row.model] = toCounters(row)
    }
    return { ok: true, days }
  } catch (error) {
    return { ok: false, error: reasonOf(error, '读取 ZCode 用量失败') }
  }
}

function reasonOf(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

// ---------- CodeBuddy(IDE 扩展日志) ----------

/** `token_codebuddy_files` 回来的一项；Rust 只列文件，内容自己读 */
interface CodeBuddyLogFile {
  path: string
  mtimeMs: number
  size: number
}

/**
 * 上一次的解析结果与它的「输入签名」。
 *
 * 扩展日志只追加、不重写，所以「文件清单 + 修改时间 + 大小」一样就一定是同一份输入，
 * 可以整份复用上次的结果 —— 这台机器上扩展日志将近十兆，闲着也每分钟重读重解析一遍
 * 没有任何意义（而改了任何一个文件就必须整批重来：解析状态是跨文件的，见 codebuddy-log.ts）。
 */
let codebuddyCache: { signature: string; days: TokenDays } | null = null

/**
 * 实读 CodeBuddy。分三步就是为了省掉上面那次无谓的重读：
 * 先拿清单（很便宜）→ 比签名 → 只有变了才真去读文件、重新解析。
 */
async function readCodeBuddyLive(): Promise<LiveRead> {
  let listing: { found?: unknown; files?: unknown }
  try {
    listing = await invoke<{ found?: unknown; files?: unknown }>('token_codebuddy_files')
  } catch (error) {
    return { ok: false, error: reasonOf(error, '读取 CodeBuddy 日志失败') }
  }

  // 没装就安静跳过：这台机器上没有这个工具是常态，
  // 不该和「装了却读不出来」一样点亮面板上的「部分来源不可用」
  if (listing?.found !== true) return { ok: false, missing: true, error: '' }

  const files = (Array.isArray(listing.files) ? listing.files : [])
    .map((item) => item as Partial<CodeBuddyLogFile>)
    .filter(
      (item): item is CodeBuddyLogFile =>
        typeof item.path === 'string' &&
        typeof item.mtimeMs === 'number' &&
        typeof item.size === 'number'
    )
    // 快照只留最近一年，更早的日志里不可能有窗口内的记录
    .filter((item) => item.mtimeMs >= Date.now() - (TOKEN_KEEP_DAYS - 1) * 86_400_000)

  const signature = files.map((item) => `${item.path}:${item.mtimeMs}:${item.size}`).join('|')
  if (codebuddyCache?.signature === signature) return { ok: true, days: codebuddyCache.days }

  const state = createCodeBuddyParseState()
  const days: TokenDays = {}
  for (const file of files) {
    try {
      collectCodeBuddyLogText(await invoke<string>('fs_read_text', { path: file.path }), state, days)
    } catch {
      // 单个文件读不了（被占用 / 编码异常）只少几条记录，不影响其余
    }
  }

  codebuddyCache = { signature, days }
  return { ok: true, days }
}

// ---------- DeepSeek Harness(~/.dsh/sessions) ----------

/** `token_dsh_sessions` 回来的一项 */
interface DshSessionFile {
  path: string
  mtimeMs: number
  size: number
}

/**
 * 每个会话文件的解码结果，key 是路径。
 *
 * 与 CodeBuddy 的整批缓存不同，这里可以**按文件**缓存：会话文件之间互不依赖
 * （每个文件都自带 request/header 声明模型、没有跨文件的链路），
 * 所以只重解变化的那些就够 —— 解压是实打实的 CPU 活，本机 9MB 会话没必要时时全解一遍。
 */
const dshCache = new Map<string, { mtimeMs: number; size: number; days: TokenDays }>()

/**
 * 实读 DSH。清单由 Rust 给（很便宜），内容要逐帧解压 —— 浏览器没有 zstd 解码 API，
 * 所以这一步回 Rust 走 `token_zstd_decode`，解出来的事件交给 shared 的纯函数解析。
 */
async function readDshLive(): Promise<LiveRead> {
  let listing: { found?: unknown; sessions?: unknown }
  try {
    listing = await invoke<{ found?: unknown; sessions?: unknown }>('token_dsh_sessions')
  } catch (error) {
    return { ok: false, error: reasonOf(error, '读取 DSH 会话目录失败') }
  }

  // 没装就安静跳过（与 CodeBuddy 同一约定）
  if (listing?.found !== true) return { ok: false, missing: true, error: '' }

  const cutoff = Date.now() - (TOKEN_KEEP_DAYS - 1) * 86_400_000
  const sessions = (Array.isArray(listing.sessions) ? listing.sessions : [])
    .map((item) => item as Partial<DshSessionFile>)
    .filter(
      (item): item is DshSessionFile =>
        typeof item.path === 'string' &&
        typeof item.mtimeMs === 'number' &&
        typeof item.size === 'number'
    )
    // 快照只留最近一年，更早的会话里不可能有窗口内的记录
    .filter((item) => item.mtimeMs >= cutoff)

  let days: TokenDays = {}
  const alive = new Set<string>()

  for (const session of sessions) {
    alive.add(session.path)
    let cached = dshCache.get(session.path)

    if (!cached || cached.mtimeMs !== session.mtimeMs || cached.size !== session.size) {
      try {
        const text = await invoke<string>('token_zstd_decode', { path: session.path })
        const parsed: TokenDays = {}
        collectDshSessionText(text, parsed)
        cached = { mtimeMs: session.mtimeMs, size: session.size, days: parsed }
        dshCache.set(session.path, cached)
      } catch {
        // 单个会话坏了（帧损坏 / 文件被删）只少这一个，不影响其余
        dshCache.delete(session.path)
        continue
      }
    }

    days = sumDays(days, cached.days)
  }

  // 会话被清理掉的就从缓存里摘掉，不然内存里会一直留着它们
  for (const path of [...dshCache.keys()]) {
    if (!alive.has(path)) dshCache.delete(path)
  }

  return { ok: true, days }
}

// ---------- WorkBuddy(~/.workbuddy/projects) ----------

/** `token_workbuddy_sessions` 回来的一项 */
interface WorkBuddySessionFile {
  path: string
  mtimeMs: number
  size: number
}

/**
 * 每个会话文件的解析结果，key 是路径。
 *
 * 与 DSH 同样**按文件**缓存：会话正文里每一行都自带模型与用量（见 shared/workbuddy-log.ts），
 * 文件之间互不依赖，所以只重解变化的那些就够 —— 会话正文会长到几兆，
 * 每分钟整批重解析一遍没有意义。
 */
const workbuddyCache = new Map<string, { mtimeMs: number; size: number; days: TokenDays }>()

/**
 * 实读 WorkBuddy。清单由 Rust 给（很便宜），正文按路径读回来自己解析 ——
 * 正文没有压缩，不用像 DSH 那样再回 Rust 解码一趟。
 */
async function readWorkBuddyLive(): Promise<LiveRead> {
  let listing: { found?: unknown; sessions?: unknown }
  try {
    listing = await invoke<{ found?: unknown; sessions?: unknown }>('token_workbuddy_sessions')
  } catch (error) {
    return { ok: false, error: reasonOf(error, '读取 WorkBuddy 会话目录失败') }
  }

  // 没装就安静跳过（与 CodeBuddy / DSH 同一约定）
  if (listing?.found !== true) return { ok: false, missing: true, error: '' }

  const cutoff = Date.now() - (TOKEN_KEEP_DAYS - 1) * 86_400_000
  const sessions = (Array.isArray(listing.sessions) ? listing.sessions : [])
    .map((item) => item as Partial<WorkBuddySessionFile>)
    .filter(
      (item): item is WorkBuddySessionFile =>
        typeof item.path === 'string' &&
        typeof item.mtimeMs === 'number' &&
        typeof item.size === 'number'
    )
    // 快照只留最近一年，更早的会话里不可能有窗口内的记录
    .filter((item) => item.mtimeMs >= cutoff)

  let days: TokenDays = {}
  const alive = new Set<string>()

  for (const session of sessions) {
    alive.add(session.path)
    let cached = workbuddyCache.get(session.path)

    if (!cached || cached.mtimeMs !== session.mtimeMs || cached.size !== session.size) {
      try {
        const parsed: TokenDays = {}
        collectWorkBuddySessionText(
          await invoke<string>('fs_read_text', { path: session.path }),
          parsed
        )
        cached = { mtimeMs: session.mtimeMs, size: session.size, days: parsed }
        workbuddyCache.set(session.path, cached)
      } catch {
        // 单个会话读不了（被占用 / 编码异常）只少这一个，不影响其余
        workbuddyCache.delete(session.path)
        continue
      }
    }

    days = sumDays(days, cached.days)
  }

  // 会话被清理掉的就从缓存里摘掉，不然内存里会一直留着它们
  for (const path of [...workbuddyCache.keys()]) {
    if (!alive.has(path)) workbuddyCache.delete(path)
  }

  return { ok: true, days }
}

// ---------- 本机设备标识 ----------

/** 本机设备标识只问一次：它落盘后就不再变，而面板每 60 秒就会走一次这条路 */
let device: { id: string; name: string } | null = null

/**
 * 本机设备标识（`%APPDATA%/Workbench/device.json`，没有就现生成一份）。
 *
 * 除了 Token 分片，笔记图片的落点也要用它（见 `workbench/note.ts` 的 `imageScope`），
 * 所以这里是导出的：它描述的是「这台机器」，不是「Token 面板」。
 */
export async function localDevice(): Promise<{ id: string; name: string }> {
  if (device) return device

  try {
    const info = await invoke<{ id?: unknown; name?: unknown }>('token_device')
    device = {
      id: typeof info?.id === 'string' ? info.id.trim() : '',
      name: typeof info?.name === 'string' ? info.name.trim() : ''
    }
  } catch {
    // 拿不到标识只影响同步与图片上传（分片名 / 目录名要用它），本机数据照常展示
    device = { id: '', name: '' }
  }
  return device
}

// ---------- 同步 ----------

/**
 * 自动同步的间隔：面板每分钟刷新一次，一小时里只有到点的那一次真的走网络。
 *
 * 一小时是「推送」的节奏：分片内容只要变了就会推一次（没变不产生提交），
 * 干活的时候十分钟一推会让仓库里堆出一串没有信息量的提交。
 * 想让数据立刻出去就用手动同步按钮，它不受这个间隔限制。
 */
const SYNC_INTERVAL_MS = 60 * 60_000

let lastSyncAt = 0
/** 上次尝试同步用的仓库；设置里换了地址就立刻同步一次，不必等节流窗口过去 */
let lastSyncRepo = ''
let lastSyncError = ''
/** 别人的分片（已收敛）；两次同步之间照旧参与合计，面板不会因为没到同步点就少一块数据 */
let remoteShards: TokenShard[] = []
/** 别人的配置（`config/` 目录，按设备 id 配对）；与分片同一批读回来、同一个仓库 */
let remoteConfigs: ThemeFile[] = []
/** 上面那两份是从哪个仓库读回来的：换仓库要重读，同一个仓库不必每轮再读一遍 */
let shardsRepo = ''

/**
 * 同步串行化：面板轮询与手动同步可能正好撞上，
 * 两个 git 进程同时动同一个克隆目录会互相打架（index.lock 冲突）。
 */
let inflight: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): Promise<void> {
  inflight = inflight.then(task, task)
  return inflight
}

/** Rust 侧 `token_sync_shards` 回来的形状：仓库里两个目录各一份（见 sync.rs 的 read_shards） */
interface SyncFiles {
  usage?: unknown
  config?: unknown
}

/** 两个目录里的原始条目 → 收敛后的分片与配置（认不出来的整条丢掉，坏文件不拖垮面板） */
function parseFiles(files: SyncFiles): { shards: TokenShard[]; configs: ThemeFile[] } {
  const shards = (Array.isArray(files.usage) ? files.usage : []).map((item) => sanitizeShard(item))
  const configs = (Array.isArray(files.config) ? files.config : [])
    .map((item) => sanitizeThemeFile(item))
    .filter((file): file is ThemeFile => file !== null)
  return { shards, configs }
}

/**
 * 用量分片与配置文件按设备 id 配对，得到设置界面要的那份设备列表。
 *
 * 两个目录都要看：关掉外观同步的机器只有用量分片（或者反过来，只推过配置）。
 * 时间取两份里较新的那个 —— 那才是「那台机器最后一次动过」。
 */
function pairDevices(shards: TokenShard[], configs: ThemeFile[]): SyncDeviceInfo[] {
  const byDevice = new Map<string, SyncDeviceInfo>()

  for (const shard of shards) {
    byDevice.set(shard.device, {
      id: shard.device,
      name: shard.name || shard.device,
      updatedAt: shard.updatedAt,
      theme: null
    })
  }

  for (const file of configs) {
    const existing = byDevice.get(file.device)
    const updatedAt = Math.max(existing?.updatedAt ?? 0, file.theme?.updatedAt ?? 0)
    byDevice.set(file.device, {
      id: file.device,
      name: file.name || existing?.name || file.device,
      updatedAt,
      theme: file.theme
    })
  }

  return [...byDevice.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 读回别人的分片与配置。**只碰本地克隆，不联网**（见 sync.rs 的 read_shards）：
 * 内容是上一次同步取回来的样子，所以它足够便宜，可以直接放在取数的关键路径上 ——
 * 首屏因此就能带上别的机器，而不必等这一轮的 git 走完。
 */
async function readRemoteShards(repo: string, ownDevice: string): Promise<void> {
  const files = await invoke<SyncFiles>('token_sync_shards', { repo })
  const { shards, configs } = parseFiles(files ?? {})

  // 本机那份要用内存里的最新分片 / 最新主题，仓库里的副本是上次推送时的样子；
  // 两份都合进去就会把本机重复计一遍。没有 device 的条目认不出是谁的，一并丢掉。
  remoteShards = shards.filter((item) => item.device && item.device !== ownDevice)
  remoteConfigs = configs.filter((file) => file.device !== ownDevice)
  shardsRepo = repo
}

/**
 * 同步那一路的状态复位 + 本地分片读取（不联网）。
 *
 * 实读取数和首屏快照都要走这一步，所以它必须是一份：少了「换仓库先把旧分片丢掉」这段，
 * 界面就会显示一份「看着正常、其实来自另一个仓库」的数字（踩过一次，见 sync.rs 的 read_shards）。
 * 本身不抛错：读不回来只当没有别的机器，失败原因交给同步那轮去报，免得两处各报一遍。
 */
async function syncLocalShards(repo: string, ownDevice: string): Promise<void> {
  if (!repo) {
    // 关掉同步：连别人机器上已经读到的分片也一起撤掉，界面回到「只有本机」
    remoteShards = []
    remoteConfigs = []
    shardsRepo = ''
    lastSyncRepo = ''
    lastSyncError = ''
    return
  }

  // 同一个仓库只需要读一次：两次同步之间克隆目录不会被别的进程改写
  if (shardsRepo === repo) return

  try {
    await readRemoteShards(repo, ownDevice)
  } catch {
    // 读不回来（克隆还指着上个仓库 / 目录被占）就把旧的丢掉，宁可少显示也不显示错的
    remoteShards = []
  }
}

/** 本机分片 + 别人的分片，合成界面要的合计；本机那份用内存里的，仓库副本不参与 */
function buildData(repo: string, ownShard: TokenShard, now: number): TokenDataFile {
  return combineShards(repo ? [ownShard, ...remoteShards] : [ownShard], now)
}

/**
 * 一轮完整同步：推本机分片（联网）→ 读回所有分片（本地）。
 *
 * 两步各自兜住失败：推送失败（没网 / 凭据过期）不该连带把「读别人的分片」也停掉 ——
 * 克隆目录还在，读是纯本地操作，能读到就还能看到别的机器的最新数据。
 */
async function runSync(repo: string, shard: TokenShard): Promise<void> {
  const errors: string[] = []

  try {
    await invoke('token_sync_publish', {
      repo,
      device: shard.device,
      shard,
      // 主题文件整份作为这台机器的配置推上去（见 shared/sync-config.ts）。
      // 关掉那个开关时给 null：Rust 那边会把仓库里自己那份配置删掉 ——
      // 「不同步外观」就该是仓库里没有它，而不是留着一份越放越旧的副本
      config: state.settings().syncAppearance
        ? captureThemeFile(shard.device, shard.name, state.themeConfig())
        : null,
      // 登录过就默认用账号的 token 授权（省掉先手工给 git 配凭据）；
      // 设置里关掉这个开关就退回系统凭据 —— token 失效时那条路还得能用
      useAccount: state.settings().useAccountForSync
    })
  } catch (error) {
    errors.push(reasonOf(error, '同步失败'))
  }

  try {
    await readRemoteShards(repo, shard.device)
  } catch (error) {
    errors.push(reasonOf(error, '读取同步分片失败'))
  }

  lastSyncError = errors.join('；')
  lastSyncAt = Date.now()
  lastSyncRepo = repo
}

function syncStatus(enabled: boolean, deviceName: string, repo: string): TokenSyncStatus {
  if (!enabled) {
    return { enabled: false, deviceName, repo: '', lastSyncAt: 0, error: '', devices: [] }
  }
  return {
    enabled: true,
    deviceName,
    repo,
    lastSyncAt,
    error: lastSyncError,
    // 时间取用量与配置里较新的那个（见 pairDevices）：配置改晚了也该反映出来
    devices: pairDevices(remoteShards, remoteConfigs).map((device) => ({
      id: device.id,
      name: device.name,
      updatedAt: device.updatedAt
    }))
  }
}

// ---------- 对外入口 ----------

/**
 * 实读 + 合并 + 按需同步，返回界面要的合计。
 *
 * `repo` 是设置里的同步仓库地址（空串 = 不同步）；`force` 给手动同步按钮用，绕过节流。
 *
 * 实读失败不抛错：回退展示快照，把原因带给界面；
 * 某个来源「没装」不算失败（`missing`），只是那个来源没有数据。
 */
export async function getTokenUsage(options: {
  repo: string
  force?: boolean
}): Promise<TokenUsageResult> {
  const now = Date.now()
  const repo = sanitizeSyncRepo(options.repo)
  // 先取设备标识:v3 老文件里没有设备信息,收敛时要用它补齐(见 sanitizeShard 的 fallback)
  const { id, name } = await localDevice()
  const local = sanitizeShard(await invoke<unknown>('token_load'), { device: id, name })

  // 各来源互不依赖,并行读:都是本地读取,串起来白等
  const sourcesRead = Promise.all([
    readZcodeLive(),
    readCodeBuddyLive(),
    readDshLive(),
    readWorkBuddyLive()
  ])

  // 别人的分片同样是本地读（克隆目录），也并行：首屏就带上别的机器，
  // 而不是等这一轮的 git 走完 —— 换仓库后才读得到新仓库的分片，所以按 shardsRepo 判断一次就够
  const shardsRead = syncLocalShards(repo, id)

  const [zcodeLive, codebuddyLive, dshLive, workbuddyLive] = await sourcesRead
  await shardsRead

  const sources = { ...local.sources }
  const sourceErrors: Record<string, string> = {}
  // 计数有没有真的变化:没变就不刷新快照时间戳,否则同步那边每轮都会推一个内容相同的提交
  let changed = false

  // 逐个来源合并进本机快照:分片内取 max(抗上游清理、重复实读幂等),失败就保住旧数据
  for (const { id: sourceId, read } of [
    { id: ZCODE_SOURCE_ID, read: zcodeLive },
    { id: CODEBUDDY_SOURCE_ID, read: codebuddyLive },
    { id: DSH_SOURCE_ID, read: dshLive },
    { id: WORKBUDDY_SOURCE_ID, read: workbuddyLive }
  ]) {
    if (!read.ok) {
      // missing 是「这台机器上没装这个工具」,不算读取失败,只是没有这个来源
      if (!read.missing) sourceErrors[sourceId] = read.error
      continue
    }

    const before = local.sources[sourceId]?.days ?? {}
    const merged = pruneTokenDays(mergeDays(before, read.days), now)
    if (!sameDays(merged, before)) changed = true
    sources[sourceId] = { days: merged }
  }

  // 外观配置**不在这份分片里**：它是 theme.json 的整份内容，由 runSync 单独作为 config 推上去
  // （见 shared/sync-config.ts）。两个目录各管一件事，用量这边的版本演进不必再带上外观
  const shard: TokenShard = {
    version: TOKEN_DATA_VERSION,
    device: id,
    name,
    // 计数没变就不刷新时间戳，否则每轮同步都会推一个内容相同的提交
    updatedAt: changed ? now : local.updatedAt,
    sources
  }
  await invoke('token_save', { value: shard })

  // 换仓库（或首次）之后的这一轮立刻走，不必等节流窗口过去；Rust 那边发现克隆指向的不是
  // 这个仓库会重新克隆，读分片时也会核对仓库归属 —— 详见 sync.rs 的 ensure_clone / read_shards
  if (repo && (options.force || repo !== lastSyncRepo || now - lastSyncAt >= SYNC_INTERVAL_MS)) {
    if (!id) {
      lastSyncAt = now
      lastSyncRepo = repo
      lastSyncError = '拿不到本机设备标识，无法同步'
    } else if (options.force) {
      // 手点的那一次必须等回来：按钮上的成功 / 失败提示要用这一轮的真实结果
      await enqueue(() => runSync(repo, shard))
    } else {
      // 自动同步放后台：数据上面已经全部算完了，没有理由让卡片再等两趟网络。
      // 跑完（成功失败都算）广播一次，订阅方据此重取 —— 新读回的分片立刻显示出来，
      // 同步失败的原因也能及时反映到标题行，都不必干等到下一个轮询周期
      void enqueue(() => runSync(repo, shard))
        .finally(() => emit('tokenSynced', null))
        .catch(() => undefined)
    }
  }

  // 本机那份用刚算出来的分片，仓库里的副本不参与
  const data = buildData(repo, shard, now)
  return { data, sourceErrors, sync: syncStatus(Boolean(repo), name, repo) }
}

/**
 * 只读本地的那一份：本机快照 + 克隆里别人的分片。
 *
 * 给面板首屏用 —— 冷读一轮要一秒上下（CodeBuddy 的日志、DSH 的会话都要重新读重新解析），
 * 那段时间卡片只能拿空态示人，明明有数据的用户会以为数据没了。先把这个摆出来，
 * 实读结果随后整份覆盖它（见 TokenPanel 的 boot）。
 *
 * **形状与 getTokenUsage 一致**，所以界面上不用区分两条路。它**不实读、不落盘、不碰网络**：
 * 快照是上次实读的结果，它的意义就是等着被实读修正（分片内取 max 抗上游清理），
 * 拿它当结果用会把上游清理掉的历史永久锁住 —— 所以每次仍然要老老实实跑 getTokenUsage。
 */
export async function getTokenUsageSnapshot(options: {
  repo: string
}): Promise<TokenUsageResult> {
  const now = Date.now()
  const repo = sanitizeSyncRepo(options.repo)
  const { id, name } = await localDevice()
  const local = sanitizeShard(await invoke<unknown>('token_load'), { device: id, name })
  await syncLocalShards(repo, id)

  // 首屏没有任何实读，来源错误表就是空的：铺开的状态行由实读那一轮负责
  return {
    data: buildData(repo, local, now),
    sourceErrors: {},
    sync: syncStatus(Boolean(repo), name, repo)
  }
}

/** 手动同步一次（面板上的同步按钮）：绕过自动同步的节流 */
export async function syncTokenUsage(repo: string): Promise<TokenUsageResult> {
  return getTokenUsage({ repo, force: true })
}

/**
 * 同步仓库里别的机器（含各自那份配置），按「最近动过的在前」排序。
 *
 * 只读本地那份克隆（Rust 侧 `token_sync_shards` 不联网、不推东西），所以设置界面打开时
 * 随时可以问；内容就是上一次同步取回来的样子。地址没填、或还没同步过时是空数组。
 *
 * 本机那份要按 device 排除掉：设置界面的用途是「取别人的配置」，把自己列进去
 * 只会让人以为多了一台机器（同一份分片已经在面板的「同步设备」里露过一次脸了）。
 */
export async function listSyncDevices(repo: string): Promise<SyncDeviceInfo[]> {
  const target = sanitizeSyncRepo(repo)
  if (!target) return []

  const { id } = await localDevice()
  const files = await invoke<SyncFiles>('token_sync_shards', { repo: target })
  const { shards, configs } = parseFiles(files ?? {})

  return pairDevices(
    shards.filter((item) => item.device && item.device !== id),
    configs.filter((file) => file.device !== id)
  )
}
