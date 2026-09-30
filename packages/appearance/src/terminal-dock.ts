/**
 * 终端收起后那颗悬浮按钮的位置规则。
 *
 * 与面板高度同理（见 terminal-height.ts）：这个位置会落盘，读它的一方（这里的
 * sanitizeSettings）与拖动它的一方（渲染层）必须用同一套边界，否则手改过的数据文件
 * 能把按钮放到视口外面去 —— 而它一旦落在外面，界面里就再也够不着了。
 *
 * 取值的两种状态：
 *  - `null`：没拖动过。按钮落在**终端面板自己的位置上**（面板贴底铺开，按钮就落在它
 *    纵向中线上），由渲染层按当前面板高度现算 —— 收起看着才像面板收进了这颗按钮。
 *  - 数字：用户拖到过的位置，占窗口高度的百分比。
 *
 * 存百分比而不是像素：换台机器、把窗口拉高拉矮，它都还停在差不多的高度上。
 * 窗口内的上下限另有一份，在组件里按当前视口高度现算（那里才知道顶栏占了多高）。
 */

/** 默认位置：跟随终端面板（拖动过才有数字） */
export const TERMINAL_BUTTON_TOP_DEFAULT: number | null = null

/** 最上 / 最下的落点：各留一颗按钮的余量，免得贴着窗口边缘被裁掉一半 */
export const TERMINAL_BUTTON_TOP_MIN = 3
export const TERMINAL_BUTTON_TOP_MAX = 97

/**
 * 收敛到合法区间。
 * 缺失 / null / 认不出的取值一律回到「跟随终端面板」—— 那是个永远落得进视口的位置，
 * 比一个猜出来的数字安全。
 */
export function clampTerminalButtonTop(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TERMINAL_BUTTON_TOP_DEFAULT
  return Math.min(TERMINAL_BUTTON_TOP_MAX, Math.max(TERMINAL_BUTTON_TOP_MIN, value))
}
