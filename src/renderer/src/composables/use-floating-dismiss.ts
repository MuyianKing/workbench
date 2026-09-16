/**
 * 浮层的收起骨架：点别处 / 右键别处 / Esc / 滚轮 / 窗口缩放或失焦时收起。
 *
 * 界面上有两处浮层是「跟着指针冒出来、点别处就收」的菜单（正文的右键菜单、
 * 目录树空白区的右键菜单），原先各写一遍同样的一串监听。这里只收「什么时候收」，
 * 摆在哪、长什么样、点了做什么仍然留在各自的组件里。
 *
 * 三条细节是这两个菜单都踩过的：
 *   - **左键按下才收**。右键按下去的一瞬间就收、等松开 `contextmenu` 才到，
 *     中间那几十毫秒会白闪一下；
 *   - **落在面板里的不算「别处」**（点菜单自己的项不能先把自己收掉）；
 *   - **右键别处也收**：在正文 / 目录树里换个位置右击时，新的那份菜单会紧接着开出来，
 *     两件事在同一个事件里闭环，不会先消失再出现。
 */
import { onBeforeUnmount, onMounted } from 'vue'

export interface FloatingDismissOptions {
  /**
   * 浮层的面板元素；落在它里面的都算「在菜单上」。
   *
   * 是个函数而不是元素：面板常常是 `v-if` 出来的（挂监听时它还不存在），
   * 每次事件发生时现问一次才拿得到最新的那个。
   */
  panel: () => HTMLElement | null | undefined
  onDismiss: () => void
}

/** 挂上这一串监听，返回「摘掉」的函数（组件卸载时调） */
export function attachFloatingDismiss(options: FloatingDismissOptions): () => void {
  const dismiss = (): void => options.onDismiss()

  /** 事件是否落在面板里。target 可能是 window / document 这类非元素，先认一下再问 */
  function insidePanel(target: EventTarget | null): boolean {
    if (typeof target !== 'object' || target === null) return false
    return options.panel()?.contains(target as Node) === true
  }

  function onPointerDown(event: PointerEvent): void {
    // 只认左键：右键按下去先收、等松开 contextmenu 才到，中间那段会白闪一下
    if (event.button !== 0) return
    if (insidePanel(event.target)) return
    dismiss()
  }

  function onContextMenu(event: MouseEvent): void {
    if (insidePanel(event.target)) return
    dismiss()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') dismiss()
  }

  // 捕获阶段：这几件事一旦发生，浮层原来的位置就不再对了
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('wheel', dismiss, true)
  window.addEventListener('resize', dismiss)
  window.addEventListener('blur', dismiss)

  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('contextmenu', onContextMenu, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('wheel', dismiss, true)
    window.removeEventListener('resize', dismiss)
    window.removeEventListener('blur', dismiss)
  }
}

/** 在组件里用的那一层：挂载时接上、卸载时摘掉 */
export function useFloatingDismiss(options: FloatingDismissOptions): void {
  let stop: (() => void) | null = null
  onMounted(() => {
    stop = attachFloatingDismiss(options)
  })
  onBeforeUnmount(() => {
    stop?.()
    stop = null
  })
}
