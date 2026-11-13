/**
 * 刻度环表盘的几何：一圈 48 格刻度，点亮多少格、哪几格算下行。
 *
 * 放在域包里而不是组件里，是因为它有两处**必须一致**的地方：
 *
 *  - 刻度环的半径与格数要与设计稿对齐（48 格、从 12 点起顺时针）——
 *    起点错了就是「亮起来的那一段从 3 点钟开始」；
 *  - 「点亮多少格」这条口径只写一次：总吞吐占链路带宽的比例，
 *    组件与用例都从这里取，免得两边各算一遍。
 *
 * 坐标系与 SVG 一致：0° 在 3 点钟方向，角度顺时针增大（y 轴朝下）。
 *
 * 窗口尺寸（收起 / 展开）只由 Rust 的 `ball.rs` 定，这里不重复一份 ——
 * 表盘的 viewBox 边长等于展开态的球径。
 */
/** 表盘坐标系（viewBox 的边长，等于展开态的球径） */
export const DIAL_BOX = 76
/** 刻度环的格数 */
export const TICK_COUNT = 48
/** 刻度内端所在的半径 */
export const TICK_RADIUS = 29
/** 刻度有多长（从 TICK_RADIUS 往外量） */
export const TICK_LENGTH = 4.4

/** 一格刻度：两端坐标 + 亮没亮（亮的话是下行那一段还是上行那一段） */
export interface TickMark {
  x1: number
  y1: number
  x2: number
  y2: number
  state: 'off' | 'down' | 'up'
}

/**
 * 算一圈刻度。
 *
 * - `totalRatio`：总吞吐占链路带宽的比例（0~1）。取不到链路带宽时传 `null` ——
 *   这时**一格都不亮**（整圈留成一条暗轨道），而不是随便亮一段假的。
 * - `downShare`：点亮的那一段里，下行的份（0~1）。上半圈绿、下半圈橙就是这么分的。
 *
 * 点亮多少格 = `round(TICK_COUNT * totalRatio)`：凑不满半格就是 0，
 * 宁可让它看起来「没动静」，也不要为了好看虚报一格。
 */
export function tickMarks(totalRatio: number | null, downShare: number): TickMark[] {
  const ratio = totalRatio === null ? 0 : Math.min(1, Math.max(0, totalRatio))
  const lit = Math.round(TICK_COUNT * ratio)
  const share = Math.min(1, Math.max(0, downShare))
  const downTicks = Math.round(lit * share)
  const center = DIAL_BOX / 2

  const marks: TickMark[] = []
  for (let index = 0; index < TICK_COUNT; index += 1) {
    // 第 0 格在 12 点（-90°），顺时针排
    const deg = -90 + (360 / TICK_COUNT) * index
    const inner = polar(center, center, TICK_RADIUS, deg)
    const outer = polar(center, center, TICK_RADIUS + TICK_LENGTH, deg)
    const state: TickMark['state'] = index >= lit ? 'off' : index < downTicks ? 'down' : 'up'
    marks.push({
      x1: round(inner.x),
      y1: round(inner.y),
      x2: round(outer.x),
      y2: round(outer.y),
      state,
    })
  }
  return marks
}

function polar(cx: number, cy: number, r: number, deg: number): { x: number, y: number } {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** 亮了几格（用例与调试看这个，别去数 DOM） */
export function litCount(marks: TickMark[]): number {
  return marks.filter(mark => mark.state !== 'off').length
}
