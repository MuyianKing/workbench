/**
 * 浮层收起骨架的用例。
 *
 * 环境是 node（见 vitest.config.ts），这里给一个最小的 `window` 桩：被测代码只用到
 * `addEventListener` / `removeEventListener`。
 *
 * 钉住的是两处菜单共同的边界：左键点别处才收（右键按下去那一下不能收，否则会白闪）、
 * 点在面板里不收、Esc 与滚轮 / 窗口变化都收、卸载后一个监听都不留。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachFloatingDismiss } from './use-floating-dismiss'

type Listener = (event: unknown) => void

function stubWindow(): {
  dispatch: (type: string, event?: unknown) => void
  counts: () => Record<string, number>
} {
  const listeners = new Map<string, Set<Listener>>()

  vi.stubGlobal('window', {
    addEventListener(type: string, handler: Listener) {
      const group = listeners.get(type) ?? new Set()
      group.add(handler)
      listeners.set(type, group)
    },
    removeEventListener(type: string, handler: Listener) {
      listeners.get(type)?.delete(handler)
    }
  })

  return {
    dispatch: (type, event = {}) => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event)
    },
    counts: () => Object.fromEntries([...listeners].map(([type, group]) => [type, group.size]))
  }
}

/** 事件目标的两个桩（面板里 / 面板外）：只按「是不是同一个对象」判定 */
const INSIDE = { tag: 'inside' }
const OUTSIDE = { tag: 'outside' }

/** 面板桩：只用到 `contains` */
function panelContaining(element: unknown): HTMLElement {
  return { contains: (target: unknown) => target === element } as unknown as HTMLElement
}

describe('attachFloatingDismiss', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('左键点面板外面就收起', () => {
    const { dispatch } = stubWindow()
    const onDismiss = vi.fn()

    attachFloatingDismiss({ panel: () => panelContaining(INSIDE), onDismiss })
    dispatch('pointerdown', { button: 0, target: OUTSIDE })

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  /** 点菜单自己的项时不能先把自己收掉：那一项还要用面板里的元素 */
  it('点在面板里面不收起', () => {
    const { dispatch } = stubWindow()
    const onDismiss = vi.fn()

    attachFloatingDismiss({ panel: () => panelContaining(INSIDE), onDismiss })
    dispatch('pointerdown', { button: 0, target: INSIDE })

    expect(onDismiss).not.toHaveBeenCalled()
  })

  /**
   * 右键按下去的那一下不收：跟着来的 `contextmenu` 会开一份新菜单，
   * 先收再开会白闪一下（正文里的右键菜单就是靠这条与它自己的 contextmenu 闭环的）。
   */
  it('右键按下那一下不收起，等 contextmenu 到再说', () => {
    const { dispatch } = stubWindow()
    const onDismiss = vi.fn()

    attachFloatingDismiss({ panel: () => panelContaining(INSIDE), onDismiss })
    dispatch('pointerdown', { button: 2, target: OUTSIDE })
    expect(onDismiss).not.toHaveBeenCalled()

    dispatch('contextmenu', { target: OUTSIDE })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('在面板里右键不收起', () => {
    const { dispatch } = stubWindow()
    const onDismiss = vi.fn()

    attachFloatingDismiss({ panel: () => panelContaining(INSIDE), onDismiss })
    dispatch('contextmenu', { target: INSIDE })

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('Esc 收起，别的键不作数', () => {
    const { dispatch } = stubWindow()
    const onDismiss = vi.fn()

    attachFloatingDismiss({ panel: () => panelContaining(INSIDE), onDismiss })
    dispatch('keydown', { key: 'a' })
    expect(onDismiss).not.toHaveBeenCalled()

    dispatch('keydown', { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('滚轮、窗口缩放与失焦都收起', () => {
    const { dispatch } = stubWindow()
    const onDismiss = vi.fn()

    attachFloatingDismiss({ panel: () => null, onDismiss })
    dispatch('wheel', {})
    dispatch('resize', {})
    dispatch('blur', {})

    expect(onDismiss).toHaveBeenCalledTimes(3)
  })

  /** 面板还没渲染出来（v-if 还没成真）时不该报错，也不该把事件当成「在里面」 */
  it('面板还不存在时，点别处照样收', () => {
    const { dispatch } = stubWindow()
    const onDismiss = vi.fn()

    attachFloatingDismiss({ panel: () => null, onDismiss })
    dispatch('pointerdown', { button: 0, target: OUTSIDE })

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('返回的摘除函数把监听全清掉', () => {
    const { dispatch, counts } = stubWindow()
    const onDismiss = vi.fn()

    const stop = attachFloatingDismiss({ panel: () => null, onDismiss })
    stop()
    dispatch('pointerdown', { button: 0, target: OUTSIDE })

    expect(onDismiss).not.toHaveBeenCalled()
    expect(counts()).toEqual({
      pointerdown: 0,
      contextmenu: 0,
      keydown: 0,
      wheel: 0,
      resize: 0,
      blur: 0
    })
  })
})
