/**
 * 坐标换算。
 *
 * 三层坐标，写清楚免得混：
 *  1. **虚拟桌面物理坐标**：以主屏左上角为原点，多屏合成一张大桌面。Rust 侧抓屏、
 *     摆遮罩窗口用的都是它（PHYSICAL 就是它）。
 *  2. **画布像素**：某一块屏自己的坐标，原点在该屏左上角，单位是物理像素 ——
 *     遮罩窗口的画布 backing store 就是这块屏的物理像素，与截下来的那张 PNG 一一对应。
 *  3. **视口坐标**：WebView 里的 CSS 像素（`clientX/Y`、`getBoundingClientRect`）。
 *     窗口被系统缩放时它比物理像素小（`scale` 倍）。
 *
 * 第 2 ↔ 3 层之间不要用 devicePixelRatio 换算：跨屏拖动时它会在中途变，而画布的
 * CSS 尺寸与 backing store 的比例才是真正决定「鼠标落在哪个像素格子」的那个比值。
 */

import type { Point, Rect, Size } from './rect'

/** 一块屏在虚拟桌面里的位置与缩放（与 Rust 侧 available_monitors 给的物理值同源） */
export interface MonitorGeometry {
  /** 在这场会话里的序号（窗口标签 capture-<index> 就是它） */
  index: number
  /** 显示器名（界面上给用户看的） */
  name: string
  x: number
  y: number
  width: number
  height: number
  scale: number
}

/** 元素在视口里的位置与尺寸（getBoundingClientRect 的那几个字段） */
export interface ViewportBox {
  left: number
  top: number
  width: number
  height: number
}

/** 画布元素的像素尺寸（backing store，不是 CSS 尺寸） */
export type CanvasSize = Size

/**
 * 视口坐标 → 画布像素。
 *
 * 比例取 `canvas.width / box.width`：它把「CSS 像素 → 物理像素」这件事一次算清，
 * 不依赖 devicePixelRatio，也不怕窗口被挪到另一块缩放的屏上。
 */
export function viewportToCanvas(client: Point, box: ViewportBox, canvas: CanvasSize): Point {
  const scaleX = box.width > 0 ? canvas.width / box.width : 1
  const scaleY = box.height > 0 ? canvas.height / box.height : 1
  return {
    x: (client.x - box.left) * scaleX,
    y: (client.y - box.top) * scaleY,
  }
}

/** 画布像素 → 视口坐标（工具条、尺寸标签摆位用）：用上面同一个比例做除法，两边严格互逆 */
export function canvasToViewport(point: Point, box: ViewportBox, canvas: CanvasSize): Point {
  const scaleX = box.width > 0 ? canvas.width / box.width : 1
  const scaleY = box.height > 0 ? canvas.height / box.height : 1
  return {
    x: box.left + point.x / scaleX,
    y: box.top + point.y / scaleY,
  }
}

/** 所有屏都包进去的那个矩形（虚拟桌面），物理坐标 */
export function virtualBounds(monitors: MonitorGeometry[]): Rect {
  if (!monitors.length)
    return { x: 0, y: 0, width: 0, height: 0 }

  const left = Math.min(...monitors.map(item => item.x))
  const top = Math.min(...monitors.map(item => item.y))
  const right = Math.max(...monitors.map(item => item.x + item.width))
  const bottom = Math.max(...monitors.map(item => item.y + item.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 虚拟桌面物理坐标落在哪块屏上（都不在时回那块屏都没有的 null） */
export function monitorAt(monitors: MonitorGeometry[], point: Point): MonitorGeometry | null {
  // 边界重叠时取包含它的第一块：多屏可以镜像，也可以故意排成重叠的样子
  return monitors.find(
    item => point.x >= item.x && point.x < item.x + item.width
      && point.y >= item.y && point.y < item.y + item.height,
  ) ?? null
}
