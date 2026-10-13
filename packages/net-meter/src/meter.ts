/**
 * 网速换算：两次累计计数 → 速率 → 显示用的数字与单位。
 *
 * 三件事都在这儿，因为它们都有「踩过一次才知道」的边界：
 *
 *  - `rateOf` —— 计数器回绕 / 网卡被拔 / 定时器被节流，三种都会算出离谱的数；
 *  - `smoothRate` —— 一秒一跳的数字看着像坏了，指数滑动平均压掉毛刺；
 *  - `formatSpeed` —— 1024 进制进位，且**进位要在四舍五入之后再看一眼**，
 *    否则 1023.96K 会显示成「1024K」而不是「1.0M」。
 *
 * 采样间隔的两条界：小于 `MIN_INTERVAL_MS` 说明是重复触发（别把同一段算两遍），
 * 大于 `MAX_INTERVAL_MS` 说明中间被节流或系统挂起了 —— 那一段的**平均值**不是一个
 * 「当前速度」，宁可整帧丢掉、保留上一次读数（见 mail.md：窗口被遮住时 WebView 的定时器会被节流）。
 */

import type { NetCounters } from './wire'

/** 两次采样之间算出来的速率（字节/秒） */
export interface NetRate {
  down: number
  up: number
}

/** 采样间隔的下界：短于它就当这次触发是多余的 */
export const MIN_INTERVAL_MS = 200
/** 采样间隔的上界：长于它说明中间被节流 / 挂起了，这一段不算 */
export const MAX_INTERVAL_MS = 5000
/** 球每秒问一次宿主 */
export const SAMPLE_INTERVAL_MS = 1000

const IDLE: NetRate = { down: 0, up: 0 }

/**
 * 两次采样之间这一段的速率。
 *
 * 返回 `null` 表示**这一次不更新**（间隔不合理、或者这是第一帧），调用方保留上一次读数。
 * 计数器倒着走（网卡被拔掉、计数器重置）不当作错误：按 0 算，下一帧就恢复了 ——
 * 报一个负的速率或者一个几 GB 的尖峰都比「先显示 0」难看得多。
 */
export function rateOf(
  previous: NetCounters | null,
  current: NetCounters,
  elapsedMs: number,
): NetRate | null {
  if (!previous)
    return null
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_INTERVAL_MS || elapsedMs > MAX_INTERVAL_MS)
    return null

  const seconds = elapsedMs / 1000
  return {
    down: Math.max(0, current.inOctets - previous.inOctets) / seconds,
    up: Math.max(0, current.outOctets - previous.outOctets) / seconds,
  }
}

/**
 * 指数滑动平均：新值占 `weight`。
 *
 * 0.5 是「跟着走、但不抖」的那一档：一秒一次刷新时，一次毛刺只影响一半，
 * 而真实的变化两三秒内就能到位。`previous` 为 null（第一帧）时直接取新值。
 */
export function smoothRate(previous: NetRate | null, next: NetRate, weight = 0.5): NetRate {
  if (!previous)
    return next
  const ratio = Math.min(1, Math.max(0, weight))
  return {
    down: previous.down * (1 - ratio) + next.down * ratio,
    up: previous.up * (1 - ratio) + next.up * ratio,
  }
}

/** 显示用的数字与单位分开给：单位要画得比数字小、还淡一档（见 float-ball.md） */
export interface SpeedParts {
  value: string
  unit: string
}

const UNITS = ['B', 'K', 'M', 'G'] as const

/**
 * 字节/秒 → `{ value, unit }`，1024 进制。
 *
 * 小数位：不到 10 留一位（1.2M 比 1M 有信息量），10 以上取整（三位数字在小球里已经够挤）。
 * 进位在取整之后复查一遍：1023.96K 取整成 1024 时换成 1.0M，否则球里会出现「1024K」这种读法。
 */
export function formatSpeed(bytesPerSec: number): SpeedParts {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0)
    return { value: '0', unit: UNITS[0] }

  let index = 0
  let value = bytesPerSec
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024
    index += 1
  }

  let text = format(value)
  // 取整之后可能刚好顶到 1024（1023.96K → 1024K）：往上进一位
  if (Number(text) >= 1024 && index < UNITS.length - 1) {
    value /= 1024
    index += 1
    text = format(value)
  }

  return { value: text, unit: UNITS[index] }
}

function format(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

/**
 * 速率占链路带宽的比例（0~1），用来画弧。
 *
 * 链路速率是 bit/s，速率是字节/s，先折成同一口径再比。取不到链路速率（虚拟网卡常见）
 * 时返回 `null` —— 这时**不画弧**，而不是画一段假的。
 */
export function linkRatio(bytesPerSec: number, linkBitsPerSec: number): number | null {
  if (!Number.isFinite(linkBitsPerSec) || linkBitsPerSec <= 0)
    return null
  const ceiling = linkBitsPerSec / 8
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0)
    return 0
  return Math.min(1, bytesPerSec / ceiling)
}

/** 上行 + 下行的合计速率（收起态那条竖条按它算高度） */
export function totalRate(rate: NetRate): number {
  return rate.down + rate.up
}

/**
 * 上下行在合计里各占多少（0~1），给收起态那条双色竖条分色用。
 * 两边都是 0（静止）时返回对半 —— 条本来也不显示，这个值只是为了不出现 NaN。
 */
export function directionShare(rate: NetRate): { down: number, up: number } {
  const total = totalRate(rate)
  if (total <= 0)
    return { down: 0.5, up: 0.5 }
  return { down: rate.down / total, up: rate.up / total }
}

/** 一帧都没测到时的空读数（静止态） */
export function idleRate(): NetRate {
  return { ...IDLE }
}

/** 这个读数算不算「有流量」：收起态的点亮与呼吸按它判 */
export function isBusy(rate: NetRate, threshold = 20 * 1024): boolean {
  return totalRate(rate) >= threshold
}
