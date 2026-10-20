/**
 * 工作区背景图的收敛规则。
 *
 * 背景图由用户在设置里自己挑，主进程（读旧数据、被手工改过的数据文件）与渲染层
 * （拖动浓淡滑块时）必须用同一套边界：百分比一旦越界，蒙版就会算出一个负的 alpha，
 * 把首页留白的对比度整个打穿。
 */

/** 浓淡下限：再淡就等于没设，用户会以为设置没生效 */
export const BACKGROUND_OPACITY_MIN = 5

/** 浓淡上限：100% 就是一张实图铺在留白里，卡片边缘反而看不清 */
export const BACKGROUND_OPACITY_MAX = 100

/** 默认浓淡：按当前配置固化的一档，以图为主，蒙版只压一层底 */
export const BACKGROUND_OPACITY_DEFAULT = 35

/** 收敛到合法区间；不是有限数字（缺失 / null / 字符串 / NaN）一律回到默认值 */
export function clampBackgroundOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return BACKGROUND_OPACITY_DEFAULT
  return Math.min(BACKGROUND_OPACITY_MAX, Math.max(BACKGROUND_OPACITY_MIN, Math.round(value)))
}

/**
 * 图片层之上那层蒙版的不透明度（0~1）：图片越浓，蒙版越淡。
 *
 * 蒙版的颜色固定取当前主题的画布色（tokens.css 里明暗各一份的 --ws-veil-rgb）：
 * 它就是「图片渐淡进去的那个颜色」，所以两套主题下都能把照片压回背景该有的深度。
 */
export function backgroundVeilAlpha(opacityPercent: unknown): number {
  return Number(((100 - clampBackgroundOpacity(opacityPercent)) / 100).toFixed(2))
}

/** 把设置里的路径收拾成可直接使用的一个字符串，非字符串一律当没有背景 */
export function sanitizeBackgroundPath(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
