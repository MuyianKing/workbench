import { describe, expect, it } from 'vitest'
import {
  CARD_GAP_DEFAULT,
  CARD_GAP_MAX,
  CARD_GAP_MIN,
  CARD_HEIGHT_MAX,
  CARD_HEIGHT_MIN,
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  DEFAULT_THEME,
  HOME_CARD_IDS,
  LEFT_WIDTH_DEFAULT,
  NOTE_TREE_WIDTH_DEFAULT,
  NOTE_TREE_WIDTH_MAX,
  NOTE_TREE_WIDTH_MIN,
  RIGHT_WIDTH_DEFAULT,
  THEME_VERSION,
  cardIdsInColumn,
  clampCardGap,
  clampCardHeight,
  clampColumnWidth,
  clampNoteTreeWidth,
  moveCard,
  normalizeOrder,
  resizeCardHeight,
  sameThemeContent,
  sanitizeCardMode,
  sanitizeTheme,
  visibleCardIdsInColumn,
  type CardPlacement,
  type HomeCardId
} from './theme'

/**
 * 算法用例（移动 / 重排）的固定夹具：只关心栏与 order 的算法行为，
 * 用自带布局而不是 DEFAULT_THEME，默认布局再改也不会波及这些断言。
 */
function sampleCards(): Record<HomeCardId, CardPlacement> {
  return {
    activity: { column: 'left', order: 0, mode: 'fixed', height: 155, hidden: false },
    system: { column: 'left', order: 1, mode: 'fixed', height: 147, hidden: false },
    recent: { column: 'right', order: 0, mode: 'fixed', height: 155, hidden: false },
    actions: { column: 'right', order: 1, mode: 'flex', height: 180, hidden: false },
    commands: { column: 'right', order: 2, mode: 'flex', height: 400, hidden: false },
    quick: { column: 'center', order: 0, mode: 'fixed', height: 108, hidden: false },
    token: { column: 'center', order: 1, mode: 'flex', height: 600, hidden: false },
    work: { column: 'right', order: 3, mode: 'flex', height: 200, hidden: false }
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
    expect(clampColumnWidth(300, LEFT_WIDTH_DEFAULT)).toBe(300)
    expect(clampColumnWidth(LEFT_WIDTH_DEFAULT, LEFT_WIDTH_DEFAULT)).toBe(LEFT_WIDTH_DEFAULT)
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
      cards: { quick: { column: 'left', order: 0, height: 240 } }
    })
    expect(Object.keys(result.cards).sort()).toEqual([...HOME_CARD_IDS].sort())
    // 与默认的 activity 同栏同 order 0 → 按 id 声明顺序让 activity 在前，quick 顺延到 1；
    // mode 缺省时沿用该卡片在默认布局里的模式（快捷启动是固定高度）
    expect(result.cards.quick).toEqual({
      column: 'left',
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

  it('版本对不上时回到默认布局（卡片清单变过，老布局按原样套用会缺一块）', () => {
    const old = {
      version: THEME_VERSION - 1,
      gridStep: 8,
      cardGap: 30,
      leftWidth: 420,
      rightWidth: 380,
      cards: { commands: { column: 'right', order: 0, mode: 'flex', height: 300 } }
    }
    expect(sanitizeTheme(old)).toEqual(DEFAULT_THEME)
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

  it('认不出来的栏落到默认栏，栏宽跟随收敛', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      leftWidth: 99999,
      rightWidth: 1,
      cards: { quick: { column: 'middle', order: 0, height: 200 } }
    })
    expect(result.cards.quick.column).toBe(DEFAULT_THEME.cards.quick.column)
    expect(result.leftWidth).toBe(COLUMN_WIDTH_MAX)
    expect(result.rightWidth).toBe(COLUMN_WIDTH_MIN)
  })

  it('order 有洞 / 重复时按栏重排成连续序号', () => {
    const result = sanitizeTheme({
      version: THEME_VERSION,
      cards: {
        activity: { column: 'left', order: 5, height: 200 },
        system: { column: 'left', order: 5, height: 200 },
        recent: { column: 'left', order: 0, height: 200 },
        token: { column: 'center', order: 3, height: 200 },
        quick: { column: 'center', order: 9, height: 200 },
        commands: { column: 'right', order: 7, height: 200 },
        actions: { column: 'right', order: 2, height: 200 },
        work: { column: 'right', order: 9, height: 200 }
      }
    })
    expect(cardIdsInColumn(result.cards, 'left')).toEqual(['recent', 'activity', 'system'])
    expect(result.cards.recent.order).toBe(0)
    expect(result.cards.activity.order).toBe(1)
    expect(result.cards.system.order).toBe(2)
    expect(cardIdsInColumn(result.cards, 'center')).toEqual(['token', 'quick'])
    expect(result.cards.token.order).toBe(0)
    expect(result.cards.quick.order).toBe(1)
    expect(cardIdsInColumn(result.cards, 'right')).toEqual(['actions', 'commands', 'work'])
    expect(result.cards.actions.order).toBe(0)
    expect(result.cards.commands.order).toBe(1)
    expect(result.cards.work.order).toBe(2)
  })

  it('默认布局：左栏排常用面板、中栏两张吃宽度的图表、右栏放快捷操作与今日完成', () => {
    expect(DEFAULT_THEME.leftWidth).toBe(LEFT_WIDTH_DEFAULT)
    expect(DEFAULT_THEME.rightWidth).toBe(RIGHT_WIDTH_DEFAULT)
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'left')).toEqual([
      'recent',
      'quick',
      'system',
      'commands'
    ])
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'center')).toEqual(['activity', 'token'])
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'right')).toEqual(['actions', 'work'])
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
    expect(cardIdsInColumn(next, 'center')).toEqual(['token', 'quick'])
    expect(cards.quick.order).toBe(42)
  })
})

describe('moveCard', () => {
  it('跨栏插到指定位置', () => {
    const next = moveCard(sampleCards(), 'recent', 'left', 1)
    expect(cardIdsInColumn(next, 'left')).toEqual(['activity', 'recent', 'system'])
  })

  it('移到末尾时 index 越界会被夹住', () => {
    const next = moveCard(sampleCards(), 'recent', 'left', 99)
    expect(cardIdsInColumn(next, 'left')).toEqual(['activity', 'system', 'recent'])
  })

  it('原栏剩下的卡片 order 依然连续', () => {
    const next = moveCard(sampleCards(), 'recent', 'left', 0)
    expect(cardIdsInColumn(next, 'right')).toEqual(['actions', 'commands', 'work'])
    expect(next.actions.order).toBe(0)
    expect(next.commands.order).toBe(1)
    expect(next.work.order).toBe(2)
  })

  it('栏内前移 / 后移都按插入位算', () => {
    const forward = moveCard(sampleCards(), 'quick', 'center', 1)
    expect(cardIdsInColumn(forward, 'center')).toEqual(['token', 'quick'])
    const backward = moveCard(forward, 'quick', 'center', 0)
    expect(cardIdsInColumn(backward, 'center')).toEqual(['quick', 'token'])
  })

  it('不动传入的对象', () => {
    const cards = sampleCards()
    moveCard(cards, 'quick', 'right', 0)
    expect(cards.quick.column).toBe('center')
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
      cards: { quick: { column: 'left', order: 0, height: 200 } }
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
    expect(cardIdsInColumn(result.cards, 'left')).toEqual(
      cardIdsInColumn(DEFAULT_THEME.cards, 'left')
    )
    expect(visibleCardIdsInColumn(result.cards, 'left')).not.toContain('recent')
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
