import { describe, expect, it } from 'vitest'
import { SCROLL_PIN_THRESHOLD_PX, distanceFromBottom, isPinnedToBottom } from './log-scroll'

const metrics = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({
  scrollTop,
  scrollHeight,
  clientHeight
})

describe('distanceFromBottom', () => {
  it('滚到底时为 0', () => {
    expect(distanceFromBottom(metrics(900, 1000, 100))).toBe(0)
  })

  it('被过度滚动（橡皮筋）夹到 0，不出现负数', () => {
    expect(distanceFromBottom(metrics(950, 1000, 100))).toBe(0)
  })

  it('往上翻时等于剩余内容高度', () => {
    expect(distanceFromBottom(metrics(400, 1000, 100))).toBe(500)
  })
})

describe('isPinnedToBottom', () => {
  it('正好贴底算贴底', () => {
    expect(isPinnedToBottom(metrics(900, 1000, 100))).toBe(true)
  })

  it('亚像素误差仍算贴底', () => {
    expect(isPinnedToBottom(metrics(899.5, 1000, 100))).toBe(true)
  })

  it('阈值边界内算贴底，超出不算', () => {
    const limit = metrics(900 - SCROLL_PIN_THRESHOLD_PX, 1000, 100)
    expect(isPinnedToBottom(limit)).toBe(true)
    expect(isPinnedToBottom(metrics(900 - SCROLL_PIN_THRESHOLD_PX - 1, 1000, 100))).toBe(false)
  })

  it('内容没撑满容器时算贴底（此时没有可滚动余地）', () => {
    expect(isPinnedToBottom(metrics(0, 60, 100))).toBe(true)
  })

  it('用户往上翻看报错时不算贴底，不该被拽回底部', () => {
    expect(isPinnedToBottom(metrics(0, 5000, 100))).toBe(false)
  })
})
