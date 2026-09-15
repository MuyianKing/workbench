/**
 * 指针拖拽的公共骨架：起手、跟手、收手，以及「中途取消」的几条出口。
 *
 * 界面上有五处拖拽（终端面板高度、收起后那颗悬浮按钮的位置、首页卡片换栏换位、首页栏宽、
 * 卡片高度），原先各写一遍同样的三段：`pointerdown` 记起点 → 往 window 上挂
 * `pointermove` / `pointerup` / `pointercancel` → 收手时逐个解绑。五份都在靠人记住
 * 「别忘了 pointercancel」（系统接管指针时不收手，监听会一直留在 window 上，
 * 之后每次移动都在改值），也只有两处做了 Esc 放弃。
 *
 * 这里只收「骨架」，不收数学：位移怎么换算、落点在哪、要不要阈值，仍然留在各自的组件里。
 */

export interface PointerDragOptions {
  /**
   * 指针移动。调用方在这里换算自己的值（并决定要不要跟手）—— 只有真的动了才回调，
   * 也就是说「按下没动」不会触发。
   */
  onMove: (event: PointerEvent, start: { x: number; y: number }) => void
  /**
   * 收手。`last` 是这次拖动期间最后一次 onMove 收到的那个事件（没有移动过则为 null），
   * `cancelled` 表示这一手是被放弃的（Esc / 系统取消指针 / 组件卸载）而不是正常松手。
   * 两个参数要一起看：`last` 为 null 只说明「没移动过」，按下没动也是 null，
   * 光凭它分不出「点了一下」与「放弃了」（调用方要抑制随后的 click 时就需要这个区分）。
   */
  onEnd?: (last: PointerEvent | null, cancelled: boolean) => void
  /** 拖拽期间的清理（无论正常收手、Esc 还是被系统取消都会走一次） */
  onCleanup?: () => void
  /** 拖拽期间挂在 <body> 上的类名：用来关过渡动画、换光标（见 global.css 的 .is-* 几条） */
  bodyClass?: string
  /** 按下时的指针位置（viewport 坐标） */
  start: { x: number; y: number }
}

/**
 * 开始一次拖拽。
 *
 * 返回一个「立即结束」的函数（供组件在 unmount 时收尾：拖到一半被切走，监听不能留在 window 上）。
 */
export function startPointerDrag(options: PointerDragOptions): () => void {
  const { start, onMove, onEnd, onCleanup, bodyClass } = options
  let last: PointerEvent | null = null
  let done = false

  const detach = (): void => {
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', handleUp)
    window.removeEventListener('pointercancel', handleUp)
    window.removeEventListener('keydown', handleKeydown)
    if (bodyClass) document.body.classList.remove(bodyClass)
  }

  /** 收尾只走一次：指针抬起、被系统取消、Esc、组件卸载四条路都汇到这里 */
  const finish = (cancelled: boolean): void => {
    if (done) return
    done = true
    detach()
    onCleanup?.()
    onEnd?.(cancelled ? null : last, cancelled)
  }

  function handleMove(moveEvent: PointerEvent): void {
    last = moveEvent
    onMove(moveEvent, start)
  }

  function handleUp(): void {
    finish(false)
  }

  /** 拖到一半按 Esc：放弃这次调整，值回到拖动前 */
  function handleKeydown(keyEvent: KeyboardEvent): void {
    if (keyEvent.key !== 'Escape') return
    finish(true)
  }

  // 监听挂在 window 上：指针跑出那条 10px 的把手（或跑出那颗按钮）也还能继续拖
  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', handleUp)
  // 没有 pointercancel 时，系统取消指针（触控、手势接管）会让监听器留在 window 上，
  // 之后每次移动都在改值
  window.addEventListener('pointercancel', handleUp)
  window.addEventListener('keydown', handleKeydown)
  if (bodyClass) document.body.classList.add(bodyClass)

  return () => finish(true)
}
