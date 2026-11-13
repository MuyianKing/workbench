/**
 * 全包唯一一套色值工具，主题色派生（`accent-color.ts`）与设计参考库（`design-styles.ts`）共用。
 *
 * 契约：**只认带 `#` 的三位 / 六位 hex**。认不出来不抛错、也不猜 —— `mixHex` 原样返回第一个参数，
 * `relativeLuminance` 按 0 处理；`rgb()` / `hsl()` 这类函数式写法只在 `isColorValue` 里放行
 * （那是「能不能写进样式表」的判定，不参与颜色计算）。
 */
import { sanitizeHexColor } from '@workbench/core'

/** 解析 hex，认不出来回 null（不抛错：外部数据手改坏过也不能白屏） */
export function parseHex(value: unknown): { r: number, g: number, b: number } | null {
  if (typeof value !== 'string')
    return null
  const hex = sanitizeHexColor(value.trim())
  if (!hex)
    return null
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

/** 是不是一个能写进样式的颜色值（hex / 常见函数式写法 / 关键字） */
export function isColorValue(value: unknown): value is string {
  if (typeof value !== 'string')
    return false
  const text = value.trim()
  if (parseHex(text))
    return true
  return /^(rgb|rgba|hsl|hsla|oklch|lab|color-mix)\(/i.test(text) || text === 'transparent'
}

/** 相对亮度（WCAG），用于决定叠在某个底色上的字用黑还是白；认不出的颜色按 0 处理 */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb)
    return 0
  const channel = (value: number): number => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/**
 * 叠在这个底色上的字该用黑还是白。阈值取 0.45 而不是 0.5：
 * 深色系品牌里大量 `#181715` 这类近黑底，0.5 会让中灰底判成白字而糊掉。
 */
export function inkOn(background: string): string {
  return relativeLuminance(background) > 0.45 ? '#11151b' : '#ffffff'
}

/**
 * 两个 hex 之间线性插值：`t=0` 取 a，`t=1` 取 b。
 *
 * 样例页面的兜底色（卡片底 / 次文字 / 分隔线）靠它从画布色与文字色之间现调 ——
 * 缺这些 token 的设计不必另拍一套写死的颜色，导出的深浅也是跟着这套设计走的。
 * 认不出 hex 时原样回 a（与 `parseHex` 一样，坏数据不抛错）。
 */
export function mixHex(a: string, b: string, t: number): string {
  const from = parseHex(a)
  const to = parseHex(b)
  if (!from || !to)
    return a
  const ratio = Math.min(1, Math.max(0, t))
  const channel = (x: number, y: number): number => Math.round(x + (y - x) * ratio)
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  return `#${hex(channel(from.r, to.r))}${hex(channel(from.g, to.g))}${hex(channel(from.b, to.b))}`
}

/** WCAG 对比度（1 ~ 21）；读不出的颜色按最暗处理 */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}
