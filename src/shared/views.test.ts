import { describe, expect, it } from 'vitest'
import { VIEW_IDS, VIEW_LABELS, isViewId, sanitizeViewId } from '@shared/views'

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
