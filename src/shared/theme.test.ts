import { describe, expect, it } from 'vitest'
import {
  CARD_GAP_DEFAULT,
  CARD_GAP_MAX,
  CARD_GAP_MIN,
  CARD_HEIGHT_MAX,
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
  THEME_VERSION,
  addColumn,
  cardIdsInColumn,
  clampCardGap,
  clampCardHeight,
  clampColumnWidth,
  clampNoteTreeWidth,
  columnIds,
  moveCard,
  normalizeOrder,
  removeColumn,
  resizeCardHeight,
  resizeColumnPair,
  sameThemeContent,
  setColumnWidths,
  sanitizeCardMode,
  sanitizeTheme,
  visibleCardIdsInColumn,
  type CardPlacement,
  type HomeCardId,
  type HomeColumn
} from './theme'

/**
 * 算法用例（移动 / 重排）的固定夹具：只关心栏与 order 的算法行为，
 * 用自带布局而不是 DEFAULT_THEME，默认布局再改也不会波及这些断言。
 */
function sampleCards(): Record<HomeCardId, CardPlacement> {
  return {
    activity: { column: 'col-1', order: 0, mode: 'fixed', height: 155, hidden: false },
    system: { column: 'col-1', order: 1, mode: 'fixed', height: 147, hidden: false },
    recent: { column: 'col-3', order: 0, mode: 'fixed', height: 155, hidden: false },
    actions: { column: 'col-3', order: 1, mode: 'flex', height: 180, hidden: false },
    commands: { column: 'col-3', order: 2, mode: 'flex', height: 400, hidden: false },
    quick: { column: 'col-2', order: 0, mode: 'fixed', height: 108, hidden: false },
    token: { column: 'col-2', order: 1, mode: 'flex', height: 600, hidden: false },
    work: { column: 'col-3', order: 3, mode: 'flex', height: 200, hidden: false },
    news: { column: 'col-3', order: 4, mode: 'fixed', height: 200, hidden: false }
  }
}

/** 与默认布局同一套栏骨架，但卡片自己摆（改栏的用例都从这里出发） */
function sampleColumns(): HomeColumn[] {
  return DEFAULT_THEME.columns.map((column) => ({ ...column }))
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

describe('clampCardHeight', () => {
  it('高度不低于该卡片的下限', () => {
    expect(clampCardHeight(1, 'token')).toBe(CARD_HEIGHT_MIN.token)
  })

  it('高度不高于全局上限', () => {
    expect(clampCardHeight(999999, 'token')).toBe(CARD_HEIGHT_MAX)
  })

  it('非法值回落到默认布局的高度', () => {
    expect(clampCardHeight(undefined, 'recent')).toBe(DEFAULT_THEME.cards.recent.height)
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
  it('缺哪块补哪块，八块一定齐全', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      cards: { quick: { column: 'col-1', order: 0, height: 240 } }
    })
    expect(Object.keys(result.cards).sort()).toEqual([...HOME_CARD_IDS].sort())
    // 与默认的 activity 同栏同 order 0 → 按 id 声明顺序让 activity 在前，quick 顺延到 1；
    // mode 缺省时沿用该卡片在默认布局里的模式（快捷启动是固定高度）
    expect(result.cards.quick).toEqual({
      column: 'col-1',
      order: 1,
      mode: 'fixed',
      height: 240,
      hidden: false
    })
    // 没在入参里出现的卡片沿用默认布局（order 会被重排成连续序号，故只比对其余字段）
    expect(result.cards.recent).toMatchObject({
      column: DEFAULT_THEME.cards.recent.column,
      mode: DEFAULT_THEME.cards.recent.mode,
      height: DEFAULT_THEME.cards.recent.height
    })
  })

  it('整份认不出来时就是默认布局', () => {
    expect(sanitizeTheme(null)).toEqual(DEFAULT_THEME)
    expect(sanitizeTheme({ hack: true })).toEqual(DEFAULT_THEME)
  })

  /** v2 的三栏是写死的，v3 换成一份可拆分的栏清单：老文件要一字不差地翻过来 */
  it('v2 的左中右三栏翻成栏清单，宽度与卡片摆放都留着', () => {
    const legacy = {
      version: 2,
      cardGap: 30,
      leftWidth: 420,
      rightWidth: 380,
      cards: { commands: { column: 'right', order: 0, mode: 'flex', height: 300 } }
    }
    const result = sanitizeTheme(legacy)

    expect(result.columns).toEqual([
      { id: 'col-1', width: 420 },
      { id: 'col-2', width: null },
      { id: 'col-3', width: 380 }
    ])
    expect(result.cardGap).toBe(30)
    expect(result.cards.commands.column).toBe('col-3')
    // 老文件里没提到的卡片，按默认布局落在对应的那一栏（中栏两张图仍在 col-2）
    expect(result.cards.token.column).toBe('col-2')
  })

  it('更早的版本（v1）也照样翻：认不出的卡片由默认布局补上，不会整份回默认', () => {
    // 高度取 260：「最近使用」的下限是 220，用它才能证明老文件里的值原样留着（而不是被夹住或回默认）
    const result = sanitizeTheme({ version: 1, leftWidth: 300, cards: { recent: { column: 'left', order: 0, height: 260 } } })

    expect(result.columns[0]).toEqual({ id: 'col-1', width: 300 })
    expect(result.cards.recent).toMatchObject({ column: 'col-1', height: 260 })
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

  it('卡片引用一个不存在的栏时落回默认布局那一栏；那一栏也不在就落到第一栏', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      columns: [{ id: 'col-9', width: 300 }],
      cards: {
        quick: { column: 'middle', order: 0, height: 200 },
        token: { column: 'col-9', order: 0, height: 200 }
      }
    })
    // quick 的默认栏是 col-1（不在这份清单里）→ 落到第一栏；token 明确写了 col-9 → 也在第一栏
    expect(result.cards.quick.column).toBe('col-9')
    expect(result.cards.token.column).toBe('col-9')
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

  it('order 有洞 / 重复时按栏重排成连续序号', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      columns: sampleColumns(),
      cards: {
        activity: { column: 'col-1', order: 5, height: 200 },
        system: { column: 'col-1', order: 5, height: 200 },
        recent: { column: 'col-1', order: 0, height: 200 },
        token: { column: 'col-2', order: 3, height: 200 },
        quick: { column: 'col-2', order: 9, height: 200 },
        commands: { column: 'col-3', order: 7, height: 200 },
        actions: { column: 'col-3', order: 2, height: 200 },
        work: { column: 'col-3', order: 9, height: 200 },
        news: { column: 'col-3', order: 9, height: 200 }
      }
    })
    expect(cardIdsInColumn(result.cards, 'col-1')).toEqual(['recent', 'activity', 'system'])
    expect(result.cards.recent.order).toBe(0)
    expect(result.cards.activity.order).toBe(1)
    expect(result.cards.system.order).toBe(2)
    expect(cardIdsInColumn(result.cards, 'col-2')).toEqual(['token', 'quick'])
    expect(result.cards.token.order).toBe(0)
    expect(result.cards.quick.order).toBe(1)
    expect(cardIdsInColumn(result.cards, 'col-3')).toEqual(['actions', 'commands', 'work', 'news'])
    expect(result.cards.actions.order).toBe(0)
    expect(result.cards.commands.order).toBe(1)
    expect(result.cards.work.order).toBe(2)
    expect(result.cards.news.order).toBe(3)
  })

  it('默认布局：第一栏排常用面板、第二栏（自适应）两张吃宽度的图表、第三栏放快捷操作与今日完成', () => {
    expect(DEFAULT_THEME.columns).toEqual([
      { id: 'col-1', width: 290 },
      { id: 'col-2', width: null },
      { id: 'col-3', width: 294 }
    ])
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'col-1')).toEqual([
      'recent',
      'quick',
      'system',
      'commands'
    ])
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'col-2')).toEqual(['activity', 'token'])
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'col-3')).toEqual(['actions', 'work', 'news'])
    // 中栏两张图表、左栏命令、右栏今日完成各占一块 flex，吃掉所在栏剩余高度
    expect(DEFAULT_THEME.cards.activity.mode).toBe('flex')
    expect(DEFAULT_THEME.cards.token.mode).toBe('flex')
    expect(DEFAULT_THEME.cards.commands.mode).toBe('flex')
    expect(DEFAULT_THEME.cards.work.mode).toBe('flex')
    expect(DEFAULT_THEME.cards.actions.mode).toBe('fixed')
  })
})

describe('normalizeOrder', () => {
  it('不改栏与高度，只把 order 排连续', () => {
    const cards = sampleCards()
    for (const id of HOME_CARD_IDS) cards[id] = { ...cards[id], order: 42 }
    const next = normalizeOrder(cards)
    // order 全相同时按 HOME_CARD_IDS 的声明顺序兜底（token 排在 quick 前面）
    expect(cardIdsInColumn(next, 'col-2')).toEqual(['token', 'quick'])
    expect(cards.quick.order).toBe(42)
  })
})

describe('moveCard', () => {
  it('跨栏插到指定位置', () => {
    const next = moveCard(sampleCards(), 'recent', 'col-1', 1)
    expect(cardIdsInColumn(next, 'col-1')).toEqual(['activity', 'recent', 'system'])
  })

  it('移到末尾时 index 越界会被夹住', () => {
    const next = moveCard(sampleCards(), 'recent', 'col-1', 99)
    expect(cardIdsInColumn(next, 'col-1')).toEqual(['activity', 'system', 'recent'])
  })

  it('原栏剩下的卡片 order 依然连续', () => {
    const next = moveCard(sampleCards(), 'recent', 'col-1', 0)
    expect(cardIdsInColumn(next, 'col-3')).toEqual(['actions', 'commands', 'work', 'news'])
    expect(next.actions.order).toBe(0)
    expect(next.commands.order).toBe(1)
    expect(next.work.order).toBe(2)
    expect(next.news.order).toBe(3)
  })

  it('栏内前移 / 后移都按插入位算', () => {
    const forward = moveCard(sampleCards(), 'quick', 'col-2', 1)
    expect(cardIdsInColumn(forward, 'col-2')).toEqual(['token', 'quick'])
    const backward = moveCard(forward, 'quick', 'col-2', 0)
    expect(cardIdsInColumn(backward, 'col-2')).toEqual(['quick', 'token'])
  })

  it('不动传入的对象', () => {
    const cards = sampleCards()
    moveCard(cards, 'quick', 'col-3', 0)
    expect(cards.quick.column).toBe('col-2')
  })
})

describe('拆栏 / 收栏', () => {
  it('新栏拆在它右边，宽度跟着被拆的那一栏（自适应拆出自适应）', () => {
    const next = addColumn(sampleColumns(), 'col-2')

    expect(columnIds(next)).toEqual(['col-1', 'col-2', 'col-4', 'col-3'])
    expect(next[2].width).toBeNull()
  })

  it('固定宽度的栏拆出来也一样宽', () => {
    const next = addColumn(sampleColumns(), 'col-1')

    expect(columnIds(next)).toEqual(['col-1', 'col-4', 'col-2', 'col-3'])
    expect(next[1].width).toBe(290)
  })

  it('到栏数上限就不再拆（原样返回同一份）', () => {
    let columns = sampleColumns()
    while (columns.length < COLUMN_COUNT_MAX) {
      columns = addColumn(columns, columns[columns.length - 1].id)
    }

    expect(columns.length).toBe(COLUMN_COUNT_MAX)
    expect(addColumn(columns, columns[0].id)).toBe(columns)
  })

  it('收栏时栏里的卡片按原顺序并到左边那一栏', () => {
    const removed = removeColumn(sampleCards(), sampleColumns(), 'col-3')

    expect(columnIds(removed!.columns)).toEqual(['col-1', 'col-2'])
    expect(cardIdsInColumn(removed!.cards, 'col-2')).toEqual([
      'quick',
      'token',
      'recent',
      'actions',
      'commands',
      'work',
      'news'
    ])
  })

  it('第一栏被收掉时卡片并到右边那一栏', () => {
    const removed = removeColumn(sampleCards(), sampleColumns(), 'col-1')

    expect(columnIds(removed!.columns)).toEqual(['col-2', 'col-3'])
    expect(cardIdsInColumn(removed!.cards, 'col-2')).toEqual([
      'quick',
      'token',
      'activity',
      'system'
    ])
  })

  it('只剩一栏时收不掉：首页总得留一栏给卡片落脚', () => {
    expect(removeColumn(sampleCards(), [{ id: 'col-1', width: null }], 'col-1')).toBeNull()
  })

  it('不动传入的对象', () => {
    const cards = sampleCards()
    const columns = sampleColumns()
    removeColumn(cards, columns, 'col-2')

    expect(columns.length).toBe(3)
    expect(cards.quick.column).toBe('col-2')
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

  it('不改传入的那份', () => {
    const columns = sampleColumns()
    setColumnWidths(columns, { 'col-1': 400 })
    expect(columns[0].width).toBe(290)
  })
})

describe('resizeCardHeight', () => {
  it('落到整数像素（吸附网格就是 1px）', () => {
    expect(resizeCardHeight(200, 37, 150)).toBe(237)
    expect(resizeCardHeight(200, 36.4, 150)).toBe(236)
    expect(resizeCardHeight(200.6, 0, 150)).toBe(201)
  })

  it('不低于下限', () => {
    expect(resizeCardHeight(200, -9999, 150)).toBe(150)
  })

  it('不高于上限', () => {
    expect(resizeCardHeight(200, 999999, 150)).toBe(CARD_HEIGHT_MAX)
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
      cards: { quick: { column: 'col-1', order: 0, height: 200 } }
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

  it('关掉只是不画：栏内位置与高度照旧留着，再打开时回到原处', () => {
    const result = sanitizeTheme({ version: THEME_VERSION, cards: cardsWithHidden(['recent']) })

    expect(result.cards.recent).toEqual({ ...DEFAULT_THEME.cards.recent, hidden: true })
    // 栏里的清单不受影响（它是「摆了哪些」，画不画由 visibleCardIdsInColumn 决定）
    expect(cardIdsInColumn(result.cards, 'col-1')).toEqual(
      cardIdsInColumn(DEFAULT_THEME.cards, 'col-1')
    )
    expect(visibleCardIdsInColumn(result.cards, 'col-1')).not.toContain('recent')
  })

  it('关掉一块卡片也算内容变了（同步要跟着刷新时间戳）', () => {
    const before = sanitizeTheme(DEFAULT_THEME)
    const after = sanitizeTheme({ version: THEME_VERSION, cards: cardsWithHidden(['quick']) })
    expect(sameThemeContent(before, after)).toBe(false)
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
