import type { AccentInkMode } from '@workbench/appearance'
import type { BootstrapSnapshot, EffectiveTheme } from '@/types'
/**
 * 首屏快照，以及「把外观落到 DOM」的三个写入口。
 *
 * 设置是异步加载的，而窗口在渲染层第一帧之后就显示了 —— 只等异步结果的话，用户会先看到
 * 一份默认外观（亮色、无主题色、默认卡片布局），几十到几百毫秒后才被换成自己的设置，
 * 看上去就是「启动时切换了一次」。
 *
 * 所以这里在 mount 之前同步取一份主进程内存里的快照（见 apps/desktop/src/renderer/src/types.ts 的
 * BootstrapSnapshot），把明暗与主题色先落到 <html> 上，store 再拿同一份快照当初始值。
 * 第一帧因此就是最终的样子，之后的异步加载只是核对一遍，不再产生视觉变化。
 *
 * 快照里刻意不含背景图：它是主进程解码压缩出来的 data URL，体积大、天生异步，
 * 只能等 loadBackground 回来（见 store 里的 applyBackground）。
 */
import { ACCENT_VARIABLE_NAMES, accentVariables } from '@workbench/appearance'

/**
 * 快照只取一次：入口 main.ts 与 store 各要一回，缓存住省一次跨进程往返。
 * undefined 表示还没问过，与「问过但拿不到」区分开。
 */
let cached: BootstrapSnapshot | null | undefined

/**
 * 同步取首屏快照。
 *
 * 拿不到时返回 null —— 预览用的 API 桩、渲染层单独跑起来都属于这种情况，
 * 调用方一律退回默认值 + 异步加载那条老路：只是没有「首帧即正确」这个优化，功能不受影响。
 */
export function bootstrapSnapshot(): BootstrapSnapshot | null {
  if (cached !== undefined)
    return cached

  cached = null
  try {
    const snapshot = window.workbench?.getBootstrap?.()
    if (snapshot && snapshot.settings && snapshot.theme)
      cached = snapshot
  }
  catch {
    // 通道不可用就当作没有快照，别让启动挂在这一步上
  }
  return cached
}

/** 明暗落在 <html> 上；.dark 类同时给 Element Plus 的暗色变量表用 */
export function writeTheme(theme: EffectiveTheme): void {
  const root = document.documentElement
  root.dataset.theme = theme
  root.classList.toggle('dark', theme === 'dark')
}

/**
 * 主题色：把派生出来的整族变量写到 <html> 的内联样式上。
 *
 * 必须写在 :root 上而不是组件里 —— 弹层都 Teleport 到 body，只有根元素上的变量才同时
 * 管得到 .app 与 body 下的弹层。没配（空串）时逐个摘掉内联值，回落到 tokens.css。
 */
export function writeAccentColor(color: string, theme: EffectiveTheme, ink: AccentInkMode): void {
  const vars = accentVariables(color, theme, ink)
  const root = document.documentElement

  for (const name of ACCENT_VARIABLE_NAMES) {
    const value = vars[name]
    if (value)
      root.style.setProperty(name, value)
    else root.style.removeProperty(name)
  }
}

/**
 * 毛玻璃那条描边：关掉时把两个变量在 <html> 上写成 transparent。
 *
 * 落点必须与主题色同一处（根元素的内联样式）：描边要管到 Teleport 到 body 的弹层与下拉，
 * 写在 `.app` 上它们就看不见了。开着时**逐个摘掉内联值**、回落到 tokens.css 里那一份 ——
 * 两种主题下各自那档灰仍然跟着 `--border` / `--border-strong` 走。
 *
 * 只把那两个变量的值改掉、不动 border 本身：面上那条 1px 照旧占位，
 * 开关一下不会让定高的卡片挪 1px。
 */
const GLASS_BORDER_VARIABLES = ['--glass-border-color', '--glass-border-color-hover'] as const

export function writeGlassBorder(enabled: boolean): void {
  const root = document.documentElement
  for (const name of GLASS_BORDER_VARIABLES) {
    if (enabled)
      root.style.removeProperty(name)
    else root.style.setProperty(name, 'transparent')
  }
}

/**
 * mount 之前调用：把快照里的明暗、主题色与玻璃描边先落到 DOM。
 *
 * 必须在 Element Plus 的样式表之后执行（本模块由 main.ts 在创建应用前调用，
 * 那几个样式 import 早已完成），否则会看见亮色的一瞥。
 */
export function applyBootstrapTheme(): void {
  const snapshot = bootstrapSnapshot()
  if (!snapshot)
    return

  writeTheme(snapshot.theme)
  writeAccentColor(snapshot.settings.accentColor, snapshot.theme, snapshot.settings.accentInk)
  // 老主题文件里没有这一项：缺省就是不画描边（与 sanitizeAppearanceSettings 同一个口径）
  writeGlassBorder(snapshot.settings.glassBorder === true)
}
