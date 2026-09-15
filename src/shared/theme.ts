/**
 * 主题文件（theme.json）的数据结构、收敛规则与纯计算：**外观设置 + 首页三栏布局**。
 *
 * 首页分成左中右三栏：左右两栏宽度可调，中间那栏 flex:1 吃掉剩余宽度。
 * 七块卡片各自属于某一栏，在栏内按 order 从上到下排列、宽度铺满整栏，高度各自可调；
 * 没有卡片的栏在平时不渲染（编辑时才显示出来，好把卡片拖进去）。
 *
 * 外观那几项（明暗 / 主题色 / 顶部样式 / 卡片不透明度 / 终端高度 / 程序名称 / 背景）也在这里，
 * 原因见 appearance.ts 的文件头：它们与布局是同一类东西，而且同步时整个文件就是一台机器
 * 要带给另一台机器的那份配置。
 *
 * 这个模块被宿主（读盘、收敛旧文件）和渲染层（拖动、缩放）共用：两边必须是同一套
 * 边界与吸附规则，否则一个手改过的 theme.json 就能把栏宽撑爆、或者拖出一个负高度。
 */
import { DEFAULT_APPEARANCE, sanitizeAppearanceSettings, type AppearanceSettings } from './appearance'

/** 首页七块卡片的稳定 id；数组顺序也是同栏同 order 时的兜底排序 */
export const HOME_CARD_IDS = [
  'activity',
  'token',
  'system',
  'recent',
  'actions',
  'quick',
  'commands'
] as const

export type HomeCardId = (typeof HOME_CARD_IDS)[number]

/** 三栏；center 没有固定宽度，永远吃掉剩余空间 */
export const COLUMN_IDS = ['left', 'center', 'right'] as const
export type ColumnId = (typeof COLUMN_IDS)[number]

/** 只有这两栏有固定宽度 */
export const SIDE_COLUMN_IDS = ['left', 'right'] as const
export type SideColumnId = (typeof SIDE_COLUMN_IDS)[number]

/** 抓取卡片那一刻的指针位置与卡片盒子，拖动跟手时用 */
export interface CardGrab {
  x: number
  y: number
  left: number
  top: number
  width: number
  height: number
}

/** 卡片高度的两种模式 */
export type CardMode = 'fixed' | 'flex'

/** 一块卡片在栏目里的位置与尺寸 */
export interface CardPlacement {
  column: ColumnId
  /** 栏内顺序（从 0 开始，连续） */
  order: number
  /**
   * 高度模式：
   * fixed 用 height 的像素值；flex 相当于 flex:1，吃掉所在栏剩下的高度（自适应）。
   */
  mode: CardMode
  /** 固定高度（px）；mode 为 flex 时只作为下限参考，不直接生效 */
  height: number
}

export interface ThemeConfig {
  /** 配置结构版本，将来改字段时用来兜底 */
  version: number
  /** 拖动 / 缩放的吸附步进（px） */
  gridStep: number
  /**
   * 卡片间距（px）：栏间、栏内卡片之间、项目列表里项目卡之间共用这一个值，
   * 让首页所有卡片之间的留白保持一致。
   */
  cardGap: number
  /** 左栏宽度（px） */
  leftWidth: number
  /** 右栏宽度（px） */
  rightWidth: number
  cards: Record<HomeCardId, CardPlacement>
  /**
   * 外观设置（见 appearance.ts）：这一批也住在主题文件里，和布局一起构成
   * 「一台机器的外观配置」—— 同步时整个文件就是带过去的那份东西。
   */
  appearance: AppearanceSettings
  /**
   * 这份外观**最后一次真的变化**的时间（毫秒，Unix 纪元）。
   *
   * 存在的唯一理由是同步：多个文件放在 git 里，只有内容变了才该提交，
   * 所以时间戳不能每轮刷新，得由「内容与上次不同」来驱动（见适配层 state.ts 的 touchTheme）。
   * 别的机器读它来显示「更新于」与排序。老文件里没有，补 0（表示时间未知）。
   */
  updatedAt: number
}

export function isColumnId(value: unknown): value is ColumnId {
  return COLUMN_IDS.includes(value as ColumnId)
}

/**
 * 配置结构的版本号。
 *
 * v1 → v2：卡片清单里移除了「项目列表」（它连筛选标签一起搬去了项目页）。
 * 老文件里那张卡所在的栏会因此空出来，而空栏不渲染 —— 剩下的栏会挤在左边、右边空一大片，
 * 比丢掉一次自定义摆放更难看。所以版本对不上时整份回到默认布局（见 sanitizeTheme）。
 */
export const THEME_VERSION = 2

/** 步进的可配区间：1px 太细容易拖不齐，20px 又太跳，两头都够用；默认 1 为按当前配置固化 */
export const GRID_STEP_MIN = 1
export const GRID_STEP_MAX = 20
export const GRID_STEP_DEFAULT = 1

/**
 * 卡片间距的可配区间（px）。
 * 下限 0 允许卡片紧贴（想要一整面连排时用），上限 40 再大就只剩缝了；默认 10 为按当前配置固化。
 */
export const CARD_GAP_MIN = 0
export const CARD_GAP_MAX = 40
export const CARD_GAP_DEFAULT = 10

/**
 * 侧栏宽度区间。
 * 下限要放得下「系统状态 / 最近使用」里那几行信息，上限只防手改数据把中间栏挤没。
 */
export const COLUMN_WIDTH_MIN = 220
export const COLUMN_WIDTH_MAX = 720
export const LEFT_WIDTH_DEFAULT = 290
export const RIGHT_WIDTH_DEFAULT = 294

/** 卡片高度上限：只防离谱数据，正常拖拽够不着 */
export const CARD_HEIGHT_MAX = 4000

/**
 * 每块卡片的高度下限。
 *
 * 定得比较小：卡片内部该滚的都滚（最近使用 / 快捷操作 / 快捷启动 / 明细行），
 * 拖到很矮时大不了只剩标题加一行，不会把卡片压成一条没有意义的细边。
 * 真正的物理下限是「面板标题 + 上下内边距」那一圈，约 64px。
 */
export const CARD_HEIGHT_MIN: Record<HomeCardId, number> = {
  activity: 110,
  token: 160,
  system: 88,
  recent: 88,
  actions: 76,
  quick: 76,
  commands: 90
}

/**
 * 默认布局（按当前配置固化）：左栏从上到下是四张竖着排的清单卡（最近使用、快捷启动、
 * 系统状态），最底下是吃剩余高度的命令；中栏整栏给两张吃宽度的图表（活跃度、Token 用量）；
 * 右栏是快捷操作。
 *
 * 中栏以前整栏是项目列表，它搬去「项目」页之后中栏空了出来（空栏不渲染 = 默认变两栏、中间空一大片），
 * 所以把两张大图挪了进来 —— 它们是这套卡片里最需要宽度的。
 */
export const DEFAULT_THEME: ThemeConfig = {
  version: THEME_VERSION,
  gridStep: GRID_STEP_DEFAULT,
  cardGap: CARD_GAP_DEFAULT,
  leftWidth: LEFT_WIDTH_DEFAULT,
  rightWidth: RIGHT_WIDTH_DEFAULT,
  cards: {
    recent: { column: 'left', order: 0, mode: 'fixed', height: 155 },
    quick: { column: 'left', order: 1, mode: 'fixed', height: 98 },
    /* 系统状态：node / 包管理器 / nvm / nrm 四行 + 贴底的数据目录，
       170 是四行刚好放全的高度（147 是按三行定的，加一行后明细区会被挤进滚动） */
    system: { column: 'left', order: 2, mode: 'fixed', height: 170 },
    commands: { column: 'left', order: 3, mode: 'flex', height: 90 },
    activity: { column: 'center', order: 0, mode: 'flex', height: 240 },
    token: { column: 'center', order: 1, mode: 'flex', height: 240 },
    actions: { column: 'right', order: 0, mode: 'fixed', height: 224 }
  },
  // 外观的默认值只有一处口径（数据文件那份设置的默认值，见 appearance.ts）
  appearance: DEFAULT_APPEARANCE,
  // 还没改过，所以时间未知
  updatedAt: 0
}

/** 认不出来的高度模式回落到 fallback */
export function sanitizeCardMode(value: unknown, fallback: CardMode): CardMode {
  return value === 'fixed' || value === 'flex' ? value : fallback
}

/** 收敛步进；不是有限数字一律回到默认值 */
export function clampGridStep(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return GRID_STEP_DEFAULT
  return Math.min(GRID_STEP_MAX, Math.max(GRID_STEP_MIN, Math.round(value)))
}

/** 收敛卡片间距；不是有限数字一律回到默认值 */
export function clampCardGap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CARD_GAP_DEFAULT
  return Math.min(CARD_GAP_MAX, Math.max(CARD_GAP_MIN, Math.round(value)))
}

/** 吸附到步进网格：最近的整数格（2px 步进下 7 → 8、9 → 10） */
export function snapToStep(value: number, step: number): number {
  const size = clampGridStep(step)
  return Math.round(value / size) * size
}

/** 收敛侧栏宽度；非法值回退到 fallback */
export function clampColumnWidth(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(fallback)))
  }
  return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(value)))
}

/** 收敛卡片高度：不低于该卡片的下限，不高于全局上限 */
export function clampCardHeight(value: unknown, id: HomeCardId): number {
  const fallback = DEFAULT_THEME.cards[id].height
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(CARD_HEIGHT_MAX, Math.max(CARD_HEIGHT_MIN[id], base))
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 收敛单块卡片：栏认不出来回默认，高度夹到区间，order 先原样留着（后面统一重排） */
export function sanitizeCardPlacement(value: unknown, id: HomeCardId): CardPlacement {
  const fallback = DEFAULT_THEME.cards[id]
  const input = (value ?? {}) as Partial<CardPlacement>

  return {
    column: isColumnId(input.column) ? input.column : fallback.column,
    order: Math.round(finiteOr(input.order, fallback.order)),
    mode: sanitizeCardMode(input.mode, fallback.mode),
    height: clampCardHeight(input.height, id)
  }
}

/** 按栏把 order 重排成 0..n-1：手改过的 order 有洞 / 重复也能收拾干净 */
export function normalizeOrder(
  cards: Record<HomeCardId, CardPlacement>
): Record<HomeCardId, CardPlacement> {
  const next = {} as Record<HomeCardId, CardPlacement>
  for (const id of HOME_CARD_IDS) next[id] = { ...cards[id] }

  for (const column of COLUMN_IDS) {
    HOME_CARD_IDS.filter((id) => next[id].column === column)
      .sort(
        (a, b) =>
          next[a].order - next[b].order ||
          HOME_CARD_IDS.indexOf(a) - HOME_CARD_IDS.indexOf(b)
      )
      .forEach((id, index) => {
        next[id].order = index
      })
  }
  return next
}

/**
 * 整份收敛：缺哪块补哪块，认不出来的值一律回到默认布局，最后把 order 排连续。
 *
 * 版本对不上时整份回到默认布局（见 THEME_VERSION）：卡片清单变过，老布局按原样套用会缺一块。
 * 走的是同一条收敛路径（每个字段都新造对象），所以不会改到 DEFAULT_THEME 那份常量。
 *
 * `updatedAt` 原样留着（缺省补 0）：它是同步用的时间戳，不是这里能判定的东西。
 */
export function sanitizeTheme(raw: unknown): ThemeConfig {
  const input = (raw ?? {}) as Partial<ThemeConfig>
  const base = input.version === THEME_VERSION ? input : DEFAULT_THEME
  const rawCards = (base.cards ?? {}) as Partial<Record<HomeCardId, CardPlacement>>

  const cards = {} as Record<HomeCardId, CardPlacement>
  for (const id of HOME_CARD_IDS) cards[id] = sanitizeCardPlacement(rawCards[id], id)

  return {
    version: THEME_VERSION,
    gridStep: clampGridStep(base.gridStep),
    cardGap: clampCardGap(base.cardGap),
    leftWidth: clampColumnWidth(base.leftWidth, LEFT_WIDTH_DEFAULT),
    rightWidth: clampColumnWidth(base.rightWidth, RIGHT_WIDTH_DEFAULT),
    cards: normalizeOrder(cards),
    // 外观是后加的字段：老主题文件里没有，缺了就补默认（**不能**因为它去动上面的版本判定，
    // 否则升级一次就会把用户的布局整份清掉）
    appearance: sanitizeAppearanceSettings(base.appearance),
    updatedAt:
      typeof base.updatedAt === 'number' && Number.isFinite(base.updatedAt) && base.updatedAt > 0
        ? Math.floor(base.updatedAt)
        : 0
  }
}

/**
 * 两份主题的**内容**是否一致（不看时间戳）。
 *
 * 用途只有一个：主题文件真的变了才刷新时间戳（见适配层 state.ts 的 touchTheme）——
 * 每轮同步都刷新的话，仓库里会堆出一串只改了时间的提交。
 */
export function sameThemeContent(a: ThemeConfig, b: ThemeConfig): boolean {
  if (layoutSignature(a) !== layoutSignature(b)) return false
  return (Object.keys(b.appearance) as Array<keyof AppearanceSettings>).every(
    (key) => a.appearance[key] === b.appearance[key]
  )
}

/** 布局压成一行可比的字符串（外观由调用方逐项比） */
function layoutSignature(layout: ThemeConfig): string {
  return [
    layout.version,
    layout.gridStep,
    layout.cardGap,
    layout.leftWidth,
    layout.rightWidth,
    HOME_CARD_IDS.map((id) => {
      const card = layout.cards[id]
      return `${id}:${card.column}/${card.order}/${card.mode}/${card.height}`
    }).join(',')
  ].join('|')
}

/** 某一栏里的卡片 id，按 order 排好 */
export function cardIdsInColumn(
  cards: Record<HomeCardId, CardPlacement>,
  column: ColumnId
): HomeCardId[] {
  return HOME_CARD_IDS.filter((id) => cards[id].column === column).sort(
    (a, b) => cards[a].order - cards[b].order
  )
}

/**
 * 把一块卡片挪到目标栏的第 index 个位置。
 *
 * index 是「插入到该栏现有卡片（不含被拖的这块）的第几位」，越界会被夹到末尾。
 * 返回新的 cards（其余栏的 order 也会顺带排连续），不动传入的对象。
 */
export function moveCard(
  cards: Record<HomeCardId, CardPlacement>,
  id: HomeCardId,
  column: ColumnId,
  index: number
): Record<HomeCardId, CardPlacement> {
  const next = {} as Record<HomeCardId, CardPlacement>
  for (const cardId of HOME_CARD_IDS) next[cardId] = { ...cards[cardId] }

  next[id].column = column

  const rest = HOME_CARD_IDS.filter(
    (cardId) => cardId !== id && next[cardId].column === column
  ).sort((a, b) => next[a].order - next[b].order)

  const at = Math.max(0, Math.min(Math.round(index), rest.length))
  rest.splice(at, 0, id)
  rest.forEach((cardId, order) => {
    next[cardId].order = order
  })

  return normalizeOrder(next)
}

/** 拖动下边缘改高度：按步进吸附，不低于该卡片的下限 */
export function resizeCardHeight(start: number, dy: number, step: number, min: number): number {
  return Math.min(CARD_HEIGHT_MAX, Math.max(min, snapToStep(start + dy, step)))
}

/**
 * 拖动过程中的落点占位高度 —— 占位块本身不画任何东西（就是一段空隙），
 * 高度和要落下的卡片一致：固定卡用它自己的高度，自适应卡用下限示意。
 */
export function cardPlaceholderHeight(id: HomeCardId, placement: CardPlacement): number {
  return placement.mode === 'flex' ? CARD_HEIGHT_MIN[id] : placement.height
}
