/**
 * Token 用量的读取与快照合并。
 *
 * 分工：Rust 只把 ZCode 的 sqlite 原始聚合行取回来（`token_zcode_rows`），
 * 合并 / 取最大值 / 修剪 / 落盘都在这里 —— 与 `src/shared/token-usage.ts` 共用同一套函数，
 * 所以这段逻辑的既有单测全部继续有效。
 */
import {
  TOKEN_DATA_VERSION,
  ZCODE_SOURCE_ID,
  isDateKey,
  mergeDays,
  pruneTokenDays,
  sanitizeTokenData,
  type TokenCounters,
  type TokenDataFile,
  type TokenDays,
  type TokenUsageResult
} from '@shared/token-usage'
import { invoke } from './bridge'

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

type LiveRead = { ok: true; days: TokenDays } | { ok: false; error: string }

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
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 实读 + 取最大值合并 + 修剪 + 落盘（防抖）。
 *
 * ZCode 自己会清理旧会话，所以每次实读都要把结果 max 合并进快照并落盘，历史才守得住。
 * 读取失败不抛错：回退展示快照，把原因带给界面。
 *
 * 待移植：DSH（~/.dsh/sessions，多帧 zstd）与 CodeBuddy 扩展日志两个来源。
 */
export async function getTokenUsage(): Promise<TokenUsageResult> {
  const now = Date.now()
  const snapshot = sanitizeTokenData(await invoke<unknown>('token_load'))
  const sources = { ...snapshot.sources }
  const sourceErrors: Record<string, string> = {}

  const live = await readZcodeLive()
  if (!live.ok) {
    sourceErrors[ZCODE_SOURCE_ID] = live.error
    return { data: snapshot, sourceErrors }
  }

  sources[ZCODE_SOURCE_ID] = {
    days: pruneTokenDays(mergeDays(sources[ZCODE_SOURCE_ID]?.days ?? {}, live.days), now)
  }

  const next: TokenDataFile = { version: TOKEN_DATA_VERSION, updatedAt: now, sources }
  await invoke('token_save', { value: next })
  return { data: next, sourceErrors }
}
