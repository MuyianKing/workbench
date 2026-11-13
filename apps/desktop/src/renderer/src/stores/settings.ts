import type { ViewId } from '@workbench/appearance'
import type { ThemeOrigin } from '@/theme-transition'
import type { AppSettings, TopBarStyle } from '@/types'
import { clampCardOpacity } from '@workbench/appearance'
import { defineStore } from 'pinia'
/**
 * 设置与外观：明暗、主题色、工作区背景、卡片浓度，以及首页的分栏布局。
 *
 * 这些都在 `theme.json` + 数据文件的 settings 里（见 packages/appearance/src/appearance.ts 的白名单），
 * 适配层已经把两份合成一份完整的 `AppSettings`，所以这一层只认一个 `settings`。
 * 它是**界面长什么样**的唯一来源：主题落在 `<html>` 上、布局落在 `theme.json` 里。
 *
 * 与「业务」无关的持久化状态都归这里，于是别的 store（项目、终端）要用设置时，
 * 只需 `useSettingsStore()`，不必把项目数据一起拖进来。
 *
 * 四块内容各自住在同目录的工厂里，这里只做装配（对外名字与行为不变）：
 * `settings-theme.ts`（明暗与主题色）、`settings-layout.ts`（首页布局）、
 * `settings-sync.ts`（别台机器的外观）、`settings-background.ts`（工作区背景）。
 */
import { ref, watch } from 'vue'
import { bootstrapSnapshot, writeGlassBorder } from '@/bootstrap'
import { notifyError, notifyWarning } from '@/notify'
import { useSettingsBackground } from '@/stores/settings-background'
import { useSettingsLayout } from '@/stores/settings-layout'
import { useSettingsSync } from '@/stores/settings-sync'
import { resolveTheme, useSettingsTheme } from '@/stores/settings-theme'
import { DEFAULT_SETTINGS, TOP_BAR_STYLES } from '@/types'

export const useSettingsStore = defineStore('settings', () => {
  /**
   * 首屏快照（见 bootstrap.ts）。
   *
   * 这几个「决定界面长什么样」的初始值都取自它：入口 main.ts 已经在 mount 之前把明暗与
   * 主题色落到 <html> 上了，store 再用同一份快照起头，第一帧就不会是默认外观 ——
   * 之后 loadAppearance 拉回来的值只是核一遍，不再产生视觉变化。
   * 拿不到快照（预览桩）时为 null，退回默认值 + 异步加载的老路。
   */
  const bootstrap = bootstrapSnapshot()
  const settings = ref<AppSettings>(bootstrap ? bootstrap.settings : { ...DEFAULT_SETTINGS })

  // 主题内核：先把落盘入口以闭包递进去（updateSettings 是下面的函数声明，已提升）
  const theme = useSettingsTheme({
    settings,
    updateSettings: (patch, origin) => updateSettings(patch, origin),
  })

  // ---------- 设置本体 ----------

  async function updateSettings(
    patch: Partial<AppSettings>,
    origin?: ThemeOrigin | null,
  ): Promise<boolean> {
    const wantedHotkey = patch.hotkeyEnabled === true

    // 主题的起点先挂上：主进程既会回包又会广播，哪条路先触发应用都要用同一个起点。
    // 传了主题却没传起点（键盘切换）就是 null，从中心扩散。
    if (patch.theme !== undefined)
      theme.setPendingOrigin(origin)

    const result = await window.workbench.updateSettings(patch)
    if (!result.ok || !result.data) {
      // 没保存成功就不会有主题应用来认领，别把起点留给下一次系统切换
      theme.clearPendingOrigin()
      notifyError(result.error ?? '保存设置失败')
      return false
    }

    settings.value = result.data
    theme.applyTheme(resolveTheme(result.data), { origin })

    // 主进程注册失败时会自动把开关关掉，这里替它把原因说清楚
    if (wantedHotkey && !result.data.hotkeyEnabled) {
      notifyWarning(`快捷键 ${patch.hotkey ?? result.data.hotkey} 被系统或其他应用占用，已自动停用`)
    }
    return true
  }

  /**
   * 程序名：自绘的那条标题栏由组件自己读设置，而**窗口标题与托盘提示归系统**，只能在
   * Rust 侧设 —— 少了这一步，改完名字任务栏上还是构建时那个名字。
   *
   * immediate：store 一建好就把快照里那个名字送过去，不必等 loadAppearance
   * （在那之前窗口标题一直是构建时的占位名）。设置里改完由同一个 watch 接手。
   * 浏览器预览下没有后端，用可选链跳过（与 bootstrap.ts 同一个写法）。
   */
  watch(
    () => settings.value.appName,
    name => window.workbench?.setAppName(name),
    { immediate: true },
  )

  /** 顶部三条栏的样式（标题栏 / 欢迎语 / 筛选栏怎么跟壁纸叠） */
  async function setTopBarStyle(style: TopBarStyle): Promise<boolean> {
    if (!TOP_BAR_STYLES.includes(style))
      return false
    if (style === settings.value.topBarStyle)
      return true

    return updateSettings({ topBarStyle: style })
  }

  /**
   * 关掉 / 打开左侧导航栏上的某一页。
   *
   * 走 updateSettings：这一项在外观白名单里，实际落在 theme.json（与布局同一个文件）。
   * 全关掉的补丁会被收敛拦下（至少留一页，见 packages/appearance/src/views.ts 的 sanitizeHiddenViews），
   * 回推的设置就是收敛后的那一份，界面按它重画即可，这里不必自己兜 —— 所以也不做本地乐观更新。
   */
  async function setViewVisible(id: ViewId, visible: boolean): Promise<boolean> {
    const hidden = visible
      ? settings.value.hiddenViews.filter(item => item !== id)
      : [...settings.value.hiddenViews, id]

    return updateSettings({ hiddenViews: hidden })
  }

  /**
   * 左侧导航栏的显示顺序（设置里拖动排序收手时落盘）。
   *
   * 与 setViewVisible 同一条路：这一项也在外观白名单里，实际落在 theme.json。
   * 排列的完整性由收敛兜底（见 packages/appearance/src/views.ts 的 sanitizeViewOrder），这里只管把用户
   * 拖出来的那份送出去。
   */
  async function setViewOrder(order: ViewId[]): Promise<boolean> {
    return updateSettings({ viewOrder: order })
  }

  /**
   * 收起 / 展开左侧导航栏整条（顶栏右上角那颗折叠按钮）。
   *
   * 与 setViewVisible 同一条路：这一项也在外观白名单里，实际落在 theme.json。
   * 收起只是不画那一列（App.vue 按 navHidden 决定渲染），换页入口仍在顶栏按钮上。
   */
  async function setNavVisible(visible: boolean): Promise<boolean> {
    if (settings.value.navHidden === !visible)
      return true
    return updateSettings({ navHidden: !visible })
  }

  // 工作区背景（状态与动作）在 settings-background.ts：这里只装配并转出去
  const background = useSettingsBackground({ settings, updateSettings })

  /**
   * 卡片不透明度：首页工作台面板与项目卡共用的底色浓度。
   * 与背景浓淡同一套做法：拖动滑块时先跟手，松手才落盘。
   */
  const cardOpacity = ref(DEFAULT_SETTINGS.cardOpacity)

  watch(
    () => settings.value.cardOpacity,
    (value) => {
      cardOpacity.value = clampCardOpacity(value)
    },
    { immediate: true },
  )

  async function setCardOpacity(percent: number): Promise<void> {
    const next = clampCardOpacity(percent)
    cardOpacity.value = next
    if (next === settings.value.cardOpacity)
      return

    await updateSettings({ cardOpacity: next })
  }

  /**
   * 毛玻璃四周那条 1px 的描边（卡片 / 面板 / 下拉 / 弹窗都吃它，默认不画）。
   *
   * 与主题色同一套做法：落地只是往 `<html>` 上写两个变量的值（写法见 bootstrap.ts），
   * 这里只要在设置变了之后调一次 —— 首次加载、别的窗口改完推回来的整份设置都经这条 watch。
   */
  function applyGlassBorder(): void {
    writeGlassBorder(settings.value.glassBorder)
  }

  watch(() => settings.value.glassBorder, applyGlassBorder, { immediate: true })

  async function setGlassBorder(enabled: boolean): Promise<void> {
    if (settings.value.glassBorder === enabled)
      return

    await updateSettings({ glassBorder: enabled })
  }

  // ---------- 首页布局 / 别台机器的外观 ----------

  const layout = useSettingsLayout({ settings })
  const sync = useSettingsSync({ saveThemeConfig: layout.saveThemeConfig })

  // ---------- 载入与订阅 ----------

  /**
   * 拉一次设置与首页布局。
   *
   * **外观必须排在别的调用前面**：主题与布局决定界面长什么样，排到后面的话，
   * 用户会先看见默认外观、几十到几百毫秒后才被换成自己的设置。
   * 首屏快照是启动那一瞬的值（数据目录可能在启动后被换过），所以这里仍照当前值核一遍。
   */
  async function loadAppearance(): Promise<void> {
    const settingsResult = await window.workbench.getSettings()
    if (settingsResult.ok && settingsResult.data) {
      settings.value = settingsResult.data
      theme.applyTheme(resolveTheme(settings.value), { animate: false })
    }
    else {
      console.warn('读取设置失败', settingsResult.error)
    }

    const themeResult = await window.workbench.getThemeConfig()
    if (themeResult.ok && themeResult.data)
      layout.applyThemeConfig(themeResult.data)
    else
      console.warn('读取首页布局失败', themeResult.error)
  }

  /** 主进程 / 别的窗口推设置与主题过来时同步本地（由 store 的 init 统一调用） */
  function installListeners(): void {
    window.workbench.onSettingsChanged((value) => {
      settings.value = value
      theme.applyTheme(resolveTheme(value))
    })
    window.workbench.onTheme(theme.applyTheme)
    // 首页布局被改（本地保存或另一个窗口），整份同步
    window.workbench.onThemeConfig(layout.applyThemeConfig)
    // 跟随系统时，系统切换主题要即时响应（主进程那条事件是另一重保险）
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (settings.value.theme === 'system')
        theme.applyTheme(resolveTheme(settings.value))
    })
  }

  return {
    settings,
    effectiveTheme: theme.effectiveTheme,
    updateSettings,
    toggleTheme: theme.toggleTheme,
    applyTheme: theme.applyTheme,
    setTopBarStyle,
    setAccentColor: theme.setAccentColor,
    setAccentInk: theme.setAccentInk,
    setViewVisible,
    setViewOrder,
    setNavVisible,
    // 背景（状态与动作整组来自 settings-background.ts）
    ...background,
    cardOpacity,
    setCardOpacity,
    setGlassBorder,
    // 布局（整组来自 settings-layout.ts）
    ...layout,
    // 别台机器的外观（整组来自 settings-sync.ts）
    ...sync,
    // 生命周期
    loadAppearance,
    installListeners,
  }
})
