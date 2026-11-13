import type { AccentInkMode } from '@workbench/appearance'
import type { Ref } from 'vue'
import type { ThemeOrigin } from '@/theme-transition'
import type { AppSettings, EffectiveTheme, ThemeSource } from '@/types'
import { sanitizeAccentColor, sanitizeAccentInkMode } from '@workbench/appearance'
import { ref, watch } from 'vue'
import { bootstrapSnapshot, writeAccentColor, writeTheme } from '@/bootstrap'
import { applyThemeWithTransition } from '@/theme-transition'

/**
 * 主题内核：明暗切换、主题色、以及「同一轮切换只开一个转场」的那套守卫。
 *
 * 从 `settings.ts` 拆出来的一整块，只认整份设置与落盘入口（与 `settings-background.ts`
 * 同一个做法：工厂返回一组东西，宿主 spread 出去）。对外名字与行为完全不变。
 */
export function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** 主进程推主题之前，先按设置自算一次，避免首帧闪一下白底 */
export function resolveTheme(value: AppSettings): EffectiveTheme {
  if (value.theme === 'system')
    return prefersDark() ? 'dark' : 'light'
  return value.theme
}

export function useSettingsTheme(options: {
  settings: Ref<AppSettings>
  /** 落盘一层（settings store 的 updateSettings） */
  updateSettings: (patch: Partial<AppSettings>, origin?: ThemeOrigin | null) => Promise<boolean>
}) {
  const { settings, updateSettings } = options

  /**
   * 当前实际生效的明暗（`system` 已被解析成 light / dark）。
   * 界面里要按它画图标（顶栏的主题开关），所以不能只落在 DOM 属性上，得是个响应式的值。
   */
  const effectiveTheme = ref<EffectiveTheme>(bootstrapSnapshot()?.theme ?? 'light')

  /**
   * 已经生效的主题。
   *
   * 必须用这个变量做守卫，不能读 root.dataset.theme：View Transitions 的 DOM 改动要等旧快照
   * 拍完才执行，是异步的。一次用户切换会从三条路各推一次主题进来（IPC 回包、主进程显式的
   * 主题广播、nativeTheme 的 updated 广播），读 DOM 的话后两次会误判成「还没应用」，
   * 于是连开好几个转场、互相把对方挤成 skipped，界面上就是动效错乱甚至没有。
   *
   * 起点取首屏快照里的主题：入口 main.ts 已经把那一份落到 <html> 上了，这里登记成
   * 「已生效」，loadAppearance 拿回同一个值时才会直接返回，不会把首帧再改一遍。
   */
  let appliedTheme: EffectiveTheme | null = bootstrapSnapshot()?.theme ?? null

  /**
   * 用户刚点下的切换起点，等「真正生效的那一次应用」来认领。
   * IPC 回包与主进程广播谁先到不确定，把起点挂在这里，谁先到都能从点击处扩散。
   */
  let pendingThemeOrigin: ThemeOrigin | null = null

  /** 落盘前先登记这次切换的起点（由 updateSettings 调，见它的注释） */
  function setPendingOrigin(origin?: ThemeOrigin | null): void {
    pendingThemeOrigin = origin ?? null
  }

  /** 落盘失败时清掉：没有主题应用会来认领，别把起点留给下一次系统切换 */
  function clearPendingOrigin(): void {
    pendingThemeOrigin = null
  }

  /**
   * 主题落在 <html> 上；同时切换 Element Plus 需要的 .dark 类。
   *
   * origin 是这次切换的起点（用户点主题按钮的位置），过渡会从那个点扩散开；没有起点
   * （跟随系统、主进程推送）就从视口中心扩散。启动时传 animate: false，首帧不该播动画。
   */
  function applyTheme(
    theme: EffectiveTheme,
    options: { origin?: ThemeOrigin | null, animate?: boolean } = {},
  ): void {
    // 同一轮切换里的其余推送到这里直接返回，保证一次切换只开一个转场
    if (appliedTheme === theme)
      return

    appliedTheme = theme
    effectiveTheme.value = theme

    const origin = options.origin ?? pendingThemeOrigin
    pendingThemeOrigin = null

    const commit = (): void => {
      writeTheme(theme)
      // 主题色的浅色 / 深色档是照着明暗派生的，换主题必须一起重算（同一帧落进去，快照才是完整的）
      applyAccentColor()
    }

    if (options.animate === false) {
      commit()
      return
    }
    applyThemeWithTransition(commit, origin)
  }

  /**
   * 主题色：把派生出来的整族变量写到 <html> 的内联样式上（写法见 bootstrap.ts，
   * 与 mount 之前那次首屏落地共用同一份）。
   */
  function applyAccentColor(): void {
    writeAccentColor(settings.value.accentColor, effectiveTheme.value, settings.value.accentInk)
  }

  /**
   * 设置里一改就跟着落地：主题没变时 applyTheme 会直接返回，所以挑色后的落点是这条 watch。
   * 首次加载、别的窗口改设置推回来的整份设置也都经它。
   */
  watch([() => settings.value.accentColor, () => settings.value.accentInk], applyAccentColor, {
    immediate: true,
  })

  /**
   * 快速切换明暗（顶栏那颗图标）。
   *
   * 按「当前生效主题」取反后显式写进设置：原本是「跟随系统」的话，点一下就等于手动
   * 指定了相反的明或暗。origin 传点击位置，过渡动画从图标那一点扩散开。
   */
  function toggleTheme(origin?: ThemeOrigin | null): Promise<boolean> {
    const next: ThemeSource = effectiveTheme.value === 'dark' ? 'light' : 'dark'
    return updateSettings({ theme: next }, origin)
  }

  /**
   * 主题色：交互态与主按钮用的颜色，空串表示回到默认的中性色。
   * 只影响 Element Plus 的主色一族与全局焦点环，状态色和终端不动。
   */
  async function setAccentColor(color: string): Promise<boolean> {
    const next = sanitizeAccentColor(color)
    if (next === settings.value.accentColor)
      return true

    return updateSettings({ accentColor: next })
  }

  /** 铺在主题色上的文字色：自动 / 白字 / 黑字 */
  async function setAccentInk(mode: AccentInkMode): Promise<boolean> {
    const next = sanitizeAccentInkMode(mode)
    if (next === settings.value.accentInk)
      return true

    return updateSettings({ accentInk: next })
  }

  return {
    effectiveTheme,
    applyTheme,
    toggleTheme,
    setAccentColor,
    setAccentInk,
    setPendingOrigin,
    clearPendingOrigin,
  }
}
