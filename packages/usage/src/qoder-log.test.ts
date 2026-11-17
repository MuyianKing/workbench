import type { TokenDays, TokenProjectDays } from './token-usage'
import { describe, expect, it } from 'vitest'
import { collectQoderSessionText, QODER_DEFAULT_MODEL } from './qoder-log'
import { emptyCounters } from './token-usage'

/**
 * 样例行取自 Qoder 会话文件（`~/.qoder-cn/projects/<项目>/<会话 id>.jsonl`）的真实形态，
 * id 与数值做了匿名化。关键部分：
 *   { "type": "assistant", "timestamp": <ISO 串>, "cwd": "E:\\…", "message": { "model": …, "usage": { … } } }
 * 时间戳用本地时间构造再转成 ISO，断言里的日期键在任何时区下都成立。
 */
function at(day = 10, hour = 16, minute = 44): string {
  return new Date(2026, 8, day, hour, minute, 19, 869).toISOString()
}

/** 真实 usage 的形状：token 那几项恒为 0，只有 credits 有值 */
function usageLine(
  usage: Record<string, unknown>,
  options: { type?: string, model?: string | null, timestamp?: unknown, cwd?: string } = {},
): string {
  const { type = 'assistant', model = 'qfmodel', timestamp = at(), cwd = 'E:\\muyian\\Workbench' } = options
  return JSON.stringify({
    type,
    sessionId: 'c5ef1c9b-ba57-4e60-a9de-9f4dcfc24215',
    uuid: 'cafebabe-1234',
    timestamp,
    cwd,
    message: {
      id: 'msg_01',
      role: 'assistant',
      model,
      usage,
    },
  })
}

/** 一次解析同时拿到「按模型」与「按项目」两层,用例各取所需 */
function run(lines: string | string[]): { days: TokenDays, projects: TokenProjectDays } {
  const days: TokenDays = {}
  const projects: TokenProjectDays = {}
  collectQoderSessionText(Array.isArray(lines) ? lines.join('\n') : lines, days, projects)
  return { days, projects }
}

const FULL_USAGE = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  credits: 0.78379939,
  original_credits: 0.78379939,
  billable: false,
}

describe('qoder 会话额度解析', () => {
  it('只落 credits：token 那几项照上游的 0，不拿额度折算', () => {
    const { days } = run(usageLine(FULL_USAGE))

    // 这份 usage 里 input/output/cache 全是 0（Qoder 不产生 token 计数），
    // 一旦有人在这儿「顺手折算一下」，credits 口径就变成了编出来的 token 数
    expect(days['2026-09-10'].qfmodel).toEqual({
      ...emptyCounters(),
      credits: 0.78379939,
      requests: 1,
    })
  })

  it('事件自带的 cwd 优先于会话开头的目录清单', () => {
    const { projects } = run([
      JSON.stringify({ type: 'workspace-directories', directories: ['E:\\git-projects\\ICU2.0\\code\\ICUClient'] }),
      usageLine({ credits: 1 }, { cwd: 'E:\\muyian\\Workbench' }),
    ])

    expect(projects['2026-09-10']['E:\\muyian\\Workbench'].credits).toBe(1)
  })

  it('事件没有 cwd 时退回会话开头的目录清单', () => {
    const { projects } = run([
      JSON.stringify({ type: 'workspace-directories', directories: ['E:\\git-projects\\ICU2.0\\code\\ICUClient'] }),
      JSON.stringify({
        type: 'assistant',
        timestamp: at(),
        message: { model: 'qfmodel', usage: { credits: 2 } },
      }),
    ])

    expect(projects['2026-09-10']['E:\\git-projects\\ICU2.0\\code\\ICUClient'].credits).toBe(2)
  })

  it('两处都没有目录时不落项目层,额度只进口径合计', () => {
    const { days, projects } = run(JSON.stringify({
      type: 'assistant',
      timestamp: at(),
      message: { model: 'qfmodel', usage: { credits: 3 } },
    }))

    expect(days['2026-09-10'].qfmodel.credits).toBe(3)
    // 没有工作目录就不算项目
    expect(projects).toEqual({})
  })

  it('额度是小数记账，逐条累加不取整', () => {
    const { days } = run([
      usageLine({ credits: 0.078367718 }),
      usageLine({ credits: 6.140525885999999 }),
      usageLine({ credits: 0.5 }),
    ])

    const counters = days['2026-09-10'].qfmodel
    expect(counters.credits).toBeCloseTo(6.718893604, 9)
    expect(counters.requests).toBe(3)
  })

  it('跨天的会话按各自的时间戳分桶（时间戳是 UTC 的 ISO 串）', () => {
    const { days } = run([
      usageLine({ credits: 1 }, { timestamp: at(10, 23, 59) }),
      usageLine({ credits: 2 }, { timestamp: at(11, 0, 1) }),
    ])

    expect(days['2026-09-10'].qfmodel.credits).toBe(1)
    expect(days['2026-09-11'].qfmodel.credits).toBe(2)
  })

  it('模型名取行内自带的那一个，缺失才落到兜底名', () => {
    const { days } = run([
      usageLine({ credits: 1 }, { model: 'qfmodel' }),
      usageLine({ credits: 2 }, { model: '  ' }),
      usageLine({ credits: 4 }, { model: null }),
    ])

    expect(days['2026-09-10'].qfmodel.credits).toBe(1)
    // 没带模型名的两条落兜底名，不并进上面那一个
    expect(days['2026-09-10'][QODER_DEFAULT_MODEL].credits).toBe(6)
  })

  it('只认 assistant 事件，且只认有额度的那些', () => {
    const { days } = run([
      // 用户消息、运行时配置这些事件里没有 usage
      JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user' } }),
      JSON.stringify({ type: 'runtime-config', timestamp: at(), model: 'qfmodel' }),
      // 免费模型扣 0 个额度：记下来只会是一条 0
      usageLine({ credits: 0 }),
      // 负数与非法值同理
      usageLine({ credits: -1 }),
      usageLine({ credits: 'oops' }),
      // usage 整个缺失
      usageLine({}),
      // 真正该落账的那一条
      usageLine({ credits: 0.25 }),
    ])

    expect(Object.keys(days)).toEqual(['2026-09-10'])
    expect(days['2026-09-10'].qfmodel.credits).toBe(0.25)
    expect(days['2026-09-10'].qfmodel.requests).toBe(1)
  })

  it('半行与坏行只丢那一条，不影响同一个文件里的其余记录', () => {
    const { days } = run(['{"type":"assistant","timestamp"', 'not json at all', usageLine({ credits: 3 })])

    expect(days['2026-09-10'].qfmodel.credits).toBe(3)
    expect(days['2026-09-10'].qfmodel.requests).toBe(1)
  })

  it('时间戳缺失或解析不出来时丢掉那条，不硬塞进今天', () => {
    const { days } = run([
      usageLine({ credits: 1 }, { timestamp: 'oops' }),
      usageLine({ credits: 2 }, { timestamp: null }),
      usageLine({ credits: 4 }, { timestamp: Date.parse(at(12, 9, 30)) }),
    ])

    // 毫秒数也认（万一上游换了写法），前面两条照丢
    expect(Object.keys(days)).toEqual(['2026-09-12'])
    expect(days['2026-09-12'].qfmodel.credits).toBe(4)
  })
})
