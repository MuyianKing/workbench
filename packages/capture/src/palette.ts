/**
 * 标注用的颜色与档位。
 *
 * 这些是**画在截图上的颜色**，不取 tokens.css —— 界面主体灰度、彩色只表达状态那条规矩
 * 管的是应用界面；一张截图上的箭头要什么颜色是用户自己的事，所以这里是一份固定的调色板，
 * 与明暗主题无关（截图本身也不分主题）。
 */
import type { AnnotationTool } from './annotation'

export interface NamedValue<T> {
  name: string
  value: T
}

/** 调色板：从红到黑，够用且不花哨 */
export const ANNOTATION_COLORS: Array<NamedValue<string>> = [
  { name: '红', value: '#f5222d' },
  { name: '橙', value: '#fa8c16' },
  { name: '黄', value: '#fadb14' },
  { name: '绿', value: '#52c41a' },
  { name: '蓝', value: '#1677ff' },
  { name: '紫', value: '#722ed1' },
  { name: '白', value: '#ffffff' },
  { name: '黑', value: '#000000' },
]

export const ANNOTATION_COLOR_DEFAULT = '#f5222d'

/** 线宽（画布像素） */
export const STROKE_WIDTHS: Array<NamedValue<number>> = [
  { name: '细', value: 2 },
  { name: '中', value: 4 },
  { name: '粗', value: 8 },
]

export const STROKE_WIDTH_DEFAULT = 2

/** 马赛克格子边长（画布像素）：越大越糊 */
export const MOSAIC_BLOCKS: Array<NamedValue<number>> = [
  { name: '小', value: 6 },
  { name: '中', value: 12 },
  { name: '大', value: 24 },
]

export const MOSAIC_BLOCK_DEFAULT = 6

/** 字号（画布像素） */
export const TEXT_SIZES: Array<NamedValue<number>> = [
  { name: '小', value: 16 },
  { name: '中', value: 24 },
  { name: '大', value: 36 },
]

export const TEXT_SIZE_DEFAULT = 16

/** 荧光笔的不透明度：它是「铺一层色」，不是画一条实线 */
export const HIGHLIGHT_ALPHA = 0.35

/** 放大镜：倍数与边长（画布像素） */
export const MAGNIFIER_ZOOM = 8
export const MAGNIFIER_SIDE = 150

/** 把手的命中容差（画布像素）：指哪儿抓哪儿，太小学生抓不住 */
export const HANDLE_TOLERANCE = 10
/** 命中已有标注的容差 */
export const ANNOTATION_TOLERANCE = 6

/** 小于这个尺寸的选区当「还没选」：误点一下不该截出一个 1×1 的图 */
export const MIN_SELECTION = 3

/** 可用的标注工具与它们的显示名（工具条上的顺序就是它） */
export const ANNOTATION_TOOLS: Array<{ tool: AnnotationTool, name: string }> = [
  { tool: 'rect', name: '矩形' },
  { tool: 'ellipse', name: '椭圆' },
  { tool: 'arrow', name: '箭头' },
  { tool: 'pen', name: '画笔' },
  { tool: 'highlight', name: '荧光笔' },
  { tool: 'mosaic', name: '马赛克' },
  { tool: 'text', name: '文字' },
]
