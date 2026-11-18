import type { CategoryRow } from './etf-category-rows'
import { describe, expect, it } from 'vitest'
import { sortCategoryRows } from './etf-category-rows'

function row(category: string, values: Partial<CategoryRow> = {}): CategoryRow {
  return {
    category,
    count: 1,
    todayYi: 0,
    weekYi: 0,
    monthYi: 0,
    lastShareYi: 0,
    lastScaleYi: 0,
    isTotal: false,
    ...values,
  }
}

const rows: CategoryRow[] = [
  row('中证500', { monthYi: 10, todayYi: -2, lastScaleYi: 754 }),
  row('沪深300', { monthYi: 1828, todayYi: 116, lastScaleYi: 4310 }),
  row('全部', { monthYi: 3143, todayYi: 152, lastScaleYi: 8348, isTotal: true }),
  row('创业板', { monthYi: 579, todayYi: 16.86, lastScaleYi: 1355 }),
]

describe('sortCategoryRows', () => {
  it('order 为空时保持传入顺序，合计行留在末行', () => {
    expect(sortCategoryRows(rows, 'monthYi', null).map(r => r.category))
      .toEqual(['中证500', '沪深300', '创业板', '全部'])
  })

  it('按数值列升序，合计行仍在末行', () => {
    expect(sortCategoryRows(rows, 'monthYi', 'ascending').map(r => r.category))
      .toEqual(['中证500', '创业板', '沪深300', '全部'])
  })

  it('按数值列降序，合计行仍在末行', () => {
    expect(sortCategoryRows(rows, 'todayYi', 'descending').map(r => r.category))
      .toEqual(['沪深300', '创业板', '中证500', '全部'])
  })

  it('按类别列（中文）排序，合计行仍在末行', () => {
    const sorted = sortCategoryRows(rows, 'category', 'ascending')
    expect(sorted.at(-1)?.category).toBe('全部')
    expect(sorted).toHaveLength(rows.length)
    expect(sorted.map(r => r.category).sort()).toEqual(rows.map(r => r.category).sort())
  })

  it('不改动传入数组', () => {
    const before = rows.map(r => r.category)
    sortCategoryRows(rows, 'monthYi', 'ascending')
    expect(rows.map(r => r.category)).toEqual(before)
  })
})
