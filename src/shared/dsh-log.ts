/**
 * DeepSeek Harness 会话的用量解析（纯逻辑，供适配层的 reader 调用）。
 *
 * 会话文件是多帧 zstd：每条事件一帧、追加写。解压留在 Rust（浏览器没有 zstd 解码 API），
 * 这里只负责把解出来的文本累计成按天计数 —— 一行一个 JSON 事件，只关心两类：
 *   1. `request/header`：声明这次请求用的模型，后面的事件都算在它头上；
 *   2. `assistant/message`：带 `usage`，是计数的来源。
 * `usage` 里的输入**已经是不含缓存读取的口径**，与 ZCode 拆开后的字段一一对应，
 * 所以这里直接落到 inputTokens / cacheReadTokens，不再减一次（减了就把缓存双算成负数）。
 *
 * 一个会话文件里的模型声明是自洽的：每个文件都从默认模型起算，跨文件不共享状态，
 * 因此适配层可以按文件单独解析、只重解变化的那些（见 workbench/token.ts 的按文件缓存）。
 */

import { dayKey } from './activity'
import { addCounters, emptyCounters, isDateKey, type TokenCounters, type TokenDays } from './token-usage'

/** 会话里没声明模型时的兜底名 */
export const DSH_DEFAULT_MODEL = 'deepseek'

/** assistant/message 事件里的用量；字段缺失或非法都按 0 计 */
interface DshUsage {
  inputTokens?: unknown
  outputTokens?: unknown
  reasoningTokens?: unknown
  cacheReadTokens?: unknown
}

/** 事件里用得上的那几层；其余字段不解析 */
interface DshEvent {
  type?: unknown
  time?: unknown
  data?: {
    header?: { config?: { model?: unknown } }
    usage?: DshUsage
  }
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 把一个会话文件（已解压的文本）的用量累计进 days：
 * 按事件时间的本地日期、按当时声明的模型分桶。单个事件解析失败只丢那一条。
 */
export function collectDshSessionText(text: string, days: TokenDays): void {
  let model = DSH_DEFAULT_MODEL

  for (const line of text.split('\n')) {
    if (!line) continue

    let event: DshEvent
    try {
      event = JSON.parse(line) as DshEvent
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

    // 只记「这条 assistant 消息产生了一次请求」；同一会话的多条消息各自成一条
    const step: TokenCounters = {
      inputTokens: finite(usage.inputTokens),
      outputTokens: finite(usage.outputTokens),
      reasoningTokens: finite(usage.reasoningTokens),
      cacheReadTokens: finite(usage.cacheReadTokens),
      cacheWriteTokens: 0,
      requests: 1
    }

    const modelDays = (days[date] ??= {})
    modelDays[model] = addCounters(modelDays[model] ?? emptyCounters(), step)
  }
}
