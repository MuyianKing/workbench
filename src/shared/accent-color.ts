/**
 * 主题色的收敛与派生。
 *
 * 界面默认是灰度的：Element Plus 的主色（--el-color-primary 一族）走 tokens.css 里那对
 * 「亮色近黑、暗色近白」的中性值，界面里唯一的彩色留给运行状态。用户可以在设置里挑一个
 * 主题色，它只接管交互态 —— 开关、单选、滑块、复选、聚焦环、主按钮，以及**选中块的底色**
 * （--bg-selected：左侧导航栏的当前项与各处列表的选中行都取它）—— 状态色（--st-*）
 * 与终端（--term-*）不受影响。
 *
 * Element Plus 不认「一个主色」，它要一整族派生的变量（light-3/5/7/8/9、dark-2，
 * 以及铺在主色上的文字色）。这里按官方那套配色公式算出来：亮色主题往白里混，
 * 暗色主题往画布色里混，dark-2 反过来。
 *
 * 选中块的底色不算 Element Plus 的事，是应用自己的令牌（tokens.css 里那档中性灰），
 * 但配了主题色就要跟着走 —— 否则「主题色只接管交互态」这句话里那个「选中」是空的。
 * 用的还是同一条混色公式，只是比例另有一档（见 SELECTED_BLEND_*）。
 *
 * 铺在主色上的文字色按主题色的深浅自动挑（红底白字、浅灰底黑字，见 inkOnAccent），
 * 用户也可以在设置里手动指定黑白。
 *
 * 主进程（收敛磁盘上的旧数据）与渲染层（挑完色立即生效）共用这里的判定，
 * 所以整个模块是纯函数、不碰 DOM；写变量由渲染层负责。
 */

/** 设置里空串表示「用默认的中性色」，也就是界面原本的灰度样子 */
export const ACCENT_COLOR_DEFAULT = ''

/**
 * 预置的主题色：几档常用色相，省得每次现调。
 *
 * 都挑得偏深：实心主色块上默认给白字（见 inkOnAccent），色太浅就压不住白字了。
 * 这几档在亮暗两套主题下白字都稳过 WCAG AA 的 4.5:1（见 accent-color.test.ts 的对比度用例）。
 */
export const ACCENT_PRESETS = [
  '#2f6bd8',
  '#4f46e5',
  '#7c3aed',
  '#be185d',
  '#0e7490',
  '#b45309'
] as const

/**
 * 派生出来要写到 :root 上的变量名单。
 * 恢复默认时要按它逐个摘掉内联值，所以顺序也得稳定（不能靠遍历结果对象的键）。
 */
export const ACCENT_VARIABLE_NAMES = [
  '--el-color-primary',
  '--el-color-primary-light-3',
  '--el-color-primary-light-5',
  '--el-color-primary-light-7',
  '--el-color-primary-light-8',
  '--el-color-primary-light-9',
  '--el-color-primary-dark-2',
  '--el-color-white',
  '--bg-selected'
] as const

export type AccentVariableName = (typeof ACCENT_VARIABLE_NAMES)[number]

export type AccentVariables = Partial<Record<AccentVariableName, string>>

/**
 * 主色上文字的三种取法：
 *   auto  —— 按主色的深浅自动挑（默认）
 *   white —— 一律白字
 *   dark  —— 一律近黑字
 */
export const ACCENT_INK_MODES = ['auto', 'white', 'dark'] as const

export type AccentInkMode = (typeof ACCENT_INK_MODES)[number]

export const ACCENT_INK_DEFAULT: AccentInkMode = 'auto'

/** 收敛主色文字色：认不出来的取值一律回到「自动」 */
export function sanitizeAccentInkMode(value: unknown): AccentInkMode {
  return ACCENT_INK_MODES.includes(value as AccentInkMode)
    ? (value as AccentInkMode)
    : ACCENT_INK_DEFAULT
}

/** 暗色主题下 light-N 往哪个颜色里混：就是暗色的画布色（--bg-canvas） */
const DARK_BLEND = '#1b212a'

/** 亮色主题下 light-N 往白里混，跟 Element Plus 一致 */
const LIGHT_BLEND = '#ffffff'

/**
 * 选中块底色（--bg-selected）里主色还剩多少。
 *
 * 亮色下混到只剩两成：出来的色阶与 tokens.css 那档中性灰（#dde1e7）几乎同亮，
 * 所以「比面底色高一档」这件事没变，只是那一档挂上了主色的色相。
 *
 * 暗色下要留得更多：面底色本来就深，照亮色那个比例混会贴回背景上、等于没画
 * —— tokens.css 那条注释说的就是这个坑。那边的中性值（#3b4552）是手调出来的，
 * 这边只能靠比例算，0.55 算出来与它深浅相当。
 */
const SELECTED_BLEND_LIGHT = 0.8
const SELECTED_BLEND_DARK = 0.55

/** 主题色太亮时铺在上面的字要换成这个深色，否则白字看不清 */
const DARK_INK = '#11151b'

const WHITE = '#ffffff'

/**
 * 白字可用的下限（对比度）：再低就连 WCAG 对界面元素 / 非正文文字的 3:1 都够不着。
 * 实心色块上的文字是 13px 的正文，理想要 4.5:1，但主色是用户自己挑的 ——
 * 主流设计系统（Ant / Tailwind 那些品牌色）也都在 3.5~4 这一档用白字，
 * 所以这里只在白字真的不可读时才换深色字，而不是机械地比大小。
 */
const WHITE_INK_FLOOR = 3

/**
 * 只认 #rgb / #rrggbb，统一归一成小写六位；其它一律返回空串（即「没配」）。
 *
 * 渲染层拿它拼 CSS 变量，主进程用它收敛磁盘上的旧数据；两边必须是同一套判定，
 * 否则一个手改过的色值就能写出一个非法变量、把整族主色带崩。
 */
export function sanitizeAccentColor(value: unknown): string {
  if (typeof value !== 'string') return ACCENT_COLOR_DEFAULT

  const matched = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value.trim().toLowerCase())
  if (!matched) return ACCENT_COLOR_DEFAULT

  const digits = matched[1]
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
  return `#${full}`
}

/** #rrggbb → 三个 0~255 的分量 */
function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0')
}

/**
 * 把 blend 按 ratio 的比例混进 base（ratio 是 blend 的占比）。
 * Element Plus 的 light-N 就是 10 分之 N 的白混进主色。
 */
export function mixHex(base: string, blend: string, ratio: number): string {
  const [r1, g1, b1] = channels(base)
  const [r2, g2, b2] = channels(blend)
  const t = Math.min(1, Math.max(0, ratio))

  return `#${toHex(r1 + (r2 - r1) * t)}${toHex(g1 + (g2 - g1) * t)}${toHex(b1 + (b2 - b1) * t)}`
}

/** WCAG 相对亮度（0 全黑 ~ 1 全白） */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度（1 ~ 21） */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/**
 * 铺在主色上的文字色：深色底用白字、浅色底用近黑字。
 *
 * 实心主色块上默认是白字 —— 红底白字、蓝底白字是惯例，Element Plus 自己也是这么取的
 * （主按钮文字、选中的单选按钮、复选对勾都取 --el-color-white）。所以只在白字真的读不清时
 * 才换成近黑字，而不是两边比一下谁的对比度数字更大：中等明度的饱和色（比如 #db4c4c）
 * 近黑字算下来会略高一点，但那样色块会发闷，也背离了主按钮一贯的样子。
 *
 * mode 传 white / dark 就是用户在设置里手动钉死的选择，这时不做任何判断
 * —— 他挑了一个浅灰底还坚持要白字，那是他的事，我们只负责照做。
 */
export function inkOnAccent(color: string, mode: AccentInkMode = ACCENT_INK_DEFAULT): string {
  if (mode === 'white') return WHITE
  if (mode === 'dark') return DARK_INK

  return contrastRatio(color, WHITE) >= WHITE_INK_FLOOR ? WHITE : DARK_INK
}

/**
 * 把主题色派生成要写到 :root 上的整族变量；空串（没配）返回空对象，由 tokens.css 接管。
 *
 * theme 决定往哪边混：亮色主题的 light-N 往白里混（浅底上的悬停底色），
 * 暗色主题往画布色里混（深底上的悬停底色），dark-2 则始终往对比度更高的一边混。
 * inkMode 决定铺在主色上的文字色（见 inkOnAccent）。
 * 选中块底色（--bg-selected）走的是同一条混色、另一个比例（见 SELECTED_BLEND_*）。
 */
export function accentVariables(
  color: unknown,
  theme: 'light' | 'dark',
  inkMode: AccentInkMode = ACCENT_INK_DEFAULT
): AccentVariables {
  const hex = sanitizeAccentColor(color)
  if (!hex) return {}

  const blend = theme === 'dark' ? DARK_BLEND : LIGHT_BLEND
  const deep = theme === 'dark' ? WHITE : '#000000'
  const selected = theme === 'dark' ? SELECTED_BLEND_DARK : SELECTED_BLEND_LIGHT

  return {
    '--el-color-primary': hex,
    '--el-color-primary-light-3': mixHex(hex, blend, 0.3),
    '--el-color-primary-light-5': mixHex(hex, blend, 0.5),
    '--el-color-primary-light-7': mixHex(hex, blend, 0.7),
    '--el-color-primary-light-8': mixHex(hex, blend, 0.8),
    '--el-color-primary-light-9': mixHex(hex, blend, 0.9),
    '--el-color-primary-dark-2': mixHex(hex, deep, 0.2),
    '--el-color-white': inkOnAccent(hex, inkMode),
    '--bg-selected': mixHex(hex, blend, selected)
  }
}
