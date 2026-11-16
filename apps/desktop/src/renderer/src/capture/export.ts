import type { Annotation, Rect } from '@workbench/capture'
import { clampRect } from '@workbench/capture'
import { drawAnnotation, drawAnnotations } from './annotation-render'

export interface ComposeInput {
  /** 这一场的原始帧 */
  frame: ImageBitmap
  /** 选区（画布物理像素） */
  rect: Rect
  /** 整帧边界（画布尺寸），选区在这里面裁 */
  bounds: Rect
  /** 画进导出图的标注（已经按「拖到一半」的规矩处理过，见 settledAnnotations） */
  annotations: Annotation[]
  /** 正被拖的那一笔（调用方已从 annotations 里摘掉） */
  draft: Annotation | null
}

/**
 * 选区那一块 + 标注，编成 PNG。画法与显示侧完全一致（见 CaptureApp.vue 的文件头）。
 *
 * **先在整帧尺寸的画布上画**（与 stage 同一套：绝对坐标、不平移），最后才把选区那块抠出来。
 * 不能图省事只在「选区那么大」的画布上平移到选区坐标系再画：那样两边 canvas 尺寸与原点的
 * 小数部分都不一样，抗锯齿、马赛克那类要读像素 / 要缩放的画法会与屏幕上差一点点
 * （马赛克更明显：浏览器的缩放实现跟源画布尺寸有关，块色会差几个点）。
 */
export async function composePng(input: ComposeInput): Promise<Blob | null> {
  const { frame, rect, bounds, annotations, draft } = input
  const crop = clampRect({ ...rect, x: Math.round(rect.x), y: Math.round(rect.y) }, bounds)
  const width = Math.max(1, Math.round(crop.width))
  const height = Math.max(1, Math.round(crop.height))

  const stage = document.createElement('canvas')
  stage.width = frame.width
  stage.height = frame.height
  const painter = stage.getContext('2d')
  if (!painter)
    return null
  painter.imageSmoothingEnabled = false
  painter.drawImage(frame, 0, 0)
  drawAnnotations(painter, annotations, { x: 0, y: 0 })
  if (draft)
    drawAnnotation(painter, draft, { x: 0, y: 0 })

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx)
    return null
  ctx.drawImage(stage, crop.x, crop.y, width, height, 0, 0, width, height)

  try {
    return await new Promise<Blob | null>(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'))
  }
  catch {
    // 污染的画布上 toBlob 会同步抛 SecurityError（帧走 Blob 之后不该发生，兜住免得白屏）
    return null
  }
}
