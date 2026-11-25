/**
 * 工具条上那几个形状图标的描边路径（viewBox 24×24）。
 *
 * 为什么手写 SVG 而不取 @element-plus/icons-vue：EP 没有「矩形 / 椭圆 / 箭头 / 画笔 /
 * 荧光笔 / 马赛克」这几个图形工具图标，硬拿别的凑（比如用 Crop 表示矩形）反而认不出来；
 * 撤销 / 重做同理（见下面那条）。复制 / 保存 / 关闭那几个仍然用 EP 的。
 */
import type { AnnotationTool } from '@/types'

export const TOOL_ICONS: Record<AnnotationTool, string> = {
  rect: 'M4 6.5h16v11H4z',
  ellipse: 'M12 17.5c4.4 0 8-2.5 8-5.5s-3.6-5.5-8-5.5-8 2.5-8 5.5 3.6 5.5 8 5.5z',
  arrow: 'M5 19 19 5M19 5h-6.5M19 5v6.5',
  pen: 'M4 19c3.5-.5 3.5-9 8-9 2.5 0 3.5 2.5 2.5 4.5',
  highlight: 'M9.5 19.5 4.5 18l1.5-5L15 4l4.5 4.5zM4 21h9',
  // 九宫格：一眼看出是「打码」
  mosaic:
    'M4 4h5v5H4zM9.5 4h5v5h-5zM15 4h5v5h-5zM4 9.5h5v5H4zM9.5 9.5h5v5h-5zM15 9.5h5v5h-5zM4 15h5v5H4zM9.5 15h5v5h-5zM15 15h5v5h-5z',
  text: 'M5 6.5h14M12 6.5v11M9 17.5h6',
}

/** 钉到屏幕（EP 里没有合适的，形状就是一枚图钉） */
export const PIN_ICON = 'M9 3h6l-1 6 4.5 4.5H5.5L10 9zM12 13.5V21'

/** 取字：一支文字光标（I-beam）—— 与文字工具那个实心 T 区分开 */
export const OCR_ICON = 'M12 4v16M8.5 4h7M8.5 20h7'

/** 复制文字：文字光标 + 一枚复制块 —— 与「取字」（进文字层挑）区分：整段直接进剪贴板 */
export const OCR_COPY_ICON = 'M9 3v18M6 3h6M6 21h6M15 13h6v8h-6z'

/**
 * 撤销 / 重做。**别用 EP 的 `RefreshLeft` / `RefreshRight`**：那两个是「绕一圈的箭头」，
 * 摆在工具条上更像「刷新 / 重新加载」，有歧义；拐个弯回头的返回箭头才是撤销 / 重做。
 */
export const UNDO_ICON = 'M9 14 4 9 9 4M20 20v-7a4 4 0 0 0-4-4H4'
export const REDO_ICON = 'M15 14 20 9 15 4M4 20v-7a4 4 0 0 1 4-4h12'
