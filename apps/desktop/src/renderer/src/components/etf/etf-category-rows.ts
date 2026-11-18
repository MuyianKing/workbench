import type { EtfCategorySummary } from '@workbench/etf'

/** 归集表可排序列（与表头 prop 一一对应） */
export type CategorySortKey = keyof EtfCategorySummary
export type CategorySortOrder = 'ascending' | 'descending' | null

export interface CategoryRow extends EtfCategorySummary {
  isTotal: boolean
}

/**
 * 归集表行序：非合计行按指定列排，合计行永远钉在末行。
 * order 为空时保持传入顺序（即数据默认的近一月降序，与分品种表一致）。
 */
export function sortCategoryRows(
  rows: CategoryRow[],
  key: CategorySortKey,
  order: CategorySortOrder,
): CategoryRow[] {
  const detail = rows.filter(row => !row.isTotal)
  const total = rows.filter(row => row.isTotal)
  if (order) {
    detail.sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      const cmp = typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv, 'zh-CN')
        : Number(av) - Number(bv)
      return order === 'ascending' ? cmp : -cmp
    })
  }
  return [...detail, ...total]
}
