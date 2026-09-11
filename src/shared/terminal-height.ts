/**
 * 终端面板高度的收敛规则。
 *
 * 高度由用户拖出来并且会落盘，所以主进程（读旧数据、被手工改过的数据文件）与渲染层
 * （拖动过程中）必须用同一套边界，否则一个离谱的数值就能把面板撑到整个窗口。
 */

/** 展开后的最小高度：再矮就只剩一两行日志，不如直接收起 */
export const TERMINAL_HEIGHT_MIN = 120

/** 展开后的最大高度（px）：只防「离谱的数据」，实际拖拽还要看窗口高度 */
export const TERMINAL_HEIGHT_MAX = 1200

/** 默认高度，与 tokens.css 里的 --h-terminal 保持一致（按当前配置固化） */
export const TERMINAL_HEIGHT_DEFAULT = 406

/** 收敛到合法区间；不是有限数字（缺失 / null / 字符串 / NaN）一律回到默认值 */
export function clampTerminalHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TERMINAL_HEIGHT_DEFAULT
  return Math.min(TERMINAL_HEIGHT_MAX, Math.max(TERMINAL_HEIGHT_MIN, Math.round(value)))
}

/**
 * 当前窗口高度下允许的最大面板高度。
 *
 * 固定的 TERMINAL_HEIGHT_MAX 只挡离谱数据，真正拖拽时还要给上面的项目列表留地方，
 * 否则小窗口里能把列表挤成一条缝。返回值永远 >= 最小高度，保证拖拽区间非空。
 */
export function maxTerminalHeightFor(viewportHeight: number): number {
  if (typeof viewportHeight !== 'number' || !Number.isFinite(viewportHeight)) {
    return TERMINAL_HEIGHT_MAX
  }
  return Math.min(TERMINAL_HEIGHT_MAX, Math.max(TERMINAL_HEIGHT_MIN, Math.round(viewportHeight * 0.7)))
}
