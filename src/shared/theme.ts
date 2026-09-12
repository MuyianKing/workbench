/**
 * 首页布局（theme.json）的数据结构、收敛规则与纯计算。
 *
 * 首页分成左中右三栏：左右两栏宽度可调，中间那栏 flex:1 吃掉剩余宽度。
 * 七块卡片各自属于某一栏，在栏内按 order 从上到下排列、宽度铺满整栏，高度各自可调；
 * 没有卡片的栏在平时不渲染（编辑时才显示出来，好把卡片拖进去）。
 *
 * 这个模块被主进程（读盘、收敛旧文件）和渲染层（拖动、缩放）共用：两边必须是同一套
 * 边界与吸附规则，否则一个手改过的 theme.json 就能把栏宽撑爆、或者拖出一个负高度。
 */

/** 首页七块卡片的稳定 id；数组顺序也是同栏同 order 时的兜底排序 */
export const HOME_CARD_IDS = [
  'activity',
  'system',
  'recent',
  'actions',
  'quick',
  'commands',
  'projects'
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
}

export function isColumnId(value: unknown): value is ColumnId {
  return COLUMN_IDS.includes(value as ColumnId)
}

export const THEME_VERSION = 1

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
 * 定得比较小：卡片内部该滚的都滚（最近使用 / 快捷操作 / 快捷启动 / 项目列表 / 明细行），
 * 拖到很矮时大不了只剩标题加一行，不会把卡片压成一条没有意义的细边。
 * 真正的物理下限是「面板标题 + 上下内边距」那一圈，约 64px。
 */
export const CARD_HEIGHT_MIN: Record<HomeCardId, number> = {
  activity: 110,
  system: 88,
  recent: 88,
  actions: 76,
  quick: 76,
  commands: 90,
  projects: 100
}

/**
 * 默认布局（按当前配置固化）：左栏从上到下排常用面板，中间那栏上面是项目列表、
 * 下面是命令，右栏默认空着。项目列表占中间栏的 flex 位，窗口越高能看到的项目卡越多；
 * 左栏的快捷操作吃掉左栏剩余高度，整页随窗口自适应、不留半截空白。
 */
export const DEFAULT_THEME: ThemeConfig = {
  version: THEME_VERSION,
  gridStep: GRID_STEP_DEFAULT,
  cardGap: CARD_GAP_DEFAULT,
  leftWidth: LEFT_WIDTH_DEFAULT,
  rightWidth: RIGHT_WIDTH_DEFAULT,
  cards: {
    activity: { column: 'left', order: 0, mode: 'fixed', height: 155 },
    recent: { column: 'left', order: 1, mode: 'fixed', height: 155 },
    quick: { column: 'left', order: 2, mode: 'fixed', height: 98 },
    system: { column: 'left', order: 3, mode: 'fixed', height: 147 },
    actions: { column: 'left', order: 4, mode: 'flex', height: 180 },
    projects: { column: 'center', order: 0, mode: 'flex', height: 600 },
    commands: { column: 'center', order: 1, mode: 'fixed', height: 90 }
  }
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

/** 整份收敛：缺哪块补哪块，认不出来的值一律回到默认布局，最后把 order 排连续 */
export function sanitizeTheme(raw: unknown): ThemeConfig {
  const input = (raw ?? {}) as Partial<ThemeConfig>
  const rawCards = (input.cards ?? {}) as Partial<Record<HomeCardId, CardPlacement>>

  const cards = {} as Record<HomeCardId, CardPlacement>
  for (const id of HOME_CARD_IDS) cards[id] = sanitizeCardPlacement(rawCards[id], id)

  return {
    version: THEME_VERSION,
    gridStep: clampGridStep(input.gridStep),
    cardGap: clampCardGap(input.cardGap),
    leftWidth: clampColumnWidth(input.leftWidth, LEFT_WIDTH_DEFAULT),
    rightWidth: clampColumnWidth(input.rightWidth, RIGHT_WIDTH_DEFAULT),
    cards: normalizeOrder(cards)
  }
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
