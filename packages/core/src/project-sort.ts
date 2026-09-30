/**
 * 项目页的排序方式。
 *
 * 定义在 shared 而不是渲染层的 store 里：它现在会被存进设置（数据文件里的 `projectSort`），
 * 而收敛设置的那份代码在 `persisted-data.ts` —— 两边各写一份联合类型的话，
 * 加一档时总有一边认不出来（与 `views.ts` 里页面清单同一个道理）。
 *
 * 界面上的下拉标签不在这儿：那是 `ProjectFilterBar.vue` 的事（与 views.ts 的分工一致）。
 */
export const PROJECT_SORTS = ['recent', 'name', 'created'] as const

export type ProjectSort = (typeof PROJECT_SORTS)[number]

/** 默认「最近使用」：项目页最常见的用法是接着上次那个项目干 */
export const PROJECT_SORT_DEFAULT: ProjectSort = 'recent'

export function isProjectSort(value: unknown): value is ProjectSort {
  return PROJECT_SORTS.includes(value as ProjectSort)
}

/**
 * 认不出来的一律回到默认。
 *
 * 收敛是必须的：这一项会被写回下拉的选中值，一个老数据文件里没有的写法
 * （比如将来删掉某一档、或者文件被手工改过）会让下拉一个都对不上，显示成空白。
 */
export function sanitizeProjectSort(value: unknown): ProjectSort {
  return isProjectSort(value) ? value : PROJECT_SORT_DEFAULT
}
