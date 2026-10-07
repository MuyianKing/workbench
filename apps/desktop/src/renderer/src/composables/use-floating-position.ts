/**
 * 贴指针浮层的落点：量面板尺寸 → 夹回窗口内（边缘留出空当）。
 *
 * 与 use-floating-dismiss 配套 —— 那边收「什么时候收」，这边收「摆在哪」。
 * 三处右键菜单（笔记正文 / 邮件清单行 / 目录树空白区）原先各写一遍同一条
 * `Math.max(EDGE, Math.min(x, 窗口宽 - 面板宽 - EDGE))`，收口在这里。
 *
 * 长什么样、入场动画、菜单项仍然留在各自的组件里 —— 三份外壳的宽度与细节并不同。
 */
import { ref, watch } from 'vue'

/** 离窗口边缘留出的空当：贴着边看着像被裁掉了一角 */
export const FLOATING_EDGE = 6

export interface FloatingPositionOptions {
  /** 打开位置，视口坐标（contextmenu 的 clientX / clientY） */
  x: () => number
  y: () => number
  /**
   * 菜单面板元素；量尺寸要等它真的渲染出来。
   * 是个函数而不是元素：面板常常是 `v-if` 出来的，调用时现问才拿得到最新的那个。
   */
  panel: () => HTMLElement | null | undefined
  /**
   * 指针坐标变了就重摆：面板常驻（靠坐标 prop 驱动、在同一行换个地方右击时
   * 沿用同一实例）的菜单用；每次右击都现开现关的不用，打开时手动调一次 place()。
   */
  follow?: boolean
  /** 每次摆完的钩子（如笔记正文菜单判断子菜单往哪边开） */
  onPlaced?: () => void
}

export function useFloatingPosition(options: FloatingPositionOptions) {
  /** 夹回窗口之后的落点 */
  const pos = ref({ left: 0, top: 0 })

  /** 贴指针摆好，并把整块夹进窗口 */
  function place(): void {
    const element = options.panel()
    if (!element)
      return
    const { width, height } = element.getBoundingClientRect()
    pos.value = {
      left: Math.max(
        FLOATING_EDGE,
        Math.min(options.x(), window.innerWidth - width - FLOATING_EDGE),
      ),
      top: Math.max(
        FLOATING_EDGE,
        Math.min(options.y(), window.innerHeight - height - FLOATING_EDGE),
      ),
    }
    options.onPlaced?.()
  }

  if (options.follow)
    watch(() => [options.x(), options.y()], place)

  return { pos, place }
}
