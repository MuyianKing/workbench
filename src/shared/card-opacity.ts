/**
 * 卡片不透明度的收敛规则。
 *
 * 首页卡片（工作台面板与项目卡）的底色由设置里的一个百分比驱动，
 * 主进程（读旧数据、被手工改过的数据文件）与渲染层（拖动滑块时）必须用同一套边界，
 * 两边各自为政的话，一个手改过的数据文件就能把 rgba() 拼出界。
 */

/** 不透明度下限：再透就看不清卡片内容，边框也救不回来 */
export const CARD_OPACITY_MIN = 20

/** 不透明度上限：100% 就是现在的实底卡片 */
export const CARD_OPACITY_MAX = 100

/** 默认不透明度：按当前配置固化的一档，卡片半透、壁纸从底下透出来 */
export const CARD_OPACITY_DEFAULT = 55

/** 收敛到合法区间；不是有限数字（缺失 / null / 字符串 / NaN）一律回到默认值 */
export function clampCardOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CARD_OPACITY_DEFAULT
  return Math.min(CARD_OPACITY_MAX, Math.max(CARD_OPACITY_MIN, Math.round(value)))
}

/** 百分比 → CSS 里 rgba() 的 alpha（0~1，两位小数），喂给 --card-alpha */
export function cardSurfaceAlpha(opacityPercent: unknown): number {
  return Number((clampCardOpacity(opacityPercent) / 100).toFixed(2))
}
