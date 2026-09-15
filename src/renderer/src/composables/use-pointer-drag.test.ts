/**
 * 拖拽骨架的用例。
 *
 * 环境是 node（见 vitest.config.ts），所以这里给它一个最小的 `window` / `document` 桩：
 * 被测代码只用到 `addEventListener` / `removeEventListener` 与 `document.body.classList`。
 *
 * 这几条用例钉住的正是「五处各写一遍」时最容易漏掉的东西：
 * 系统取消指针（`pointercancel`）要收手、Esc 要放弃、收手之后监听必须全部摘掉
 * （否则监听会留在 window 上，之后每次移动都在改值）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startPointerDrag } from './use-pointer-drag'

/** 最小的 window 桩：记下监听器，好断言「收手后一个不剩」；body 类也一并记下来 */
function stubWindow(): {
  listeners: Map<string, Set<(event: unknown) => void>>
  bodyClasses: Set<string>
  dispatch: (type: string, event?: unknown) => void
  counts: () => Record<string, number>
} {
  const listeners = new Map<string, Set<(event: unknown) => void>>()

  const windowStub = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      const group = listeners.get(type) ?? new Set()
      group.add(handler)
      listeners.set(type, group)
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      listeners.get(type)?.delete(handler)
    }
  }

  const classes = new Set<string>()
  const documentStub = {
    body: {
      classList: {
        add: (name: string) => void classes.add(name),
        remove: (name: string) => void classes.delete(name)
      }
    }
  }

  vi.stubGlobal('window', windowStub)
  vi.stubGlobal('document', documentStub)

  return {
    listeners,
    bodyClasses: classes,
    dispatch: (type, event = {}) => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event)
    },
    counts: () => Object.fromEntries([...listeners].map(([type, group]) => [type, group.size]))
  }
}

describe('startPointerDrag', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('把指针移动交给调用方，并带上按下时的起点', () => {
    const { dispatch } = stubWindow()
    const onMove = vi.fn()

    startPointerDrag({ start: { x: 100, y: 200 }, onMove })
    dispatch('pointermove', { clientX: 130, clientY: 180 })

    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove.mock.calls[0][1]).toEqual({ x: 100, y: 200 })
    expect(onMove.mock.calls[0][0]).toMatchObject({ clientX: 130, clientY: 180 })
  })

  it('收手时把最后一次移动的事件交出去，并摘掉全部监听', () => {
    const { dispatch, counts } = stubWindow()
    const onEnd = vi.fn()

    startPointerDrag({ start: { x: 0, y: 0 }, onMove: vi.fn(), onEnd })
    dispatch('pointermove', { clientX: 10, clientY: 10 })
    dispatch('pointerup', {})

    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd.mock.calls[0][0]).toMatchObject({ clientX: 10, clientY: 10 })
    expect(counts()).toEqual({ pointermove: 0, pointerup: 0, pointercancel: 0, keydown: 0 })
  })

  /** 系统接管指针（触控、手势）时也要收手：留着监听的话，之后每次移动都在改值 */
  it('被系统取消指针时同样收手', () => {
    const { dispatch, counts } = stubWindow()
    const onEnd = vi.fn()

    startPointerDrag({ start: { x: 0, y: 0 }, onMove: vi.fn(), onEnd })
    dispatch('pointercancel', {})

    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(counts().pointermove).toBe(0)
  })

  /**
   * 「没移动过」与「放弃了」都会让 last 是 null，调用方（终端那颗悬浮按钮）要抑制
   * 随后的 click 就得靠第二个参数分辨：单击要能点开，Esc 放弃的那一下不能。
   */
  it('收手结果分得开「按下没动」与「被放弃」', () => {
    const plain = stubWindow()
    const plainEnd = vi.fn()
    startPointerDrag({ start: { x: 0, y: 0 }, onMove: vi.fn(), onEnd: plainEnd })
    plain.dispatch('pointerup', {})

    expect(plainEnd.mock.calls[0][0]).toBeNull()
    expect(plainEnd.mock.calls[0][1]).toBe(false)

    const escaped = stubWindow()
    const escEnd = vi.fn()
    startPointerDrag({ start: { x: 0, y: 0 }, onMove: vi.fn(), onEnd: escEnd })
    escaped.dispatch('keydown', { key: 'Escape' })

    expect(escEnd.mock.calls[0][0]).toBeNull()
    expect(escEnd.mock.calls[0][1]).toBe(true)
  })

  it('拖动中按 Esc 是放弃：onEnd 收到 null，收手后不再响应移动', () => {
    const { dispatch } = stubWindow()
    const onEnd = vi.fn()
    const onMove = vi.fn()

    startPointerDrag({ start: { x: 0, y: 0 }, onMove, onEnd })
    dispatch('pointermove', { clientX: 50, clientY: 50 })
    dispatch('keydown', { key: 'Escape' })
    dispatch('pointermove', { clientX: 80, clientY: 80 })

    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd.mock.calls[0][0]).toBeNull()
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('Esc 之外的其他键不作数', () => {
    const { dispatch } = stubWindow()
    const onEnd = vi.fn()

    startPointerDrag({ start: { x: 0, y: 0 }, onMove: vi.fn(), onEnd })
    dispatch('keydown', { key: 'a' })

    expect(onEnd).not.toHaveBeenCalled()
  })

  /** 组件在拖动中被切走：返回的收尾函数要把监听收干净（否则留在 window 上） */
  it('返回的收尾函数能立即结束这次拖拽', () => {
    const { dispatch, counts } = stubWindow()
    const onEnd = vi.fn()

    const stop = startPointerDrag({ start: { x: 0, y: 0 }, onMove: vi.fn(), onEnd })
    stop()
    dispatch('pointermove', { clientX: 10, clientY: 10 })

    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(counts().pointermove).toBe(0)
  })

  /** 收手只走一次：pointerup 之后再补一个 pointercancel 不该重复回调 */
  it('收手只回调一次', () => {
    const { dispatch } = stubWindow()
    const onEnd = vi.fn()

    startPointerDrag({ start: { x: 0, y: 0 }, onMove: vi.fn(), onEnd })
    dispatch('pointerup', {})
    dispatch('pointercancel', {})
    dispatch('pointerup', {})

    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('拖拽期间挂上的 body 类会在收手时摘掉', () => {
    const { dispatch, bodyClasses } = stubWindow()
    const onEnd = vi.fn()

    startPointerDrag({
      start: { x: 0, y: 0 },
      onMove: vi.fn(),
      onEnd,
      bodyClass: 'is-resizing-terminal'
    })
    expect(bodyClasses.has('is-resizing-terminal')).toBe(true)

    dispatch('pointerup', {})
    expect(bodyClasses.has('is-resizing-terminal')).toBe(false)
  })
})
