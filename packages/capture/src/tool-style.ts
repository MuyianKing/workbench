/**
 * 每个工具自己的一份参数档位（颜色 + 三个尺寸）。
 *
 * 工具条第二排是**跟着工具走**的：切走时记住这条工具用的档位，切回来时原样读回 ——
 * 否则在两条工具之间来回切一次，另一条工具刚调好的线宽 / 字号就被带跑了。
 * **默认一律取最小档**（细 / 小 / 小），不用每回都从「中」往下调。
 *
 * 这里只给「每个工具一份」的初始值；记与取由渲染层在参数变化 / 切工具时做
 * （见 CaptureApp 的 rememberStyle / recallStyle）。
 */
import type { AnnotationTool } from './annotation'
import { ANNOTATION_COLOR_DEFAULT, ANNOTATION_TOOLS, MOSAIC_BLOCK_DEFAULT, STROKE_WIDTH_DEFAULT, TEXT_SIZE_DEFAULT } from './palette'

export interface ToolStyle {
  color: string
  strokeWidth: number
  block: number
  textSize: number
}

/** 一条工具的默认档位（每次调用都是新对象，工具之间不共享） */
export function defaultToolStyle(): ToolStyle {
  return {
    color: ANNOTATION_COLOR_DEFAULT,
    strokeWidth: STROKE_WIDTH_DEFAULT,
    block: MOSAIC_BLOCK_DEFAULT,
    textSize: TEXT_SIZE_DEFAULT,
  }
}

/** 所有工具各来一份默认档位 */
export function defaultToolStyles(): Record<AnnotationTool, ToolStyle> {
  const styles = {} as Record<AnnotationTool, ToolStyle>
  for (const { tool } of ANNOTATION_TOOLS)
    styles[tool] = defaultToolStyle()
  return styles
}
