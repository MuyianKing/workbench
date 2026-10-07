/**
 * 浮层落点骨架的用例。
 *
 * 环境是 node（见 vitest.config.ts），这里给最小的 `window` 桩（只有 innerWidth /
 * innerHeight）与面板桩（getBoundingClientRect 量出固定尺寸）。
 *
 * 钉住的是三处右键菜单共用的规矩：放得下就贴指针、放不下往回收（边缘留空当）、
 * follow 时指针挪了重摆、面板还没渲染出来时不动。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { FLOATING_EDGE, useFloatingPosition } from './use-floating-position'

function stubViewport(width: number, height: number): void {
  vi.stubGlobal('window', { innerWidth: width, innerHeight: height })
}

/** 面板桩：只用到 getBoundingClientRect */
function panelOf(width: number, height: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width, height })
  } as unknown as HTMLElement
}

describe('useFloatingPosition', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('放得下就贴指针', () => {
    stubViewport(1920, 1080)
    const panel = panelOf(180, 120)
    const { pos, place } = useFloatingPosition({
      x: () => 300,
      y: () => 200,
      panel: () => panel
    })

    place()
    expect(pos.value).toEqual({ left: 300, top: 200 })
  })

  it('右边或下边放不下就往回收，边缘留出空当', () => {
    stubViewport(1000, 800)
    const panel = panelOf(200, 100)
    const { pos, place } = useFloatingPosition({
      x: () => 950,
      y: () => 760,
      panel: () => panel
    })

    place()
    expect(pos.value).toEqual({
      left: 1000 - 200 - FLOATING_EDGE,
      top: 800 - 100 - FLOATING_EDGE
    })
  })

  it('指针太靠上或靠左时，边缘空当兜住下限', () => {
    stubViewport(1000, 800)
    const panel = panelOf(200, 100)
    const { pos, place } = useFloatingPosition({
      x: () => 1,
      y: () => 2,
      panel: () => panel
    })

    place()
    expect(pos.value).toEqual({ left: FLOATING_EDGE, top: FLOATING_EDGE })
  })

  it('follow 打开后指针挪了就重摆', async () => {
    stubViewport(1920, 1080)
    const panel = panelOf(100, 50)
    // 坐标得是响应式的 —— 组件里它是 props;普通对象没有依赖可追踪,watch 不会触发
    const x = ref(10)
    const y = ref(20)
    const { pos } = useFloatingPosition({
      x: () => x.value,
      y: () => y.value,
      panel: () => panel,
      follow: true
    })

    x.value = 500
    y.value = 300
    await nextTick()
    expect(pos.value).toEqual({ left: 500, top: 300 })
  })

  it('面板还没渲染出来时 place() 不动', () => {
    stubViewport(1920, 1080)
    const { pos, place } = useFloatingPosition({
      x: () => 300,
      y: () => 200,
      panel: () => null
    })

    place()
    expect(pos.value).toEqual({ left: 0, top: 0 })
  })
})
