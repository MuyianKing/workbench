import { describe, expect, it } from 'vitest'
import {
  VIEW_IDS,
  VIEW_LABELS,
  fallbackView,
  isViewId,
  orderedViews,
  sanitizeHiddenViews,
  sanitizeViewId,
  sanitizeViewOrder,
  visibleViews
} from '@shared/views'

describe('页面 id', () => {
  it('每个 id 都有名字，否则导航栏会出现空白项', () => {
    for (const id of VIEW_IDS) expect(VIEW_LABELS[id]).toBeTruthy()
  })

  it('只认登记过的 id', () => {
    expect(isViewId('home')).toBe(true)
    expect(isViewId('projects')).toBe(true)
    expect(isViewId('settings')).toBe(false)
    expect(isViewId('')).toBe(false)
    expect(isViewId(null)).toBe(false)
    expect(isViewId(1)).toBe(false)
  })

  it('认不出来的一律回首页（老数据文件没有这个字段）', () => {
    expect(sanitizeViewId(undefined)).toBe('home')
    expect(sanitizeViewId('nope')).toBe('home')
    expect(sanitizeViewId({ home: true })).toBe('home')
    expect(sanitizeViewId('projects')).toBe('projects')
  })
})

describe('导航栏显示哪几页', () => {
  it('只记「关掉了哪些」：认不出来的、重复的、不是数组的一律丢掉', () => {
    // 老主题文件里没有这个字段 = 一页都没关
    expect(sanitizeHiddenViews(undefined)).toEqual([])
    expect(sanitizeHiddenViews('notes')).toEqual([])
    expect(sanitizeHiddenViews(['notes', 'notes', 'settings', 42, null])).toEqual(['notes'])
  })

  it('剩下哪几页永远按 VIEW_IDS 的顺序（关掉哪几项不影响其余项的先后）', () => {
    expect(visibleViews([])).toEqual([...VIEW_IDS])
    expect(visibleViews(['home', 'work'])).toEqual(['projects', 'notes', 'skills', 'vault', 'styles'])
  })

  it('至少留一页：全关掉时把首页留下，界面上不会一个入口都不剩', () => {
    expect(sanitizeHiddenViews([...VIEW_IDS])).toEqual([
      'projects',
      'work',
      'notes',
      'skills',
      'vault',
      'styles'
    ])
    expect(visibleViews(sanitizeHiddenViews([...VIEW_IDS]))).toEqual(['home'])
  })

  it('当前页被关掉之后退到第一页可见的', () => {
    expect(fallbackView(['home'])).toBe('projects')
    expect(fallbackView(['home', 'projects', 'work'])).toBe('notes')
    expect(fallbackView([])).toBe('home')
    // 防御：真的把每一页都关掉时也不能返回 undefined（正常到不了这里）
    expect(fallbackView([...VIEW_IDS])).toBe('home')
  })
})

describe('导航栏的顺序', () => {
  it('收敛成一个完整排列：认不出来的、重复的丢掉，落下的按默认顺序补到末尾', () => {
    // 老主题文件里没有这个字段 = 默认顺序
    expect(sanitizeViewOrder(undefined)).toEqual([...VIEW_IDS])
    expect(sanitizeViewOrder('notes')).toEqual([...VIEW_IDS])
    expect(sanitizeViewOrder(['notes', 'nope', 'notes', 'home'])).toEqual([
      'notes',
      'home',
      'projects',
      'work',
      'skills',
      'vault',
      'styles'
    ])
  })

  it('显示的页按排好的顺序走，关掉的整项不出现', () => {
    const order = sanitizeViewOrder(['work', 'home', 'notes'])
    expect(orderedViews([], order)).toEqual(['work', 'home', 'notes', 'projects', 'skills', 'vault', 'styles'])
    expect(orderedViews(['work', 'skills', 'vault', 'styles', 'projects'], order)).toEqual([
      'home',
      'notes'
    ])
    // 不带顺序参数时就是老行为：按 VIEW_IDS 的默认顺序
    expect(orderedViews(['home', 'work'])).toEqual(['projects', 'notes', 'skills', 'vault', 'styles'])
  })

  it('退回页按顺序数过去第一页可见的（不是默认顺序里的第一页）', () => {
    const order = sanitizeViewOrder(['work', 'notes', 'home'])
    expect(fallbackView(['home'], order)).toBe('work')
    expect(fallbackView([], order)).toBe('work')
  })
})
