import { describe, expect, it } from 'vitest'
import { GIT_REPO_HISTORY_MAX, pushRepoHistory, sanitizeGitRepoRoot, sanitizeRepoHistory } from './repos'

describe('sanitizeGitRepoRoot', () => {
  it('去掉首尾空白与末尾分隔符，盘根保留分隔符', () => {
    expect(sanitizeGitRepoRoot('  E:/work/repo/  ')).toBe('E:/work/repo')
    expect(sanitizeGitRepoRoot('E:\\work\\repo\\\\')).toBe('E:\\work\\repo')
    expect(sanitizeGitRepoRoot('E:')).toBe('E:\\')
    expect(sanitizeGitRepoRoot('   ')).toBe('')
    expect(sanitizeGitRepoRoot(42)).toBe('')
  })
})

describe('sanitizeRepoHistory', () => {
  it('不是数组时回空清单', () => {
    expect(sanitizeRepoHistory('不是数组')).toEqual([])
    expect(sanitizeRepoHistory(null)).toEqual([])
  })

  it('去空、按大小写不敏感去重，保留第一次出现的写法', () => {
    expect(sanitizeRepoHistory([
      'E:/work/repo/',
      '',
      '  ',
      null,
      'e:\\work\\repo',
      'E:/other',
    ])).toEqual(['E:/work/repo', 'E:/other'])
  })

  it('超过上限的部分整段丢掉', () => {
    const many = Array.from({ length: GIT_REPO_HISTORY_MAX + 5 }, (_, index) => `E:/repo-${index}`)
    const list = sanitizeRepoHistory(many)
    expect(list).toHaveLength(GIT_REPO_HISTORY_MAX)
    expect(list[0]).toBe('E:/repo-0')
  })
})

describe('pushRepoHistory', () => {
  it('新打开的排到最前，已有的不会出现两次', () => {
    expect(pushRepoHistory(['E:/a', 'E:/b'], 'E:/b')).toEqual(['E:/b', 'E:/a'])
    expect(pushRepoHistory(['E:/a'], 'E:/c')).toEqual(['E:/c', 'E:/a'])
  })

  it('空路径不改动清单', () => {
    expect(pushRepoHistory(['E:/a'], '  ')).toEqual(['E:/a'])
  })
})
