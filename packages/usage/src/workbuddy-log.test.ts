import type { TokenDays, TokenProjectDays } from './token-usage'
import { describe, expect, it } from 'vitest'
import { collectWorkBuddySessionText, WORKBUDDY_DEFAULT_MODEL } from './workbuddy-log'

/**
 * 样例行取自 WorkBuddy 会话正文（`~/.workbuddy/projects/<项目>/<会话 id>.jsonl`）的真实形态，
 * id 与数值做了匿名化。一行的关键部分：
 *   { "timestamp": <epoch 毫秒>, "cwd": "e:\\…", "providerData": { "model": …, "usage": { … } } }
 * 时间戳用本地时间构造，断言里的日期键在任何时区下都成立。
 */
function at(day = 10, hour = 16, minute = 44): number {
  return new Date(2026, 8, day, hour, minute, 19).getTime()
}

function usageLine(
  usage: Record<string, unknown>,
  options: { model?: string, timestamp?: number, cwd?: string } = {},
): string {
  const { model = 'hy3', timestamp = at(), cwd = 'E:\\muyian\\Workbench' } = options
  return JSON.stringify({
    id: 'cafebabe1234',
    timestamp,
    type: 'function_call',
    cwd,
    providerData: { model, usage },
  })
}

/** 一次解析同时拿到「按模型」与「按项目」两层,用例各取所需 */
function run(lines: string | string[]): { days: TokenDays, projects: TokenProjectDays } {
  const days: TokenDays = {}
  const projects: TokenProjectDays = {}
  collectWorkBuddySessionText(Array.isArray(lines) ? lines.join('\n') : lines, days, projects)
  return { days, projects }
}

const FULL_USAGE = {
  requests: 1,
  inputTokens: 36775,
  outputTokens: 280,
  totalTokens: 37055,
  inputTokensDetails: [{ cached_tokens: 3520 }],
  outputTokensDetails: [{ reasoning_tokens: 243 }],
}

describe('workBuddy 会话用量解析', () => {
  it('按时间戳的本地日期与自带的模型分桶，输入里减掉缓存读取', () => {
    const { days } = run(usageLine(FULL_USAGE))

    const counters = days['2026-09-10'].hy3
    // inputTokens 是含缓存的总输入，拆掉 cached_tokens 后入库，避免总量双算
    expect(counters.inputTokens).toBe(36775 - 3520)
    expect(counters.cacheReadTokens).toBe(3520)
    expect(counters.outputTokens).toBe(280)
    expect(counters.reasoningTokens).toBe(243)
    // WorkBuddy 的用量里没有缓存写入这一项
    expect(counters.cacheWriteTokens).toBe(0)
    expect(counters.requests).toBe(1)
  })

  it('用量归到事件里的工作目录', () => {
    const { projects } = run(usageLine(FULL_USAGE))
    expect(projects['2026-09-10']['E:\\muyian\\Workbench'].inputTokens).toBe(36775 - 3520)
  })

  it('事件缺 cwd 时不落项目层,计数只进模型口径', () => {
    const { days, projects } = run(JSON.stringify({
      timestamp: at(),
      providerData: { model: 'hy3', usage: { inputTokens: 10, outputTokens: 1 } },
    }))

    expect(days['2026-09-10'].hy3.inputTokens).toBe(10)
    // 没有工作目录就不算项目
    expect(projects).toEqual({})
  })

  it('模型自带，一行一条，不需要靠别的行反推', () => {
    const { days } = run([
      usageLine({ inputTokens: 100, outputTokens: 10 }, { model: 'hy4-preview' }),
      usageLine({ inputTokens: 50, outputTokens: 5 }, { model: 'glm-5.3-flash' }),
      usageLine({ inputTokens: 20, outputTokens: 2 }, { model: 'hy4-preview' }),
    ])

    expect(days['2026-09-10']['hy4-preview'].inputTokens).toBe(120)
    expect(days['2026-09-10']['glm-5.3-flash'].inputTokens).toBe(50)
    expect(days['2026-09-10']['hy4-preview'].requests).toBe(2)
  })

  it('跨天的会话按各自的时间戳分桶', () => {
    const { days } = run([
      usageLine({ inputTokens: 100, outputTokens: 10 }, { timestamp: at(10, 23, 59) }),
      usageLine({ inputTokens: 200, outputTokens: 20 }, { timestamp: at(11, 0, 1) }),
    ])

    expect(days['2026-09-10'].hy3.inputTokens).toBe(100)
    expect(days['2026-09-11'].hy3.inputTokens).toBe(200)
  })

  it('模型名为空白时回退到最近声明过的模型', () => {
    const declared = usageLine({ inputTokens: 30, outputTokens: 3 }, { model: 'hy4-preview' })
    const blank = JSON.stringify({
      timestamp: at(),
      cwd: 'E:\\muyian\\Workbench',
      providerData: { model: '   ', usage: { inputTokens: 70, outputTokens: 7 } },
    })

    const { days } = run([declared, blank])
    expect(days['2026-09-10']['hy4-preview'].inputTokens).toBe(100)
  })

  it('一条模型也没声明过时落到兜底名', () => {
    const { days } = run(usageLine({ inputTokens: 10, outputTokens: 1 }, { model: '' }))

    expect(days['2026-09-10'][WORKBUDDY_DEFAULT_MODEL].inputTokens).toBe(10)
  })

  it('details 是逐次调用的细分，逐项相加', () => {
    const { days } = run(usageLine({
      requests: 2,
      inputTokens: 900,
      outputTokens: 60,
      inputTokensDetails: [{ cached_tokens: 300 }, { cached_tokens: 200 }],
      outputTokensDetails: [{ reasoning_tokens: 15 }, { reasoning_tokens: 5 }],
    }))

    const counters = days['2026-09-10'].hy3
    expect(counters.cacheReadTokens).toBe(500)
    expect(counters.inputTokens).toBe(400)
    expect(counters.reasoningTokens).toBe(20)
    expect(counters.requests).toBe(2)
  })

  it('requests 字段缺失或为零时按一次计', () => {
    const { days } = run([
      usageLine({ inputTokens: 10, outputTokens: 1 }),
      usageLine({ requests: 0, inputTokens: 10, outputTokens: 1 }),
    ])

    expect(days['2026-09-10'].hy3.requests).toBe(2)
  })

  it('坏行直接跳过：坏 JSON、缺时间戳、缺 usage、非法的 details', () => {
    const { days } = run([
      'garbage line not json',
      JSON.stringify({ providerData: { model: 'hy3', usage: { inputTokens: 100 } } }),
      JSON.stringify({ timestamp: at(), providerData: { model: 'hy3' } }),
      JSON.stringify({ timestamp: 'oops', providerData: { model: 'hy3', usage: { inputTokens: 100 } } }),
      usageLine({
        inputTokens: 50,
        outputTokens: 5,
        inputTokensDetails: 'nope',
        outputTokensDetails: [{ reasoning_tokens: 'oops' }],
      }),
    ])

    // 只有最后一行算数；非法的 details 按 0 计而不是把整行丢掉
    const counters = days['2026-09-10'].hy3
    expect(counters.inputTokens).toBe(50)
    expect(counters.cacheReadTokens).toBe(0)
    expect(counters.reasoningTokens).toBe(0)
    expect(counters.requests).toBe(1)
    expect(Object.keys(days)).toHaveLength(1)
  })
})
