/**
 * 首页侧栏（系统状态 / 最近使用 / 快捷操作）放在卡片网格的哪一侧。
 *
 * 与侧栏宽度同理：这个值由用户在设置里选并落盘，主进程（读旧数据、被手工改过的
 * 数据文件）与渲染层（拼布局类名）必须用同一套判定 —— 认不出来的写法一律回到默认的
 * 「右」，否则一个手改过的数据文件就能让侧栏不知道被摆到哪去。
 */

/** 侧栏可以放的两条边；卡片网格占另一侧 */
export type SidePanelPosition = 'left' | 'right'

/** 两个位置的声明顺序，与设置里那排按钮一致（左右） */
export const SIDE_PANEL_POSITIONS: readonly SidePanelPosition[] = ['left', 'right']

/** 默认位置：与 ProjectGrid 原先写死的「卡片在左、面板在右」一致 */
export const SIDE_PANEL_POSITION_DEFAULT: SidePanelPosition = 'right'

/** 收敛到合法取值；缺失 / null / 手改过的字符串一律回到默认位置 */
export function sanitizeSidePanelPosition(value: unknown): SidePanelPosition {
  return SIDE_PANEL_POSITIONS.includes(value as SidePanelPosition)
    ? (value as SidePanelPosition)
    : SIDE_PANEL_POSITION_DEFAULT
}
