import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, historyCanRedo, historyCanUndo, historyInit, historyPush, historyRedo, historyUndo } from './history'

describe('history', () => {
  it('初始状态两边都不可撤销 / 重做', () => {
    const state = historyInit<string>('a')
    expect(state.present).toBe('a')
    expect(historyCanUndo(state)).toBe(false)
    expect(historyCanRedo(state)).toBe(false)
  })

  it('撤销回到上一步，重做再走回来', () => {
    let state = historyInit<string>('a')
    state = historyPush(state, 'b')
    state = historyPush(state, 'c')

    state = historyUndo(state)
    expect(state.present).toBe('b')
    state = historyUndo(state)
    expect(state.present).toBe('a')
    expect(historyCanUndo(state)).toBe(false)

    state = historyRedo(state)
    expect(state.present).toBe('b')
    state = historyRedo(state)
    expect(state.present).toBe('c')
    expect(historyCanRedo(state)).toBe(false)
  })

  it('撤销后再记一步，重做栈作废（新分支）', () => {
    let state = historyInit<string>('a')
    state = historyPush(state, 'b')
    state = historyUndo(state)
    state = historyPush(state, 'x')
    expect(historyCanRedo(state)).toBe(false)
    expect(state.present).toBe('x')
  })

  it('到底时撤销 / 重做是空转，返回同一个对象', () => {
    const state = historyInit<string>('a')
    expect(historyUndo(state)).toBe(state)
    expect(historyRedo(state)).toBe(state)
  })

  it('超过深度上限时丢掉最老的那一步', () => {
    let state = historyInit<number>(0)
    for (let index = 1; index <= HISTORY_LIMIT + 10; index += 1)
      state = historyPush(state, index)

    expect(state.past).toHaveLength(HISTORY_LIMIT)
    // 一直撤销到底，落在「能留下的最老那一步」上，而不是 0
    while (historyCanUndo(state))
      state = historyUndo(state)
    expect(state.present).toBe(10)
  })

  it('原状态对象不被改（纯函数）', () => {
    const state = historyInit<string>('a')
    historyPush(state, 'b')
    expect(state.past).toHaveLength(0)
    expect(state.present).toBe('a')
  })
})
