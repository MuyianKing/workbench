/**
 * WorkBuddy 会话正文的用量解析（纯逻辑，供适配层的 reader 调用）。
 *
 * WorkBuddy 没有独立的用量库，但没有 CodeBuddy 那种「靠 id 串联」的麻烦：
 * 每次模型调用的用量就写在会话正文里
 * （`~/.workbuddy/projects/<项目>/<会话 id>.jsonl`，一行一个 JSON 事件），
 * 事件自己带着时间、模型与用量：
 *   { "timestamp": 1789042961416, "providerData": { "model": "hy3", "usage": { … } } }
 *
 * 用量里的 `inputTokens` **含**缓存读取（同一条 usage 的 inputTokensDetails 里给出
 * cached_tokens），按与 ZCode / CodeBuddy 同一口径拆开落字段，否则缓存那部分会被算两遍 ——
 * 缓存往往占九成以上，这一处不拆数字会大得离谱。
 * `outputTokensDetails` 里的 reasoning_tokens 是输出里的思考部分，与 ZCode 的 reasoning_tokens
 * 同口径，照其余来源的做法单独成字段（不减进输出）。
 *
 * 与 CodeBuddy 的解析器不同，这里的每一行都是自足的：模型名不必从别的行反推，
 * 所以适配层可以**按文件**缓存解析结果，只重解变化的那些（见 workbench/token.ts）。
 */

import { dayKey } from './activity'
import { addCounters, emptyCounters, isDateKey, type TokenCounters, type TokenDays } from './token-usage'

/** 事件里没带模型名时的兜底名（正常每条用量都自带模型，只防残缺事件） */
export const WORKBUDDY_DEFAULT_MODEL = 'workbuddy'

/** 事件里用得上的那几层；其余字段不解析 */
interface WorkBuddyEvent {
  timestamp?: unknown
  providerData?: {
    model?: unknown
    usage?: WorkBuddyUsage
  }
}

/** usage 是聚合口径：requests 是它汇了几次调用，details 是逐次调用的细分 */
interface WorkBuddyUsage {
  requests?: unknown
  inputTokens?: unknown
  outputTokens?: unknown
  inputTokensDetails?: unknown
  outputTokensDetails?: unknown
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 把 details 数组里每项的某个字段加起来。
 * 数组每项对应一次调用的细分（实测一次调用一项），逐项相加才是这次聚合口径的总量；
 * 项不是对象、字段不是数字的按 0 计，坏数据不把整行带崩。
 */
function sumDetail(details: unknown, field: string): number {
  if (!Array.isArray(details)) return 0
  let total = 0
  for (const item of details) {
    if (!item || typeof item !== 'object') continue
    total += finite((item as Record<string, unknown>)[field])
  }
  return total
}

/**
 * 把一个会话文件（正文）的用量累计进 days：
 * 按事件时间戳的本地日期、按事件自己声明的模型分桶。单个事件解析失败只丢那一条。
 */
export function collectWorkBuddySessionText(text: string, days: TokenDays): void {
  let model = WORKBUDDY_DEFAULT_MODEL

  for (const line of text.split('\n')) {
    if (!line) continue

    let event: WorkBuddyEvent
    try {
      event = JSON.parse(line) as WorkBuddyEvent
    } catch {
      // 会话正文是追加写的：最后一行可能只写了一半，下次刷新就会带上完整的那条
      continue
    }

    const providerData = event.providerData
    if (!providerData || typeof providerData !== 'object') continue

    const declared = providerData.model
    if (typeof declared === 'string' && declared.trim()) model = declared.trim()

    const usage = providerData.usage
    if (!usage || typeof usage !== 'object') continue

    const date = dayKey(Number(event.timestamp))
    if (!isDateKey(date)) continue

    const cacheRead = sumDetail(usage.inputTokensDetails, 'cached_tokens')
    const requests = finite(usage.requests)
    const step: TokenCounters = {
      inputTokens: Math.max(0, finite(usage.inputTokens) - cacheRead),
      outputTokens: finite(usage.outputTokens),
      reasoningTokens: sumDetail(usage.outputTokensDetails, 'reasoning_tokens'),
      cacheReadTokens: cacheRead,
      // WorkBuddy 的用量里没有缓存写入这一项，不编造
      cacheWriteTokens: 0,
      // 一条 usage 记的就是一次请求；字段缺失或非法时也按一次算
      requests: requests > 0 ? requests : 1
    }

    const modelDays = (days[date] ??= {})
    modelDays[model] = addCounters(modelDays[model] ?? emptyCounters(), step)
  }
}
