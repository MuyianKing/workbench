/**
 * ETF 资金流刷新过程的通道载荷类型。
 *
 * 原先定义在 workbench/etf.ts（实现文件）里，WorkbenchApi 契约为了引用它们只能写
 * `import('./workbench/etf')` 这种反向依赖；现在类型住在这里（契约侧），
 * 实现文件反过来从 `@/types` re-export，既有的 `from '@/workbench/etf'` 导入一行不用改。
 */

/** 刷新进度：页面那行「正在回填」的提示 */
/** 一轮刷新的结论：新视图 + 有没有真的动过缓存 + 失败原因（如实给界面） */
import type { EtfOverview } from '@workbench/etf'

export interface EtfProgress {
  phase: 'nav' | 'szse' | 'sse'
  done: number
  total: number
}

export interface EtfRefreshOutcome {
  overview: EtfOverview
  updated: boolean
  notes: string[]
}

/** 从同步仓库拉回别的机器那几份缓存的结果 */
export interface EtfSyncPullOutcome {
  /** 有没有同步可用（没登录 / 没填仓库地址时为 false） */
  enabled: boolean
  /** 仓库里已经有本机那一份（第一次同步完之前是 false） */
  own: boolean
  /** 并进本机之后缓存有没有变 */
  changed: boolean
}
