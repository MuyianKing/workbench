import { describe, expect, it } from 'vitest'
import {
  PROJECT_SORT_DEFAULT,
  PROJECT_SORTS,
  isProjectSort,
  sanitizeProjectSort
} from './project-sort'

describe('project-sort', () => {
  it('默认是「最近使用」', () => {
    expect(PROJECT_SORT_DEFAULT).toBe('recent')
    expect(PROJECT_SORTS).toContain(PROJECT_SORT_DEFAULT)
  })

  it('认得出的取值原样留下', () => {
    for (const value of PROJECT_SORTS) {
      expect(sanitizeProjectSort(value)).toBe(value)
      expect(isProjectSort(value)).toBe(true)
    }
  })

  /**
   * 这一项会被写回筛选栏下拉的选中值，认不出的值在那儿会显示成空白 ——
   * 所以「不认识」必须收敛成默认，而不是原样带出去。
   */
  it('认不出的一律回默认', () => {
    expect(sanitizeProjectSort('size')).toBe(PROJECT_SORT_DEFAULT)
    expect(sanitizeProjectSort('')).toBe(PROJECT_SORT_DEFAULT)
    expect(sanitizeProjectSort(undefined)).toBe(PROJECT_SORT_DEFAULT)
    expect(sanitizeProjectSort(null)).toBe(PROJECT_SORT_DEFAULT)
    expect(sanitizeProjectSort(3)).toBe(PROJECT_SORT_DEFAULT)
    expect(sanitizeProjectSort({})).toBe(PROJECT_SORT_DEFAULT)
  })

  it('isProjectSort 不认非字符串', () => {
    expect(isProjectSort(undefined)).toBe(false)
    expect(isProjectSort(['recent'])).toBe(false)
  })
})
