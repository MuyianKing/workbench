import { describe, expect, it } from 'vitest'
import { collectCodeBuddyLogText, createCodeBuddyParseState } from './codebuddy-log'
import type { TokenDays } from './token-usage'

/**
 * 样例行取自 CodeBuddy 扩展日志的真实形态(腾讯云代码助手*.log),id 与数值做了匿名化。
 * 行形态:
 *   [CraftInvokableAgent] [<traceId>] Preparing model: <名> (<模型 id>)
 *   [AgentReporter] [<traceId>] onAgentStart: … requestId=<requestId>
 *   [BaseAgent:*] [<requestId>] notifyStepEnd, … requestId: <requestId>, … usage: {…}
 */
function modelLine(traceId: string, model: string): string {
  return `2026-09-10 19:44:41.364 [info] [CraftInvokableAgent] [${traceId}] Preparing model: Hy4 preview (${model})`
}

function requestLine(traceId: string, requestId: string): string {
  return `2026-09-10 19:44:41.385 [info] [AgentReporter] [${traceId}] onAgentStart: userInput=分析一下这个项目 agent=craft mode=craft conversationId=c1 requestId=${requestId}`
}

function usageLine(requestId: string, usage: Record<string, number>, day = '2026-09-10'): string {
  const json = JSON.stringify(usage)
  return `${day} 19:44:47.061 [info] [BaseAgent:craft] [${requestId}] notifyStepEnd, step: 1, requestId: ${requestId}, messageId: m1, usage: ${json}, isMaxTokenLimit: false, isMaxStepLimit: false`
}

const FULL_USAGE = {
  inputTokens: 25600,
  outputTokens: 110,
  totalTokens: 25710,
  cacheTokens: 3520,
  cachedWriteTokens: 40,
  cachedMissTokens: 22080,
  lastTokens: 25710,
  credit: 0,
  thinkingTokens: 24
}

describe('CodeBuddy 日志用量解析', () => {
  it('经 traceId → requestId 串联后,把 usage 归到请求的模型并按天分桶', () => {
    const state = createCodeBuddyParseState()
    const days: TokenDays = {}
    collectCodeBuddyLogText(
      [modelLine('cafebabe1234', 'hy4-preview'), requestLine('cafebabe1234', 'feedface1234'), usageLine('feedface1234', FULL_USAGE)].join('\n'),
      state,
      days
    )

    const counters = days['2026-09-10']['hy4-preview']
    // inputTokens 是含缓存的总输入,拆掉 cacheTokens 后入库,避免总量双算
    expect(counters.inputTokens).toBe(25600 - 3520)
    expect(counters.outputTokens).toBe(110)
    expect(counters.reasoningTokens).toBe(24)
    expect(counters.cacheReadTokens).toBe(3520)
    expect(counters.cacheWriteTokens).toBe(40)
    expect(counters.requests).toBe(1)
  })

  it('同一请求的多个 step 累加,不同日期分桶', () => {
    const state = createCodeBuddyParseState()
    const days: TokenDays = {}
    collectCodeBuddyLogText(
      [
        modelLine('cafebabe1234', 'hy4-preview'),
        requestLine('cafebabe1234', 'feedface1234'),
        usageLine('feedface1234', { inputTokens: 100, outputTokens: 10 }),
        usageLine('feedface1234', { inputTokens: 200, outputTokens: 20 }, '2026-09-11')
      ].join('\n'),
      state,
      days
    )

    expect(days['2026-09-10']['hy4-preview'].inputTokens).toBe(100)
    expect(days['2026-09-10']['hy4-preview'].requests).toBe(1)
    expect(days['2026-09-11']['hy4-preview'].inputTokens).toBe(200)
    expect(days['2026-09-11']['hy4-preview'].requests).toBe(1)
  })

  it('多个模型、多个请求各自成桶', () => {
    const state = createCodeBuddyParseState()
    const days: TokenDays = {}
    collectCodeBuddyLogText(
      [
        modelLine('cafebabe1234', 'hy4-preview'),
        modelLine('cafebabe5678', 'deepseek-v4-pro'),
        requestLine('cafebabe1234', 'feedface1234'),
        requestLine('cafebabe5678', 'feedface5678'),
        usageLine('feedface5678', { inputTokens: 50, outputTokens: 5 }),
        usageLine('feedface1234', { inputTokens: 60, outputTokens: 6 })
      ].join('\n'),
      state,
      days
    )

    expect(days['2026-09-10']['hy4-preview'].inputTokens).toBe(60)
    expect(days['2026-09-10']['deepseek-v4-pro'].inputTokens).toBe(50)
  })

  it('拿不到模型映射的请求回退到最近见过的模型', () => {
    const state = createCodeBuddyParseState()
    const days: TokenDays = {}
    collectCodeBuddyLogText(
      [
        modelLine('cafebabe1234', 'hy4-preview'),
        // 只有 usage、没有 trace→request 映射的子请求
        usageLine('feedface9999', { inputTokens: 70, outputTokens: 7 })
      ].join('\n'),
      state,
      days
    )

    expect(days['2026-09-10']['hy4-preview'].inputTokens).toBe(70)
  })

  it('状态跨文件复用:映射在前一个文件、usage 在轮转后的文件里也能关联', () => {
    const state = createCodeBuddyParseState()
    const days: TokenDays = {}
    collectCodeBuddyLogText([modelLine('cafebabe1234', 'hy4-preview'), requestLine('cafebabe1234', 'feedface1234')].join('\n'), state, days)
    expect(Object.keys(days)).toHaveLength(0)
    collectCodeBuddyLogText(usageLine('feedface1234', FULL_USAGE), state, days)
    expect(days['2026-09-10']['hy4-preview'].requests).toBe(1)
  })

  it('坏行直接跳过:无时间戳、坏 JSON、缺 usage 都不算数', () => {
    const state = createCodeBuddyParseState()
    const days: TokenDays = {}
    collectCodeBuddyLogText(
      [
        'garbage line without timestamp',
        modelLine('cafebabe1234', 'hy4-preview'),
        requestLine('cafebabe1234', 'feedface1234'),
        usageLine('feedface1234', FULL_USAGE).replace('"inputTokens":25600,', '"inputTokens":"oops",'),
        `${'2026-09-10'} 19:44:47.061 [info] [BaseAgent:craft] usage: {broken`,
        usageLine('feedface1234', FULL_USAGE, '2026-9-10')
      ].join('\n'),
      state,
      days
    )

    // 坏行不产生任何桶
    expect(Object.keys(days)).toHaveLength(0)
  })

  it('字段缺失或为零按 0 计,请求仍然计数', () => {
    const state = createCodeBuddyParseState()
    const days: TokenDays = {}
    collectCodeBuddyLogText(
      [modelLine('cafebabe1234', 'hy4-preview'), requestLine('cafebabe1234', 'feedface1234'), usageLine('feedface1234', { inputTokens: 0, outputTokens: 0 })].join(
        '\n'
      ),
      state,
      days
    )

    const counters = days['2026-09-10']['hy4-preview']
    expect(counters.inputTokens).toBe(0)
    expect(counters.cacheReadTokens).toBe(0)
    expect(counters.requests).toBe(1)
  })
})
