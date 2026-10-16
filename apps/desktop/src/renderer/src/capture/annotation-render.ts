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
import { arrowOutline, HIGHLIGHT_ALPHA } from '@workbench/capture'

/** 文字标注的字体栈（画布、量基线那条探针，以及 CaptureApp 里输入框的 CSS 都得是这一串） */
const TEXT_FONT_FAMILY = `'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif`

/** 文字用的字体串（量尺寸与画字必须是同一串，否则摆位会偏） */
export function textFont(size: number): string {
  return `${size}px ${TEXT_FONT_FAMILY}`
}

/**
 * 文字标注的行高倍数：多行时每行的步进 = size * TEXT_LINE_HEIGHT，标注高度也按行数算。
 * **画布上的步进、量尺寸、以及输入框自己的 CSS 行高必须是这一个值** —— 差一点，
 * 提交那一刻整块字就会跳（多行时按行数累积，越往下越明显）。
 */
export const TEXT_LINE_HEIGHT = 1.3

/**
 * 文字块**第一行基线**落在块顶下面多少（画布像素）—— 问浏览器自己排的那一行，见 `domBaseline`。
 *
 * 为什么不能直接用 `ctx.textBaseline = 'top'` 画在文字块的左上角：那个 'top' 与输入框
 * **不是同一套字体度量**。实测（Segoe UI / 微软雅黑这套字体栈）canvas 的 'top' 认的是
 * 字体表里的 typo ascender（16px 时离基线 12px、24px 时 20px），而输入框里的那行字是按
 * CSS 行盒摆的：行盒高 = size × TEXT_LINE_HEIGHT，字号自带的 ascender + descender 居中
 * 落在行盒里（上下各摊一半行距）。两边差出来的那几像素，就是「输入的时候一行字在那儿，
 * 一落下去往上跳一小段」的来源（24px 字号实测差 5~6px，肉眼很明显）。
 *
 * 为什么**不自己按字体度量套行盒模型**（`(size × 行高 − (ascender + descender)) / 2 + ascender`）：
 * canvas 的 `fontBoundingBox*` 是**取整**过的（16px 报 17 + 4，浏览器排版用的是 1/64px 的小数），
 * 差出来的小半个像素正好把落笔位置翻到相邻的一行上 —— 实测 24px 公式给 25.6、输入框那一行
 * 落的是 25，字一落下去就往下跳 1px（16px 也一样差 1px，22 / 32px 正好对上；同一个字号
 * 永远差同一个方向）。看着就是「字落下去 / 合成一结束，整块往下移动了一点」。
 *
 * **调用前先设好 `ctx.font`**（量不出 DOM 时退回按度量的老算法，那条要用当前字号的度量）。
 */
export function textBaselineOffset(ctx: CanvasRenderingContext2D, size: number): number {
  const measured = domBaseline(size)
  if (measured !== null)
    return measured

  const metrics = ctx.measureText('Hg')
  // 量不出字体度量时（度量给 0 / NaN）按字号粗估：宁可差一点，也不要摆到行盒外面去
  const ascent = metrics.fontBoundingBoxAscent > 0 ? metrics.fontBoundingBoxAscent : size
  const descent = metrics.fontBoundingBoxDescent > 0 ? metrics.fontBoundingBoxDescent : 0
  return (size * TEXT_LINE_HEIGHT - (ascent + descent)) / 2 + ascent
}

/** 量出来的第一行基线（按字号缓存；量不出来的那几回不留空值，下次还能量） */
const baselineCache = new Map<number, number>()

/** 量基线的那对盒子（现用现建，建一次就留着复用） */
let baselineProbe: { host: HTMLElement, marker: HTMLElement } | null = null

/**
 * 让浏览器把这一行自己排一遍，读出一行文字的基线离块顶多远。
 *
 * 探针是一个**与输入框同字体、同行高**的隐藏块，里面挂一个零尺寸、
 * `vertical-align: baseline` 的 inline-block —— 这种盒子的基线就是它的底边，而它没有高度，
 * 于是它的顶边正好压在基线上，两个位置相减就是答案。写什么字都行：一行文字的基线由行盒定
 * （字号自带的 ascender / descender 摊在行高里），与行里是中文、拉丁还是混排无关（实测同一个数）。
 *
 * 量不到（没有 DOM 的单测）给 null，由调用方退回按字体度量算。
 */
function domBaseline(size: number): number | null {
  if (typeof document === 'undefined')
    return null
  const cached = baselineCache.get(size)
  if (cached !== undefined)
    return cached

  if (!baselineProbe) {
    const host = document.createElement('div')
    host.textContent = 'M'
    host.style.cssText = `position: absolute; left: -9999px; top: 0; visibility: hidden;`
      + ` white-space: pre; line-height: ${TEXT_LINE_HEIGHT}; font-family: ${TEXT_FONT_FAMILY}`
    const marker = document.createElement('span')
    marker.style.cssText = 'display: inline-block; width: 0; height: 0; vertical-align: baseline'
    host.appendChild(marker)
    document.body.appendChild(host)
    baselineProbe = { host, marker }
  }

  const { host, marker } = baselineProbe
  host.style.fontSize = `${size}px`
  const baseline = marker.getBoundingClientRect().top - host.getBoundingClientRect().top
  // 没有排版引擎时（拿 jsdom 跑单测）这一对全是 0：那不是量到了 0，是量不出来
  if (!(baseline > 0))
    return null
  baselineCache.set(size, baseline)
  return baseline
}

/** 按换行把文字拆成几行（`\r\n` / `\r` 都算，空行保留 —— 空行也是用户敲的） */
export function textLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/**
 * 量一段文字的尺寸（多行：宽取最长的那一行、高按行数算）。文字标注的 `box` 就取它 ——
 * 命中判定、选中框、工具栏摆位都靠这个尺寸，量的时候与画的时候必须同一字体。
 */
export function measureTextBlock(ctx: CanvasRenderingContext2D, text: string, size: number): Size {
  ctx.save()
  ctx.font = textFont(size)
  const lines = textLines(text)
  let width = 0
  for (const line of lines)
    width = Math.max(width, ctx.measureText(line).width)
  ctx.restore()
  return { width: Math.ceil(width), height: Math.ceil(lines.length * size * TEXT_LINE_HEIGHT) }
}

/** 量尺寸用的离屏上下文（只量不画；输入框的宽高跟着它长） */
let measureCtx: CanvasRenderingContext2D | null = null

/** 量一段文字的尺寸（自带离屏上下文，供输入框每次敲键实时跟着长） */
export function measureTextSize(text: string, size: number): Size {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx)
    return { width: 0, height: Math.ceil(size * TEXT_LINE_HEIGHT) }
  return measureTextBlock(measureCtx, text, size)
}

/** 箭头要用的那几项（按结构取，比从联合类型里 Extract 干净） */
interface ArrowLike {
  start: Point
  end: Point
  width: number
  color: string
}

/**
 * 箭头：**把那一圈轮廓填一次色**（外形在 `@workbench/capture` 的 `arrowOutline` 里 ——
 * 收尖的锥形杆 + 实心三角头，尺寸随线宽）。一次填充比「先描一层杆、再填一个三角」干净：
 * 接缝与双重抗锯齿都不会有，锥形杆与头就是同一条边。
 */
function drawArrow(ctx: CanvasRenderingContext2D, annotation: ArrowLike): void {
  const outline = arrowOutline(annotation)
  if (!outline.length)
    return

  ctx.fillStyle = annotation.color
  ctx.beginPath()
  ctx.moveTo(outline[0].x, outline[0].y)
  for (const point of outline.slice(1))
    ctx.lineTo(point.x, point.y)
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
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = annotation.color
      // 多行：每行自己一次 fillText，步进与量尺寸、输入框 CSS 行高同一个值；
      // 基线问浏览器自己排的那一行（见 textBaselineOffset —— 用 'top' 或者按画布度量算，
      // 都会与输入框里那一行差几像素，字一落下去就跳）
      const lines = textLines(annotation.text)
      const step = annotation.size * TEXT_LINE_HEIGHT
      const first = textBaselineOffset(ctx, annotation.size)
      for (let index = 0; index < lines.length; index += 1)
        ctx.fillText(lines[index], annotation.at.x, annotation.at.y + first + index * step)
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
