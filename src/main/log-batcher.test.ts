import { describe, expect, it, vi } from 'vitest'
import { LOG_FLUSH_INTERVAL_MS, LogBatcher } from './log-batcher'
import type { ProcessLogEvent } from '../shared/types'

function line(text: string, terminal = 'p1::start'): ProcessLogEvent {
  return { terminal, projectId: 'p1', stream: 'out', text, time: '10:00:00' }
}

describe('LogBatcher', () => {
  it('未开窗时逐行直发，保持原有顺序', () => {
    const seen: ProcessLogEvent[][] = []
    const batcher = new LogBatcher((events) => seen.push(events))

    batcher.push(line('a'))
    batcher.push(line('b'))

    expect(seen.map((batch) => batch.map((e) => e.text))).toEqual([['a'], ['b']])
  })

  it('开窗后攒到窗口到点才整批交出去', () => {
    vi.useFakeTimers()
    try {
      const seen: ProcessLogEvent[][] = []
      const batcher = new LogBatcher((events) => seen.push(events))
      batcher.start()

      batcher.push(line('a'))
      batcher.push(line('b'))
      batcher.push(line('c'))
      // 窗口没到，一次 IPC 都还没发生
      expect(seen).toHaveLength(0)

      vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS)
      expect(seen).toHaveLength(1)
      expect(seen[0].map((e) => e.text)).toEqual(['a', 'b', 'c'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('一整窗的写入只排一个定时器，窗口到点后下一批重新计时', () => {
    vi.useFakeTimers()
    try {
      const seen: ProcessLogEvent[][] = []
      const batcher = new LogBatcher((events) => seen.push(events))
      batcher.start()

      for (let i = 0; i < 500; i += 1) batcher.push(line(`l${i}`))
      vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toHaveLength(500)

      batcher.push(line('next'))
      vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS)
      expect(seen).toHaveLength(2)
      expect(seen[1].map((e) => e.text)).toEqual(['next'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 会停掉定时器并立刻排空队列', () => {
    vi.useFakeTimers()
    try {
      const seen: ProcessLogEvent[][] = []
      const batcher = new LogBatcher((events) => seen.push(events))
      batcher.start()
      batcher.push(line('tail'))

      batcher.dispose()
      expect(seen.map((batch) => batch.map((e) => e.text))).toEqual([['tail']])

      // 排空后不该再有迟到的批次
      vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS * 4)
      expect(seen).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushBefore 保证待发日志排在动作之前（清屏顺序）', () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      const batcher = new LogBatcher((events) => order.push(`log:${events[0].text}`))
      batcher.start()

      batcher.push(line('上一轮的尾巴'))
      batcher.flushBefore(() => order.push('clear'))

      expect(order).toEqual(['log:上一轮的尾巴', 'clear'])

      // 动作之后进来的日志仍然照常攒批
      batcher.push(line('新一轮第一行'))
      vi.advanceTimersByTime(LOG_FLUSH_INTERVAL_MS)
      expect(order).toEqual(['log:上一轮的尾巴', 'clear', 'log:新一轮第一行'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('空队列不触发回调', () => {
    const emit = vi.fn()
    const batcher = new LogBatcher(emit)

    batcher.flush()
    expect(emit).not.toHaveBeenCalled()
  })
})
