/**
 * 撤销 / 重做栈。
 *
 * 每一步存的是**整份标注清单的快照**（不是 diff）：一张截图上的标注撑死几十条，
 * 快照拷贝比维护一套可逆操作便宜得多，也不会出现「撤销到一半状态对不上」。
 * 深度卡在 `HISTORY_LIMIT` —— 它只是个内存里的会话栈，不留档。
 *
 * 纯函数：进出都是新对象，适配层/组件把当前那份 `present` 画出来就行。
 */

export const HISTORY_LIMIT = 60

export interface HistoryState<T> {
  past: T[]
  present: T
  future: T[]
}

export function historyInit<T>(present: T): HistoryState<T> {
  return { past: [], present, future: [] }
}

/** 记一步：当前那份进 past，新的一份成为 present；重做栈作废（新分支） */
export function historyPush<T>(state: HistoryState<T>, present: T): HistoryState<T> {
  const past = [...state.past, state.present]
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    present,
    future: [],
  }
}

export function historyCanUndo<T>(state: HistoryState<T>): boolean {
  return state.past.length > 0
}

export function historyCanRedo<T>(state: HistoryState<T>): boolean {
  return state.future.length > 0
}

export function historyUndo<T>(state: HistoryState<T>): HistoryState<T> {
  if (!state.past.length)
    return state
  const present = state.past[state.past.length - 1]
  return {
    past: state.past.slice(0, -1),
    present,
    future: [state.present, ...state.future],
  }
}

export function historyRedo<T>(state: HistoryState<T>): HistoryState<T> {
  if (!state.future.length)
    return state
  return {
    past: [...state.past, state.present],
    present: state.future[0],
    future: state.future.slice(1),
  }
}
