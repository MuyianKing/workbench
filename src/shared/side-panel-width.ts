/**
 * 首页侧栏宽度的收敛规则。
 *
 * 与终端高度同理：这个值由用户在设置里调整并落盘，主进程（读旧数据、被手工改过的
 * 数据文件）与渲染层（拖动滑块时）必须用同一套边界，否则一个离谱的数值就能把
 * 左边的卡片网格挤成一条缝。只在侧栏位于左 / 右时生效（见 side-panel-position.ts）。
 */

/** 侧栏最小宽度：再窄就放不下「系统状态 / 最近使用」里的那几行信息 */
export const SIDE_PANEL_WIDTH_MIN = 280

/** 侧栏最大宽度（px）：只防「离谱的数据」，侧栏本就是辅助信息，不该喧宾夺主 */
export const SIDE_PANEL_WIDTH_MAX = 560

/** 默认宽度，与 ProjectGrid 原先写死的固定值一致 */
export const SIDE_PANEL_WIDTH_DEFAULT = 340

/** 收敛到合法区间；不是有限数字（缺失 / null / 字符串 / NaN）一律回到默认值 */
export function clampSidePanelWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDE_PANEL_WIDTH_DEFAULT
  return Math.min(SIDE_PANEL_WIDTH_MAX, Math.max(SIDE_PANEL_WIDTH_MIN, Math.round(value)))
}
