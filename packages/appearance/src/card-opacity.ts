/**
 * 卡片不透明度的收敛规则。
 *
 * 首页卡片（工作台面板与项目卡）的底色由设置里的一个百分比驱动，
 * 主进程（读旧数据、被手工改过的数据文件）与渲染层（拖动滑块时）必须用同一套边界，
 * 两边各自为政的话，一个手改过的数据文件就能把 rgba() 拼出界。
 */

/**
 * 不透明度下限：0% 就是「只剩毛玻璃」—— 卡片没有底色，壁纸隔着磨砂铺在内容下面。
 * 这是允许的：模糊把背后的图案化开成色块，字色仍按面底色那一档给，读不读得清由用户自己看着调。
 * （由它兜底的是数据文件里的越界值，不是替用户判断下限。）
 */
export const CARD_OPACITY_MIN = 0

/** 不透明度上限：100% 就是现在的实底卡片 */
export const CARD_OPACITY_MAX = 100

/**
 * 默认不透明度：卡片半透、壁纸从底下透出来。
 *
 * 30% 是照着苹果那套玻璃定的：底色越薄、背后的颜色越穿得过来（草上是暖绿、暗处发灰），
 * 同一种材料在不同壁纸上颜色不一样 —— 那正是玻璃的样子。定到 55% 那档偏「奶白板」，
 * 模糊再重也还是板子。**这只是一台新机器的起点**：改默认值不会覆盖已经存下的配置
 * （theme.json 里有这一项，就按用户的来）。
 */
export const CARD_OPACITY_DEFAULT = 30

/** 收敛到合法区间；不是有限数字（缺失 / null / 字符串 / NaN）一律回到默认值 */
export function clampCardOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return CARD_OPACITY_DEFAULT
  return Math.min(CARD_OPACITY_MAX, Math.max(CARD_OPACITY_MIN, Math.round(value)))
}

/** 百分比 → CSS 里 rgba() 的 alpha（0~1，两位小数），喂给 --card-alpha */
export function cardSurfaceAlpha(opacityPercent: unknown): number {
  return Number((clampCardOpacity(opacityPercent) / 100).toFixed(2))
}
