/**
 * 选区与矩形的纯几何。
 *
 * 坐标一律是**画布像素**：遮罩窗口的画布 backing store 就是那块屏的物理像素，
 * 与截下来的 PNG 一一对应（见 coords.ts 的文件头）。屏幕缩放、DPI 换算是另一层的事，
 * 这里只认整数格子的加减乘除。
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 两个拖拽端点 → 规范化矩形。
 * 往哪个方向拖都成立：从右下往左上拖出来的是同一个矩形。
 */
export function fromDrag(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

/**
 * 宽 / 高为负的矩形 → 正常矩形。
 *
 * 拖把手越过对边时中间态就是负的（与 Snipaste 一样允许翻转），翻转归这里收；
 * 负值一旦漏进裁剪逻辑，取出来的是一块空图。
 */
export function normalizeRect(rect: Rect): Rect {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x
  const y = rect.height < 0 ? rect.y + rect.height : rect.y
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) }
}

/**
 * 夹回边界内：四条边都不许出画布。出界的那部分没有像素可截，留着只会在导出时露白。
 *
 * 先归一化再夹：调用方可能在拖拽中途把负宽度的中间态递进来。
 */
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const value = normalizeRect(rect)
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height

  const left = clamp(value.x, bounds.x, right)
  const top = clamp(value.y, bounds.y, bottom)
  // 右 / 下两条边不能越过左 / 上：越界时收成零宽（而不是负矩形倒回来）
  return {
    x: left,
    y: top,
    width: clamp(value.x + value.width, left, right) - left,
    height: clamp(value.y + value.height, top, bottom) - top,
  }
}

/** 点在不在矩形里（含边界） */
export function rectContains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
}

/** 两个矩形都包进去的最小矩形 */
export function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 四周各放 `padding`（负数 = 缩进去） */
export function growRect(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  }
}

/** 这个选区值不值得截：小于 minSize 的按「还没选」处理 */
export function rectIsEmpty(rect: Rect, minSize = 1): boolean {
  return rect.width < minSize || rect.height < minSize
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** 尺寸标签，如 `1024 × 768`（界面上的实时尺寸读数） */
export function rectSizeText(rect: Rect): string {
  return `${Math.round(rect.width)} × ${Math.round(rect.height)}`
}

/** 坐标标签，如 `(1024, 768)` */
export function rectOriginText(rect: Rect): string {
  return `(${Math.round(rect.x)}, ${Math.round(rect.y)})`
}
