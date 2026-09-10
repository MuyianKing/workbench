/**
 * 终端日志面板的「贴底」判定。
 *
 * 单独抽出来是因为这里的逻辑出过问题：原实现每帧无脑 `scrollTop = scrollHeight`，
 * 于是用户往上翻着看编译报错时，会被下一帧硬拽回底部 —— 而且每帧读 scrollHeight
 * 都是一次强制同步布局。改成「只在贴底时跟随」以后，这个判定就成了行为核心，
 * 值得脱离 DOM 单独测。
 */

/**
 * 距底部多少像素以内算「贴底」。
 *
 * 不能取 0：亚像素布局、字体度量取整都会让滚动到底后的
 * `scrollHeight - scrollTop - clientHeight` 停在 0.5~1 之间；
 * 40px 也留出了「隐约想跟随时手指抖一下」的余量。
 */
export const SCROLL_PIN_THRESHOLD_PX = 40

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** 视口底部距内容底部的距离（已夹到非负） */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

/**
 * 用户当前是否停在底部。
 *
 * 内容还没撑满容器（scrollHeight <= clientHeight）时恒为 true：
 * 此时没有可滚动的余地，新日志理应直接跟到底。
 */
export function isPinnedToBottom(metrics: ScrollMetrics): boolean {
  return distanceFromBottom(metrics) <= SCROLL_PIN_THRESHOLD_PX
}
