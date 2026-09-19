import { describe, expect, it } from 'vitest'
import {
  CARD_GAP_DEFAULT,
  CARD_GAP_MAX,
  CARD_GAP_MIN,
  CARD_HEIGHT_MIN,
  COLUMN_COUNT_MAX,
  COLUMN_WIDTH_DEFAULT,
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  DEFAULT_THEME,
  HOME_CARD_IDS,
  NOTE_TREE_WIDTH_DEFAULT,
  NOTE_TREE_WIDTH_MAX,
  NOTE_TREE_WIDTH_MIN,
  ROW_HEIGHT_MAX,
  ROW_HEIGHT_MIN_DEFAULT,
  THEME_VERSION,
  addColumn,
  cardIdsInRow,
  clampCardGap,
  clampColumnWidth,
  clampNoteTreeWidth,
  clampRowHeight,
  columnHasVisibleCards,
  columnIds,
  columnOfRow,
  moveCard,
  normalizeOrder,
  pruneEmptyRows,
  removeColumn,
  resizeColumnPair,
  resizeRowHeight,
  rowBoxHeight,
  rowHeightMin,
  rowIds,
  rowOf,
  rowShapeFor,
  sameThemeContent,
  sanitizeCardMode,
  sanitizeTheme,
  setColumnWidths,
  visibleCardIdsInRow,
  type CardPlacement,
  type HomeCardId,
  type HomeColumn
} from './theme'

/**
 * 算法用例（移动 / 拆栏 / 收栏）的固定夹具：三栏五行，一行里可能并着好几张卡片。
 * 用它而不是 DEFAULT_THEME —— 默认布局再改也不会波及这些断言。
 */
function sampleColumns(): HomeColumn[] {
  return [
    {
      id: 'col-1',
      width: 300,
      rows: [
        { id: 'row-1', mode: 'fixed', height: 200 },
        { id: 'row-2', mode: 'fixed', height: 150 }
      ]
    },
    { id: 'col-2', width: null, rows: [{ id: 'row-3', mode: 'flex', height: 240 }] },
    { id: 'col-3', width: 320, rows: [{ id: 'row-4', mode: 'fixed', height: 260 }] }
  ]
}

function sampleCards(): Record<HomeCardId, CardPlacement> {
  return {
    activity: { row: 'row-1', order: 0, hidden: false },
    token: { row: 'row-1', order: 1, hidden: false },
    system: { row: 'row-2', order: 0, hidden: false },
    recent: { row: 'row-2', order: 1, hidden: false },
    quick: { row: 'row-3', order: 0, hidden: false },
    commands: { row: 'row-3', order: 1, hidden: false },
    actions: { row: 'row-4', order: 0, hidden: false },
    work: { row: 'row-4', order: 1, hidden: false },
    news: { row: 'row-4', order: 2, hidden: false }
  }
}

describe('clampCardGap', () => {
  it('区间内的值原样返回，四舍五入成整数', () => {
    expect(clampCardGap(14)).toBe(14)
    expect(clampCardGap(13.6)).toBe(14)
    expect(clampCardGap(CARD_GAP_MIN)).toBe(CARD_GAP_MIN)
    expect(clampCardGap(CARD_GAP_MAX)).toBe(CARD_GAP_MAX)
  })

  it('越界收敛到边界，非有限数字回落到默认值', () => {
    expect(clampCardGap(-5)).toBe(CARD_GAP_MIN)
    expect(clampCardGap(999)).toBe(CARD_GAP_MAX)
    expect(clampCardGap(undefined)).toBe(CARD_GAP_DEFAULT)
    expect(clampCardGap('14')).toBe(CARD_GAP_DEFAULT)
    expect(clampCardGap(Number.NaN)).toBe(CARD_GAP_DEFAULT)
  })
})

describe('clampColumnWidth', () => {
  it('区间内的值原样返回', () => {
    expect(clampColumnWidth(300, COLUMN_WIDTH_DEFAULT)).toBe(300)
    expect(clampColumnWidth(COLUMN_WIDTH_DEFAULT, COLUMN_WIDTH_DEFAULT)).toBe(COLUMN_WIDTH_DEFAULT)
  })

  it('越界收敛到边界', () => {
    expect(clampColumnWidth(10, 300)).toBe(COLUMN_WIDTH_MIN)
    expect(clampColumnWidth(99999, 300)).toBe(COLUMN_WIDTH_MAX)
  })

  it('非有限数字回退到 fallback', () => {
    expect(clampColumnWidth(undefined, 333)).toBe(333)
    expect(clampColumnWidth('300', 333)).toBe(333)
    expect(clampColumnWidth(Number.NaN, 333)).toBe(333)
  })
})

describe('clampRowHeight', () => {
  it('不低于这一行的下限，不高于全局上限', () => {
    expect(clampRowHeight(1, 160)).toBe(160)
    expect(clampRowHeight(999999, 160)).toBe(ROW_HEIGHT_MAX)
    expect(clampRowHeight(240, 160)).toBe(240)
  })

  it('非法值回落到下限（也就是「这一行最矮能有多少」）', () => {
    expect(clampRowHeight(undefined, 130)).toBe(130)
    expect(clampRowHeight('高一点', 130)).toBe(130)
    expect(clampRowHeight(Number.NaN, 130)).toBe(130)
  })
})

describe('sanitizeCardMode', () => {
  it('只认 fixed / flex，其余回落到 fallback', () => {
    expect(sanitizeCardMode('flex', 'fixed')).toBe('flex')
    expect(sanitizeCardMode('fixed', 'flex')).toBe('fixed')
    expect(sanitizeCardMode(undefined, 'flex')).toBe('flex')
    expect(sanitizeCardMode('auto', 'fixed')).toBe('fixed')
    expect(sanitizeCardMode(1, 'flex')).toBe('flex')
  })
})

describe('sanitizeTheme', () => {
  it('缺哪块补哪块，九块一定齐全', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      cards: { quick: { row: 'row-1', order: 0 } }
    })
    expect(Object.keys(result.cards).sort()).toEqual([...HOME_CARD_IDS].sort())
    // 没在入参里出现的卡片沿用默认布局（order 会被重排成连续序号，故只比对其余字段）
    expect(result.cards.recent).toMatchObject({
      row: DEFAULT_THEME.cards.recent.row,
      hidden: false
    })
  })

  it('整份认不出来时就是默认布局', () => {
    expect(sanitizeTheme(null)).toEqual(DEFAULT_THEME)
    expect(sanitizeTheme({ hack: true })).toEqual(DEFAULT_THEME)
  })

  it('收敛是幂等的：把结果再喂一遍，一个字段都不动', () => {
    const once = sanitizeTheme({ version: THEME_VERSION, cardGap: 30, noteTreeWidth: 300 })
    expect(sanitizeTheme(once)).toEqual(once)
  })

  /** v3 的首页是「栏内从上往下排」，v4 加了一层行：老文件要一字不差地翻过来 */
  it('v3 的一维布局按「一卡一行」翻成行清单，栏宽与摆放都留着', () => {
    const legacy = {
      version: 3,
      cardGap: 30,
      columns: [
        { id: 'col-1', width: 420 },
        { id: 'col-2', width: null },
        { id: 'col-3', width: 380 }
      ],
      cards: { commands: { column: 'col-3', order: 0, mode: 'flex', height: 300 } }
    }
    const result = sanitizeTheme(legacy)

    expect(columnIds(result.columns)).toEqual(['col-1', 'col-2', 'col-3'])
    expect(result.columns.map((column) => column.width)).toEqual([420, null, 380])
    expect(result.cardGap).toBe(30)

    // 左栏剩下五张卡各占一行（命令被老文件挪去了右栏），高度与模式就是它们原来那一份
    expect(result.columns[0].rows).toEqual([
      { id: 'row-1', mode: 'fixed', height: 183 },
      { id: 'row-2', mode: 'fixed', height: 103 },
      { id: 'row-3', mode: 'fixed', height: 170 },
      { id: 'row-4', mode: 'fixed', height: 198 },
      { id: 'row-5', mode: 'flex', height: 727 }
    ])
    // 挪到右栏的命令夹在 Token 用量与 AI 热点之间（老文件里 order 0，与 Token 用量并列时按卡片清单的顺序）
    expect(result.columns[2].rows).toEqual([
      { id: 'row-7', mode: 'flex', height: 727 },
      { id: 'row-8', mode: 'flex', height: 300 },
      { id: 'row-9', mode: 'fixed', height: 345 }
    ])
    expect(result.cards.commands).toEqual({ row: 'row-8', order: 0, hidden: false })
  })

  it('更早的版本（v1 / v2）也照样翻：认不出的卡片由默认布局补上，不会整份回默认', () => {
    const result = sanitizeTheme({
      version: 2,
      leftWidth: 300,
      cards: { recent: { column: 'left', order: 0, mode: 'fixed', height: 200 } }
    })

    expect(columnIds(result.columns)).toEqual(['col-1', 'col-2', 'col-3'])
    expect(result.columns[0].width).toBe(300)
    expect(columnOfRow(result.columns, result.cards.recent.row)?.id).toBe('col-1')
    expect(rowOf(result.columns, result.cards.recent.row)).toMatchObject({ mode: 'fixed', height: 200 })
  })

  /** 笔记页左栏宽度是后加的字段：老主题文件里没有它，得补默认值而不是当成 0 */
  it('笔记页左栏宽度缺省用默认值，越界收敛', () => {
    expect(sanitizeTheme({}).noteTreeWidth).toBe(NOTE_TREE_WIDTH_DEFAULT)
    expect(clampNoteTreeWidth(undefined)).toBe(NOTE_TREE_WIDTH_DEFAULT)
    expect(clampNoteTreeWidth('宽一点')).toBe(NOTE_TREE_WIDTH_DEFAULT)
    expect(sanitizeTheme({ version: THEME_VERSION, noteTreeWidth: 9999 }).noteTreeWidth).toBe(
      NOTE_TREE_WIDTH_MAX
    )
    expect(sanitizeTheme({ version: THEME_VERSION, noteTreeWidth: 1 }).noteTreeWidth).toBe(
      NOTE_TREE_WIDTH_MIN
    )
    expect(sanitizeTheme({ version: THEME_VERSION, noteTreeWidth: 300 }).noteTreeWidth).toBe(300)
  })

  it('卡片间距缺省用默认值，越界收敛', () => {
    expect(sanitizeTheme({}).cardGap).toBe(CARD_GAP_DEFAULT)
    expect(sanitizeTheme({ version: THEME_VERSION, cardGap: 999 }).cardGap).toBe(CARD_GAP_MAX)
    expect(sanitizeTheme({ version: THEME_VERSION, cardGap: 3 }).cardGap).toBe(3)
  })

  /**
   * 认不出的行（手改数据、或者以后往里加的一块卡片）不给它跟别人挤一行：
   * 新开一行，落在这块卡片默认那一栏里。
   */
  it('卡片引用一个不存在的行时给它新开一行，落在默认那一栏', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      columns: [{ id: 'col-1', width: 300, rows: [{ id: 'row-a', mode: 'fixed', height: 200 }] }],
      cards: { quick: { row: '不存在的行', order: 0 } }
    })

    const row = cardIdsInRow(result.cards, result.cards.quick.row)
    expect(row).toEqual(['quick'])
    expect(columnOfRow(result.columns, result.cards.quick.row)?.id).toBe('col-1')
    // 已经是认得出的行就原样留着
    expect(rowIds(result.columns).length).toBeGreaterThan(1)
  })

  it('行清单的收敛：空行不留，认不出的模式按自适应，没有 id 的行丢掉', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      columns: [
        {
          id: 'col-1',
          width: 300,
          rows: [
            { id: 'row-a', mode: '怪', height: 200 },
            { height: 200 },
            { id: 'row-b', mode: 'fixed', height: 200 }
          ]
        }
      ],
      cards: { quick: { row: 'row-a', order: 0 }, token: { row: 'row-b', order: 0 } }
    })

    expect(rowIds(result.columns)).toContain('row-a')
    expect(rowIds(result.columns)).toContain('row-b')
    expect(rowOf(result.columns, 'row-a')?.mode).toBe('flex')
  })

  it('一栏里一张卡片都没有时也留一行（那是往这一栏拖卡片的落点）', () => {
    const everyOneInCol2 = Object.fromEntries(
      HOME_CARD_IDS.map((id) => [id, { row: 'row-b', order: 0 }])
    )
    const result = sanitizeTheme({
      version: THEME_VERSION,
      columns: [
        { id: 'col-1', width: 300, rows: [{ id: 'row-a', mode: 'fixed', height: 200 }] },
        { id: 'col-2', width: 300, rows: [{ id: 'row-b', mode: 'flex', height: 200 }] }
      ],
      cards: everyOneInCol2
    })

    expect(rowIds(result.columns)).toEqual(['row-a', 'row-b'])
    expect(cardIdsInRow(result.cards, 'row-a')).toEqual([])
  })

  it('行高按这一行里最高的那条卡片下限夹住', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      columns: [
        {
          id: 'col-1',
          width: 300,
          rows: [
            { id: 'row-a', mode: 'fixed', height: 10 },
            { id: 'row-b', mode: 'fixed', height: 10 }
          ]
        }
      ],
      cards: { token: { row: 'row-a', order: 0 }, quick: { row: 'row-b', order: 0 } }
    })

    // token 的下限 160 把 10px 顶上去；快捷启动只有 76，10 也照样顶到 76
    expect(rowOf(result.columns, 'row-a')?.height).toBe(CARD_HEIGHT_MIN.token)
    expect(rowOf(result.columns, 'row-b')?.height).toBe(CARD_HEIGHT_MIN.quick)
  })

  it('栏清单的收敛：越界宽度夹住、没有 id 的丢掉、超过上限截掉', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      columns: [
        { id: 'col-1', width: 99999 },
        { width: 300 },
        { id: 'col-1', width: 300 },
        ...Array.from({ length: 8 }, (_, index) => ({ id: `col-x${index}`, width: 260 }))
      ]
    })

    expect(result.columns.length).toBe(COLUMN_COUNT_MAX)
    expect(result.columns[0].width).toBe(COLUMN_WIDTH_MAX)
    // 缺 id 与重复 id 都被丢掉，所以第二栏是第一个 col-x0
    expect(result.columns[1].id).toBe('col-x0')
  })

  it('一栏都没有（老文件、手改坏了）时摆回默认三栏，不留一个没有落脚处的首页', () => {
    const result = sanitizeTheme({ version: THEME_VERSION, columns: [] })
    expect(result.columns).toEqual(DEFAULT_THEME.columns)
    expect(columnIds(result.columns)).toEqual(['col-1', 'col-2', 'col-3'])
  })

  it('order 有洞 / 重复时按行重排成连续序号', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      columns: sampleColumns(),
      cards: {
        activity: { row: 'row-1', order: 5 },
        token: { row: 'row-1', order: 5 },
        system: { row: 'row-2', order: 9 },
        recent: { row: 'row-2', order: 0 },
        quick: { row: 'row-3', order: 3 },
        commands: { row: 'row-3', order: 9 },
        actions: { row: 'row-4', order: 7 },
        work: { row: 'row-4', order: 2 },
        news: { row: 'row-4', order: 9 }
      }
    })

    expect(cardIdsInRow(result.cards, 'row-1')).toEqual(['activity', 'token'])
    expect(result.cards.activity.order).toBe(0)
    expect(result.cards.token.order).toBe(1)
    expect(cardIdsInRow(result.cards, 'row-2')).toEqual(['recent', 'system'])
    expect(cardIdsInRow(result.cards, 'row-3')).toEqual(['quick', 'commands'])
    expect(cardIdsInRow(result.cards, 'row-4')).toEqual(['work', 'actions', 'news'])
    expect(result.cards.news.order).toBe(2)
  })

  it('默认布局：三栏各自的行高与模式，一张卡片一行', () => {
    expect(DEFAULT_THEME.columns.map((column) => [column.id, column.width])).toEqual([
      ['col-1', 373],
      ['col-2', null],
      ['col-3', 345]
    ])
    expect(rowIds(DEFAULT_THEME.columns)).toEqual([
      'row-1',
      'row-2',
      'row-3',
      'row-4',
      'row-5',
      'row-6',
      'row-7',
      'row-8',
      'row-9'
    ])
    expect(cardIdsInRow(DEFAULT_THEME.cards, 'row-1')).toEqual(['activity'])
    expect(cardIdsInRow(DEFAULT_THEME.cards, 'row-7')).toEqual(['recent'])
    expect(cardIdsInRow(DEFAULT_THEME.cards, 'row-8')).toEqual(['token'])
    expect(cardIdsInRow(DEFAULT_THEME.cards, 'row-9')).toEqual(['news'])
    // 左栏的今日完成、中栏的最近使用、右栏的 Token 用量各占一行 flex，吃掉所在栏剩余高度
    expect(rowOf(DEFAULT_THEME.columns, 'row-1')?.mode).toBe('fixed')
    expect(rowOf(DEFAULT_THEME.columns, 'row-6')?.mode).toBe('flex')
    expect(rowOf(DEFAULT_THEME.columns, 'row-7')?.mode).toBe('flex')
    expect(rowOf(DEFAULT_THEME.columns, 'row-8')?.mode).toBe('flex')
    expect(rowOf(DEFAULT_THEME.columns, 'row-9')?.mode).toBe('fixed')
  })
})

describe('normalizeOrder', () => {
  it('不改行与高度，只把 order 排连续', () => {
    const cards = sampleCards()
    for (const id of HOME_CARD_IDS) cards[id] = { ...cards[id], order: 42 }
    const next = normalizeOrder(cards)
    // 同一行里 order 全相同时按 HOME_CARD_IDS 的声明顺序兜底（active 比 token 早）
    expect(cardIdsInRow(next, 'row-1')).toEqual(['activity', 'token'])
    expect(cards.activity.order).toBe(42)
  })
})

describe('moveCard', () => {
  it('落进已有的一行：插到行内第 index 位', () => {
    const { cards } = moveCard(sampleCards(), sampleColumns(), 'quick', {
      column: 'col-1',
      rowIndex: 0,
      newRow: false,
      index: 1
    })
    expect(cardIdsInRow(cards, 'row-1')).toEqual(['activity', 'quick', 'token'])
  })

  it('行内换位：前移 / 后移都按插入位算', () => {
    const forward = moveCard(sampleCards(), sampleColumns(), 'token', {
      column: 'col-1',
      rowIndex: 0,
      newRow: false,
      index: 0
    })
    expect(cardIdsInRow(forward.cards, 'row-1')).toEqual(['token', 'activity'])
  })

  it('落点行号越界会被夹住（落进最后一行）', () => {
    const { cards } = moveCard(sampleCards(), sampleColumns(), 'quick', {
      column: 'col-1',
      rowIndex: 99,
      newRow: false,
      index: 0
    })
    expect(cardIdsInRow(cards, 'row-2')).toEqual(['quick', 'system', 'recent'])
  })

  it('另起一行：插在指定行前面，高度跟着这块卡片原来那一行', () => {
    const { cards, columns } = moveCard(sampleCards(), sampleColumns(), 'work', {
      column: 'col-1',
      rowIndex: 1,
      newRow: true,
      index: 0
    })

    const list = columns.find((column) => column.id === 'col-1')!
    expect(list.rows.map((row) => row.id)).toEqual(['row-1', cards.work.row, 'row-2'])
    // 原来那一行（row-4）是固定 260，新开的一行照搬
    expect(rowOf(columns, cards.work.row)).toEqual({ id: cards.work.row, mode: 'fixed', height: 260 })
    expect(cardIdsInRow(cards, cards.work.row)).toEqual(['work'])
  })

  it('另起一行落在栏末尾：行号越界时就插到最后', () => {
    const { cards, columns } = moveCard(sampleCards(), sampleColumns(), 'news', {
      column: 'col-1',
      rowIndex: 99,
      newRow: true,
      index: 0
    })

    const list = columns.find((column) => column.id === 'col-1')!
    expect(list.rows[list.rows.length - 1].id).toBe(cards.news.row)
  })

  it('卡片被搬空的那一行跟着没了', () => {
    const first = moveCard(sampleCards(), sampleColumns(), 'activity', {
      column: 'col-3',
      rowIndex: 0,
      newRow: false,
      index: 0
    })
    expect(rowIds(first.columns)).toContain('row-1')

    const second = moveCard(first.cards, first.columns, 'token', {
      column: 'col-3',
      rowIndex: 0,
      newRow: false,
      index: 1
    })
    expect(rowIds(second.columns)).not.toContain('row-1')
    // 两次都插在第 index 位上：先插进去的 activity 排在 actions 前面，token 又插到它后面
    expect(cardIdsInRow(second.cards, 'row-4')).toEqual(['activity', 'token', 'actions', 'work', 'news'])
  })

  it('固定高度的行装不下这块卡片时，行高提到它的下限', () => {
    // token 的下限是 160，而 row-2 只存着 150
    const { columns } = moveCard(sampleCards(), sampleColumns(), 'token', {
      column: 'col-1',
      rowIndex: 1,
      newRow: false,
      index: 0
    })
    expect(rowOf(columns, 'row-2')?.height).toBe(160)
  })

  it('认不出的栏原样返回', () => {
    const cards = sampleCards()
    const columns = sampleColumns()
    const result = moveCard(cards, columns, 'quick', {
      column: '没有这一栏',
      rowIndex: 0,
      newRow: false,
      index: 0
    })
    expect(result.cards).toBe(cards)
    expect(result.columns).toBe(columns)
  })

  it('不动传入的对象', () => {
    const cards = sampleCards()
    const columns = sampleColumns()
    moveCard(cards, columns, 'token', { column: 'col-3', rowIndex: 0, newRow: false, index: 0 })

    expect(cards.token.row).toBe('row-1')
    expect(columns[0].rows.length).toBe(2)
    expect(columns[0].rows[1].height).toBe(150)
  })
})

describe('pruneEmptyRows', () => {
  it('每栏至少留一行：一栏的卡片全搬走时，留下第一行当落点', () => {
    const cards = sampleCards()
    for (const id of HOME_CARD_IDS) cards[id].row = 'row-4'
    const next = pruneEmptyRows(sampleColumns(), cards)

    expect(next.map((column) => column.rows.map((row) => row.id))).toEqual([
      ['row-1'],
      ['row-3'],
      ['row-4']
    ])
  })
})

describe('拆栏 / 收栏', () => {
  it('新栏拆在它右边，宽度跟着被拆的那一栏，里面先摆一行', () => {
    const next = addColumn(sampleColumns(), 'col-2')

    expect(columnIds(next)).toEqual(['col-1', 'col-2', 'col-4', 'col-3'])
    expect(next[2].width).toBeNull()
    // 新栏里那一行跟着被拆那一栏的第一行走（自适应拆出自适应）
    expect(next[2].rows).toEqual([{ id: 'row-5', mode: 'flex', height: 240 }])
  })

  it('固定宽度的栏拆出来也一样宽，新行跟着它的第一行', () => {
    const next = addColumn(sampleColumns(), 'col-1')

    expect(columnIds(next)).toEqual(['col-1', 'col-4', 'col-2', 'col-3'])
    expect(next[1].width).toBe(300)
    expect(next[1].rows).toEqual([{ id: 'row-5', mode: 'fixed', height: 200 }])
  })

  it('到栏数上限就不再拆（原样返回同一份）', () => {
    let columns = sampleColumns()
    while (columns.length < COLUMN_COUNT_MAX) {
      columns = addColumn(columns, columns[columns.length - 1].id)
    }

    expect(columns.length).toBe(COLUMN_COUNT_MAX)
    expect(addColumn(columns, columns[0].id)).toBe(columns)
  })

  it('收栏时栏里的行整条搬到左边那一栏，行里的卡片与高度都带过去', () => {
    const removed = removeColumn(sampleCards(), sampleColumns(), 'col-3')

    expect(columnIds(removed!.columns)).toEqual(['col-1', 'col-2'])
    expect(rowIds(removed!.columns)).toEqual(['row-1', 'row-2', 'row-3', 'row-4'])
    expect(cardIdsInRow(removed!.cards, 'row-4')).toEqual(['actions', 'work', 'news'])
    expect(rowOf(removed!.columns, 'row-4')).toEqual({ id: 'row-4', mode: 'fixed', height: 260 })
  })

  it('第一栏被收掉时行并到右边那一栏', () => {
    const removed = removeColumn(sampleCards(), sampleColumns(), 'col-1')

    expect(columnIds(removed!.columns)).toEqual(['col-2', 'col-3'])
    expect(rowIds(removed!.columns)).toEqual(['row-3', 'row-1', 'row-2', 'row-4'])
  })

  it('只剩一栏时收不掉：首页总得留一栏给卡片落脚', () => {
    expect(
      removeColumn(sampleCards(), [{ id: 'col-1', width: null, rows: [{ id: 'row-1', mode: 'flex', height: 200 }] }], 'col-1')
    ).toBeNull()
  })

  it('不动传入的对象', () => {
    const cards = sampleCards()
    const columns = sampleColumns()
    removeColumn(cards, columns, 'col-2')

    expect(columns.length).toBe(3)
    expect(cards.quick.row).toBe('row-3')
  })

  it('栏的变化也算内容变了（同步要跟着刷新时间戳）', () => {
    const before = sanitizeTheme(DEFAULT_THEME)
    const after = sanitizeTheme({ ...before, columns: addColumn(before.columns, 'col-1') })

    expect(sameThemeContent(before, after)).toBe(false)
  })
})

describe('resizeColumnPair', () => {
  it('往右拖：左栏变宽、右栏变窄，两栏之和不变', () => {
    const [left, right] = resizeColumnPair(300, 400, 50)
    expect(left).toBe(350)
    expect(right).toBe(350)
  })

  it('往左拖同理（右栏变宽）', () => {
    const [left, right] = resizeColumnPair(300, 400, -80)
    expect(left).toBe(220)
    expect(right).toBe(480)
  })

  it('哪一边先撞到区间就一起停住，和守得住', () => {
    // 左栏撞下限：停在 220，右栏拿剩下的
    const [left, right] = resizeColumnPair(250, 400, -100)
    expect(left).toBe(COLUMN_WIDTH_MIN)
    expect(right).toBe(400 + 250 - COLUMN_WIDTH_MIN)
  })

  it('右栏撞下限时也一样（左栏不再继续变宽）', () => {
    const [left, right] = resizeColumnPair(300, 240, 200)
    expect(right).toBe(COLUMN_WIDTH_MIN)
    expect(left).toBe(300 + 240 - COLUMN_WIDTH_MIN)
  })

  it('撞上限时同理', () => {
    // 左栏到顶就停住，右栏拿和里剩下的那部分
    const [left, right] = resizeColumnPair(COLUMN_WIDTH_MAX - 10, 400, 100)
    expect(left).toBe(COLUMN_WIDTH_MAX)
    expect(right).toBe(COLUMN_WIDTH_MAX - 10 + 400 - COLUMN_WIDTH_MAX)
    expect(left + right).toBe(COLUMN_WIDTH_MAX - 10 + 400)
  })

  it('取整落到整数像素', () => {
    const [left, right] = resizeColumnPair(300, 400, 12.6)
    expect(left).toBe(313)
    expect(right).toBe(387)
  })

  it('这个和根本放不下两栏的下限时原样不动（手改出来的极端数据）', () => {
    expect(resizeColumnPair(100, 100, 50)).toEqual([100, 100])
  })
})

describe('setColumnWidths', () => {
  it('只改列出来的那几栏，其余原样留着', () => {
    const next = setColumnWidths(sampleColumns(), { 'col-1': 400, 'col-3': 300 })

    expect(columnIds(next)).toEqual(['col-1', 'col-2', 'col-3'])
    expect(next[0].width).toBe(400)
    expect(next[1].width).toBeNull()
    expect(next[2].width).toBe(300)
  })

  it('给定值夹到区间', () => {
    const next = setColumnWidths(sampleColumns(), { 'col-3': 99999 })
    expect(next[2].width).toBe(COLUMN_WIDTH_MAX)
  })

  it('不改传入的那份（行也是深拷贝）', () => {
    const columns = sampleColumns()
    const next = setColumnWidths(columns, { 'col-1': 400 })
    next[0].rows[0].height = 999

    expect(columns[0].width).toBe(300)
    expect(columns[0].rows[0].height).toBe(200)
  })
})

describe('resizeRowHeight', () => {
  it('落到整数像素（吸附网格就是 1px）', () => {
    expect(resizeRowHeight(200, 37, 150)).toBe(237)
    expect(resizeRowHeight(200, 36.4, 150)).toBe(236)
    expect(resizeRowHeight(200.6, 0, 150)).toBe(201)
  })

  it('不低于下限', () => {
    expect(resizeRowHeight(200, -9999, 150)).toBe(150)
  })

  it('不高于上限', () => {
    expect(resizeRowHeight(200, 999999, 150)).toBe(ROW_HEIGHT_MAX)
  })
})

describe('行与卡片的关系', () => {
  it('行的高度下限取行里最高那张卡片的下限；空行用默认那条', () => {
    // activity 130 / token 160 → 160
    expect(rowHeightMin(sampleCards(), 'row-1')).toBe(CARD_HEIGHT_MIN.token)
    expect(rowHeightMin(sampleCards(), '没有这一行')).toBe(ROW_HEIGHT_MIN_DEFAULT)
  })

  it('行在画布上占的高：固定的按像素（不低于下限），自适应的按下限示意', () => {
    expect(rowBoxHeight({ id: 'r', mode: 'fixed', height: 300 }, 100)).toBe(300)
    expect(rowBoxHeight({ id: 'r', mode: 'fixed', height: 80 }, 100)).toBe(100)
    expect(rowBoxHeight({ id: 'r', mode: 'flex', height: 900 }, 100)).toBe(100)
  })

  it('新开一行时继承的高度：跟着卡片原来那一行；原来那一行认不出时给一条柔性行', () => {
    expect(rowShapeFor(sampleCards(), sampleColumns(), 'token')).toEqual({
      mode: 'fixed',
      height: 200
    })
    expect(rowShapeFor(sampleCards(), [], 'token')).toEqual({
      mode: 'flex',
      height: ROW_HEIGHT_MIN_DEFAULT
    })
  })

  it('行住在哪一栏：columnOfRow / rowOf 都认 id', () => {
    const columns = sampleColumns()
    expect(columnOfRow(columns, 'row-3')?.id).toBe('col-2')
    expect(columnOfRow(columns, '没有这一行')).toBeNull()
    expect(rowOf(columns, 'row-4')).toEqual({ id: 'row-4', mode: 'fixed', height: 260 })
    expect(rowOf(columns, '没有这一行')).toBeNull()
  })

  it('一行里的卡片全被关掉时整行不画，那一栏跟着也不画', () => {
    const cards = sampleCards()
    for (const id of ['quick', 'commands'] as HomeCardId[]) cards[id].hidden = true

    expect(visibleCardIdsInRow(cards, 'row-3')).toEqual([])
    // 满栏的行照旧画
    expect(visibleCardIdsInRow(cards, 'row-1')).toEqual(['activity', 'token'])
    expect(columnHasVisibleCards(cards, sampleColumns()[1])).toBe(false)
    expect(columnHasVisibleCards(cards, sampleColumns()[0])).toBe(true)
  })
})

describe('关掉的卡片', () => {
  /** 把某几块卡片标成关掉的，返回一整份合法的 cards */
  function cardsWithHidden(hidden: HomeCardId[]): Record<HomeCardId, CardPlacement> {
    const cards = {} as Record<HomeCardId, CardPlacement>
    for (const id of HOME_CARD_IDS) cards[id] = { ...DEFAULT_THEME.cards[id] }
    for (const id of hidden) cards[id].hidden = true
    return cards
  }

  it('缺省是开着的：老主题文件里没有这个字段，也只有明确的 true 才算关', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      cards: { quick: { row: DEFAULT_THEME.cards.quick.row, order: 0 } }
    })
    expect(result.cards.quick.hidden).toBe(false)

    const loose = sanitizeTheme({
      version: THEME_VERSION,
      cards: { quick: { hidden: 'yes' }, work: { hidden: 1 } }
    })
    expect(loose.cards.quick.hidden).toBe(false)
    expect(loose.cards.work.hidden).toBe(false)

    const off = sanitizeTheme({ version: THEME_VERSION, cards: { quick: { hidden: true } } })
    expect(off.cards.quick.hidden).toBe(true)
  })

  it('至少留一块：全关掉时第一块会被放开，首页不会是空白', () => {
    const result = sanitizeTheme({ version: THEME_VERSION, cards: cardsWithHidden([...HOME_CARD_IDS]) })

    expect(result.cards[HOME_CARD_IDS[0]].hidden).toBe(false)
    expect(HOME_CARD_IDS.filter((id) => !result.cards[id].hidden)).toEqual([HOME_CARD_IDS[0]])
  })

  it('关掉只是不画：它那一行与行内的位置照旧留着，再打开时回到原处', () => {
    const result = sanitizeTheme({ version: THEME_VERSION, cards: cardsWithHidden(['recent']) })

    expect(result.cards.recent).toEqual({ ...DEFAULT_THEME.cards.recent, hidden: true })
    // 行里的清单不受影响（它是「摆了哪些」，画不画由 visibleCardIdsInRow 决定）
    expect(cardIdsInRow(result.cards, DEFAULT_THEME.cards.recent.row)).toEqual(['recent'])
    expect(visibleCardIdsInRow(result.cards, DEFAULT_THEME.cards.recent.row)).not.toContain('recent')
  })

  it('关掉一块卡片也算内容变了（同步要跟着刷新时间戳）', () => {
    const before = sanitizeTheme(DEFAULT_THEME)
    const after = sanitizeTheme({ version: THEME_VERSION, cards: cardsWithHidden(['quick']) })
    expect(sameThemeContent(before, after)).toBe(false)
  })

  it('行高与行的高度模式也是内容，改了要算变（否则同步会漏掉这一笔）', () => {
    const before = sanitizeTheme(DEFAULT_THEME)
    const taller = {
      ...before,
      columns: before.columns.map((column) => ({
        ...column,
        rows: column.rows.map((row) => (row.id === 'row-1' ? { ...row, height: row.height + 20 } : row))
      }))
    }
    expect(sameThemeContent(before, sanitizeTheme(taller))).toBe(false)

    const flexible = {
      ...before,
      columns: before.columns.map((column) => ({
        ...column,
        rows: column.rows.map((row) => (row.id === 'row-2' ? { ...row, mode: 'flex' as const } : row))
      }))
    }
    expect(sameThemeContent(before, sanitizeTheme(flexible))).toBe(false)
  })

  it('读盘回来的数组是新对象，内容一样就不算变（否则每轮同步都多一条只改时间的提交）', () => {
    const before = sanitizeTheme(DEFAULT_THEME)
    const after = sanitizeTheme(JSON.parse(JSON.stringify(before)))
    expect(sameThemeContent(before, after)).toBe(true)
  })

  it('导航栏关掉了哪几页也是内容，比的是清单不是引用', () => {
    const before = sanitizeTheme(DEFAULT_THEME)
    const same = sanitizeTheme(
      JSON.parse(
        JSON.stringify({
          ...before,
          appearance: { ...before.appearance, hiddenViews: [] }
        })
      )
    )
    expect(sameThemeContent(before, same)).toBe(true)

    const changed = sanitizeTheme({
      ...before,
      appearance: { ...before.appearance, hiddenViews: ['notes'] }
    })
    expect(sameThemeContent(before, changed)).toBe(false)
  })
})
