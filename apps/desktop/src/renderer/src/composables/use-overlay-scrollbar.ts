import type { Ref } from 'vue'
import { onBeforeUnmount, ref, watch } from 'vue'

/**
 * 自绘悬浮滚动条的几何与事件。
 *
 * 原生滚动条的问题不是颜色：它永远占一条宽度、带上下箭头、并且只在悬停时出现得靠
 * 浏览器自己那套（WebView2 里还带按钮）。这里把原生滚动条整个藏掉，用一条 5px 的
 * 胶囊滑块自己画：**不占正文宽度**，滚动位置按比例映射到轨道上。
 *
 * 几何单独抽成 `thumbMetrics()`（纯函数、有单测）：滑块高度 = 轨道高 × 可视区 / 内容总高，
 * 最小 `MIN_THUMB`，位移把滚动比例映射到「轨道减滑块」的剩余长度。
 */

/** 滑块的最小高度：内容再长也要留一个能按住拖的点 */
export const MIN_THUMB = 28

export interface ThumbMetrics {
  /** 滑块高度（px） */
  height: number
  /** 滑块相对轨道顶部的位移（px） */
  top: number
}

/**
 * 按滚动位置算滑块几何；内容装得下（或还没有尺寸）时返回 null，调用方据此隐藏滑块。
 *
 * `trackHeight` 是滚动条自己的可用高度（含上下留白之后），不是滚动容器的高度。
 */
export function thumbMetrics(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  trackHeight: number,
  minThumb = MIN_THUMB,
): ThumbMetrics | null {
  if (clientHeight <= 0 || trackHeight <= 0)
    return null
  if (scrollHeight <= clientHeight + 1)
    return null

  const height = Math.min(trackHeight, Math.max(minThumb, Math.round(trackHeight * clientHeight / scrollHeight)))
  const maxScroll = scrollHeight - clientHeight
  const maxTop = Math.max(0, trackHeight - height)
  const top = maxTop === 0
    ? 0
    : Math.round(maxTop * Math.min(Math.max(scrollTop, 0), maxScroll) / maxScroll)

  return { height, top }
}

export interface OverlayScrollbarApi {
  /** null = 内容装得下，滑块不出现 */
  metrics: Ref<ThumbMetrics | null>
  /** 正在拖滑块（样式据此加深、加粗） */
  dragging: Ref<boolean>
  /** 按在滑块上：开始拖动 */
  onThumbPointerDown: (event: PointerEvent) => void
  /** 按在轨道空白处：直接跳到那个位置 */
  onTrackPointerDown: (event: PointerEvent) => void
}

/**
 * 把滚动条接到某个滚动容器上。
 *
 * `target` / `track` 用 getter 传进来而不是元素本身：Vditor 初始化是异步的，
 * 目标元素（`pre.vditor-reset`）在挂载之后才存在，ref 变了要重新绑。
 */
export function useOverlayScrollbar(
  target: () => HTMLElement | null,
  track: () => HTMLElement | null,
): OverlayScrollbarApi {
  const metrics = ref<ThumbMetrics | null>(null)
  const dragging = ref(false)

  let detach: (() => void) | null = null
  let frame = 0

  function measureNow(): void {
    const element = target()
    const trackElement = track()
    metrics.value = element && trackElement
      ? thumbMetrics(element.scrollTop, element.clientHeight, element.scrollHeight, trackElement.clientHeight)
      : null
  }

  function scheduleMeasure(): void {
    if (frame)
      return
    frame = requestAnimationFrame(() => {
      frame = 0
      measureNow()
    })
  }

  /**
   * 绑到目标上。
   *
   * 四类变化都要重算：滚动（位置）、尺寸（轨道高度 / 换行变了）、内容（打字 / 插图 ->
   * MutationObserver）、图片加载完（高度变了，`load` 不冒泡，用捕获）。
   */
  function bind(): void {
    detach?.()
    detach = null
    measureNow()

    const element = target()
    const trackElement = track()
    if (!element || !trackElement)
      return

    const onScroll = () => scheduleMeasure()
    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('load', scheduleMeasure, true)
    element.addEventListener('input', scheduleMeasure)

    const resize = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleMeasure)
    resize?.observe(element)
    resize?.observe(trackElement)

    const mutation = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(scheduleMeasure)
    mutation?.observe(element, { childList: true, characterData: true, subtree: true })

    window.addEventListener('resize', scheduleMeasure)

    detach = () => {
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('load', scheduleMeasure, true)
      element.removeEventListener('input', scheduleMeasure)
      resize?.disconnect()
      mutation?.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
    }
  }

  watch([target, track], bind, { immediate: true, flush: 'post' })

  onBeforeUnmount(() => {
    detach?.()
    detach = null
    if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
  })

  /**
   * 拖滑块：按「剩余轨道」映射「剩余滚动」，指针走到哪滑块跟到哪。
   * 监听挂在 window 上，拖出窗口也照旧跟手；收手时一并摘掉。
   */
  function onThumbPointerDown(event: PointerEvent): void {
    const element = target()
    const current = metrics.value
    if (!element || !current)
      return

    event.preventDefault()
    event.stopPropagation()
    dragging.value = true

    const startY = event.clientY
    const startScroll = element.scrollTop
    const maxScroll = Math.max(1, element.scrollHeight - element.clientHeight)
    const trackHeight = track()?.clientHeight ?? current.height
    const maxTop = Math.max(1, trackHeight - current.height)

    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault()
      const next = startScroll + (moveEvent.clientY - startY) * maxScroll / maxTop
      element.scrollTop = Math.max(0, Math.min(maxScroll, next))
    }
    const onEnd = () => {
      dragging.value = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      measureNow()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  /** 点轨道空白：把滑块中心挪到指针那一格 */
  function onTrackPointerDown(event: PointerEvent): void {
    const element = target()
    const trackElement = track()
    const current = metrics.value
    if (!element || !trackElement || !current)
      return

    if ((event.target as HTMLElement | null)?.closest('.osb__thumb'))
      return

    event.preventDefault()
    const maxTop = Math.max(1, trackElement.clientHeight - current.height)
    const y = event.clientY - trackElement.getBoundingClientRect().top - current.height / 2
    const ratio = Math.min(1, Math.max(0, y / maxTop))
    element.scrollTop = ratio * (element.scrollHeight - element.clientHeight)
    measureNow()
  }

  return { metrics, dragging, onThumbPointerDown, onTrackPointerDown }
}
