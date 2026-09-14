/**
 * CodeBuddy IDE 扩展日志的用量解析(纯逻辑,供适配层的 reader 调用)。
 *
 * CodeBuddy 没有落地的用量库,唯一的数据源是扩展日志(%APPDATA%/CodeBuddy CN/logs/…)
 * 里的三类行,靠 id 串起来:
 *   1. [CraftInvokableAgent] [<traceId>] Preparing model: Hy4 preview (hy4-preview)
 *      —— traceId → 模型;
 *   2. [AgentReporter] [<traceId>] onAgentStart: … requestId=<id>
 *      —— traceId → requestId;
 *   3. [BaseAgent:*] [<requestId>] notifyStepEnd, … requestId: <id>, … usage: {…}
 *      —— 每步请求一条,是计数的来源。
 * 日志按行追加、按启动会话分目录,不清理已写的行,所以整份日志可以反复重读;
 * 模型名只能从「Preparing model」行反推,极个别子请求拿不到时回退到最近见过的模型。
 */

import {
  addCounters,
  emptyCounters,
  isDateKey,
  type TokenCounters,
  type TokenDays
} from './token-usage'

/** 跨文件保留的解析状态:三张映射 + 兜底模型(日志轮转可能把一次请求拆进两个文件) */
export interface CodeBuddyParseState {
  traceModel: Map<string, string>
  traceRequest: Map<string, string>
  requestModel: Map<string, string>
  lastModel: string
}

export function createCodeBuddyParseState(): CodeBuddyParseState {
  return {
    traceModel: new Map(),
    traceRequest: new Map(),
    requestModel: new Map(),
    lastModel: 'codebuddy'
  }
}

/** 日志行首的本地时间戳;日期键直接取前 10 位,与活跃度图同一约定 */
const DATE_RE = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}/

/** [CraftInvokableAgent] [<traceId>] Preparing model: <名> (<模型 id>) */
const MODEL_RE = /\[([A-Za-z]+InvokableAgent)\] \[([0-9a-f]{8,})\] Preparing model: [^(]*\(([^()\s]+)\)/

/** [AgentReporter] [<traceId>] onAgentStart: … requestId=<requestId> */
const REQUEST_RE = /\[AgentReporter\] \[([0-9a-f]{8,})\] onAgentStart: .*requestId=([0-9a-f]+)/

/** notifyStepEnd 行里的用量 JSON;扁平数字对象,贪婪到第一个 } 即是整体 */
const USAGE_RE = /usage: (\{[^{}]*\})/
const REQUEST_OF_USAGE_RE = /requestId: ([0-9a-f]+)/

/** usage JSON 里关心的字段;字段缺失或非法都按 0 计 */
interface CodeBuddyUsageJson {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheTokens?: unknown
  cachedWriteTokens?: unknown
  cachedMissTokens?: unknown
  thinkingTokens?: unknown
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 把一段日志文本的用量累计进 days(按行首时间戳的本地日期、请求的模型分桶)。
 * state 跨文件复用;单行解析失败直接跳过,只少一条记录,不影响整体。
 */
export function collectCodeBuddyLogText(text: string, state: CodeBuddyParseState, days: TokenDays): void {
  for (const line of text.split('\n')) {
    const modelMatch = line.match(MODEL_RE)
    if (modelMatch) {
      const [, , traceId, model] = modelMatch
      state.traceModel.set(traceId, model)
      // Preparing model 行按时间顺序出现,顺带维护兜底模型
      state.lastModel = model
      continue
    }

    const requestMatch = line.match(REQUEST_RE)
    if (requestMatch) {
      const [, traceId, requestId] = requestMatch
      state.traceRequest.set(traceId, requestId)
      const model = state.traceModel.get(traceId)
      if (model) state.requestModel.set(requestId, model)
      continue
    }

    if (!line.includes('usage: {')) continue

    const usageMatch = line.match(USAGE_RE)
    if (!usageMatch) continue
    const dateMatch = line.match(DATE_RE)
    if (!dateMatch || !isDateKey(dateMatch[1])) continue

    let usage: CodeBuddyUsageJson
    try {
      usage = JSON.parse(usageMatch[1]) as CodeBuddyUsageJson
    } catch {
      continue
    }
    // 核心计数不是数字说明这条 usage 残缺,整条跳过,别按 0 硬计
    if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') continue
    const requestMatch2 = line.match(REQUEST_OF_USAGE_RE)
    const model =
      (requestMatch2 ? state.requestModel.get(requestMatch2[1]) : undefined) ?? state.lastModel

    const cacheRead = finite(usage.cacheTokens)
    const step: TokenCounters = {
      inputTokens: Math.max(0, finite(usage.inputTokens) - cacheRead),
      outputTokens: finite(usage.outputTokens),
      reasoningTokens: finite(usage.thinkingTokens),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: finite(usage.cachedWriteTokens),
      requests: 1
    }
    const modelDays = (days[dateMatch[1]] ??= {})
    modelDays[model] = addCounters(modelDays[model] ?? emptyCounters(), step)
  }
}
