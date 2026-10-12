/**
 * 把标注画到 2D 上下文上的那一套（显示与导出共用同一份代码）。
 *
 * **显示与导出必须走同一条路**：遮罩上的所见与存下来的文件要是两套画法，迟早会对不上
 * （最典型的就是马赛克 —— 格子错半格，肉眼一看就知道不是同一张图）。
 * 所以两边都约定：ctx 先平移到 `origin`，之后一律用**原图绝对坐标**画。
 * 显示时 origin 是选区左上角（并 clip 住选区），导出时同样是选区左上角。
 *
 * 马赛克是唯一要读像素的一种：`getImageData` 不吃 transform，所以它得自己减掉 origin
 * （见下面的说明），而格子本身按 `origin` 对齐，两边因此是同一种格子。
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
 * 马赛克：就地读一块像素、按块取平均色再写回去。
 *
 * **`getImageData` / `putImageData` 不吃 canvas 的 transform**，所以这里要自己把
 * 原图坐标减掉 `origin` 换成设备坐标。格子按 `origin` 对齐（`aligned` 是 origin 的整数倍偏移），
 * 于是显示与导出落在同一张格子上。
 */
/** 马赛克要用的那几项 */
interface MosaicLike {
  start: Point
  end: Point
  block: number
}

function drawMosaic(ctx: CanvasRenderingContext2D, annotation: MosaicLike, origin: Point): void {
  const block = Math.max(2, Math.round(annotation.block))
  const left = Math.min(annotation.start.x, annotation.end.x)
  const top = Math.min(annotation.start.y, annotation.end.y)
  const width = Math.abs(annotation.end.x - annotation.start.x)
  const height = Math.abs(annotation.end.y - annotation.start.y)
  if (width < 1 || height < 1)
    return

  // 往左上对齐到格子边界，让相邻两次马赛克落在同一张网格上
  const aligned = {
    x: origin.x + Math.floor((left - origin.x) / block) * block,
    y: origin.y + Math.floor((top - origin.y) / block) * block,
  }
  const right = left + width
  const bottom = top + height
  const device = {
    x: aligned.x - origin.x,
    y: aligned.y - origin.y,
    width: Math.min(right, origin.x + ctx.canvas.width) - aligned.x,
    height: Math.min(bottom, origin.y + ctx.canvas.height) - aligned.y,
  }
  if (device.width < block || device.height < block)
    return

  let image: ImageData
  try {
    image = ctx.getImageData(device.x, device.y, device.width, device.height)
  }
  catch {
    // 画布被污染时读不了像素（帧走 Blob 之后不该发生）：跳过这块马赛克，
    // 别让一次重绘整个炸掉
    return
  }
  const pixels = image.data

  for (let y = 0; y < device.height; y += block) {
    for (let x = 0; x < device.width; x += block) {
      const blockWidth = Math.min(block, device.width - x)
      const blockHeight = Math.min(block, device.height - y)

      let red = 0
      let green = 0
      let blue = 0
      let count = 0
      for (let row = 0; row < blockHeight; row += 1) {
        let offset = ((y + row) * device.width + x) * 4
        for (let column = 0; column < blockWidth; column += 1) {
          red += pixels[offset]
          green += pixels[offset + 1]
          blue += pixels[offset + 2]
          count += 1
          offset += 4
        }
      }
      if (!count)
        continue

      const average = [Math.round(red / count), Math.round(green / count), Math.round(blue / count)]
      for (let row = 0; row < blockHeight; row += 1) {
        let offset = ((y + row) * device.width + x) * 4
        for (let column = 0; column < blockWidth; column += 1) {
          pixels[offset] = average[0]
          pixels[offset + 1] = average[1]
          pixels[offset + 2] = average[2]
          pixels[offset + 3] = 255
          offset += 4
        }
      }
    }
  }

  ctx.putImageData(image, device.x, device.y)
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
      // 先描一圈半透明黑边：截图上什么底色都可能有，纯色字很容易看不见
      ctx.lineWidth = Math.max(2, annotation.size / 8)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.lineJoin = 'round'
      ctx.strokeText(annotation.text, annotation.at.x, annotation.at.y)
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
