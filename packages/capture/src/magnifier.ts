/**
 * 放大镜的取样几何。
 *
 * 放大镜是一块正方形画布（`side`），把光标周围 `zoom` 倍放大。两个约定：
 *  - **一格源像素占多少画布像素**是 `side / 格数`，不是 `zoom` —— 格数要取整，
 *    否则画出来会看到半格的像素缝（`side / zoom` 往往除不尽）。
 *  - 网格与光标格子都按这个格宽画，所以放大镜里的格子与真实像素永远一对一。
 */
import type { Point, Rect } from './rect'

export interface MagnifierView {
  /** 要取源图的那一块（整数像素）。可能超出图片边界 —— 边缘处露出空白，正是欠采样应有的样子 */
  source: Rect
  /** 一格源像素在放大镜画布里的边长 */
  cell: number
  /** 光标所在那一格在放大镜画布里的矩形（高亮框画它） */
  cursorCell: Rect
  /** 横竖各多少格 */
  cells: number
}

/**
 * 光标 → 放大镜的取样几何。
 *
 * 光标像素摆正中央：格数是奇数时中央那格就是它，偶数时落在中心的右侧 / 下侧那一格
 * （与 `floor(cells / 2)` 的偏移一致），不会随光标移动来回跳。
 */
export function magnifierView(cursor: Point, zoom: number, side: number): MagnifierView {
  const safeZoom = zoom > 0 ? zoom : 1
  const cells = Math.max(1, Math.round(side / safeZoom))
  const cell = side / cells

  const pixel = { x: Math.floor(cursor.x), y: Math.floor(cursor.y) }
  const half = Math.floor(cells / 2)
  const source: Rect = {
    x: pixel.x - half,
    y: pixel.y - half,
    width: cells,
    height: cells,
  }

  return {
    source,
    cell,
    cells,
    cursorCell: {
      x: (pixel.x - source.x) * cell,
      y: (pixel.y - source.y) * cell,
      width: cell,
      height: cell,
    },
  }
}
