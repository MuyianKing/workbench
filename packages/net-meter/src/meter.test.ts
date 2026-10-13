import type { NetCounters } from './wire'
import { describe, expect, it } from 'vitest'
import {
  directionShare,
  formatSpeed,
  isBusy,
  linkRatio,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  rateOf,
  smoothRate,
  totalRate,
} from './meter'

function counters(inOctets: number, outOctets: number, downLink = 0, upLink = 0): NetCounters {
  return { inOctets, outOctets, downLink, upLink, interfaces: 1 }
}

describe('rateOf', () => {
  it('一秒涨了多少字节就是多少字节每秒', () => {
    const rate = rateOf(counters(0, 0), counters(1024, 512), 1000)
    expect(rate).toEqual({ down: 1024, up: 512 })
  })

  it('按真实间隔折算，不假设正好一秒', () => {
    // 半秒涨 500 字节 → 1000 B/s
    expect(rateOf(counters(0, 0), counters(500, 250), 500)).toEqual({ down: 1000, up: 500 })
    // 两秒涨 4000 字节 → 2000 B/s
    expect(rateOf(counters(0, 0), counters(4000, 0), 2000)).toEqual({ down: 2000, up: 0 })
  })

  it('第一帧没有前值，不更新', () => {
    expect(rateOf(null, counters(999, 999), 1000)).toBeNull()
  })

  it('间隔太短当重复触发', () => {
    expect(rateOf(counters(0, 0), counters(100, 0), MIN_INTERVAL_MS - 1)).toBeNull()
  })

  it('间隔太长（被节流 / 挂起）整帧丢掉', () => {
    // 五分钟里涨了 300MB：平均值不是「当前速度」，宁可不更新
    expect(rateOf(counters(0, 0), counters(300 * 1024 * 1024, 0), 5 * 60 * 1000)).toBeNull()
    expect(rateOf(counters(0, 0), counters(1000, 0), MAX_INTERVAL_MS + 1)).toBeNull()
  })

  it('间隔为零或负数不算', () => {
    expect(rateOf(counters(0, 0), counters(100, 0), 0)).toBeNull()
    expect(rateOf(counters(0, 0), counters(100, 0), -50)).toBeNull()
  })

  it('计数器倒着走按 0 算，不报负速率也不报尖峰', () => {
    // 网卡被拔掉：合计一下子掉下去
    const rate = rateOf(counters(5_000_000, 900_000), counters(1000, 500), 1000)
    expect(rate).toEqual({ down: 0, up: 0 })
  })

  it('累计计数过了 2^32 也照常算（64 位计数器的意义）', () => {
    const before = counters(2 ** 32 - 100, 0)
    const after = counters(2 ** 32 + 924, 0)
    expect(rateOf(before, after, 1000)).toEqual({ down: 1024, up: 0 })
  })
})

describe('smoothRate', () => {
  it('第一帧直接取新值', () => {
    expect(smoothRate(null, { down: 100, up: 50 })).toEqual({ down: 100, up: 50 })
  })

  it('一半权重：一次毛刺只影响一半', () => {
    const smoothed = smoothRate({ down: 100, up: 0 }, { down: 300, up: 100 }, 0.5)
    expect(smoothed).toEqual({ down: 200, up: 50 })
  })

  it('持续同一个值时收敛到它', () => {
    let rate = { down: 0, up: 0 }
    // 半衰期一秒：十几轮之后就只差最后一格了
    for (let i = 0; i < 20; i += 1)
      rate = smoothRate(rate, { down: 1000, up: 200 }, 0.5)
    expect(rate.down).toBeCloseTo(1000, 0)
    expect(rate.up).toBeCloseTo(200, 0)
  })

  it('权重被夹在 0~1 之间', () => {
    expect(smoothRate({ down: 0, up: 0 }, { down: 100, up: 100 }, 5)).toEqual({ down: 100, up: 100 })
    expect(smoothRate({ down: 0, up: 0 }, { down: 100, up: 100 }, -1)).toEqual({ down: 0, up: 0 })
  })
})

describe('formatSpeed', () => {
  it('不到 10 留一位小数', () => {
    expect(formatSpeed(1.23 * 1024 * 1024)).toEqual({ value: '1.2', unit: 'M' })
    expect(formatSpeed(1234)).toEqual({ value: '1.2', unit: 'K' })
  })

  it('10 以上取整', () => {
    expect(formatSpeed(340 * 1024)).toEqual({ value: '340', unit: 'K' })
    expect(formatSpeed(12.6 * 1024 * 1024)).toEqual({ value: '13', unit: 'M' })
  })

  it('零与非法值都是 0 B', () => {
    expect(formatSpeed(0)).toEqual({ value: '0', unit: 'B' })
    expect(formatSpeed(-5)).toEqual({ value: '0', unit: 'B' })
    expect(formatSpeed(Number.NaN)).toEqual({ value: '0', unit: 'B' })
  })

  it('字节与千字节的边界', () => {
    expect(formatSpeed(999)).toEqual({ value: '999', unit: 'B' })
    // 还不到 1024 就老实待在字节里
    expect(formatSpeed(1023)).toEqual({ value: '1023', unit: 'B' })
    expect(formatSpeed(1024)).toEqual({ value: '1.0', unit: 'K' })
  })

  it('取整之后顶到 1024 要往上进一位', () => {
    // 1023.96K 取整成 1024K 就难看了，应该是 1.0M
    expect(formatSpeed(1023.96 * 1024)).toEqual({ value: '1.0', unit: 'M' })
    // 同上，M 到 G
    expect(formatSpeed(1023.99 * 1024 * 1024)).toEqual({ value: '1.0', unit: 'G' })
  })

  it('最大的单位不再往上进', () => {
    expect(formatSpeed(5000 * 1024 ** 3)).toEqual({ value: '5000', unit: 'G' })
  })

  it('贴边那一档的常见读数', () => {
    expect(formatSpeed(4.2 * 1024 * 1024)).toEqual({ value: '4.2', unit: 'M' })
    expect(formatSpeed(1.1 * 1024 * 1024)).toEqual({ value: '1.1', unit: 'M' })
    expect(formatSpeed(64 * 1024)).toEqual({ value: '64', unit: 'K' })
  })
})

describe('linkRatio', () => {
  it('字节与比特先折成同一口径', () => {
    // 100Mbps = 12.5MB/s；跑到 6.25MB/s 就是一半
    expect(linkRatio(6.25 * 1024 * 1024, 100_000_000)).toBeCloseTo(0.524, 2)
  })

  it('超过链路带宽也夹在 1', () => {
    expect(linkRatio(100 * 1024 * 1024, 100_000_000)).toBe(1)
  })

  it('取不到链路速率时返回 null（不画弧）', () => {
    expect(linkRatio(1024, 0)).toBeNull()
    expect(linkRatio(1024, Number.NaN)).toBeNull()
  })

  it('没流量时是 0', () => {
    expect(linkRatio(0, 100_000_000)).toBe(0)
  })
})

describe('合计与方向占比', () => {
  it('合计是上下行相加', () => {
    expect(totalRate({ down: 300, up: 100 })).toBe(400)
  })

  it('双色竖条按上下行的份分', () => {
    const share = directionShare({ down: 300, up: 100 })
    expect(share.down).toBeCloseTo(0.75)
    expect(share.up).toBeCloseTo(0.25)
  })

  it('静止时对半分，不出现 NaN', () => {
    expect(directionShare({ down: 0, up: 0 })).toEqual({ down: 0.5, up: 0.5 })
  })

  it('有流量的判据', () => {
    expect(isBusy({ down: 0, up: 0 })).toBe(false)
    expect(isBusy({ down: 10 * 1024, up: 0 })).toBe(false)
    expect(isBusy({ down: 30 * 1024, up: 0 })).toBe(true)
  })
})
