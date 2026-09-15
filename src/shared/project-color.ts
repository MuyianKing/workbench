/**
 * 项目标识色：用主题色给项目一个「一眼分得出来」的记号。
 *
 * 取值有两种：
 *   - **预设名**（primary / success / warning / danger / info）—— 落盘存名字、渲染时取
 *     `--el-color-<name>`，于是明暗两套、用户自己选的主题色都会自动跟着走；
 *   - **自定义色**（`#rrggbb`）—— 用户自己挑的颜色，跟着数据走，不随主题变。
 * 两种都不写死色值到界面里（见 projectColorVar），数据文件里也不会留下别人推导出的颜色。
 *
 * 分工：**「用哪个颜色」由这里的两条规则决定**，渲染层只管把结果画出来 ——
 *   - 新加项目 / 老数据补齐：取「当前用得最少的那个**预设**」（自定义色不占名额，
 *     自动分配因此始终可预期）；
 *   - 用户手动改过之后就以他为谁，不再参与自动分配。
 */

/** 预设色，顺序即「自动分配」的优先次序 —— 就是 Element Plus 的五个主题色 */
export const PROJECT_COLOR_PRESETS = ['primary', 'success', 'warning', 'danger', 'info'] as const

export type ProjectColorPreset = (typeof PROJECT_COLOR_PRESETS)[number]

/**
 * 标识色：预设名，或自定义的 `#rrggbb`。
 * 自定义那份写成模板字面量类型，好让「随手塞一个字符串」在类型上就站不住 ——
 * 真正的把关在 sanitizeProjectColor（运行时要认三位简写、大写字母这些写法）。
 */
export type ProjectColor = ProjectColorPreset | `#${string}`

/**
 * 预设色在下拉里显示的名字。
 * 刻意不写成「红色 / 绿色」：这些颜色跟着主题走（暗色下主色是近白、用户还能自定义主题色），
 * 按色相起名迟早对不上；写成它们在主题里的角色，既准确又和 Element Plus 的叫法一致。
 */
export const PROJECT_COLOR_LABELS: Record<ProjectColorPreset, string> = {
  primary: '主题色',
  success: '成功',
  warning: '警告',
  danger: '危险',
  info: '信息'
}

/** 自定义色在界面上的名字 */
export const PROJECT_COLOR_CUSTOM_LABEL = '自定义'

const PRESET_NAMES: readonly string[] = PROJECT_COLOR_PRESETS

/** `#abc` / `#aabbcc`，大小写都认；别的写法（`rgb()`、颜色名、八位带透明度）一律不收 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export function isProjectColorPreset(value: unknown): value is ProjectColorPreset {
  return typeof value === 'string' && PRESET_NAMES.includes(value)
}

export function isProjectColor(value: unknown): value is ProjectColor {
  return isProjectColorPreset(value) || (typeof value === 'string' && HEX_COLOR.test(value))
}

/**
 * 收敛成一个能直接用的取值：预设名原样返回，三位简写展开成六位并统一小写；
 * 认不出来的返回 undefined（调用方按「没设色」处理）——
 * 手改坏的数据文件不该把 `var(--el-color-红色)` 这种东西送进样式表。
 */
export function sanitizeProjectColor(value: unknown): ProjectColor | undefined {
  if (isProjectColorPreset(value)) return value
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) return undefined

  const hex = value.slice(1).toLowerCase()
  const full = hex.length === 3 ? hex.replace(/./g, (char) => char + char) : hex
  return `#${full}`
}

/** 标识色对应的 CSS 值：预设取主题变量，自定义色直接就是它自己 */
export function projectColorVar(color: ProjectColor): string {
  return isProjectColorPreset(color) ? `var(--el-color-${color})` : color
}

/**
 * 取一个「还没怎么被用过」的颜色：按各预设的已用次数排序，取最少的那一个（并列时按预设顺序）。
 *
 * 传当前所有项目的颜色即可 —— 前五个项目因此自然分散成五种颜色，再往后就循环复用。
 * 比「按项目序号取模」好在不依赖列表顺序：删掉中间一个项目不会让后面所有项目集体换色。
 * 自定义色不计数：那是用户自己挑的，不该影响自动分配的节奏。
 */
export function nextProjectColor(used: readonly (ProjectColor | undefined)[]): ProjectColorPreset {
  const counts = new Map<ProjectColorPreset, number>()
  for (const color of used) {
    if (isProjectColorPreset(color)) counts.set(color, (counts.get(color) ?? 0) + 1)
  }

  let picked: ProjectColorPreset = PROJECT_COLOR_PRESETS[0]
  let best = Number.POSITIVE_INFINITY
  for (const color of PROJECT_COLOR_PRESETS) {
    const count = counts.get(color) ?? 0
    if (count < best) {
      picked = color
      best = count
    }
  }
  return picked
}

/**
 * 老数据补齐：给还没有标识色的项目逐个补一个，返回「id → 颜色」的补丁表（没得补时是空表）。
 *
 * 它必须是纯函数并被调用方显式落盘 —— 「什么时候写用户数据」是个要交代清楚的动作，
 * 不该藏在读取路径里（见项目 store 里 backfillProjectColors 的说明）。
 */
export function backfillProjectColors(
  projects: readonly { id: string; color?: ProjectColor }[]
): Record<string, ProjectColor> {
  const patch: Record<string, ProjectColor> = {}
  let assigned: Array<ProjectColor | undefined> = projects.map((project) =>
    sanitizeProjectColor(project.color)
  )

  projects.forEach((project, index) => {
    if (assigned[index]) return
    const color = nextProjectColor(assigned)
    assigned = assigned.slice()
    assigned[index] = color
    patch[project.id] = color
  })

  return patch
}
