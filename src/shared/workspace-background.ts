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

/** 默认浓淡：按当前配置固化的一档，图与蒙版约各占一半 */
export const BACKGROUND_OPACITY_DEFAULT = 55

/** 收敛到合法区间；不是有限数字（缺失 / null / 字符串 / NaN）一律回到默认值 */
export function clampBackgroundOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BACKGROUND_OPACITY_DEFAULT
  return Math.min(BACKGROUND_OPACITY_MAX, Math.max(BACKGROUND_OPACITY_MIN, Math.round(value)))
}

/**
 * 图片层之上那层蒙版的不透明度（0~1）：图片越浓，蒙版越淡。
 *
 * 蒙版的颜色默认取当前主题的画布色，用户也可以在设置里指定一个（见 sanitizeVeilColor）：
 * 它就是「图片渐淡进去的那个颜色」，所以明暗两套主题下都能把照片压回背景该有的深度。
 */
export function backgroundVeilAlpha(opacityPercent: unknown): number {
  return Number(((100 - clampBackgroundOpacity(opacityPercent)) / 100).toFixed(2))
}

/** 把设置里的路径收拾成可直接使用的一个字符串，非字符串一律当没有背景 */
export function sanitizeBackgroundPath(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 蒙版色：只认 #rgb / #rrggbb，统一归一成小写六位。
 *
 * 其它一律返回空串，也就是「没配」—— 这时蒙版跟着主题的画布色走。
 * 渲染层拿它拼 CSS 变量，主进程用它收敛磁盘上的旧数据，两边必须是同一套判定，
 * 否则一个手改过的数据文件就能把 rgba() 拼成非法值、整条 background 声明作废。
 */
export function sanitizeVeilColor(value: unknown): string {
  if (typeof value !== 'string') return ''

  const matched = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value.trim().toLowerCase())
  if (!matched) return ''

  const digits = matched[1]
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
  return `#${full}`
}

/** #rrggbb → "r, g, b"，直接喂给 CSS 的 rgba(var(--ws-veil-rgb), alpha)；没配则返回空串 */
export function veilRgbTriplet(color: unknown): string {
  const hex = sanitizeVeilColor(color)
  if (!hex) return ''

  const value = Number.parseInt(hex.slice(1), 16)
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`
}
