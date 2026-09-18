/**
 * 主题文件（theme.json）的数据结构、收敛规则与纯计算：**外观设置 + 首页分栏布局**。
 *
 * 首页分成若干栏（栏数自己定，编辑态里拆 / 收，见 HomeColumn）：每栏宽度可以是固定像素，
 * 也可以是「自适应」（与其余自适应栏平分剩余宽度）。
 * 九块卡片各自属于某一栏，在栏内按 order 从上到下排列、宽度铺满整栏，高度各自可调；
 * 没有卡片的栏在平时不渲染（编辑时才显示出来，好把卡片拖进去）。
 * 每块卡片还能单独关掉（`hidden`，在设置里勾选）：关掉只是不画它，栏内位置与高度都留着。
 *
 * 外观那几项（明暗 / 主题色 / 顶部样式 / 卡片不透明度 / 终端高度 / 程序名称 / 背景 /
 * 导航菜单显示哪几页）也在这里，原因见 appearance.ts 的文件头：它们与布局是同一类东西，
 * 而且同步时整个文件就是一台机器要带给另一台机器的那份配置。
 *
 * 这个模块被宿主（读盘、收敛旧文件）和渲染层（拖动、缩放）共用：两边必须是同一套
 * 边界与吸附规则，否则一个手改过的 theme.json 就能把栏宽撑爆、或者拖出一个负高度。
 */
import { DEFAULT_APPEARANCE, sanitizeAppearanceSettings, type AppearanceSettings } from './appearance'

/** 首页九块卡片的稳定 id；数组顺序也是同栏同 order 时的兜底排序 */
export const HOME_CARD_IDS = [
  'activity',
  'token',
  'system',
  'recent',
  'actions',
  'quick',
  'commands',
  'work',
  'news'
] as const

export type HomeCardId = (typeof HOME_CARD_IDS)[number]

/**
 * 卡片的界面名字。放这里是因为有两处在用：画布（编辑态的卡片标签）与设置里的卡片清单 ——
 * 各写一份的话改个名字总有一边忘（各页的名字在 views.ts 里，同一个道理）。
 */
export const HOME_CARD_LABELS: Record<HomeCardId, string> = {
  activity: '活跃度',
  token: 'Token 用量',
  system: '系统状态',
  recent: '最近使用',
  actions: '快捷操作',
  quick: '快捷启动',
  commands: '命令',
  work: '今日完成',
  news: 'AI 热点'
}

/**
 * 首页的一栏。
 *
 * `width` 是这一栏的像素宽度，`null` 表示**自适应** —— 它与其余自适应栏平分剩余宽度
 * （编辑态里点栏头那颗按钮切换，拖两栏之间的竖线改的是左边那一栏的宽度）。
 */
export interface HomeColumn {
  id: string
  width: number | null
}

/** 栏 id：稳定、无语义（`col-1` …）—— 卡片靠它认自己属于哪一栏，所以别把它当序号读 */
export type ColumnId = string

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
  /**
   * 关掉的卡片不画在画布上（设置里的卡片清单勾选的）。
   *
   * 关掉只是「不画」，column / order / height 照旧留着：再打开时回到原来那个位置，
   * 而不是被塞回默认栏。所在栏因此空掉时整栏也不渲染（与「空栏不渲染」同一条规则）。
   */
  hidden: boolean
}

export interface ThemeConfig {
  /** 配置结构版本，将来改字段时用来兜底 */
  version: number
  /**
   * 卡片间距（px）：栏间、栏内卡片之间、项目列表里项目卡之间共用这一个值，
   * 让首页所有卡片之间的留白保持一致。
   */
  cardGap: number
  /**
   * 首页的栏，从左到右。栏数是自己定的（至少一栏、至多 COLUMN_COUNT_MAX），
   * 卡片用 `column` 引用其中某一栏的 id。
   */
  columns: HomeColumn[]
  /** 笔记页左栏（目录树）的宽度（px）：在那一页里左右拖动分隔条调整，与首页栏宽同一套做法 */
  noteTreeWidth: number
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

/**
 * 配置结构的版本号。
 *
 * v1 → v2：卡片清单里移除了「项目列表」（它连筛选标签一起搬去了项目页）。
 * 老文件里那张卡所在的栏会因此空出来，而空栏不渲染 —— 剩下的栏会挤在左边、右边空一大片，
 * 比丢掉一次自定义摆放更难看。所以版本对不上时整份回到默认布局（见 sanitizeTheme）。
 *
 * v2 → v3：固定的左中右三栏换成一份可自由拆分的栏清单（`columns`）。
 * 这一次**不重置**：老的三栏能一字不差地翻过来（见 migrateLegacyLayout），
 * 用户摆过的位置、调过的栏宽都留着。
 */
export const THEME_VERSION = 3

/**
 * 卡片间距的可配区间（px）。
 * 下限 0 允许卡片紧贴（想要一整面连排时用），上限 40 再大就只剩缝了；默认 10 为按当前配置固化。
 */
export const CARD_GAP_MIN = 0
export const CARD_GAP_MAX = 40
export const CARD_GAP_DEFAULT = 10

/**
 * 栏宽区间（只对固定宽度的栏有效）。
 *
 * 下限要放得下「系统状态 / 最近使用」里那几行信息。
 * 上限**只防离谱数据**（手改出一串 8 位数的宽度），不是「最大就这么宽」：宽屏上一个自适应栏
 * 本来就有一两千像素，用户把缝线拖一下就把它钉成固定宽度 —— 上限卡在 720 的话，
 * 那一下会把它硬拽回 720（栏里内容跟着重排），看着像点坏了。
 */
export const COLUMN_WIDTH_MIN = 220
export const COLUMN_WIDTH_MAX = 1600
/** 认不出宽度时用的兜底宽度（固定宽度的默认值） */
export const COLUMN_WIDTH_DEFAULT = 260

/** 首页的栏数区间：一栏也要留着（卡片总得有地方放），上限是「再多每栏都放不下东西」 */
export const COLUMN_COUNT_MIN = 1
export const COLUMN_COUNT_MAX = 6

/**
 * 默认三栏的骨架：左栏 290 固定、中栏自适应、右栏 294 固定
 * —— 与 v2 那套「左 / 中 / 右」的默认宽度一致，升级时看起来什么都没变。
 * （宽度是写在这里的引用数据，改动时下面 DEFAULT_THEME 的卡片摆放不必跟着动）
 */
const DEFAULT_COLUMNS: HomeColumn[] = [
  { id: 'col-1', width: 290 },
  { id: 'col-2', width: null },
  { id: 'col-3', width: 294 }
]

/**
 * 笔记页左栏（目录树）的宽度区间。
 *
 * 下限要放得下「笔记本名字 + 右键菜单的入口」，上限只防手改数据把正文挤没。
 * 它与首页那两栏同一个存放处（theme.json）：都是「界面长什么样」，也一起被同步带走。
 */
export const NOTE_TREE_WIDTH_MIN = 180
export const NOTE_TREE_WIDTH_MAX = 520
export const NOTE_TREE_WIDTH_DEFAULT = 232

/** 卡片高度上限：只防离谱数据，正常拖拽够不着 */
export const CARD_HEIGHT_MAX = 4000

/**
 * 每块卡片的高度下限。
 *
 * 定得比较小：卡片内部该滚的都滚（快捷操作 / 快捷启动 / 明细行），
 * 拖到很矮时大不了只剩标题加一行，不会把卡片压成一条没有意义的细边。
 * 真正的物理下限是「面板标题 + 上下内边距」那一圈，约 64px。
 *
 * 「最近使用」是例外：里面排的是**整张项目卡**（155px 起），下限得够放下一整张，
 * 否则一拖矮就永远只看得到半张卡 —— 而这个面板的全部内容就是那些卡。
 */
export const CARD_HEIGHT_MIN: Record<HomeCardId, number> = {
  // 比别的卡片高 20：图下方那行统计（连续 / 最长 / 活跃天数 / 单日峰值）也要占一行，
  // 再矮就只剩两三行格子了 —— 图本身会滚，但那个高度已经读不出「这一年」的样子
  activity: 130,
  token: 160,
  system: 88,
  // 面板头（标题 + 上下内边距）约 52px + 一张项目卡 155px，留几像素余量
  recent: 220,
  actions: 76,
  quick: 76,
  commands: 90,
  work: 88,
  // AI 热点是名单卡：一条一行（标题 + 来源），太矮就只剩一行标题了
  news: 120
}

/**
 * 默认布局（按当前配置固化）：第一栏（左）从上到下是四张竖着排的清单卡（最近使用、快捷启动、
 * 系统状态），最底下是吃剩余高度的命令 —— 「最近使用」那张里排的是整张项目卡，
 * 所以它是这几张里最高的；第二栏（中，自适应）整栏给两张吃宽度的图表（活跃度、Token 用量）；
 * 第三栏（右）上面是快捷操作、下面「今日完成」吃掉剩余高度。
 *
 * 中栏以前整栏是项目列表，它搬去「项目」页之后中栏空了出来（空栏不渲染 = 默认变两栏、中间空一大片），
 * 所以把两张大图挪了进来 —— 它们是这套卡片里最需要宽度的。
 */
export const DEFAULT_THEME: ThemeConfig = {
  version: THEME_VERSION,
  cardGap: CARD_GAP_DEFAULT,
  columns: DEFAULT_COLUMNS,
  noteTreeWidth: NOTE_TREE_WIDTH_DEFAULT,
  cards: {
    /* 最近使用：一张项目卡 155px + 面板头 52px，再露出下一张的边 —— 「下面还有」这件事
       得看得见，否则用户不会想到去滚它（这一列的卡是按最近使用时间往下排的） */
    recent: { column: 'col-1', order: 0, mode: 'fixed', height: 240, hidden: false },
    quick: { column: 'col-1', order: 1, mode: 'fixed', height: 98, hidden: false },
    /* 系统状态：node / 包管理器 / nvm / nrm 四行 + 贴底的数据目录，
       170 是四行刚好放全的高度（147 是按三行定的，加一行后明细区会被挤进滚动） */
    system: { column: 'col-1', order: 2, mode: 'fixed', height: 170, hidden: false },
    commands: { column: 'col-1', order: 3, mode: 'flex', height: 90, hidden: false },
    activity: { column: 'col-2', order: 0, mode: 'flex', height: 240, hidden: false },
    token: { column: 'col-2', order: 1, mode: 'flex', height: 240, hidden: false },
    actions: { column: 'col-3', order: 0, mode: 'fixed', height: 224, hidden: false },
    // 今日完成：条目数不确定，让它吃掉右栏剩下的高度、在里面自己滚
    work: { column: 'col-3', order: 1, mode: 'flex', height: 200, hidden: false },
    // AI 热点：名单卡，固定高度。240 是按「一屏六条、且不留半截行」定的 ——
    // 200 时只放得下四条出头，最后一条被切一半，看着像没做完
    news: { column: 'col-3', order: 2, mode: 'fixed', height: 240, hidden: false }
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

/** 收敛卡片间距；不是有限数字一律回到默认值 */
export function clampCardGap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CARD_GAP_DEFAULT
  return Math.min(CARD_GAP_MAX, Math.max(CARD_GAP_MIN, Math.round(value)))
}

/** 收敛栏宽；非法值回退到 fallback */
export function clampColumnWidth(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(fallback)))
  }
  return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(value)))
}

/** 收敛一栏的宽度：null（自适应）原样留着，其余夹到区间；认不出来的按自适应处理 */
export function sanitizeColumnWidth(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return clampColumnWidth(value, COLUMN_WIDTH_DEFAULT)
}

/**
 * 收敛整份栏清单：丢掉认不出的（没有 id、id 重复），超出上限的截掉，一栏都不剩时用默认三栏。
 *
 * 这里**不管**卡片引用的是不是不存在的栏 —— 那是 sanitizeCardPlacement 的事
 * （卡片得自己落到一栏里去，而不是让这些栏为它让位）。
 */
export function sanitizeColumns(raw: unknown): HomeColumn[] {
  const input = Array.isArray(raw) ? raw : []
  const columns: HomeColumn[] = []
  const seen = new Set<string>()

  for (const item of input) {
    if (columns.length >= COLUMN_COUNT_MAX) break
    const column = (item ?? {}) as Partial<HomeColumn>
    const id = typeof column.id === 'string' ? column.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    columns.push({ id, width: sanitizeColumnWidth(column.width) })
  }

  // 一栏都没有（老文件、手改坏了）就摆默认那三栏，别让首页没有落脚的地方
  return columns.length ? columns : DEFAULT_COLUMNS.map((column) => ({ ...column }))
}

/** 栏的 id 清单，按当前顺序 */
export function columnIds(columns: HomeColumn[]): string[] {
  return columns.map((column) => column.id)
}

/** 认不认得出这一栏 */
export function isColumnId(columns: HomeColumn[], value: unknown): value is ColumnId {
  return typeof value === 'string' && columns.some((column) => column.id === value)
}

/** 新栏的 id：从 col-1 起找第一个没用过的（收掉一栏再拆，不会和现有的撞上） */
function nextColumnId(columns: HomeColumn[]): string {
  const used = new Set(columnIds(columns))
  for (let n = 1; ; n += 1) {
    const id = `col-${n}`
    if (!used.has(id)) return id
  }
}

/**
 * 在某一栏右边拆出一栏：宽度跟着被拆的那一栏 —— 它是自适应的，新栏也自适应（两栏平分剩下的宽度）；
 * 它是固定宽度，新栏就一样宽。到上限（COLUMN_COUNT_MAX）或认不出 afterId 时原样返回。
 */
export function addColumn(columns: HomeColumn[], afterId: ColumnId): HomeColumn[] {
  const at = columns.findIndex((column) => column.id === afterId)
  if (at === -1 || columns.length >= COLUMN_COUNT_MAX) return columns

  const next = columns.map((column) => ({ ...column }))
  next.splice(at + 1, 0, { id: nextColumnId(columns), width: columns[at].width })
  return next
}

/**
 * 拖两栏之间那条缝：左栏 +dx、右栏 -dx，**两栏宽度之和不变** —— 拖的是那条边界，不是某一栏。
 *
 * 两栏都夹在宽度区间里：哪一边先撞到上下限，两栏就一起停住（和守得住，也不会一边越界、
 * 另一边还接着变）。取整落到整数像素，免得缝线上出现半像素的错位。
 *
 * 数据极端到「这个和根本放不下两栏的下限」（手改出来的）时原样返回，不动它。
 */
export function resizeColumnPair(left: number, right: number, dx: number): [number, number] {
  const sum = Math.round(left) + Math.round(right)
  const lo = Math.max(COLUMN_WIDTH_MIN, sum - COLUMN_WIDTH_MAX)
  const hi = Math.min(COLUMN_WIDTH_MAX, sum - COLUMN_WIDTH_MIN)
  if (lo > hi) return [Math.round(left), Math.round(right)]

  const next = Math.min(hi, Math.max(lo, Math.round(left + dx)))
  return [next, sum - next]
}

/**
 * 改一栏或几栏的宽度（拖一条缝会同时给左右两栏，所以收的是一份清单）。
 *
 * 没列在里面的栏原样留着（只换新对象）；给了的夹到区间。
 * 拖动过程中每一帧都会调它，所以返回的是新数组，不改传进来的那份。
 */
export function setColumnWidths(
  columns: HomeColumn[],
  widths: Record<ColumnId, number>
): HomeColumn[] {
  return columns.map((column) =>
    column.id in widths
      ? {
          ...column,
          width: clampColumnWidth(widths[column.id], column.width ?? COLUMN_WIDTH_DEFAULT)
        }
      : { ...column }
  )
}

/**
 * 收掉一栏：栏里的卡片并到相邻那一栏（左边有就并到左边，没有就并到右边，保持原来的先后顺序）。
 * 只剩一栏时返回 null —— 首页总得留一栏给卡片落脚。
 */
export function removeColumn(
  cards: Record<HomeCardId, CardPlacement>,
  columns: HomeColumn[],
  id: ColumnId
): { columns: HomeColumn[]; cards: Record<HomeCardId, CardPlacement> } | null {
  const at = columns.findIndex((column) => column.id === id)
  if (at === -1 || columns.length <= COLUMN_COUNT_MIN) return null

  const target = columns[at - 1] ?? columns[at + 1]
  if (!target) return null

  let next = cards
  for (const cardId of cardIdsInColumn(cards, id)) {
    next = moveCard(next, cardId, target.id, cardIdsInColumn(next, target.id).length)
  }

  return { columns: columns.filter((column) => column.id !== id), cards: next }
}

/** 收敛笔记页左栏宽度；非法值回到默认宽度 */
export function clampNoteTreeWidth(value: unknown): number {
  const fallback = NOTE_TREE_WIDTH_DEFAULT
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(NOTE_TREE_WIDTH_MAX, Math.max(NOTE_TREE_WIDTH_MIN, base))
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

/**
 * 收敛单块卡片：栏认不出来先看默认布局里的那一栏还在不在，不在就落到第一栏；
 * 高度夹到区间，order 先原样留着（后面统一重排）。
 */
export function sanitizeCardPlacement(
  value: unknown,
  id: HomeCardId,
  columns: HomeColumn[]
): CardPlacement {
  const fallback = DEFAULT_THEME.cards[id]
  const input = (value ?? {}) as Partial<CardPlacement>
  const wanted = isColumnId(columns, input.column) ? input.column : fallback.column

  return {
    column: isColumnId(columns, wanted) ? wanted : columns[0].id,
    order: Math.round(finiteOr(input.order, fallback.order)),
    mode: sanitizeCardMode(input.mode, fallback.mode),
    height: clampCardHeight(input.height, id),
    // 关掉的状态只在明确写了 true 时才认（老主题文件里没有这个字段 = 开着）
    hidden: input.hidden === true
  }
}

/** 按栏把 order 重排成 0..n-1：手改过的 order 有洞 / 重复也能收拾干净 */
export function normalizeOrder(
  cards: Record<HomeCardId, CardPlacement>
): Record<HomeCardId, CardPlacement> {
  const next = {} as Record<HomeCardId, CardPlacement>
  for (const id of HOME_CARD_IDS) next[id] = { ...cards[id] }

  // 要收拾的就是卡片实际落到的那些栏，栏清单本身不必参与
  const columns = [...new Set(HOME_CARD_IDS.map((id) => next[id].column))]
  for (const column of columns) {
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

/** 老版那三栏的 id：v2 的卡片就是这么认栏的（见 migrateLegacyLayout） */
const LEGACY_COLUMN_IDS: Record<string, string> = {
  left: 'col-1',
  center: 'col-2',
  right: 'col-3'
}

/** 老文件里的栏宽：是数字就用它，认不出来的回默认（区间由 sanitizeColumns 再收一次） */
function legacyWidth(value: unknown, fallback: number | null): number | null {
  return fallback === null ? null : finiteOr(value, fallback)
}

/**
 * v2 及更早的 theme.json：那时首页固定是左中右三栏，左右两栏各存一个像素宽度、中间那栏自适应，
 * 卡片用 'left' / 'center' / 'right' 认自己的栏。
 *
 * 这里把它翻成通用的栏清单（三栏一字不差地搬过来），所以 v2 → v3 不会把用户的摆放清掉 ——
 * 与 v1 → v2 那种「卡片清单变了，只能整份回默认」不是一回事。
 *
 * 返回的是**还没收敛**的原始数据（宽度可能是任何东西），交给下面同一条收敛路径。
 */
function migrateLegacyLayout(input: Record<string, unknown>): Record<string, unknown> {
  const rawCards = (input.cards ?? {}) as Record<string, { column?: unknown } | undefined>
  const cards: Record<string, unknown> = {}
  for (const [id, placement] of Object.entries(rawCards)) {
    cards[id] = placement
      ? { ...placement, column: LEGACY_COLUMN_IDS[String(placement.column)] ?? placement.column }
      : placement
  }

  return {
    ...input,
    version: THEME_VERSION,
    columns: [
      { id: 'col-1', width: legacyWidth(input.leftWidth, DEFAULT_COLUMNS[0].width) },
      { id: 'col-2', width: null },
      { id: 'col-3', width: legacyWidth(input.rightWidth, DEFAULT_COLUMNS[2].width) }
    ],
    cards
  }
}

/**
 * 整份收敛：缺哪块补哪块，认不出来的值一律回到默认布局，最后把 order 排连续。
 *
 * 版本对不上时先走一遍迁移（见 migrateLegacyLayout）：老的三栏翻成栏清单，用户的摆放留着；
 * 翻不出东西来的（空对象、随手写的 JSON）就等同于回到默认布局 —— 缺的都由下面逐项补齐。
 * 两条路走的是同一条收敛路径（每个字段都新造对象），所以不会改到 DEFAULT_THEME 那份常量。
 *
 * **往里加一块卡片不必动版本号**：老文件里缺的那块会按默认布局补上（见 sanitizeCardPlacement），
 * 用户自己摆过的位置一并留着。反过来，把某块从清单里拿掉才要动版本 —— 老布局会在它原来那一栏
 * 留下一块空位（v1 → v2 移出「项目列表」就是这种情况）。
 *
 * `updatedAt` 原样留着（缺省补 0）：它是同步用的时间戳，不是这里能判定的东西。
 */
export function sanitizeTheme(raw: unknown): ThemeConfig {
  const input = (raw ?? {}) as Partial<ThemeConfig>
  const base = input.version === THEME_VERSION ? input : migrateLegacyLayout(input)
  const columns = sanitizeColumns(base.columns)
  const rawCards = (base.cards ?? {}) as Partial<Record<HomeCardId, CardPlacement>>

  const cards = {} as Record<HomeCardId, CardPlacement>
  for (const id of HOME_CARD_IDS) cards[id] = sanitizeCardPlacement(rawCards[id], id, columns)

  return {
    version: THEME_VERSION,
    cardGap: clampCardGap(base.cardGap),
    columns,
    // 后加的字段：老主题文件里没有，补默认宽度（与 appearance 同理，不能因此去动上面的版本判定）
    noteTreeWidth: clampNoteTreeWidth(base.noteTreeWidth),
    cards: normalizeOrder(keepOneVisible(cards)),
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
  return (Object.keys(b.appearance) as Array<keyof AppearanceSettings>).every((key) =>
    sameAppearanceValue(a.appearance[key], b.appearance[key])
  )
}

/**
 * 外观项逐个比。字符串与数字直接比；**数组要比内容**（导航栏关掉了哪几页是 `ViewId[]`）——
 * 用 `===` 比的话每次读盘都得到一个新数组，两份配置永远「不一样」，
 * 时间戳就会在每轮同步里刷新，仓库里堆出一串只改了时间的提交。
 */
function sameAppearanceValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.join('\u0000') === b.join('\u0000')
  }
  return a === b
}

/** 布局压成一行可比的字符串（外观由调用方逐项比） */
function layoutSignature(layout: ThemeConfig): string {
  return [
    layout.version,
    layout.cardGap,
    layout.noteTreeWidth,
    layout.columns.map((column) => `${column.id}:${column.width ?? 'flex'}`).join(','),
    HOME_CARD_IDS.map((id) => {
      const card = layout.cards[id]
      return `${id}:${card.column}/${card.order}/${card.mode}/${card.height}/${card.hidden}`
    }).join(',')
  ].join('|')
}

/**
 * 「至少留一块」：全关掉时把清单里的第一块（活跃度）放开。
 * 一个不剩的话首页是一片空白，用户连拖动把手都看不见 —— 与导航栏那条同样的道理
 * （见 views.ts 的 sanitizeHiddenViews）。设置界面里最后一颗开关是禁用的，正常够不到这里。
 */
function keepOneVisible(
  cards: Record<HomeCardId, CardPlacement>
): Record<HomeCardId, CardPlacement> {
  if (HOME_CARD_IDS.some((id) => !cards[id].hidden)) return cards

  const next = {} as Record<HomeCardId, CardPlacement>
  for (const id of HOME_CARD_IDS) next[id] = { ...cards[id] }
  next[HOME_CARD_IDS[0]].hidden = false
  return next
}

/** 某一栏里的卡片 id，按 order 排好（含关掉的那些） */
export function cardIdsInColumn(
  cards: Record<HomeCardId, CardPlacement>,
  column: ColumnId
): HomeCardId[] {
  return HOME_CARD_IDS.filter((id) => cards[id].column === column).sort(
    (a, b) => cards[a].order - cards[b].order
  )
}

/**
 * 某一栏里**要画出来**的卡片：顺序同 cardIdsInColumn，只是把关掉的滤掉。
 * 画布与「栏里还有没有卡片」的判断都走它 —— 否则关掉一块卡会让空栏照旧占着位置。
 */
export function visibleCardIdsInColumn(
  cards: Record<HomeCardId, CardPlacement>,
  column: ColumnId
): HomeCardId[] {
  return cardIdsInColumn(cards, column).filter((id) => !cards[id].hidden)
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

/**
 * 拖动下边缘改高度：落到整数像素（吸附网格就是 1px），不低于该卡片的下限。
 *
 * 界面上的拖动都是按指针位置现算的浮点数，不取整的话高度会是一串小数，
 * 卡片间距与总高度跟着出现半像素的错位。
 */
export function resizeCardHeight(start: number, dy: number, min: number): number {
  return Math.min(CARD_HEIGHT_MAX, Math.max(min, Math.round(start + dy)))
}

/**
 * 拖动过程中的落点占位高度 —— 占位块本身不画任何东西（就是一段空隙），
 * 高度和要落下的卡片一致：固定卡用它自己的高度，自适应卡用下限示意。
 */
export function cardPlaceholderHeight(id: HomeCardId, placement: CardPlacement): number {
  return placement.mode === 'flex' ? CARD_HEIGHT_MIN[id] : placement.height
}
