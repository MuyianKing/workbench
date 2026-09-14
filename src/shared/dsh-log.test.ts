/**
 * DSH 会话事件 → 按天计数的解析规则。
 *
 * 用例里的字段与数值都照真实会话抄：`usage` 是
 * `{"inputTokens":161,"outputTokens":892,"cacheReadTokens":29696,"reasoningTokens":0,"totalTokens":30749}` 这个形状，
 * 而 161 + 892 + 29696 正好等于 totalTokens —— 也就是说 **inputTokens 已经不含缓存读取**，
 * 这里不能再减一次（那是 ZCode 的口径，减了 inputTokens 会变成 0）。
 */
import { describe, expect, it } from 'vitest'
import { dayKey } from './activity'
import { DSH_DEFAULT_MODEL, collectDshSessionText } from './dsh-log'
import { emptyCounters, type TokenDays } from './token-usage'

/** 一次请求的时间戳（毫秒）——照真实事件取 */
const TIME = 1789348272520

function headerLine(time: number, model: string): string {
  return JSON.stringify({
    type: 'request/header',
    seq: 15,
    time,
    data: { header: { config: { provider: 'deepseek-official', model } } }
  })
}

function messageLine(time: number, usage: Record<string, number>): string {
  return JSON.stringify({
    type: 'assistant/message',
    seq: 19,
    time,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage }
  })
}

function collect(...lines: string[]): TokenDays {
  const days: TokenDays = {}
  collectDshSessionText(lines.join('\n'), days)
  return days
}

describe('DSH 会话解析', () => {
  it('按事件时间的本地日期与请求声明的模型分桶', () => {
    const days = collect(
      headerLine(TIME, 'deepseek-flash'),
      messageLine(TIME, { inputTokens: 161, outputTokens: 892, cacheReadTokens: 29696, reasoningTokens: 0 })
    )

    const counters = days[dayKey(TIME)]['deepseek-flash']
    // 输入不含缓存，直接落字段；减掉缓存的话这里会变成 0
    expect(counters.inputTokens).toBe(161)
    expect(counters.cacheReadTokens).toBe(29696)
    expect(counters.outputTokens).toBe(892)
    expect(counters.reasoningTokens).toBe(0)
    // 缓存写入 DSH 的 usage 里没有这一项，恒为 0
    expect(counters.cacheWriteTokens).toBe(0)
    expect(counters.requests).toBe(1)
  })

  it('同一个会话里多条 assistant 消息累计，请求数逐条相加', () => {
    const days = collect(
      headerLine(TIME, 'deepseek-flash'),
      messageLine(TIME, { inputTokens: 100, outputTokens: 10 }),
      messageLine(TIME, { inputTokens: 200, outputTokens: 20 })
    )

    const counters = days[dayKey(TIME)]['deepseek-flash']
    expect(counters.inputTokens).toBe(300)
    expect(counters.outputTokens).toBe(30)
    expect(counters.requests).toBe(2)
  })

  it('切换模型只影响它之后的事件，前面那些仍算在原模型上', () => {
    const days = collect(
      headerLine(TIME, 'deepseek-flash'),
      messageLine(TIME, { inputTokens: 100 }),
      headerLine(TIME, 'deepseek-pro'),
      messageLine(TIME, { inputTokens: 7 })
    )

    const models = days[dayKey(TIME)]
    expect(models['deepseek-flash'].inputTokens).toBe(100)
    expect(models['deepseek-pro'].inputTokens).toBe(7)
  })

  it('没有声明模型时落到兜底模型', () => {
    const days = collect(messageLine(TIME, { inputTokens: 5 }))
    expect(days[dayKey(TIME)][DSH_DEFAULT_MODEL].inputTokens).toBe(5)
  })

  it('坏行、无关事件、缺 usage、时间非法都只丢那一条', () => {
    const days = collect(
      '{坏掉的 JSON',
      JSON.stringify({ type: 'session', version: 3, id: 'x' }),
      messageLine(TIME, { inputTokens: 5 }),
      // 没有 usage 的 assistant 事件
      JSON.stringify({ type: 'assistant/message', seq: 20, time: TIME, data: { step: 2 } }),
      // 时间拿不到日期
      JSON.stringify({ type: 'assistant/message', time: 'oops', data: { usage: { inputTokens: 999 } } })
    )

    const models = days[dayKey(TIME)]
    expect(Object.keys(days)).toEqual([dayKey(TIME)])
    expect(models[DSH_DEFAULT_MODEL].inputTokens).toBe(5)
    expect(models[DSH_DEFAULT_MODEL].requests).toBe(1)
  })

  it('负数与非数字的计数归零，不把坏数据带进快照', () => {
    const days = collect(messageLine(TIME, { inputTokens: -5, outputTokens: Number.NaN }))
    expect(days[dayKey(TIME)][DSH_DEFAULT_MODEL]).toEqual({ ...emptyCounters(), requests: 1 })
  })

  it('空文本不出任何天', () => {
    expect(collect('')).toEqual({})
  })
})
