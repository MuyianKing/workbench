/**
 * Qoder 会话文件的额度解析（纯逻辑，供适配层的 reader 调用）。
 *
 * 会话文件在 `~/.qoder-cn/projects/<项目>/<会话 id>.jsonl`，一行一个 JSON 事件
 * （Qoder 的 agent 与 Claude Code 同一套格式），assistant 事件里带着这次请求的用量：
 *   { "type": "assistant", "timestamp": "2026-09-19T13:52:31.869Z",
 *     "message": { "model": "qfmodel", "usage": { … , "credits": 0.78379939 } } }
 *
 * **能用的只有 credits**：Qoder 的客户端不产生 token 计数 —— 同一份 usage 里
 * input_tokens / output_tokens / cache_read_input_tokens 实测恒为 0（它自己的上下文快照里
 * 也写着 `tokenCountsAvailable: false`，用量面板是回头去问服务端的），所以这个来源
 * 只落 credits 一个字段，tokens 口径下整个不出现。
 *
 * 时间戳是 UTC 的 ISO 串，按本地日期分桶（与其余来源同一约定）。
 * `usage.credits` 是这次请求扣掉的额度：同一份 usage 里的 `billable` 字段实测恒为 false，
 * 拿它当过滤条件会一条都读不出来，所以照实记 credits、不看那一位。
 *
 * 每一行都自足（模型与用量都在同一行），所以适配层可以**按文件**缓存解析结果。
 */

import { dayKey } from './activity'
import { addCounters, emptyCounters, isDateKey, type TokenCounters, type TokenDays } from './token-usage'

/** 事件里没带模型名时的兜底名（正常每条都带，只防残缺事件） */
export const QODER_DEFAULT_MODEL = 'qoder'

/** 事件里用得上的那几层；其余字段不解析 */
interface QoderEvent {
  type?: unknown
  timestamp?: unknown
  message?: {
    model?: unknown
    usage?: { credits?: unknown }
  }
}

/** 一次请求的额度：非法与非正数都不落账（免费模型的 credits 就是 0） */
function creditsOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 把一个会话文件（正文）的额度累计进 days：按事件时间戳的本地日期、按行内自带的模型分桶。
 * 单个事件解析失败只丢那一条。
 */
export function collectQoderSessionText(text: string, days: TokenDays): void {
  for (const line of text.split('\n')) {
    if (!line) continue

    let event: QoderEvent
    try {
      event = JSON.parse(line) as QoderEvent
    } catch {
      // 会话文件是追加写的：最后一行可能只写了一半，下次刷新就会带上完整的那条
      continue
    }

    if (event.type !== 'assistant') continue
    const message = event.message
    if (!message || typeof message !== 'object') continue

    const credits = creditsOf(message.usage?.credits)
    if (credits <= 0) continue

    // 时间戳是 UTC 的 ISO 串（实测如此）；顺手也认毫秒数，解析不出来（缺字段 / 半行）
    // 就丢这一条，不硬塞进今天
    const raw = event.timestamp
    const timestamp =
      typeof raw === 'number' ? raw : Date.parse(typeof raw === 'string' ? raw : '')
    const date = dayKey(timestamp)
    if (!isDateKey(date)) continue

    const declared = message.model
    const model =
      typeof declared === 'string' && declared.trim() ? declared.trim() : QODER_DEFAULT_MODEL

    const step: TokenCounters = {
      // Qoder 不报 token，这几个字段一律留 0，不拿额度去折算
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      credits,
      // 一条 assistant 用量记的就是一次请求
      requests: 1
    }

    const modelDays = (days[date] ??= {})
    modelDays[model] = addCounters(modelDays[model] ?? emptyCounters(), step)
  }
}
