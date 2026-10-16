/**
 * 标注对象模型：形状、包围盒、命中判定、整体位移、选中后的把手（改大小 / 改参数）。
 *
 * 坐标都是**画布像素**（见 coords.ts 的文件头）。这里只管几何，不管怎么画 ——
 * 画在渲染层的两块画布上（见 components/capture 的 AnnotationLayer）。
 *
 * 命中判定的口径（与 Snipaste 的手感对齐，也是最好用的那一套）：
 *  矩形 / 椭圆 / 马赛克 / 文字 → 落在包围盒里就算命中（它们是「面」）；
 *  箭头 / 画笔 / 荧光笔 → 落在笔画附近才算（它们是「线」，按包围盒判会误抓一大片空白）。
 */
import type { HandleId } from './handles'
import type { Point, Rect, Size } from './rect'
import { HANDLE_IDS, handlePoint, resizeByHandle } from './handles'

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

// ---------- 箭头的样子（杆收尖 + 实心三角头） ----------

/**
 * 箭头的口径：**杆子是从尾到头收尖的锥形，头是一块实心三角**，尺寸全部按线宽算
 * （所以细 / 中 / 粗是整体等比放大，不是只换杆的粗细）。
 *
 * 三个比例是对着参考样式量出来的（147px 长、线宽 8px 的一支）：头长 26 ≈ 3.25 × 线宽、
 * 头的半宽 10 = 头长 × tan(21°)、尾巴收到 1.4px ≈ 0.18 × 线宽（看着就是一个尖）。
 * 改之前是另一套（等宽杆 + `max(线宽 × 3.5, 10)` 长的头、半角 π/7）—— 那样头更钝、杆不收尖。
 */
export const ARROW_SPREAD = (21 * Math.PI) / 180

/** 头长与线宽的比 */
const ARROW_HEAD_RATIO = 3.25
/** 头长的下限：细箭头（线宽 1~2）也该有个看得见的头 */
const ARROW_HEAD_MIN = 10
/** 尾巴那一头的宽度与线宽的比（收到尖） */
const ARROW_TAIL_RATIO = 0.18
/** 头最多占整条箭头的多少 —— 很短的箭头不能只剩一个头 */
const ARROW_HEAD_MAX_SHARE = 0.7

/** 箭头要用的那几项（按结构取，比从联合类型里 Extract 干净） */
export interface ArrowLike {
  start: Point
  end: Point
  /** 线宽（画布像素）：这里指**杆最粗处**，也就是接头的那一头 */
  width: number
}

/** 头有多长（画布像素）：随线宽放大，但再长也不超过整条箭头的 `ARROW_HEAD_MAX_SHARE` */
export function arrowHeadLength(start: Point, end: Point, width: number): number {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  return Math.min(Math.max(width * ARROW_HEAD_RATIO, ARROW_HEAD_MIN), length * ARROW_HEAD_MAX_SHARE)
}

/**
 * 箭头的外轮廓（七个点的闭合多边形：尾巴两头 → 杆接头处 → 两个头角 → 尖 → 绕回来）。
 *
 * **画就是把它填一次色**（显示与导出共用）：一次填充没有接缝，锥形杆与三角头本来就是同一条边。
 * 两端点重合时给空数组（点一下没拖的那种，什么也不用画）。
 */
export function arrowOutline(annotation: ArrowLike): Point[] {
  const { start, end, width } = annotation
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (!length)
    return []

  // 沿轴的单位向量与它的法向
  const ax = dx / length
  const ay = dy / length
  const nx = -ay
  const ny = ax

  const head = arrowHeadLength(start, end, width)
  const at = (t: number, offset: number): Point => ({ x: start.x + ax * t + nx * offset, y: start.y + ay * t + ny * offset })
  const shaftHalf = width / 2
  const headHalf = head * Math.tan(ARROW_SPREAD)
  const tailHalf = (width * ARROW_TAIL_RATIO) / 2
  const base = length - head

  return [
    at(0, tailHalf),
    at(base, shaftHalf),
    at(base, headHalf),
    end,
    at(base, -headHalf),
    at(base, -shaftHalf),
    at(0, -tailHalf),
  ]
}

/** 标注占的那块矩形（画选中框、算导出范围都用它） */
export function annotationBounds(annotation: Annotation): Rect {
  switch (annotation.tool) {
    case 'text':
      return { x: annotation.at.x, y: annotation.at.y, width: annotation.box.width, height: annotation.box.height }
    case 'arrow': {
      // **算上那个头**：头比杆粗得多（半宽是线宽的 1.25 倍），只按两端点给框的话，
      // 选中框会把两边的头角切掉一半
      const outline = arrowOutline(annotation)
      if (!outline.length)
        return { x: annotation.start.x, y: annotation.start.y, width: 0, height: 0 }
      const xs = outline.map(point => point.x)
      const ys = outline.map(point => point.y)
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      }
    }
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

// ---------- 选中之后：把手（改大小）与改参数 ----------

/** 一条标注身上摆出来的把手：id 兼作光标形状（见 handles.ts 的 handleCursor） */
export interface AnnotationHandle {
  id: HandleId
  point: Point
}

/**
 * 选中的这条标注摆哪几个把手。
 *
 *  矩形 / 椭圆 / 马赛克 → 八个（四个角 + 四条边的中点），拖它就是改那一块的大小；
 *  箭头 → 两端各一个，拖一端只动那一端（按包围盒摆八个把手的话，斜着的箭头根本拖不准）；
 *  文字 / 画笔 / 荧光笔 → **不摆**：它们没有「框」这层几何，位置直接拖整条，
 *  字号 / 线宽在工具条上改（见 restyleAnnotation）。
 *
 * 矩形那几个的把手点与选区那八个同源（handles.ts 的 handlePoint），手感一致。
 */
export function annotationHandles(annotation: Annotation): AnnotationHandle[] {
  switch (annotation.tool) {
    case 'rect':
    case 'ellipse':
    case 'mosaic': {
      const rect = annotationBounds(annotation)
      return HANDLE_IDS.map(id => ({ id, point: handlePoint(rect, id) }))
    }
    case 'arrow': {
      // 两端各一个。id 按「这一端相对另一端落在哪个角」取：斜向左上的那一端给 nw / se 这一对、
      // 另一对给 ne / sw —— 光标形状（斜向缩放）因此与拖的方向对得上
      const leaning = (annotation.start.x <= annotation.end.x) === (annotation.start.y <= annotation.end.y)
      return [
        { id: leaning ? 'nw' : 'ne', point: annotation.start },
        { id: leaning ? 'se' : 'sw', point: annotation.end },
      ]
    }
    default:
      return []
  }
}

/**
 * 命中哪个把手：容差内取**最近**的那个（与选区那八个同一套口径 —— 标注很小时几个把手
 * 挤在一起，先判到的那个未必是用户瞄的那个）。没有把手 / 都没命中时 null。
 */
export function hitAnnotationHandle(annotation: Annotation, point: Point, tolerance: number): HandleId | null {
  let best: HandleId | null = null
  let bestDistance = tolerance
  for (const handle of annotationHandles(annotation)) {
    const distance = Math.hypot(handle.point.x - point.x, handle.point.y - point.y)
    if (distance <= bestDistance) {
      best = handle.id
      bestDistance = distance
    }
  }
  return best
}

/**
 * 拖某个把手之后的新标注：
 *  矩形 / 椭圆 / 马赛克 → 按把手那一侧（或那一个角）改大小，拖过对边会翻转（与选区一致）；
 *  箭头 → 只动被拖的那一端；
 *  没有把手的那几种原样返回。
 */
export function resizeAnnotation(annotation: Annotation, id: HandleId, delta: Point): Annotation {
  switch (annotation.tool) {
    case 'rect':
    case 'ellipse':
    case 'mosaic': {
      const rect = resizeByHandle(annotationBounds(annotation), id, delta)
      return { ...annotation, start: { x: rect.x, y: rect.y }, end: { x: rect.x + rect.width, y: rect.y + rect.height } }
    }
    case 'arrow': {
      // 两端各一个把手，id 见 annotationHandles：数组里第一个是 start，另一个就是 end
      const from = annotationHandles(annotation)[0]
      return id === from.id
        ? { ...annotation, start: shiftPoint(annotation.start, delta) }
        : { ...annotation, end: shiftPoint(annotation.end, delta) }
    }
    default:
      return annotation
  }
}

/** 改一条标注的参数（选中后在工具条上点的那几项） */
export interface AnnotationStylePatch {
  color?: string
  /** 线宽（画布像素） */
  width?: number
  /** 马赛克格子边长 */
  block?: number
  /** 字号 */
  size?: number
  /** 按新字号量好的文本块尺寸（与 size 成对给，见下） */
  box?: Size
}

/**
 * 把工具条上的改动落到这一条标注上：颜色 / 线宽 / 马赛克格子 / 字号，各按它适用的那几项来
 * （不适用的原样留着 —— 一条矩形的 block 改不动，也不必清掉）。
 *
 * **文字的 `size` 与 `box` 必须成对给**：那个框是量出来的（命中判定与选中框都靠它），
 * 只改字号不改框等于留一个对不上的尺寸在那儿。调用方按新字号量好 box 一起递进来。
 */
export function restyleAnnotation(annotation: Annotation, patch: AnnotationStylePatch): Annotation {
  const color = patch.color === undefined ? {} : { color: patch.color }
  switch (annotation.tool) {
    case 'rect':
    case 'ellipse':
    case 'arrow':
    case 'pen':
    case 'highlight':
      return { ...annotation, ...color, ...(patch.width === undefined ? {} : { width: patch.width }) }
    case 'mosaic':
      return patch.block === undefined ? annotation : { ...annotation, block: patch.block }
    case 'text':
      return {
        ...annotation,
        ...color,
        ...(patch.size === undefined || !patch.box ? {} : { size: patch.size, box: patch.box }),
      }
  }
}
