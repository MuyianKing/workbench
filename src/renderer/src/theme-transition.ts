/**
 * 明暗主题切换的过渡动效。
 *
 * 参考 Element Plus 文档站的做法：先用 View Transitions API 把切换前后的界面各截一张快照，
 * 再对「新主题」那张画一个从点击位置扩散开的圆形 clip-path，让新主题从旧主题底下翻上来。
 * 不支持这套 API、或用户在系统里开了「减少动态效果」时，就直接同步切换，不留中间态。
 */

/** 圆形扩散的起点（视口坐标），通常取用户点主题按钮的位置 */
export interface ThemeOrigin {
  x: number
  y: number
}

/** 扩散时长（ms）：跟 Element Plus 文档站一致，再慢就显得拖沓 */
const REVEAL_DURATION = 400

/** 缓动：起步略快、收尾变缓，圆扩到边缘时正好停住 */
const REVEAL_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

/** 从 (x, y) 到最远一角的距离，保证圆足够大、能盖住整个视口 */
function revealRadius(x: number, y: number): number {
  return Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  )
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * 执行一次带过渡的主题切换。
 *
 * mutate 里只放同步的 DOM 改动（写 data-theme、切 .dark 类），别塞异步操作 ——
 * 它会在新旧两张快照之间被调用，浏览器要等它返回后才继续。
 * origin 给了就从那个点长出来；没给（跟随系统等自己变的场景）就从视口中心长出来。
 */
export function applyThemeWithTransition(
  mutate: () => void,
  origin?: ThemeOrigin | null
): void {
  const canAnimate =
    typeof document !== 'undefined' &&
    typeof document.startViewTransition === 'function' &&
    // 窗口收在托盘 / 页面不可见时，浏览器会把转场直接判定为无效并中止；
    // 与其开一个必然被中止的转场，不如同步切换
    document.visibilityState === 'visible' &&
    !prefersReducedMotion()

  if (!canAnimate) {
    mutate()
    return
  }

  const x = origin?.x ?? window.innerWidth / 2
  const y = origin?.y ?? window.innerHeight / 2
  const radius = revealRadius(x, y)

  let transition: ViewTransition
  try {
    transition = document.startViewTransition(mutate)
  } catch {
    // 同一时刻已经有转场在跑时浏览器会直接拒绝，退回同步切换
    mutate()
    return
  }

  transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${radius}px at ${x}px ${y}px)`
          ]
        },
        {
          duration: REVEAL_DURATION,
          easing: REVEAL_EASING,
          pseudoElement: '::view-transition-new(root)'
        }
      )
    })
    .catch(() => {
      // ready 被拒绝说明这次转场没能成立；快照已经落到新主题上，不用再补动画
    })
}
