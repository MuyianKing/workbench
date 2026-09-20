/**
 * 主题文件（theme.json）的数据结构、收敛规则与纯计算：**外观设置 + 首页布局**。
 *
 * 首页布局是两层的：若干栏并排（栏数自己定，编辑态里拆 / 收，见 HomeColumn），
 * 每栏里若干行从上往下摞（行数自己定，见 HomeRow），每行里的卡片横向平分这一栏的宽度
 * —— 于是「中栏上面一张宽卡、下面三张并排」这种摆法也表达得出来。
 * 栏宽要么是固定像素、要么是「自适应」（与其余自适应栏平分剩余宽度）；行高同样是这两种模式，
 * 固定的按像素、自适应的吃掉所在栏剩下的高度。
 *
 * 九块卡片各自落在某一行里（`CardPlacement.row`），行内按 order 从左往右排、宽度一律平分。
 * 行 id 与栏 id 一样是全局唯一、无语义的引用：卡片只认行，它在哪一栏由行反查
 * （见 columnOfRow）—— 拆一栏、收一栏都不会让别的卡片跟着换地方。
 * 一栏至少留一行（总得有个能往里头放卡片的地方）；一行里的卡片全被搬走之后这一行就没了
 * （见 pruneEmptyRows），所以数据里不会攒出一串空行。没有卡片的栏在平时不渲染。
 * 每块卡片还能单独关掉（`hidden`，在设置里勾选）：关掉只是不画它，它那一行与行内的位置都留着。
 *
 * 外观那几项（明暗 / 主题色 / 顶部样式 / 卡片不透明度 / 终端高度 / 程序名称 / 背景 /
 * 导航菜单显示哪几页）也在这里，原因见 appearance.ts 的文件头：它们与布局是同一类东西，
 * 而且同步时整个文件就是一台机器要带给另一台机器的那份配置。
 *
 * 这个模块被宿主（读盘、收敛旧文件）和渲染层（拖动、缩放）共用：两边必须是同一套
 * 边界与吸附规则，否则一个手改过的 theme.json 就能把栏宽撑爆、或者拖出一个负高度。
 */
import { DEFAULT_APPEARANCE, sanitizeAppearanceSettings, type AppearanceSettings } from './appearance'

/** 首页九块卡片的稳定 id；数组顺序也是同栏同行时的兜底排序 */
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
  token: 'Coding 用量',
  system: '系统状态',
  /* id 仍叫 recent（布局里存的是它，改 id 会让老布局整份回到默认），
     含义已经换成「挑出来放到首页的那几个项目」（见 Project.home） */
  recent: '我的项目',
  actions: '快捷操作',
  quick: '快捷启动',
  commands: '命令',
  work: '今日完成',
  news: 'AI 热点'
}

/** 高度的两种模式（用在行上：一行一个高度，行里的卡片跟着这一行） */
export type CardMode = 'fixed' | 'flex'

/** 栏 id / 行 id：稳定、无语义（`col-1` / `row-1`）—— 卡片靠行 id 认自己的位置，别把它当序号读 */
export type ColumnId = string
export type RowId = string

/**
 * 首页一栏里的一行：横向的一条槽，槽里的卡片平分这一栏的宽度、高度跟着这一行。
 *
 * `mode` 为 `fixed` 时用 `height` 那个像素值，`flex` 时相当于 flex:1，吃掉所在栏剩下的高度
 * （那时 `height` 只当「切回固定时的那个值」留着，不直接生效）。
 * 同一个高度只在行上有一份 —— 一行里几张卡片必然等高，否则并排起来高矮不齐。
 */
export interface HomeRow {
  id: RowId
  mode: CardMode
  height: number
}

/**
 * 首页的一栏。
 *
 * `width` 是这一栏的像素宽度，`null` 表示**自适应** —— 它与其余自适应栏平分剩余宽度
 * （编辑态里点栏头那颗按钮切换，拖两栏之间的竖线改的是左边那一栏的宽度）。
 * `rows` 是栏里的行，从上到下；**至少一行**（一栏总得有个能往里头放卡片的地方）。
 */
export interface HomeColumn {
  id: ColumnId
  width: number | null
  rows: HomeRow[]
}

/** 抓取卡片那一刻的指针位置与卡片盒子，拖动跟手时用 */
export interface CardGrab {
  x: number
  y: number
  left: number
  top: number
  width: number
  height: number
}

/** 一块卡片落在哪里：哪一行、行内第几位 */
export interface CardPlacement {
  /** 所在行的 id（行 id 全局唯一，它在哪一栏由行反查得出来） */
  row: RowId
  /** 行内顺序（从 0 开始，连续），从左往右 */
  order: number
  /**
   * 关掉的卡片不画在画布上（设置里的卡片清单勾选的）。
   *
   * 关掉只是「不画」，row / order 照旧留着：再打开时回到原来那一格，
   * 而不是被塞回默认位置。行里的卡片全被关掉时整行也不画（与「空行不留」同一条规则）。
   */
  hidden: boolean
}

/** 卡片要落到哪里：拖动的落点（见 moveCard） */
export interface RowTarget {
  /** 落到哪一栏 */
  column: ColumnId
  /**
   * 落点在该栏的第几行（`column.rows` 的下标）：
   * 落进已有的一行时是那一行，新开一行时是「插在它前面」的那一行。
   */
  rowIndex: number
  /** 另起一行（`rowIndex` 等于行数时就是插到这一栏的末尾） */
  newRow: boolean
  /** 落进已有的一行时，行内的插入位次（`newRow` 时忽略） */
  index: number
}

export interface ThemeConfig {
  /** 配置结构版本，将来改字段时用来兜底 */
  version: number
  /**
   * 卡片间距（px）：栏间、行间、行内卡片之间、项目列表里项目卡之间共用这一个值，
   * 让首页所有卡片之间的留白保持一致。
   */
  cardGap: number
  /**
   * 首页的栏，从左到右。栏数是自己定的（至少一栏、至多 COLUMN_COUNT_MAX），
   * 卡片用 `CardPlacement.row` 引用某一行，而行住在某一栏里。
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
 * 那一次**不重置**：老的三栏能一字不差地翻过来（见 migrateLegacyLayout）。
 *
 * v3 → v4：一维的「栏内从上往下排」换成「栏 → 行 → 卡片」两层（见 HomeRow）。
 * 这一次同样**不重置**：按「一张卡片一行」铺出来就是老样子 ——
 * 每块卡片自己那份高度模式与高度交给它新得到的那一行，用户摆过的位置、调过的栏宽都留着。
 */
export const THEME_VERSION = 4

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
 * 下限要放得下「系统状态 / 我的项目」里那几行信息。
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
 * 行高上限：只防离谱数据，正常拖拽够不着。
 * 行数不必另设上限：一行至少要有一块卡片，而卡片一共就九块，最多也就九行。
 */
export const ROW_HEIGHT_MAX = 4000

/**
 * 每块卡片的高度下限。
 *
 * 定得比较小：卡片内部该滚的都滚（我的项目 / 快捷操作 / 快捷启动 / 明细行），
 * 拖到很矮时大不了只剩标题加一行，不会把卡片压成一条没有意义的细边。
 * 真正的物理下限是「面板标题 + 上下内边距」那一圈，约 64px。
 *
 * 高度住在行上，所以它是一条**行的下限**：一行里装着哪几块卡片，就由最高的那条下限说了算
 * （见 rowHeightMin）。
 */
export const CARD_HEIGHT_MIN: Record<HomeCardId, number> = {
  // 比别的卡片高 20：图下方那行统计（连续 / 最长 / 活跃天数 / 单日峰值）也要占一行，
  // 再矮就只剩两三行格子了 —— 图本身会滚，但那个高度已经读不出「这一年」的样子
  activity: 130,
  token: 160,
  system: 88,
  // 里面是整张项目卡（155px 起），但这张卡不画面板壳、内容本来就滚：
  // 拖到 100 也读得下去（露出小半张，剩下的滚），不为它另定一条高下限
  recent: 100,
  actions: 76,
  quick: 76,
  commands: 90,
  work: 88,
  // AI 热点是名单卡：一条一行（标题 + 来源），太矮就只剩一行标题了
  news: 120
}

/** 空行的下限：所有卡片下限里最小的那个（一行里没有卡片、没人挑高度时用它） */
export const ROW_HEIGHT_MIN_DEFAULT = Math.min(...Object.values(CARD_HEIGHT_MIN))

/**
 * 笔记页左栏（目录树）的宽度区间。
 *
 * 下限要放得下「笔记本名字 + 右键菜单的入口」，上限只防手改数据把正文挤没。
 * 它与首页那两栏同一个存放处（theme.json）：都是「界面长什么样」，也一起被同步带走。
 */
export const NOTE_TREE_WIDTH_MIN = 180
export const NOTE_TREE_WIDTH_MAX = 520
export const NOTE_TREE_WIDTH_DEFAULT = 232

/**
 * 默认布局（按当前配置固化）。
 *
 * 第一栏（左，373 固定）自上而下是活跃度、快捷启动、系统状态、快捷操作、命令五张定高卡，
 * 最底下是吃剩余高度的今日完成（条目数不确定，在卡内自己滚）；第二栏（中，自适应）整栏留给
 * 我的项目 —— 那张里排的是整张项目卡，宽度富余时读起来最舒服；第三栏（右，345 固定）上面是
 * 吃剩余高度的 Coding 用量，下面是固定高度的 AI 热点（名单卡，条目多了在卡内滚）。
 *
 * **行 id 是顺次编号的（row-1 … row-9），不是随手起的**：认不出来的老文件整份回默认布局，
 * 而那条路要先按「一张卡片一行」把老布局翻一遍（见 migrateLegacyLayout），翻出来的行 id
 * 就是这个顺序 —— 它是**按栏、再按行**顺次下来的（左栏六行、中栏一行、右栏两行）。
 * 两边对不上，`sanitizeTheme(null)` 就不再等于这一份默认布局了（sanitizeTheme 那条用例盯着这件事）。
 */
export const DEFAULT_THEME: ThemeConfig = {
  version: THEME_VERSION,
  cardGap: CARD_GAP_DEFAULT,
  columns: [
    {
      id: 'col-1',
      width: 373,
      rows: [
        { id: 'row-1', mode: 'fixed', height: 183 },
        { id: 'row-2', mode: 'fixed', height: 103 },
        /* 系统状态：node / 包管理器 / nvm / nrm 四行。
           170 是四行放全的高度（147 是按三行定的，加一行后明细区会被挤进滚动） */
        { id: 'row-3', mode: 'fixed', height: 170 },
        { id: 'row-4', mode: 'fixed', height: 198 },
        { id: 'row-5', mode: 'fixed', height: 90 },
        // 今日完成：条目数不确定，让它吃掉这一栏剩下的高度、在里面自己滚
        { id: 'row-6', mode: 'flex', height: 727 }
      ]
    },
    {
      id: 'col-2',
      width: null,
      rows: [
        /* 我的项目：一张项目卡 155px + 一条卡片间距，再露出下一张小半张 —— 「下面还有」
           这件事得看得见，否则用户不会想到去滚它（排几张由用户在项目上勾，见 Project.home） */
        { id: 'row-7', mode: 'flex', height: 157 }
      ]
    },
    {
      id: 'col-3',
      width: 345,
      rows: [
        { id: 'row-8', mode: 'flex', height: 727 },
        // AI 热点：名单卡，固定高度（条目多了在卡内滚）
        { id: 'row-9', mode: 'fixed', height: 345 }
      ]
    }
  ],
  noteTreeWidth: NOTE_TREE_WIDTH_DEFAULT,
  cards: {
    activity: { row: 'row-1', order: 0, hidden: false },
    quick: { row: 'row-2', order: 0, hidden: false },
    system: { row: 'row-3', order: 0, hidden: false },
    actions: { row: 'row-4', order: 0, hidden: false },
    commands: { row: 'row-5', order: 0, hidden: false },
    work: { row: 'row-6', order: 0, hidden: false },
    recent: { row: 'row-7', order: 0, hidden: false },
    token: { row: 'row-8', order: 0, hidden: false },
    news: { row: 'row-9', order: 0, hidden: false }
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
 * 收敛行高：不低于 `min`（这一行里最高的那条卡片下限），不高于全局上限。
 * 非法值回退到「切回固定高度时的那个值」，也就是默认布局里那一行的高度。
 */
export function clampRowHeight(value: unknown, min: number): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : min
  return Math.min(ROW_HEIGHT_MAX, Math.max(min, base))
}

/** 栏的深拷贝（含行）：默认布局是常量，不能被就地改到 */
function cloneColumn(column: HomeColumn): HomeColumn {
  return { ...column, rows: column.rows.map((row) => ({ ...row })) }
}

/** 收敛出来的一栏骨架：id 与宽度定下来了，行还是原始数据（交给调用方决定怎么用） */
interface ColumnSkeleton {
  id: ColumnId
  width: number | null
  rows: unknown
}

/**
 * 收敛栏骨架：丢掉认不出的（没有 id、id 重复），超出上限的截掉，一栏都不剩时用默认三栏。
 * 行这一层原样带出来，由调用方接手 —— 版本对不上时那些行要按「一卡一行」重铺
 * （见 migrateLegacyLayout），版本对得上时才逐条收敛（见 sanitizeColumns）。
 *
 * `isDefault` 说的是「这份栏清单整个就是默认布局那一份」（文件里一栏都没给出）：
 * 卡片缺摆放时要不要去认默认布局的行，就看它（见 pickRow）。
 */
function columnSkeleton(raw: unknown): { columns: ColumnSkeleton[]; isDefault: boolean } {
  const input = Array.isArray(raw) ? raw : []
  const columns: ColumnSkeleton[] = []

  for (const item of input) {
    if (columns.length >= COLUMN_COUNT_MAX) break
    const column = (item ?? {}) as Partial<HomeColumn>
    const id = typeof column.id === 'string' ? column.id.trim() : ''
    if (!id || columns.some((seen) => seen.id === id)) continue
    columns.push({ id, width: sanitizeColumnWidth(column.width), rows: column.rows })
  }

  // 一栏都没有（老文件、手改坏了）就摆默认那三栏，别让首页没有落脚的地方
  if (columns.length) return { columns, isDefault: false }

  return {
    columns: DEFAULT_THEME.columns.map((column) => ({
      id: column.id,
      width: column.width,
      rows: column.rows
    })),
    isDefault: true
  }
}

/** 把栏骨架收敛成一栏一栏的行清单：行 id 全局唯一（跨栏也不许撞），一栏至少一行 */
function buildColumns(skeleton: ColumnSkeleton[]): HomeColumn[] {
  const columns: HomeColumn[] = []
  const usedRows = new Set<string>()

  for (const item of skeleton) {
    columns.push({ id: item.id, width: item.width, rows: sanitizeRows(item.rows, usedRows, columns) })
  }
  return columns
}

/** 收敛一条行清单：丢掉没有 id 的、id 重复的（行 id 全局唯一，跨栏也不许撞） */
function sanitizeRows(raw: unknown, used: Set<string>, columns: HomeColumn[]): HomeRow[] {
  const input = Array.isArray(raw) ? raw : []
  const rows: HomeRow[] = []

  for (const item of input) {
    const row = (item ?? {}) as Partial<HomeRow>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id || used.has(id)) continue
    used.add(id)
    rows.push({
      id,
      // 认不出的模式按自适应：它跟「吃掉剩余高度」最接近，不会把一栏挤出滚动条
      mode: sanitizeCardMode(row.mode, 'flex'),
      height: clampRowHeight(row.height, ROW_HEIGHT_MIN_DEFAULT)
    })
  }

  // 一栏至少留一行：卡片总得有地方放，拖进这一栏时也得有个落点
  return rows.length
    ? rows
    : [{ id: nextRowId(columns, used), mode: 'flex', height: ROW_HEIGHT_MIN_DEFAULT }]
}

/**
 * 收敛栏清单（含每栏的行）：骨架走 columnSkeleton，每栏的 `rows` 走 sanitizeRows，
 * 所以出来之后一定「栏栏有行」。
 *
 * 这里**不管**卡片引用的是不是不存在的行 —— 那是 sanitizeCardPlacement 的事
 * （卡片得自己落到一行里去，而不是让这些行来为它让位）。
 */
export function sanitizeColumns(raw: unknown): HomeColumn[] {
  return buildColumns(columnSkeleton(raw).columns)
}

/** 栏的 id 清单，按当前顺序 */
export function columnIds(columns: HomeColumn[]): ColumnId[] {
  return columns.map((column) => column.id)
}

/** 认不认得出这一栏 */
export function isColumnId(columns: HomeColumn[], value: unknown): value is ColumnId {
  return typeof value === 'string' && columns.some((column) => column.id === value)
}

/** 行的 id 清单，按「栏从左到右、行从上到下」的顺序 */
export function rowIds(columns: HomeColumn[]): RowId[] {
  return columns.flatMap((column) => column.rows.map((row) => row.id))
}

/** 认不认得出这一行 */
export function isRowId(columns: HomeColumn[], value: unknown): value is RowId {
  return typeof value === 'string' && rowIds(columns).includes(value)
}

/** 行住哪一栏；认不出来时返回 null */
export function columnOfRow(columns: HomeColumn[], rowId: RowId): HomeColumn | null {
  return columns.find((column) => column.rows.some((row) => row.id === rowId)) ?? null
}

/** 按 id 取一行；认不出来时返回 null */
export function rowOf(columns: HomeColumn[], rowId: RowId): HomeRow | null {
  for (const column of columns) {
    const row = column.rows.find((item) => item.id === rowId)
    if (row) return row
  }
  return null
}

/**
 * 新行的 id：从 row-1 起找第一个没用过的。
 * `extra` 是「已经定下、还没并进 columns 的那些 id」（收敛栏清单时一行一行地造，得自己带着）。
 */
function nextRowId(columns: HomeColumn[], extra?: Set<string>): RowId {
  const used = new Set(rowIds(columns))
  for (const id of extra ?? []) used.add(id)
  for (let n = 1; ; n += 1) {
    const id = `row-${n}`
    if (!used.has(id)) return id
  }
}

/**
 * 在某一栏右边拆出一栏：宽度跟着被拆的那一栏 —— 它是自适应的，新栏也自适应（两栏平分剩下的宽度）；
 * 它是固定宽度，新栏就一样宽。新栏里先摆一行（空栏也得有地方落卡片），
 * 高度模式跟着被拆那一栏的第一行走，看起来就是把那一栏切了一刀。
 *
 * 到上限（COLUMN_COUNT_MAX）或认不出 afterId 时原样返回。
 */
export function addColumn(columns: HomeColumn[], afterId: ColumnId): HomeColumn[] {
  const at = columns.findIndex((column) => column.id === afterId)
  if (at === -1 || columns.length >= COLUMN_COUNT_MAX) return columns

  const source = columns[at]
  const first = source.rows[0]
  const next = columns.map(cloneColumn)
  next.splice(at + 1, 0, {
    id: nextColumnId(columns),
    width: source.width,
    rows: [
      {
        id: nextRowId(columns),
        mode: first?.mode ?? 'flex',
        height: first?.height ?? ROW_HEIGHT_MIN_DEFAULT
      }
    ]
  })
  return next
}

/** 新栏的 id：从 col-1 起找第一个没用过的（收掉一栏再拆，不会和现有的撞上） */
function nextColumnId(columns: HomeColumn[]): ColumnId {
  const used = new Set(columnIds(columns))
  for (let n = 1; ; n += 1) {
    const id = `col-${n}`
    if (!used.has(id)) return id
  }
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
          ...cloneColumn(column),
          width: clampColumnWidth(widths[column.id], column.width ?? COLUMN_WIDTH_DEFAULT)
        }
      : cloneColumn(column)
  )
}

/**
 * 收掉一栏：栏里的行整条搬到相邻那一栏（左边有就并到左边，没有就并到右边，
 * 行的先后顺序、每一行的卡片与高度都原样带过去）。
 *
 * 卡片不用动：它们认的是行 id，行还在（只是换了一栏）。只剩一栏时返回 null
 * —— 首页总得留一栏给卡片落脚。
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

  const merged: HomeColumn = {
    ...target,
    rows: [...target.rows.map((row) => ({ ...row })), ...columns[at].rows.map((row) => ({ ...row }))]
  }
  const next = columns
    .filter((column) => column.id !== id)
    .map((column) => (column.id === target.id ? merged : cloneColumn(column)))

  // 搬过来的行里可能有空的（那一栏本来就空着），顺手收拾掉
  return { columns: pruneEmptyRows(next, cards), cards }
}

/** 收敛笔记页左栏宽度；非法值回到默认宽度 */
export function clampNoteTreeWidth(value: unknown): number {
  const fallback = NOTE_TREE_WIDTH_DEFAULT
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(NOTE_TREE_WIDTH_MAX, Math.max(NOTE_TREE_WIDTH_MIN, base))
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 默认布局里这块卡片所在的那一行（认不出的卡片补摆放时参照它） */
function defaultRowOf(id: HomeCardId): HomeRow {
  const row = rowOf(DEFAULT_THEME.columns, DEFAULT_THEME.cards[id].row)
  return row ?? { id: 'row-1', mode: 'flex', height: ROW_HEIGHT_MIN_DEFAULT }
}

/** 一块卡片在这一版默认布局里的栏 */
function defaultColumnIdOf(id: HomeCardId): ColumnId {
  return columnOfRow(DEFAULT_THEME.columns, DEFAULT_THEME.cards[id].row)?.id ?? DEFAULT_THEME.columns[0].id
}

/**
 * 一块卡片在默认布局那一栏里排第几位 —— 也就是它在老结构里那个 `order`。
 *
 * 迁移时用它给「老文件里没提到的卡片」补排序：那些卡片在本版默认布局里 order 一律是 0
 * （一卡一行），照搬 0 的话它们会退回到「按卡片清单的顺序」排，
 * 与用户眼前的默认布局不是一回事（我的项目会掉到系统状态后面）。
 */
function defaultRankOf(id: HomeCardId): number {
  const column = columnOfRow(DEFAULT_THEME.columns, DEFAULT_THEME.cards[id].row)
  const at = column?.rows.findIndex((row) => row.id === DEFAULT_THEME.cards[id].row) ?? -1
  return at === -1 ? 0 : at
}

/**
 * 卡片该落到哪一行：`wanted` 认得出就用它，否则**给它新开一行**
 * —— 追加到它在这一版默认布局里的那一栏（那一栏也不在就落到第一栏）。
 *
 * 认不出来的行是手改数据、或者「后加的一块卡片」带来的（老文件里根本没有这一行）。
 * 新开一行最接近老行为：老结构里卡片本来就是一卡一行，也免得它跟别的卡片挤在同一条槽里
 * —— 摆位摆到一块自己没看见的东西旁边，是最难排查的一种。
 *
 * `columns` 会被**就地**追加一行（这就是它不返回新数组的原因），传进来的必须是这份配置
 * 自己的那份栏清单（sanitizeTheme 里现造的那份），不能是 DEFAULT_THEME 的。
 */
function pickRow(
  columns: HomeColumn[],
  wanted: unknown,
  id: HomeCardId,
  keepDefaultRow: boolean
): RowId {
  if (isRowId(columns, wanted)) return wanted

  // 整份栏清单就是默认布局那一份（文件里一栏都没给出）时，它在默认布局里那一行也认：
  // 缺的那块于是回到它本来该在的位置上，而不是另起一行挤在末尾。
  // 只在这是默认骨架时才认 —— 别的文件里 row-1 未必还是第一栏的第一行，
  // 而且新造的行 id 也是从 row-1 起编号的，照单全收会让两块卡片挤进同一条槽。
  const fallbackRow = DEFAULT_THEME.cards[id].row
  if (keepDefaultRow && isRowId(columns, fallbackRow)) return fallbackRow

  const home = defaultColumnIdOf(id)
  const column = columns.find((item) => item.id === home) ?? columns[0]
  const source = defaultRowOf(id)
  const row: HomeRow = { id: nextRowId(columns), mode: source.mode, height: source.height }
  column.rows.push(row)
  return row.id
}

/**
 * 收敛单块卡片：行认不出来时给它新开一行（见 pickRow，`columns` 会被就地追加一行）；
 * order 先原样留着（后面统一重排）。
 */
export function sanitizeCardPlacement(
  value: unknown,
  id: HomeCardId,
  columns: HomeColumn[],
  keepDefaultRow = false
): CardPlacement {
  const fallback = DEFAULT_THEME.cards[id]
  const input = (value ?? {}) as Partial<CardPlacement>

  return {
    row: pickRow(columns, input.row, id, keepDefaultRow),
    order: Math.round(finiteOr(input.order, fallback.order)),
    // 关掉的状态只在明确写了 true 时才认（老主题文件里没有这个字段 = 开着）
    hidden: input.hidden === true
  }
}

/** 按行把 order 重排成 0..n-1：手改过的 order 有洞 / 重复也能收拾干净 */
export function normalizeOrder(
  cards: Record<HomeCardId, CardPlacement>
): Record<HomeCardId, CardPlacement> {
  const next = {} as Record<HomeCardId, CardPlacement>
  for (const id of HOME_CARD_IDS) next[id] = { ...cards[id] }

  // 要收拾的就是卡片实际落到的那些行，行清单本身不必参与
  const rows = [...new Set(HOME_CARD_IDS.map((id) => next[id].row))]
  for (const row of rows) {
    HOME_CARD_IDS.filter((id) => next[id].row === row)
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

/** 老文件里的栏骨架：v2 及更早是写死的左中右三栏（宽度住在 leftWidth / rightWidth），v3 是一份栏清单 */
function legacyColumns(input: Record<string, unknown>): unknown[] {
  if (Array.isArray(input.columns)) return input.columns
  return [
    { id: 'col-1', width: legacyWidth(input.leftWidth, DEFAULT_THEME.columns[0].width) },
    { id: 'col-2', width: null },
    { id: 'col-3', width: legacyWidth(input.rightWidth, DEFAULT_THEME.columns[2].width) }
  ]
}

/** 老文件里的卡片摆放：把 v2 的 left / center / right 换成 col-N，其余原样 */
function legacyCards(raw: unknown): Record<string, Record<string, unknown>> {
  const cards = (raw ?? {}) as Record<string, Record<string, unknown> | undefined>
  const next: Record<string, Record<string, unknown>> = {}
  for (const [id, placement] of Object.entries(cards)) {
    if (!placement) continue
    next[id] = { ...placement, column: LEGACY_COLUMN_IDS[String(placement.column)] ?? placement.column }
  }
  return next
}

/**
 * v3 及更早 → v4：老文件的首页是一维的「栏内从上往下排」，这里按**一张卡片一行**铺成行清单 ——
 * 每块卡片自己那份 mode / height 交给它新得到的那一行，所以升级之后看起来一模一样
 * （一行一张卡时，行高就是原来那张卡的高度）。
 *
 * 老文件里没提到的卡片（v1 那批、或者以后往里加的一块）沿用默认布局的栏与顺序，
 * 于是「整份认不出来」与「只缺一块」走的是同一条路：空对象翻出来就是默认布局。
 *
 * 返回的是**还没收敛**的原始数据（宽度、高度可能是任何东西），交给下面同一条收敛路径。
 * 行 id 顺着列出来（左栏六行、中栏一行、右栏两行 …… 见 DEFAULT_THEME 的注释）。
 */
function migrateLegacyLayout(input: Record<string, unknown>): Record<string, unknown> {
  // 只取栏骨架：老文件里本来就没有「行」这一层，那些行接下来按一卡一行现铺
  const { columns: skeleton } = columnSkeleton(legacyColumns(input))
  const columns: HomeColumn[] = skeleton.map((item) => ({ id: item.id, width: item.width, rows: [] }))
  const cards = legacyCards(input.cards)

  // 每块卡片先算出它的栏与栏内位置：老文件里没提到的沿用默认布局那一份
  const flat = HOME_CARD_IDS.map((id) => {
    const placement: Record<string, unknown> = cards[id] ?? {}
    const fallback = DEFAULT_THEME.cards[id]
    const wanted = placement.column
    const home = defaultColumnIdOf(id)
    return {
      id,
      column: isColumnId(columns, wanted) ? wanted : isColumnId(columns, home) ? home : columns[0].id,
      // 老文件里写过 order 的用它，没提到的按它在默认布局那一栏里排第几（见 defaultRankOf）
      order: Math.round(finiteOr(placement.order, defaultRankOf(id))),
      hidden: placement.hidden === true,
      mode: sanitizeCardMode(placement.mode, defaultRowOf(id).mode),
      height: finiteOr(placement.height, defaultRowOf(id).height)
    }
  })

  const migrated: Record<string, unknown> = {}
  let serial = 1
  for (const column of columns) {
    const mine = flat
      .filter((item) => item.column === column.id)
      .sort((a, b) => a.order - b.order || HOME_CARD_IDS.indexOf(a.id) - HOME_CARD_IDS.indexOf(b.id))

    column.rows = mine.map((item) => {
      const row: HomeRow = { id: `row-${serial}`, mode: item.mode, height: item.height }
      serial += 1
      // 一卡一行：卡片在自己那一行里排头一个
      migrated[item.id] = { row: row.id, order: 0, hidden: item.hidden }
      return row
    })
  }

  return { ...input, version: THEME_VERSION, columns, cards: migrated }
}

/**
 * 整份收敛：缺哪块补哪块，认不出来的值一律回到默认布局，最后把 order 排连续。
 *
 * 版本对不上时先走一遍迁移（见 migrateLegacyLayout）：老的一维布局按「一卡一行」翻成行清单，
 * 用户的摆放留着；翻不出东西来的（空对象、随手写的 JSON）就等同于回到默认布局 ——
 * 缺的都由下面逐项补齐。两条路走的是同一条收敛路径（每个字段都新造对象），
 * 所以不会改到 DEFAULT_THEME 那份常量。
 *
 * **往里加一块卡片不必动版本号**：老文件里缺的那块会按默认布局补上（见 pickRow，
 * 它会为这块卡片新开一行），用户自己摆过的位置一并留着。反过来，把某块从清单里拿掉才要动版本 ——
 * 老布局会在它那一行留下一块空位（v1 → v2 移出「项目列表」就是这种情况）。
 *
 * `updatedAt` 原样留着（缺省补 0）：它是同步用的时间戳，不是这里能判定的东西。
 */
export function sanitizeTheme(raw: unknown): ThemeConfig {
  const input = (raw ?? {}) as Partial<ThemeConfig>
  const base = (input.version === THEME_VERSION ? input : migrateLegacyLayout(input)) as Partial<ThemeConfig>
  const skeleton = columnSkeleton(base.columns)
  const columns = buildColumns(skeleton.columns)
  const rawCards = (base.cards ?? {}) as Partial<Record<HomeCardId, CardPlacement>>

  const cards = {} as Record<HomeCardId, CardPlacement>
  for (const id of HOME_CARD_IDS) {
    cards[id] = sanitizeCardPlacement(rawCards[id], id, columns, skeleton.isDefault)
  }

  // 卡片都认到行之后再收拾一遍：空行不留（迁移与手改都可能带来），行高按
  // 「这一行里最高的那条卡片下限」再夹一次 —— 卡片挪进来之后那条下限可能比存着的高度大
  const kept = clampRowHeights(pruneEmptyRows(columns, cards), cards)

  return {
    version: THEME_VERSION,
    cardGap: clampCardGap(base.cardGap),
    columns: kept,
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

/** 每行的高度夹到「这一行里最高的那条卡片下限」以上（就地之外造新对象，不动传进来的那份） */
function clampRowHeights(
  columns: HomeColumn[],
  cards: Record<HomeCardId, CardPlacement>
): HomeColumn[] {
  return columns.map((column) => ({
    ...column,
    rows: column.rows.map((row) => ({
      ...row,
      height: clampRowHeight(row.height, rowHeightMin(cards, row.id))
    }))
  }))
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
    layout.columns
      .map(
        (column) =>
          `${column.id}:${column.width ?? 'flex'}:${column.rows
            .map((row) => `${row.id}/${row.mode}/${row.height}`)
            .join('+')}`
      )
      .join(','),
    HOME_CARD_IDS.map((id) => {
      const card = layout.cards[id]
      return `${id}:${card.row}/${card.order}/${card.hidden}`
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

/** 某一行里的卡片 id，按 order 排好（含关掉的那些） */
export function cardIdsInRow(
  cards: Record<HomeCardId, CardPlacement>,
  row: RowId
): HomeCardId[] {
  return HOME_CARD_IDS.filter((id) => cards[id].row === row).sort(
    (a, b) => cards[a].order - cards[b].order
  )
}

/**
 * 某一行里**要画出来**的卡片：顺序同 cardIdsInRow，只是把关掉的滤掉。
 * 画布与「这一行还剩不剩东西」的判断都走它 —— 否则关掉一块卡会让空行照旧占着位置。
 */
export function visibleCardIdsInRow(
  cards: Record<HomeCardId, CardPlacement>,
  row: RowId
): HomeCardId[] {
  return cardIdsInRow(cards, row).filter((id) => !cards[id].hidden)
}

/** 这一栏平时要不要画：只要有一行还画得出卡片，这一栏就还在 */
export function columnHasVisibleCards(
  cards: Record<HomeCardId, CardPlacement>,
  column: HomeColumn
): boolean {
  return column.rows.some((row) => visibleCardIdsInRow(cards, row.id).length > 0)
}

/** 一行的高度下限：行里每块卡片各自的下限里最大的那个（空行用默认那条） */
export function rowHeightMin(cards: Record<HomeCardId, CardPlacement>, row: RowId): number {
  const ids = cardIdsInRow(cards, row)
  if (!ids.length) return ROW_HEIGHT_MIN_DEFAULT
  return Math.max(...ids.map((id) => CARD_HEIGHT_MIN[id]))
}

/** 一行在画布上占多高：固定高度按像素（不低于下限），自适应按下限示意 */
export function rowBoxHeight(row: HomeRow, min: number): number {
  return row.mode === 'flex' ? min : Math.max(row.height, min)
}

/**
 * 清掉一行卡片都没有的行，**每栏至少留一行**（卡片全被搬走的那一栏得留个落点）。
 *
 * 空行不进数据：拖走最后一块卡片时，那一行就跟着没了 —— 否则摆几次就会攒出一串空槽，
 * 而空槽在平时不渲染、编辑态又没有删除的入口，用户根本收拾不掉它。
 * 卡片全被关掉的行不算空（关掉只是不画，位置留着），所以这里按「有没有卡片」判，不按看得见看不见。
 */
export function pruneEmptyRows(
  columns: HomeColumn[],
  cards: Record<HomeCardId, CardPlacement>
): HomeColumn[] {
  return columns.map((column) => {
    const kept = column.rows.filter((row) => cardIdsInRow(cards, row.id).length > 0)
    if (kept.length) return { ...column, rows: kept }
    // 一栏总得留一行当落点；一栏一行都不剩（手改数据）时现造一条，id 照样从 row-1 起找
    const first = column.rows[0]
    return {
      ...column,
      rows: [
        first
          ? { ...first }
          : { id: nextRowId(columns), mode: 'flex' as CardMode, height: ROW_HEIGHT_MIN_DEFAULT }
      ]
    }
  })
}

/**
 * 拖一块卡片去新开一行时，那一行继承的高度：跟着它原来那一行走 —— 卡片换个地方，大小不变。
 * 认不出原来那一行（数据坏了）时给一个空的柔性行。
 */
export function rowShapeFor(
  cards: Record<HomeCardId, CardPlacement>,
  columns: HomeColumn[],
  id: HomeCardId
): Pick<HomeRow, 'mode' | 'height'> {
  const row = rowOf(columns, cards[id].row)
  return row ? { mode: row.mode, height: row.height } : { mode: 'flex', height: ROW_HEIGHT_MIN_DEFAULT }
}

/**
 * 把一块卡片挪到目标位置（拖放收手时走它），返回新的 cards 与 columns。
 *
 * 落点有两种（见 RowTarget）：
 * - 落进已有的一行：插到行内第 index 位，两张卡片之间按顺序让位；
 * - 另起一行：在 `rowIndex` 这一行前面新开一行，高度模式与高度跟着这条卡片原来那一行走
 *   （它挪个地方，大小不变）。
 *
 * 收尾两件事：卡片被搬空的那一行去掉（见 pruneEmptyRows）、固定高度的行装不下这块卡片时
 * 把行高提到它的下限（不然画布上被 min-height 撑起来，行头却还写着原来那个数）。
 * 行清单与卡片一起返回，是因为「另起一行」与「收掉空行」都会改到栏里的结构。
 */
export function moveCard(
  cards: Record<HomeCardId, CardPlacement>,
  columns: HomeColumn[],
  id: HomeCardId,
  target: RowTarget
): { cards: Record<HomeCardId, CardPlacement>; columns: HomeColumn[] } {
  const next = {} as Record<HomeCardId, CardPlacement>
  for (const cardId of HOME_CARD_IDS) next[cardId] = { ...cards[cardId] }

  const nextColumns = columns.map(cloneColumn)
  const column = nextColumns.find((item) => item.id === target.column)
  if (!column) return { cards, columns }

  let row: HomeRow
  if (target.newRow) {
    const shape = rowShapeFor(cards, columns, id)
    const at = Math.max(0, Math.min(Math.round(target.rowIndex), column.rows.length))
    row = { id: nextRowId(nextColumns), mode: shape.mode, height: shape.height }
    column.rows.splice(at, 0, row)
  } else {
    const wanted = column.rows[Math.max(0, Math.min(Math.round(target.rowIndex), column.rows.length - 1))]
    if (!wanted) return { cards, columns }
    row = wanted
  }

  next[id].row = row.id

  const rest = HOME_CARD_IDS.filter(
    (cardId) => cardId !== id && next[cardId].row === row.id
  ).sort((a, b) => next[a].order - next[b].order)

  const at = Math.max(0, Math.min(Math.round(target.index), rest.length))
  rest.splice(at, 0, id)
  rest.forEach((cardId, order) => {
    next[cardId].order = order
  })

  const normalized = normalizeOrder(next)
  if (row.mode === 'fixed') row.height = Math.max(row.height, rowHeightMin(normalized, row.id))

  return { cards: normalized, columns: pruneEmptyRows(nextColumns, normalized) }
}

/**
 * 拖动行下边缘改高度：落到整数像素（吸附网格就是 1px），不低于这一行的下限。
 *
 * 界面上的拖动都是按指针位置现算的浮点数，不取整的话高度会是一串小数，
 * 卡片间距与总高度跟着出现半像素的错位。
 */
export function resizeRowHeight(start: number, dy: number, min: number): number {
  return Math.min(ROW_HEIGHT_MAX, Math.max(min, Math.round(start + dy)))
}
