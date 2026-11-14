/**
 * 遮罩工具条的摆位纯逻辑。
 *
 * `autoToolbarPosition` 是「贴选区右下角」的默认摆法（画布像素空间，与选区同一套坐标）；
 * `clampToolbarPosition` 是拖动把手之后把落点夹回边界内 —— 两个函数只认数字，
 * 坐标空间由调用方给定（后者喂的是视口 CSS 像素，见 CaptureApp 的拖动一段）。
 */

import type { Point, Rect, Size } from './rect'

/**
 * 工具条的默认落点（画布像素，返回左上角）。
 *
 * 优先贴选区下方；下面放不下翻到上面；上下都放不下就压进选区底部；横向贴选区的
 * **右边缘**（与 Snipaste 一致），两端都夹回画布内。`size` 与 `gap` 按画布像素给 ——
 * 量到的是 CSS 像素时先乘屏幕缩放，不然「贴右边缘」会差出 (1/缩放 - 1) 个工具条宽度
 * （踩过：右边戳出去一截）。
 */
export function autoToolbarPosition(rect: Rect, size: Size, canvas: Size, gap: number): Point {
  // 优先贴选区下方；下面放不下翻到上面；上下都放不下就压进选区底部
  let top = rect.y + rect.height + gap
  if (top + size.height > canvas.height)
    top = rect.y - size.height - gap
  if (top < 0)
    top = Math.min(rect.y + rect.height - size.height - gap, canvas.height - size.height - gap)
  top = Math.max(gap, top)

  const right = rect.x + rect.width - size.width
  const left = Math.min(Math.max(right, gap), Math.max(gap, canvas.width - size.width - gap))
  return { x: left, y: top }
}

/**
 * 拖动落点夹回边界内：左上角离每条边至少 `margin`。
 *
 * 边界比工具条还小时退到 `margin` 那一点、不倒挂（超出就超出），与默认摆位横向那道
 * 夹法同一口径。
 */
export function clampToolbarPosition(at: Point, size: Size, bounds: Size, margin: number): Point {
  const maxX = Math.max(margin, bounds.width - size.width - margin)
  const maxY = Math.max(margin, bounds.height - size.height - margin)
  return {
    x: Math.min(Math.max(at.x, margin), maxX),
    y: Math.min(Math.max(at.y, margin), maxY),
  }
}
