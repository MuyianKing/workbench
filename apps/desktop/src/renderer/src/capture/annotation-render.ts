/**
 * 把标注画到 2D 上下文上的那一套（显示与导出共用同一份代码）。
 *
 * **显示与导出必须走同一条路**：遮罩上的所见与存下来的文件要是两套画法，迟早会对不上
 * （最典型的就是马赛克 —— 格子错半格，肉眼一看就知道不是同一张图）。
 * 两边都约定：标注的坐标一律是**原图绝对坐标**，而且**两侧都在整帧尺寸的画布上画** ——
 * 显示侧就是那块 stage（只 clip 住选区），导出侧先在同样大的画布上画完、最后才把选区抠出来。
 * 画布尺寸与原点的任何差别都会让抗锯齿、以及马赛克那种要读像素 / 要缩放的画法两边对不上，
 * 所以 `origin` 两侧都是 (0, 0)；它只剩一个用处：马赛克把原图坐标换成设备坐标。
 *
 * 马赛克是唯一要读像素的一种：`getImageData` / `putImageData` 不吃 transform，所以它得自己按
 * `origin`（这块 canvas 的原点落在原图上的哪儿）换算设备坐标；**格子对齐到原图绝对坐标的网格**，
 * 两侧因此落在同一张格子上。
 */
import type { Annotation, Point, Rect, Size } from '@/types'
import { HIGHLIGHT_ALPHA } from '@workbench/capture'

/** 箭头尖张开的半角 */
const ARROW_SPREAD = Math.PI / 7

/** 文字用的字体串（量尺寸与画字必须是同一串，否则摆位会偏） */
export function textFont(size: number): string {
  return `${size}px 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif`
}

/**
 * 量一段文字的尺寸。文字标注的 `box` 就取它 ——
 * 命中判定、选中框、工具栏摆位都靠这个尺寸，量的时候与画的时候必须同一字体。
 */
export function measureTextBlock(ctx: CanvasRenderingContext2D, text: string, size: number): Size {
  ctx.save()
  ctx.font = textFont(size)
  const metrics = ctx.measureText(text)
  ctx.restore()
  return { width: Math.ceil(metrics.width), height: Math.ceil(size * 1.3) }
}

/** 箭头要用的那几项（按结构取，比从联合类型里 Extract 干净） */
interface ArrowLike {
  start: Point
  end: Point
  width: number
  color: string
}

function drawArrow(ctx: CanvasRenderingContext2D, annotation: ArrowLike): void {
  const { start, end, width, color } = annotation
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const head = Math.max(width * 3.5, 10)

  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'

  // 杆子收在箭头尖之前一点，否则粗箭头会从三角里戳出来
  const shaft = { x: end.x - (Math.cos(angle) * head) / 2, y: end.y - (Math.sin(angle) * head) / 2 }
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(shaft.x, shaft.y)
  ctx.stroke()

  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(end.x, end.y)
  ctx.lineTo(end.x - Math.cos(angle - ARROW_SPREAD) * head, end.y - Math.sin(angle - ARROW_SPREAD) * head)
  ctx.lineTo(end.x - Math.cos(angle + ARROW_SPREAD) * head, end.y - Math.sin(angle + ARROW_SPREAD) * head)
  ctx.closePath()
  ctx.fill()
}

/**
 * 马赛克：把覆盖到的每一格源像素压成一个色块。
 *
 * 做法是**把「整格对齐的那一块」缩到「一格一个像素」，再按原尺寸放大铺回来**（放大时关插值）——
 * 取平均交给浏览器的缩放（GPU）做。别改回 `getImageData` + 逐像素循环：那要先 `putImageData` /
 * `getImageData` 把像素从 GPU 读回 CPU，实测一块 750×500 每帧 5~7ms，拖起来就是卡顿。
 *
 * 两条约定：
 *  - **格子落在原图绝对坐标的网格上**：显示侧与导出侧得落在同一张网格上，否则相邻两次马赛克
 *    对不齐（两侧画布都是整帧，`origin` 就是 (0, 0)；取源像素时按它换成设备坐标）；
 *  - **画出来的范围只认用户拖的那块矩形**：网格往外扩出来的那几格由 clip 裁掉，拖的时候
 *    四条边都跟着鼠标走，不会一格一格地跳。
 */
/** 马赛克要用的那几项 */
interface MosaicLike {
  start: Point
  end: Point
  block: number
}

/** 「一格一个像素」的缩小画布：每帧复用一块，别每次都新建 */
let mosaicScratch: HTMLCanvasElement | null = null

function drawMosaic(ctx: CanvasRenderingContext2D, annotation: MosaicLike, origin: Point): void {
  const block = Math.max(2, Math.round(annotation.block))
  const left = Math.min(annotation.start.x, annotation.end.x)
  const top = Math.min(annotation.start.y, annotation.end.y)
  const width = Math.abs(annotation.end.x - annotation.start.x)
  const height = Math.abs(annotation.end.y - annotation.start.y)
  if (width < 1 || height < 1)
    return

  // 往外扩到整格：格子永远对在绝对网格上
  const gridLeft = Math.floor(left / block) * block
  const gridTop = Math.floor(top / block) * block
  const cols = Math.ceil((left + width - gridLeft) / block)
  const rows = Math.ceil((top + height - gridTop) / block)
  if (cols < 1 || rows < 1)
    return

  const source = ctx.canvas
  const sx = gridLeft - origin.x
  const sy = gridTop - origin.y
  const sw = cols * block
  const sh = rows * block
  // 源可能有一圈落在画布外（贴着边、或者导出侧那块 canvas 只有选区那么大）
  const from = { x: Math.max(sx, 0), y: Math.max(sy, 0) }
  const to = { x: Math.min(sx + sw, source.width), y: Math.min(sy + sh, source.height) }
  if (to.x <= from.x || to.y <= from.y)
    return

  const scratch = (mosaicScratch ??= document.createElement('canvas'))
  scratch.width = cols
  scratch.height = rows
  const small = scratch.getContext('2d')
  if (!small)
    return

  // 缩小：一格落成一个像素。**quality 必须给 high** —— 默认的 low 是大比例缩小时只采几个像素
  // （等于「抽点」而不是取平均），白底上的字会变成零星小色块；high 才按整格求平均。
  // 只画落在画布里的那部分，目标矩形按同一个比例算，格子不会错位；缺的那几格留透明，
  // 铺回去时等于没动它们
  small.imageSmoothingEnabled = true
  small.imageSmoothingQuality = 'high'
  small.clearRect(0, 0, cols, rows)
  small.drawImage(
    source,
    from.x,
    from.y,
    to.x - from.x,
    to.y - from.y,
    (from.x - sx) / block,
    (from.y - sy) / block,
    (to.x - from.x) / block,
    (to.y - from.y) / block,
  )

  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, width, height)
  ctx.clip()
  // 放大铺回去：插值关掉才是方块
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(scratch, 0, 0, cols, rows, gridLeft, gridTop, sw, sh)
  ctx.restore()
}

/** 画一条标注（调用方已经设好 transform 与裁剪） */
export function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: Annotation, origin: Point): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'butt'

  switch (annotation.tool) {
    case 'rect': {
      const rect = boundsOf(annotation.start, annotation.end)
      ctx.strokeStyle = annotation.color
      ctx.lineWidth = annotation.width
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
      break
    }
    case 'ellipse': {
      const rect = boundsOf(annotation.start, annotation.end)
      ctx.strokeStyle = annotation.color
      ctx.lineWidth = annotation.width
      ctx.beginPath()
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2,
      )
      ctx.stroke()
      break
    }
    case 'arrow':
      drawArrow(ctx, annotation)
      break
    case 'pen':
    case 'highlight': {
      if (annotation.points.length < 2) {
        // 单点（只点了一下）：画个圆点，别什么都不留
        if (annotation.points.length === 1) {
          ctx.fillStyle = annotation.color
          ctx.beginPath()
          ctx.arc(annotation.points[0].x, annotation.points[0].y, annotation.width / 2, 0, Math.PI * 2)
          ctx.fill()
        }
        break
      }
      // 荧光笔是「铺一层色」，不透明度压在整条笔画上（不是逐段叠加，免得重叠处发黑）
      ctx.globalAlpha = annotation.tool === 'highlight' ? HIGHLIGHT_ALPHA : 1
      ctx.strokeStyle = annotation.color
      ctx.lineWidth = annotation.width
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(annotation.points[0].x, annotation.points[0].y)
      for (const point of annotation.points.slice(1))
        ctx.lineTo(point.x, point.y)
      ctx.stroke()
      break
    }
    case 'mosaic':
      drawMosaic(ctx, annotation, origin)
      break
    case 'text': {
      ctx.font = textFont(annotation.size)
      ctx.textBaseline = 'top'
      ctx.fillStyle = annotation.color
      ctx.fillText(annotation.text, annotation.at.x, annotation.at.y)
      break
    }
  }

  ctx.restore()
}

/** 两个端点之间的矩形（不论拖的方向） */
export function boundsOf(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

/**
 * 画一组标注。`origin` 见文件头：ctx 的 (0,0) 对应原图上的哪个点。
 * 调用方负责裁剪（显示时裁到选区，导出时整块就是要的那张图）。
 */
export function drawAnnotations(ctx: CanvasRenderingContext2D, list: Annotation[], origin: Point): void {
  for (const annotation of list)
    drawAnnotation(ctx, annotation, origin)
}
