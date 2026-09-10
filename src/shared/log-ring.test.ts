import { describe, expect, it } from 'vitest'
import { RingLog } from './log-ring'

describe('RingLog', () => {
  it('没写满时按写入顺序导出', () => {
    const ring = new RingLog<number>(4)
    ring.pushMany([1, 2, 3])

    expect(ring.size).toBe(3)
    expect(ring.dropped).toBe(0)
    expect(ring.toArray()).toEqual([1, 2, 3])
    expect(ring.last()).toBe(3)
  })

  it('写满后覆盖最旧的一条，顺序不乱', () => {
    const ring = new RingLog<number>(3)
    ring.pushMany([1, 2, 3, 4, 5])

    expect(ring.size).toBe(3)
    expect(ring.dropped).toBe(2)
    expect(ring.toArray()).toEqual([3, 4, 5])
    expect(ring.last()).toBe(5)
  })

  it('绕多圈后依然按时间序导出', () => {
    const ring = new RingLog<number>(3)
    for (let i = 1; i <= 10; i += 1) ring.push(i)

    expect(ring.toArray()).toEqual([8, 9, 10])
    expect(ring.dropped).toBe(7)
  })

  it('刚好写满一圈时不当作已覆盖', () => {
    const ring = new RingLog<number>(3)
    ring.pushMany([1, 2, 3])

    expect(ring.toArray()).toEqual([1, 2, 3])
    expect(ring.dropped).toBe(0)
  })

  it('tail 只取尾部 n 条', () => {
    const ring = new RingLog<number>(4)
    ring.pushMany([1, 2, 3, 4, 5, 6])

    expect(ring.tail(2)).toEqual([5, 6])
    expect(ring.tail(0)).toEqual([])
    expect(ring.tail(-1)).toEqual([])
    // n 超过现有条数时退化成全量
    expect(ring.tail(99)).toEqual([3, 4, 5, 6])
  })

  it('clear 之后容量还在，可以继续写', () => {
    const ring = new RingLog<number>(2)
    ring.pushMany([1, 2, 3])
    ring.clear()

    expect(ring.size).toBe(0)
    expect(ring.dropped).toBe(0)
    expect(ring.toArray()).toEqual([])
    expect(ring.last()).toBeUndefined()

    ring.push(9)
    expect(ring.toArray()).toEqual([9])
  })

  it('容量必须是正整数', () => {
    expect(() => new RingLog<number>(0)).toThrow()
    expect(() => new RingLog<number>(-1)).toThrow()
    expect(() => new RingLog<number>(1.5)).toThrow()
  })
})
