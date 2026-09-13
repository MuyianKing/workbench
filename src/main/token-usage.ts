import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import Database from 'better-sqlite3'
import {
  CODEBUDDY_SOURCE_ID,
  DSH_SOURCE_ID,
  TOKEN_DATA_FILE_NAME,
  TOKEN_DATA_VERSION,
  ZCODE_SOURCE_ID,
  addCounters,
  emptyCounters,
  emptyTokenData,
  isDateKey,
  mergeDays,
  pruneTokenDays,
  sanitizeTokenData,
  type TokenCounters,
  type TokenDays,
  type TokenDataFile,
  type TokenUsageResult
} from '../shared/token-usage'
import { collectCodeBuddyLogText, createCodeBuddyParseState } from '../shared/codebuddy-log'
import { dayKey } from '../shared/activity'
import { JsonStore } from './json-store'
import { currentDataDir } from './store'

/**
 * Token 用量:实读各接入工具(ZCode 的 sqlite、DSH 的会话、CodeBuddy 的扩展日志)的本地数据,
 * 合并进 token-data.json 快照。
 *
 * 数据流见 shared/token-usage.ts 的文件头。这里的关键约定:
 *  - ZCode 的库是 WAL 模式,以 readonly 打开可以与运行中的 ZCode 并存,不拷文件;
 *  - ZCode 自己会清理旧会话,所以每次实读都要 max 合并进快照并落盘,历史才守得住;
 *  - 读取失败(没装该工具 / 数据结构变化)不抛错:回退展示快照,把原因带给界面。
 */

/** 数据目录可整体迁移,所以不能在模块加载时算死路径,读写时现取 */
const store = new JsonStore<TokenDataFile>(
  () => join(currentDataDir(), TOKEN_DATA_FILE_NAME),
  emptyTokenData,
  '保存 token 用量数据'
)

export async function loadTokenData(): Promise<void> {
  await store.load(sanitizeTokenData)
}

export function flushTokenSync(): void {
  store.flushSync()
}

/** ZCode 数据目录;少数人会把整个 .zcode 放在别处,给个环境变量出口 */
function zcodeDbFile(): string {
  const root = process.env.ZCODE_HOME?.trim() || join(homedir(), '.zcode')
  return join(root, 'cli', 'db', 'db.sqlite')
}

/**
 * 聚合 SQL:按 天 × 模型 汇总。
 *  - ROW_NUMBER 去重重试:同一个 logical_request_id 只留最后一次尝试,重试不双算;
 *  - error_type IS NULL 排除失败请求:没产生计数的失败不算用量;
 *  - date(..., 'localtime') 按本地日期归天,与活跃度图同一约定。
 */
const USAGE_SQL = `
  SELECT
    date(mu.started_at / 1000, 'unixepoch', 'localtime') AS day,
    mu.model_id AS model,
    SUM(mu.input_tokens) AS input,
    SUM(mu.output_tokens) AS output,
    SUM(mu.reasoning_tokens) AS reasoning,
    SUM(mu.cache_read_input_tokens) AS cacheRead,
    SUM(mu.cache_creation_input_tokens) AS cacheWrite,
    COUNT(*) AS requests
  FROM model_usage mu
  WHERE mu.id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY logical_request_id ORDER BY attempt_index DESC) AS rn
      FROM model_usage
    ) latest WHERE latest.rn = 1
  )
    AND mu.error_type IS NULL
  GROUP BY day, model
`

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

function toCounters(row: UsageRow): TokenCounters {
  const finite = (value: number | null): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  /**
   * ZCode 的 input_tokens 是「含缓存读取」的总输入(raw_usage_json 里 totalTokens =
   * inputTokens + outputTokens,cacheReadTokens 是前者的子集),这里拆开落字段:
   * inputTokens 只存未命中的输入,总量(sum)与命中率(cacheRead / (cacheRead + input))才不会双算。
   */
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

type LiveRead = { ok: true; days: TokenDays } | { ok: false; error: string }

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

// ---------- DeepSeek Harness(~/.dsh/sessions) ----------

/** DeepSeek Harness 的 home;环境变量出口与其自身约定(DSH_HOME)一致 */
function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * DSH 会话文件是多帧 zstd:每条事件一帧追加写,解压器只认第一帧,
 * 这里按帧头魔数切开后逐帧解。魔数偶现在压缩数据里理论可能,概率可忽略(~1e-4/文件),
 * 单帧解失败就跳过,只少一条事件,不影响整体。
 */
function decompressDshFrames(buf: Buffer): string {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts: number[] = []
  let index = buf.indexOf(magic)
  while (index !== -1) {
    starts.push(index)
    index = buf.indexOf(magic, index + 4)
  }
  starts.push(buf.length)

  let text = ''
  for (let k = 0; k < starts.length - 1; k += 1) {
    try {
      text += `${zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])).toString('utf-8')}\n`
    } catch {
      // 坏帧:跳过
    }
  }
  return text
}

/** assistant/message 事件里的用量;输入已是不含缓存的口径,与 ZCode 拆分后的字段一一对应 */
interface DshUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

/** 解析一个会话文件,把用量累计进 days(按 事件时间 的本地日期、会话声明的模型分桶) */
function collectDshSession(buf: Buffer, days: TokenDays): void {
  let model = 'deepseek'
  for (const line of decompressDshFrames(buf).split('\n')) {
    if (!line) continue
    let event: {
      type?: string
      time?: number
      data?: {
        header?: { config?: { model?: unknown } }
        usage?: DshUsage
      }
    }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (event.type === 'request/header') {
      const declared = event.data?.header?.config?.model
      if (typeof declared === 'string' && declared.trim()) model = declared.trim()
      continue
    }
    if (event.type !== 'assistant/message') continue

    const usage = event.data?.usage
    if (!usage) continue
    const date = dayKey(Number(event.time))
    if (!isDateKey(date)) continue

    const modelDays = (days[date] ??= {})
    modelDays[model] = addCounters(modelDays[model] ?? emptyCounters(), {
      inputTokens: finite(usage.inputTokens),
      outputTokens: finite(usage.outputTokens),
      reasoningTokens: finite(usage.reasoningTokens),
      cacheReadTokens: finite(usage.cacheReadTokens),
      cacheWriteTokens: 0,
      requests: 1
    })
  }
}

function readDshLive(): LiveRead {
  const sessionsDir = join(dshHome(), 'sessions')

  let projects: string[]
  try {
    projects = readdirSync(sessionsDir)
  } catch {
    return { ok: false, error: `未找到 DeepSeek Harness 的会话目录(${sessionsDir})` }
  }

  const days: TokenDays = {}
  for (const project of projects) {
    const projectDir = join(sessionsDir, project)
    let sessions: string[]
    try {
      sessions = readdirSync(projectDir)
    } catch {
      continue
    }
    for (const session of sessions) {
      const sessionDir = join(projectDir, session)
      // v3 优先:同一会话可能同时留着旧版 session.jsonl.zstd,两个都读会双算
      let file: string | null = null
      try {
        const names = readdirSync(sessionDir)
        if (names.includes('session.v3.jsonl.zstd')) file = join(sessionDir, 'session.v3.jsonl.zstd')
        else if (names.includes('session.jsonl.zstd')) file = join(sessionDir, 'session.jsonl.zstd')
      } catch {
        continue
      }
      if (!file) continue

      try {
        collectDshSession(readFileSync(file), days)
      } catch {
        // 单个会话损坏不影响其余
      }
    }
  }

  return { ok: true, days }
}

// ---------- CodeBuddy(IDE 扩展日志) ----------

/**
 * CodeBuddy 没有本地用量库,唯一的数据源是 IDE 扩展日志里的逐步 usage 记录,
 * 解析逻辑(纯函数)在 shared/codebuddy-log.ts,这里只负责找目录与遍历文件。
 * 国内版装在 %APPDATA%/CodeBuddy CN,国际版没有 CN 后缀,两个都试;环境变量出口。
 */
function codebuddyLogRoots(): string[] {
  const override = process.env.CODEBUDDY_DATA_DIR?.trim()
  if (override) return [join(override, 'logs')]
  const roaming = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
  return [join(roaming, 'CodeBuddy CN', 'logs'), join(roaming, 'CodeBuddy', 'logs')]
}

/** 快照只保留 TOKEN_KEEP_DAYS 天,更早的日志目录里没有窗口内数据,不必再读 */
const CODEBUDDY_CUTOFF_MS = Date.now() - (53 * 7 - 1) * 24 * 60 * 60 * 1000

/** 递归收集扩展目录(tencent-cloud.coding-copilot)下的 .log 文件,目录名与语言无关 */
function collectCodeBuddyLogFiles(dir: string, inExtensionDir: boolean, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectCodeBuddyLogFiles(path, inExtensionDir || entry.name === 'Tencent-Cloud.coding-copilot', out)
    } else if (inExtensionDir && entry.isFile() && entry.name.endsWith('.log')) {
      out.push(path)
    }
  }
}

function readCodeBuddyLive(): LiveRead {
  const roots = codebuddyLogRoots()
  const logsRoot = roots.find((root) => {
    try {
      return statSync(root).isDirectory()
    } catch {
      return false
    }
  })
  if (!logsRoot) return { ok: false, error: `未找到 CodeBuddy 的日志目录(${roots[0]})` }

  let folders: string[]
  try {
    folders = readdirSync(logsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(logsRoot, entry.name))
      .filter((path) => {
        try {
          return statSync(path).mtimeMs >= CODEBUDDY_CUTOFF_MS
        } catch {
          return false
        }
      })
  } catch {
    return { ok: false, error: 'CodeBuddy 日志目录读取失败,可能它的版本已更新了目录结构' }
  }

  const state = createCodeBuddyParseState()
  const days: TokenDays = {}
  for (const folder of folders) {
    const files: string[] = []
    collectCodeBuddyLogFiles(folder, false, files)
    for (const file of files) {
      try {
        collectCodeBuddyLogText(readFileSync(file, 'utf-8'), state, days)
      } catch {
        // 单个文件损坏(如编码异常)不影响其余
      }
    }
  }
  return { ok: true, days }
}

function readZCodeLive(): LiveRead {
  const file = zcodeDbFile()

  let db: Database.Database
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
  } catch {
    return { ok: false, error: `未找到 ZCode 数据库(${file})` }
  }

  try {
    const rows = db.prepare(USAGE_SQL).all() as UsageRow[]
    const days: TokenDays = {}
    for (const row of rows) {
      if (!isDateKey(row.day) || !row.model) continue
      const modelDays = (days[row.day] ??= {})
      modelDays[row.model] = toCounters(row)
    }
    return { ok: true, days }
  } catch {
    return { ok: false, error: 'ZCode 数据库读取失败,可能它的版本已更新了表结构' }
  } finally {
    db.close()
  }
}

/** 实读 + max 合并 + 修剪 + 落盘(防抖);供 IPC 调用,不抛错。
 * 每个来源独立实读:一个失败只记原因,其余来源与快照照常展示 */
export function getTokenUsage(): TokenUsageResult {
  const now = Date.now()
  const snapshot = store.get()
  const sources: Record<string, NonNullable<TokenDataFile['sources'][string]>> = {
    ...snapshot.sources
  }
  const sourceErrors: Record<string, string> = {}
  let anyOk = false

  const readers: Array<{ id: string; read: () => LiveRead }> = [
    { id: ZCODE_SOURCE_ID, read: readZCodeLive },
    { id: DSH_SOURCE_ID, read: readDshLive },
    { id: CODEBUDDY_SOURCE_ID, read: readCodeBuddyLive }
  ]
  for (const { id, read } of readers) {
    const live = read()
    if (live.ok) {
      anyOk = true
      sources[id] = { days: pruneTokenDays(mergeDays(sources[id]?.days ?? {}, live.days), now) }
    } else {
      sourceErrors[id] = live.error
    }
  }

  if (!anyOk) return { data: snapshot, sourceErrors }

  const next: TokenDataFile = { version: TOKEN_DATA_VERSION, updatedAt: now, sources }
  store.set(next)
  store.schedule()
  return { data: next, sourceErrors }
}
