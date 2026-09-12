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
  GRID_STEP_DEFAULT,
  GRID_STEP_MAX,
  GRID_STEP_MIN,
  HOME_CARD_IDS,
  LEFT_WIDTH_DEFAULT,
  RIGHT_WIDTH_DEFAULT,
  cardIdsInColumn,
  clampCardGap,
  clampCardHeight,
  clampColumnWidth,
  clampGridStep,
  moveCard,
  normalizeOrder,
  resizeCardHeight,
  sanitizeCardMode,
  sanitizeTheme,
  snapToStep,
  type CardPlacement,
  type HomeCardId
} from './theme'

/**
 * 算法用例（移动 / 重排）的固定夹具：只关心栏与 order 的算法行为，
 * 用自带布局而不是 DEFAULT_THEME，默认布局再改也不会波及这些断言。
 */
function sampleCards(): Record<HomeCardId, CardPlacement> {
  return {
    activity: { column: 'left', order: 0, mode: 'fixed', height: 155 },
    system: { column: 'left', order: 1, mode: 'fixed', height: 147 },
    recent: { column: 'right', order: 0, mode: 'fixed', height: 155 },
    actions: { column: 'right', order: 1, mode: 'flex', height: 180 },
    quick: { column: 'center', order: 0, mode: 'fixed', height: 108 },
    commands: { column: 'right', order: 2, mode: 'flex', height: 400 },
    projects: { column: 'center', order: 1, mode: 'flex', height: 600 }
  }
}

describe('clampGridStep', () => {
  it('区间内的值原样返回，四舍五入成整数', () => {
    expect(clampGridStep(2)).toBe(2)
    expect(clampGridStep(2.6)).toBe(3)
    expect(clampGridStep(GRID_STEP_MIN)).toBe(GRID_STEP_MIN)
    expect(clampGridStep(GRID_STEP_MAX)).toBe(GRID_STEP_MAX)
  })

  it('越界收敛到边界，非有限数字回落到默认值', () => {
    expect(clampGridStep(0)).toBe(GRID_STEP_MIN)
    expect(clampGridStep(999)).toBe(GRID_STEP_MAX)
    expect(clampGridStep(undefined)).toBe(GRID_STEP_DEFAULT)
    expect(clampGridStep('2')).toBe(GRID_STEP_DEFAULT)
    expect(clampGridStep(Number.NaN)).toBe(GRID_STEP_DEFAULT)
  })
})

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

describe('snapToStep', () => {
  it('吸附到最近的整数格', () => {
    expect(snapToStep(7, 2)).toBe(8)
    expect(snapToStep(9, 2)).toBe(10)
    expect(snapToStep(980, 2)).toBe(980)
    expect(snapToStep(13, 5)).toBe(15)
    expect(snapToStep(11, 5)).toBe(10)
  })

  it('非法步进取默认值', () => {
    expect(snapToStep(7, 0)).toBe(7)
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
    expect(clampCardHeight(1, 'projects')).toBe(CARD_HEIGHT_MIN.projects)
  })

  it('高度不高于全局上限', () => {
    expect(clampCardHeight(999999, 'projects')).toBe(CARD_HEIGHT_MAX)
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
  it('缺哪块补哪块，七块一定齐全', () => {
    const result = sanitizeTheme({ cards: { quick: { column: 'left', order: 0, height: 240 } } })
    expect(Object.keys(result.cards).sort()).toEqual([...HOME_CARD_IDS].sort())
    // 与默认的 activity 同栏同 order 0 → 按 id 声明顺序让 activity 在前，quick 顺延到 1；
    // mode 缺省时沿用该卡片在默认布局里的模式（快捷启动是固定高度）
    expect(result.cards.quick).toEqual({ column: 'left', order: 1, mode: 'fixed', height: 240 })
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

  it('卡片间距缺省用默认值，越界收敛', () => {
    expect(sanitizeTheme({}).cardGap).toBe(CARD_GAP_DEFAULT)
    expect(sanitizeTheme({ cardGap: 999 }).cardGap).toBe(CARD_GAP_MAX)
    expect(sanitizeTheme({ cardGap: 3 }).cardGap).toBe(3)
  })

  it('认不出来的栏落到默认栏，栏宽跟随收敛', () => {
    const result = sanitizeTheme({
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
      cards: {
        activity: { column: 'left', order: 5, height: 200 },
        system: { column: 'left', order: 5, height: 200 },
        recent: { column: 'left', order: 0, height: 200 },
        quick: { column: 'center', order: 9, height: 200 },
        projects: { column: 'center', order: 3, height: 200 },
        commands: { column: 'right', order: 7, height: 200 },
        actions: { column: 'right', order: 2, height: 200 }
      }
    })
    expect(cardIdsInColumn(result.cards, 'left')).toEqual(['recent', 'activity', 'system'])
    expect(result.cards.recent.order).toBe(0)
    expect(result.cards.activity.order).toBe(1)
    expect(result.cards.system.order).toBe(2)
    expect(cardIdsInColumn(result.cards, 'center')).toEqual(['projects', 'quick'])
    expect(cardIdsInColumn(result.cards, 'right')).toEqual(['actions', 'commands'])
    expect(result.cards.actions.order).toBe(0)
    expect(result.cards.commands.order).toBe(1)
  })

  it('默认布局：左栏排常用面板、中栏放项目列表与命令、右栏留空', () => {
    expect(DEFAULT_THEME.leftWidth).toBe(LEFT_WIDTH_DEFAULT)
    expect(DEFAULT_THEME.rightWidth).toBe(RIGHT_WIDTH_DEFAULT)
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'left')).toEqual([
      'activity',
      'recent',
      'quick',
      'system',
      'actions'
    ])
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'center')).toEqual(['projects', 'commands'])
    expect(cardIdsInColumn(DEFAULT_THEME.cards, 'right')).toEqual([])
    // 中栏项目列表、左栏快捷操作各占一块 flex，吃掉所在栏剩余高度
    expect(DEFAULT_THEME.cards.projects.mode).toBe('flex')
    expect(DEFAULT_THEME.cards.actions.mode).toBe('flex')
    expect(DEFAULT_THEME.cards.commands.mode).toBe('fixed')
  })
})

describe('normalizeOrder', () => {
  it('不改栏与高度，只把 order 排连续', () => {
    const cards = sampleCards()
    for (const id of HOME_CARD_IDS) cards[id] = { ...cards[id], order: 42 }
    const next = normalizeOrder(cards)
    expect(cardIdsInColumn(next, 'center')).toEqual(['quick', 'projects'])
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
    expect(cardIdsInColumn(next, 'right')).toEqual(['actions', 'commands'])
    expect(next.actions.order).toBe(0)
    expect(next.commands.order).toBe(1)
  })

  it('栏内前移 / 后移都按插入位算', () => {
    const forward = moveCard(sampleCards(), 'quick', 'center', 1)
    expect(cardIdsInColumn(forward, 'center')).toEqual(['projects', 'quick'])
    const backward = moveCard(forward, 'quick', 'center', 0)
    expect(cardIdsInColumn(backward, 'center')).toEqual(['quick', 'projects'])
  })

  it('不动传入的对象', () => {
    const cards = sampleCards()
    moveCard(cards, 'quick', 'right', 0)
    expect(cards.quick.column).toBe('center')
  })
})

describe('resizeCardHeight', () => {
  it('按步进吸附增量', () => {
    expect(resizeCardHeight(200, 37, 2, 150)).toBe(238)
  })

  it('不低于下限', () => {
    expect(resizeCardHeight(200, -9999, 2, 150)).toBe(150)
  })

  it('不高于上限', () => {
    expect(resizeCardHeight(200, 999999, 2, 150)).toBe(CARD_HEIGHT_MAX)
  })
})
