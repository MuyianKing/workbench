/**
 * 主题色的收敛与派生。
 *
 * 界面默认是灰度的：Element Plus 的主色（--el-color-primary 一族）走 tokens.css 里那对
 * 「亮色近黑、暗色近白」的中性值，界面里唯一的彩色留给运行状态。用户可以在设置里挑一个
 * 主题色，它只接管交互态 —— 开关、单选、滑块、复选、聚焦环、主按钮，以及**选中块的底色**
 * （--bg-selected：左侧导航栏的当前项与各处列表的选中行都取它）与**选中块里的字**
 * （--ink-accent：导航栏当前项的图标与文字、邮箱清单里正在读的那封）—— 状态色（--st-*）
 * 与终端（--term-*）不受影响。
 *
 * 例外只有两处，都是「表达多与少」的图，而主题色正好是用户自己挑的那条色相：
 * **首页那张活跃度图**（ActivityGraph.vue 用 color-mix 从主色掺出四档深浅），
 * 与**网关用量页那张按天的柱状图**（单色实心，高度已经表达了多少，不必再分阶）。
 * 没配主题色时主色是中性色，这两处仍旧是灰阶。
 *
 * Element Plus 不认「一个主色」，它要一整族派生的变量（light-3/5/7/8/9、dark-2，
 * 以及铺在主色上的文字色）。这里按官方那套配色公式算出来：亮色主题往白里混，
 * 暗色主题往画布色里混，dark-2 反过来。
 *
 * 选中块的底色不算 Element Plus 的事，是应用自己的令牌（tokens.css 里那档中性灰），
 * 但配了主题色就要跟着走 —— 否则「主题色只接管交互态」这句话里那个「选中」是空的。
 * 用的还是同一条混色公式，只是比例另有一档（见 SELECTED_BLEND_*）。
 *
 * 选中块里那几行字（邮箱清单里正在读的那封：主题与发件人）也取主题色，但主色本身铺在
 * 浅底上多半读不清（亮绿 #1fbb70 在它自己的浅底上只有 2.1:1），所以另给一档按对比度推深 /
 * 推亮的 --ink-accent（见 accentTextInk）—— 「这些字用主题色」这句话要成立，靠的是它。
 *
 * 铺在主色上的文字色按主题色的深浅自动挑（红底白字、浅灰底黑字，见 inkOnAccent），
 * 用户也可以在设置里手动指定黑白。
 *
 * 主进程（收敛磁盘上的旧数据）与渲染层（挑完色立即生效）共用这里的判定，
 * 所以整个模块是纯函数、不碰 DOM；写变量由渲染层负责。
 */
import { sanitizeHexColor } from '@workbench/core'

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
  '#b45309',
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
  '--bg-selected',
  '--ink-accent',
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
 * 选中块底色（--bg-selected）里混进多少白（越小主色越浓）。
 *
 * 亮色下留一半主色：**这一档是按压在毛玻璃上定的**。卡片默认只有 20% 白底，
 * 磨开的壁纸会透上来 —— 原先混到只剩两成主色（#6fb684 那种绿算出来 #e2f0e6）
 * 与那层浅底几乎同亮，选中态就消失了。留一半时出来的浅底（#b7dbc2）比浅色玻璃深一档，
 * 壁纸再亮也看得出那块底；再浓就不像「浅底上的选中」而是实心色块了。
 *
 * 暗色下同理，但面底色本来就深，要留更多主色才浮得起来，所以 0.55（约四成半主色）。
 * tokens.css 那边的中性值（#3b4552 / #cfd4dc）与这两档深浅相当。
 */
const SELECTED_BLEND_LIGHT = 0.5
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
 * 只认 #rgb / #rrggbb，统一归一成小写六位；其它一律回默认色（即「没配」）。
 *
 * 渲染层拿它拼 CSS 变量，主进程用它收敛磁盘上的旧数据；两边必须是同一套判定，
 * 否则一个手改过的色值就能写出一个非法变量、把整族主色带崩。
 * 校验与归一用的是 core 的 sanitizeHexColor（全项目唯一一份 hex 口径），这里只留回退语义。
 */
export function sanitizeAccentColor(value: unknown): string {
  return sanitizeHexColor(typeof value === 'string' ? value.trim() : '') ?? ACCENT_COLOR_DEFAULT
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
  if (mode === 'white')
    return WHITE
  if (mode === 'dark')
    return DARK_INK

  return contrastRatio(color, WHITE) >= WHITE_INK_FLOOR ? WHITE : DARK_INK
}

/**
 * 铺在选中块底色上的主题色文字（--ink-accent）要过的对比度。
 *
 * 这里按正文那一档取 4.5:1，不跟着上面的 WHITE_INK_FLOOR（3:1）走：那一档是「用户挑的
 * 主色块上放什么颜色的字」，色块本身是他的选择，只保证基本可读；而这里是**主题色的浅底
 * 上放标题与发件人那两行 13px 的字**，底色是应用自己算的，没有理由让它读不清。
 */
const ACCENT_TEXT_FLOOR = 4.5

/**
 * 选中块里那几行主题色文字的字色：主题色往黑（亮色）/ 往白（暗色）里推，推到在选中底色上
 * 够得着 ACCENT_TEXT_FLOOR 为止。
 *
 * 不能直接把主色当字色：主色是拿来当色块用的（实心块上配白字），它自己的明度多半
 * 落在中间 —— 亮绿 #1fbb70 在它自己那层浅底（#d2f1e2）上只有 2.1:1，等于没画。
 * 推深之后仍是同一个色相（#1fbb70 → 深绿），「这行字是主题色」这件事看得出来。
 *
 * 主色本身就够对比（深蓝、靛那几档浅底上本来就在 4.5:1 以上）时原样返回 —— 那种主色
 * 推一下就发黑了，没必要。对比度对混入比例单调，二分到 24 次够用；万一推到底还够不着
 * （只有很淡的主色在暗色主题下会这样），给的就是推到底那一档，不再硬凑。
 */
function accentTextInk(hex: string, tint: string, theme: 'light' | 'dark'): string {
  if (contrastRatio(hex, tint) >= ACCENT_TEXT_FLOOR)
    return hex

  const deep = theme === 'dark' ? WHITE : '#000000'
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (contrastRatio(mixHex(hex, deep, mid), tint) < ACCENT_TEXT_FLOOR)
      lo = mid
    else hi = mid
  }

  // 取 hi 那一侧（已过线的那一档）而不是中点：混色最后要落成 8 位色值，中点取整后
  // 可能刚好掉回线下（#2f6bd8 那档就差 0.01），而 hi 是拿取整后的颜色比过的。
  // 推到底都够不着时（只有很淡的主色在暗色主题下会这样）给的就是推到底那一档。
  return mixHex(hex, deep, hi)
}

/**
 * 把主题色派生成要写到 :root 上的整族变量；空串（没配）返回空对象，由 tokens.css 接管。
 *
 * theme 决定往哪边混：亮色主题的 light-N 往白里混（浅底上的悬停底色），
 * 暗色主题往画布色里混（深底上的悬停底色），dark-2 则始终往对比度更高的一边混。
 * inkMode 决定铺在主色上的文字色（见 inkOnAccent）。
 * 选中块底色（--bg-selected）走的是同一条混色、另一个比例（见 SELECTED_BLEND_*），
 * 铺在它上面的主题色文字（--ink-accent）按对比度另推一档（见 accentTextInk）。
 */
export function accentVariables(
  color: unknown,
  theme: 'light' | 'dark',
  inkMode: AccentInkMode = ACCENT_INK_DEFAULT,
): AccentVariables {
  const hex = sanitizeAccentColor(color)
  if (!hex)
    return {}

  const blend = theme === 'dark' ? DARK_BLEND : LIGHT_BLEND
  const deep = theme === 'dark' ? WHITE : '#000000'
  const selected = theme === 'dark' ? SELECTED_BLEND_DARK : SELECTED_BLEND_LIGHT
  const selectedTint = mixHex(hex, blend, selected)

  return {
    '--el-color-primary': hex,
    '--el-color-primary-light-3': mixHex(hex, blend, 0.3),
    '--el-color-primary-light-5': mixHex(hex, blend, 0.5),
    '--el-color-primary-light-7': mixHex(hex, blend, 0.7),
    '--el-color-primary-light-8': mixHex(hex, blend, 0.8),
    '--el-color-primary-light-9': mixHex(hex, blend, 0.9),
    '--el-color-primary-dark-2': mixHex(hex, deep, 0.2),
    '--el-color-white': inkOnAccent(hex, inkMode),
    '--bg-selected': selectedTint,
    '--ink-accent': accentTextInk(hex, selectedTint, theme),
  }
}
