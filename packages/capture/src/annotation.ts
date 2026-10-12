/**
 * 标注对象模型：形状、包围盒、命中判定、整体位移。
 *
 * 坐标都是**画布像素**（见 coords.ts 的文件头）。这里只管几何，不管怎么画 ——
 * 画在渲染层的两块画布上（见 components/capture 的 AnnotationLayer）。
 *
 * 命中判定的口径（与 Snipaste 的手感对齐，也是最好用的那一套）：
 *  矩形 / 椭圆 / 马赛克 / 文字 → 落在包围盒里就算命中（它们是「面」）；
 *  箭头 / 画笔 / 荧光笔 → 落在笔画附近才算（它们是「线」，按包围盒判会误抓一大片空白）。
 */
import type { Point, Rect, Size } from './rect'

export type AnnotationTool = 'rect' | 'ellipse' | 'arrow' | 'pen' | 'highlight' | 'mosaic' | 'text'

interface AnnotationBase {
  id: string
}

/** 拖出来的封闭 / 半封闭形状：两个端点决定一切 */
export interface ShapeAnnotation extends AnnotationBase {
  tool: 'rect' | 'ellipse' | 'arrow'
  start: Point
  end: Point
  /** #rrggbb */
  color: string
  /** 线宽（画布像素） */
  width: number
}

/** 马赛克：一块矩形区域打码，没有颜色与线宽，只有格子大小 */
export interface MosaicAnnotation extends AnnotationBase {
  tool: 'mosaic'
  start: Point
  end: Point
  /** 马赛克格子边长（画布像素），越大越糊 */
  block: number
}

/** 连续笔画：画笔与荧光笔共用，只有颜色和粗细不同 */
export interface FreehandAnnotation extends AnnotationBase {
  tool: 'pen' | 'highlight'
  points: Point[]
  color: string
  width: number
}

/** 文字：位置 + 内容；尺寸在建的时候由画布量出来（工具栏摆位与命中判定都要它） */
export interface TextAnnotation extends AnnotationBase {
  tool: 'text'
  at: Point
  text: string
  color: string
  /** 字号（画布像素） */
  size: number
  /** 文本块的宽高，ctx.measureText 的结果 */
  box: Size
}

export type Annotation = ShapeAnnotation | MosaicAnnotation | FreehandAnnotation | TextAnnotation

/** 点到线段的最短距离 */
export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0)
    return Math.hypot(point.x - a.x, point.y - a.y)

  // 投影参数夹到 [0, 1]：线段外的点按最近的那个端点算
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

/** 点到折线的最短距离（空 / 单点折线也成立） */
export function distanceToPath(point: Point, points: Point[]): number {
  if (!points.length)
    return Number.POSITIVE_INFINITY
  if (points.length === 1)
    return Math.hypot(point.x - points[0].x, point.y - points[0].y)

  let best = Number.POSITIVE_INFINITY
  for (let index = 1; index < points.length; index += 1) {
    const distance = distanceToSegment(point, points[index - 1], points[index])
    if (distance < best)
      best = distance
  }
  return best
}

/** 标注占的那块矩形（画选中框、算导出范围都用它） */
export function annotationBounds(annotation: Annotation): Rect {
  switch (annotation.tool) {
    case 'text':
      return { x: annotation.at.x, y: annotation.at.y, width: annotation.box.width, height: annotation.box.height }
    case 'pen':
    case 'highlight': {
      // 理论上笔画至少有一个点；空数组会让 Math.min 给出 ±Infinity，一路带到液压 / 导出里
      if (!annotation.points.length)
        return { x: 0, y: 0, width: 0, height: 0 }
      const xs = annotation.points.map(point => point.x)
      const ys = annotation.points.map(point => point.y)
      const padding = annotation.width / 2
      return {
        x: Math.min(...xs) - padding,
        y: Math.min(...ys) - padding,
        width: Math.max(...xs) - Math.min(...xs) + padding * 2,
        height: Math.max(...ys) - Math.min(...ys) + padding * 2,
      }
    }
    default: {
      const left = Math.min(annotation.start.x, annotation.end.x)
      const top = Math.min(annotation.start.y, annotation.end.y)
      return {
        x: left,
        y: top,
        width: Math.abs(annotation.end.x - annotation.start.x),
        height: Math.abs(annotation.end.y - annotation.start.y),
      }
    }
  }
}

function insideRect(rect: Rect, point: Point, tolerance: number): boolean {
  return point.x >= rect.x - tolerance
    && point.x <= rect.x + rect.width + tolerance
    && point.y >= rect.y - tolerance
    && point.y <= rect.y + rect.height + tolerance
}

/**
 * 点是不是落在这条标注上。
 * `tolerance` 是「好抓」的容差（一般取几个画布像素），线状标注还要加上半个线宽。
 */
export function hitTestAnnotation(annotation: Annotation, point: Point, tolerance: number): boolean {
  switch (annotation.tool) {
    case 'text':
    case 'mosaic':
      return insideRect(annotationBounds(annotation), point, tolerance)
    case 'rect':
    case 'ellipse':
      return insideRect(annotationBounds(annotation), point, tolerance + annotation.width / 2)
    case 'arrow':
      return distanceToSegment(point, annotation.start, annotation.end) <= tolerance + annotation.width / 2
    case 'pen':
    case 'highlight':
      return distanceToPath(point, annotation.points) <= tolerance + annotation.width / 2
    default:
      return false
  }
}

/**
 * 命中的是哪一条：**从后往前找**（后画的盖在前面之上），返回它在数组里的下标。
 * 一条都没命中时 null。
 */
export function hitTestAnnotations(annotations: Annotation[], point: Point, tolerance: number): number | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    if (hitTestAnnotation(annotations[index], point, tolerance))
      return index
  }
  return null
}

function shiftPoint(point: Point, delta: Point): Point {
  return { x: point.x + delta.x, y: point.y + delta.y }
}

/** 整体平移（拖动已选中的标注） */
export function moveAnnotation(annotation: Annotation, delta: Point): Annotation {
  switch (annotation.tool) {
    case 'text':
      return { ...annotation, at: shiftPoint(annotation.at, delta) }
    case 'pen':
    case 'highlight':
      return { ...annotation, points: annotation.points.map(point => shiftPoint(point, delta)) }
    default:
      return { ...annotation, start: shiftPoint(annotation.start, delta), end: shiftPoint(annotation.end, delta) }
  }
}
