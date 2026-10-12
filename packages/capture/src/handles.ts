/**
 * 选区的八个把手：位置、命中、拖动重算。
 *
 * 形状与手感照 Snipaste：角上四个、四条边各一个中点，拖过对边可以翻转
 * （翻转交给 rect.ts 的 normalizeRect，这里只负责把位移落到正确的边上）。
 */
import type { Point, Rect } from './rect'
import { normalizeRect } from './rect'

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** 画与判定的顺序：命中判定按这个顺序找最近的一个，所以边在角后面（角优先） */
export const HANDLE_IDS: HandleId[] = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']

/** 把手的中心点：角取角、边取中点 */
export function handlePoint(rect: Rect, id: HandleId): Point {
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  return {
    x: id.includes('w') ? rect.x : id.includes('e') ? rect.x + rect.width : centerX,
    y: id.includes('n') ? rect.y : id.includes('s') ? rect.y + rect.height : centerY,
  }
}

/**
 * 命中哪个把手：容差内取**最近**的那个。
 *
 * 不能按顺序碰第一个就返回 —— 选区很小时八个把手挤在一起，先判到的那个未必是用户瞄准的那个。
 */
export function hitHandle(rect: Rect, point: Point, tolerance: number): HandleId | null {
  let best: HandleId | null = null
  let bestDistance = tolerance

  for (const id of HANDLE_IDS) {
    const center = handlePoint(rect, id)
    const distance = Math.hypot(center.x - point.x, center.y - point.y)
    if (distance <= bestDistance) {
      best = id
      bestDistance = distance
    }
  }

  return best
}

/** 拖某个把手 → 新选区：位移只落到这个把手负责的那条（那两条）边上 */
export function resizeByHandle(rect: Rect, id: HandleId, delta: Point): Rect {
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.width
  let bottom = rect.y + rect.height

  if (id.includes('w'))
    left += delta.x
  if (id.includes('e'))
    right += delta.x
  if (id.includes('n'))
    top += delta.y
  if (id.includes('s'))
    bottom += delta.y

  return normalizeRect({ x: left, y: top, width: right - left, height: bottom - top })
}

/** 把手的鼠标指针形状 */
export function handleCursor(id: HandleId): string {
  switch (id) {
    case 'nw':
    case 'se':
      return 'nwse-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'n':
    case 's':
      return 'ns-resize'
    default:
      return 'ew-resize'
  }
}
