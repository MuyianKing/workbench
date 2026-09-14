import { describe, expect, it } from 'vitest'
import { iconCacheHit, sanitizeIconCache } from './icon-cache'
import type { IconCacheEntry } from './types'

const PNG = 'data:image/png;base64,AAAA'
const TARGET = 'C:\\Tools\\Code.exe'

function entry(mtime: number, dataUrl = PNG): IconCacheEntry {
  return { mtime, dataUrl }
}

describe('sanitizeIconCache', () => {
  it('保留合法条目', () => {
    const raw = { [TARGET]: entry(1700000000000) }
    expect(sanitizeIconCache(raw, new Set([TARGET]))).toEqual(raw)
  })

  it('丢掉已经不在快捷启动列表里的程序', () => {
    const raw = { [TARGET]: entry(1), 'C:\\gone.exe': entry(2) }
    expect(Object.keys(sanitizeIconCache(raw, new Set([TARGET])))).toEqual([TARGET])
  })

  it('丢掉不是内联图片的值', () => {
    const raw = {
      [TARGET]: { mtime: 1, dataUrl: 'C:\\icon.png' },
      'C:\\b.exe': { mtime: 1, dataUrl: undefined }
    }
    expect(sanitizeIconCache(raw, new Set([TARGET, 'C:\\b.exe']))).toEqual({})
  })

  it('丢掉修改时间不是有限数的条目', () => {
    const raw = {
      [TARGET]: { mtime: Number.NaN, dataUrl: PNG },
      'C:\\b.exe': { mtime: 'x', dataUrl: PNG }
    }
    expect(sanitizeIconCache(raw, new Set([TARGET, 'C:\\b.exe']))).toEqual({})
  })

  it('对缺失 / 垃圾输入给空对象，而不是抛错', () => {
    expect(sanitizeIconCache(undefined, new Set())).toEqual({})
    expect(sanitizeIconCache(null, new Set())).toEqual({})
    expect(sanitizeIconCache('nonsense', new Set())).toEqual({})
    expect(sanitizeIconCache([1, 2], new Set())).toEqual({})
    expect(sanitizeIconCache({ [TARGET]: 'nope' }, new Set([TARGET]))).toEqual({})
  })
})

describe('iconCacheHit', () => {
  it('修改时间一致就算命中', () => {
    expect(iconCacheHit(entry(123), 123)).toBe(true)
  })

  it('修改时间不一样就失效（程序升级换了图标）', () => {
    expect(iconCacheHit(entry(123), 124)).toBe(false)
  })

  it('没有缓存条目时不算命中', () => {
    expect(iconCacheHit(undefined, 123)).toBe(false)
  })

  it('问不到修改时间时不认缓存', () => {
    expect(iconCacheHit(entry(123), null)).toBe(false)
  })
})
