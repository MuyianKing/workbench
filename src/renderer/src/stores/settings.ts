/**
 * 设置与外观：明暗、主题色、工作区背景、卡片浓度，以及首页三栏布局。
 *
 * 这些都在 `theme.json` + 数据文件的 settings 里（见 shared/appearance.ts 的白名单），
 * 适配层已经把两份合成一份完整的 `AppSettings`，所以这一层只认一个 `settings`。
 * 它是**界面长什么样**的唯一来源：主题落在 `<html>` 上、布局落在 `theme.json` 里。
 *
 * 与「业务」无关的持久化状态都归这里，于是别的 store（项目、终端）要用设置时，
 * 只需 `useSettingsStore()`，不必把项目数据一起拖进来。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_THEME,
  clampCardGap,
  clampCardHeight,
  clampColumnWidth,
  clampNoteTreeWidth,
  moveCard as placeCard,
  sanitizeTheme,
  type CardPlacement,
  type HomeCardId,
  type SideColumnId,
  type ThemeConfig
} from '@shared/theme'
import { clampBackgroundOpacity, sanitizeVeilColor } from '@shared/workspace-background'
import { clampCardOpacity } from '@shared/card-opacity'
import { sanitizeAccentColor, sanitizeAccentInkMode, type AccentInkMode } from '@shared/accent-color'
import type { ViewId } from '@shared/views'
import {
  DEFAULT_SETTINGS,
  TOP_BAR_STYLES,
  type AppSettings,
  type BuiltinWallpaper,
  type EffectiveTheme,
  type SyncDeviceInfo,
  type ThemeSource,
  type TopBarStyle
} from '@/types'
import { bootstrapSnapshot, writeAccentColor, writeTheme } from '@/bootstrap'
import { applyThemeWithTransition, type ThemeOrigin } from '@/theme-transition'
import type { Result, TokenUsageResult } from '@/types'
import { notifyError, notifySuccess, notifyWarning } from '@/notify'

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** 主进程推主题之前，先按设置自算一次，避免首帧闪一下白底 */
function resolveTheme(value: AppSettings): EffectiveTheme {
  if (value.theme === 'system') return prefersDark() ? 'dark' : 'light'
  return value.theme
}

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

  /**
   * 当前实际生效的明暗（`system` 已被解析成 light / dark）。
   * 界面里要按它画图标（顶栏的主题开关），所以不能只落在 DOM 属性上，得是个响应式的值。
   */
  const effectiveTheme = ref<EffectiveTheme>(bootstrap?.theme ?? 'light')

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
  let appliedTheme: EffectiveTheme | null = bootstrap?.theme ?? null

  /**
   * 用户刚点下的切换起点，等「真正生效的那一次应用」来认领。
   * IPC 回包与主进程广播谁先到不确定，把起点挂在这里，谁先到都能从点击处扩散。
   */
  let pendingThemeOrigin: ThemeOrigin | null = null

  /**
   * 主题落在 <html> 上；同时切换 Element Plus 需要的 .dark 类。
   *
   * origin 是这次切换的起点（用户点主题按钮的位置），过渡会从那个点扩散开；没有起点
   * （跟随系统、主进程推送）就从视口中心扩散。启动时传 animate: false，首帧不该播动画。
   */
  function applyTheme(
    theme: EffectiveTheme,
    options: { origin?: ThemeOrigin | null; animate?: boolean } = {}
  ): void {
    // 同一轮切换里的其余推送到这里直接返回，保证一次切换只开一个转场
    if (appliedTheme === theme) return

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
   * 首次加载、别的窗口改设置、数据目录迁移推回来的整份设置也都经它。
   */
  watch([() => settings.value.accentColor, () => settings.value.accentInk], applyAccentColor, {
    immediate: true
  })

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
    (name) => window.workbench?.setAppName(name),
    { immediate: true }
  )

  // ---------- 设置本体 ----------

  async function updateSettings(
    patch: Partial<AppSettings>,
    origin?: ThemeOrigin | null
  ): Promise<boolean> {
    const wantedHotkey = patch.hotkeyEnabled === true

    // 主题的起点先挂上：主进程既会回包又会广播，哪条路先触发应用都要用同一个起点。
    // 传了主题却没传起点（键盘切换）就是 null，从中心扩散。
    if (patch.theme !== undefined) pendingThemeOrigin = origin ?? null

    const result = await window.workbench.updateSettings(patch)
    if (!result.ok || !result.data) {
      // 没保存成功就不会有主题应用来认领，别把起点留给下一次系统切换
      pendingThemeOrigin = null
      notifyError(result.error ?? '保存设置失败')
      return false
    }

    settings.value = result.data
    applyTheme(resolveTheme(result.data), { origin })

    // 主进程注册失败时会自动把开关关掉，这里替它把原因说清楚
    if (wantedHotkey && !result.data.hotkeyEnabled) {
      notifyWarning(`快捷键 ${patch.hotkey ?? result.data.hotkey} 被系统或其他应用占用，已自动停用`)
    }
    return true
  }

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

  /** 顶部三条栏的样式（标题栏 / 搜索栏 / 筛选栏怎么跟壁纸叠） */
  async function setTopBarStyle(style: TopBarStyle): Promise<boolean> {
    if (!TOP_BAR_STYLES.includes(style)) return false
    if (style === settings.value.topBarStyle) return true

    return updateSettings({ topBarStyle: style })
  }

  /**
   * 关掉 / 打开左侧导航栏上的某一页。
   *
   * 走 updateSettings：这一项在外观白名单里，实际落在 theme.json（与布局同一个文件）。
   * 全关掉的补丁会被收敛拦下（至少留一页，见 shared/views.ts 的 sanitizeHiddenViews），
   * 回推的设置就是收敛后的那一份，界面按它重画即可，这里不必自己兜 —— 所以也不做本地乐观更新。
   */
  async function setViewVisible(id: ViewId, visible: boolean): Promise<boolean> {
    const hidden = visible
      ? settings.value.hiddenViews.filter((item) => item !== id)
      : [...settings.value.hiddenViews, id]

    return updateSettings({ hiddenViews: hidden })
  }

  /**
   * 主题色：交互态与主按钮用的颜色，空串表示回到默认的中性色。
   * 只影响 Element Plus 的主色一族与全局焦点环，状态色和终端不动。
   */
  async function setAccentColor(color: string): Promise<boolean> {
    const next = sanitizeAccentColor(color)
    if (next === settings.value.accentColor) return true

    return updateSettings({ accentColor: next })
  }

  /** 铺在主题色上的文字色：自动 / 白字 / 黑字 */
  async function setAccentInk(mode: AccentInkMode): Promise<boolean> {
    const next = sanitizeAccentInkMode(mode)
    if (next === settings.value.accentInk) return true

    return updateSettings({ accentInk: next })
  }

  // ---------- 工作区背景 ----------

  /**
   * 工作区背景。
   *
   * 设置里存的是磁盘路径，这里拿到的是后端授权、由 webview 按 asset 协议读的 URL（见适配层的
   * assetUrl）：图片不进数据文件，换图只是换一个字符串。
   * 图片被删、被换成读不出来的格式时留空并把原因记在 backgroundError 里，设置界面据此提示。
   */
  const backgroundImage = ref('')
  const backgroundName = ref('')
  const backgroundError = ref('')
  /** 已经读进 backgroundImage 的那条路径，用来免掉「刚选完又被设置变化推着读一遍」 */
  const backgroundPath = ref('')

  const backgroundOpacity = ref(DEFAULT_SETTINGS.workspaceBackgroundOpacity)

  watch(
    () => settings.value.workspaceBackgroundOpacity,
    (value) => {
      backgroundOpacity.value = clampBackgroundOpacity(value)
    },
    { immediate: true }
  )

  async function setBackgroundOpacity(percent: number): Promise<void> {
    const next = clampBackgroundOpacity(percent)
    backgroundOpacity.value = next
    if (next === settings.value.workspaceBackgroundOpacity) return

    await updateSettings({ workspaceBackgroundOpacity: next })
  }

  /**
   * 蒙版色：图片渐淡进去的那个颜色，空串表示跟随主题的画布色。
   * 没有背景图时它照样生效 —— 相当于给工作区定一个底色。
   */
  async function setBackgroundVeil(color: string): Promise<boolean> {
    const next = sanitizeVeilColor(color)
    if (next === settings.value.workspaceBackgroundVeil) return true

    return updateSettings({ workspaceBackgroundVeil: next })
  }

  /** 读一张图贴上工作区；读不出来时清空并把原因留在 backgroundError */
  async function applyBackground(path: string): Promise<boolean> {
    if (!path) {
      backgroundImage.value = ''
      backgroundName.value = ''
      backgroundPath.value = ''
      backgroundError.value = ''
      return true
    }

    // 同一张图已经在手上：选完图落盘会再触发一次，没必要把同一个 asset URL 再解析一遍
    if (path === backgroundPath.value && backgroundImage.value) return true

    const result = await window.workbench.loadBackground(path)
    if (!result.ok || !result.data) {
      backgroundImage.value = ''
      backgroundName.value = ''
      backgroundPath.value = ''
      backgroundError.value = result.error ?? '背景图读取失败'
      return false
    }

    backgroundImage.value = result.data.url
    backgroundName.value = result.data.name
    backgroundPath.value = result.data.path
    backgroundError.value = ''
    return true
  }

  // 设置是异步载入的，也可能被设置窗口改写（甚至被数据目录迁移整份换掉），跟着它同步
  watch(() => settings.value.workspaceBackground, (value) => void applyBackground(value), {
    immediate: true
  })

  /**
   * 随应用发布的内置壁纸（resources/backgrounds 下的那几张）。
   *
   * 每张的缩略图都要现解码 + 现压（7 张实测 270ms，全在 Rust 那边），而只有设置面板会读它，
   * 所以不跟着启动一起拉：面板第一次打开时按需取一次，之后一直用这份缓存。
   * 目录里没有图时是空数组，设置里那一栏自己会收起来。
   */
  const wallpapers = ref<BuiltinWallpaper[]>([])
  let wallpapersLoaded = false

  /** 打开设置面板时调一次；取不到就下次再试，不因为一组缩略图让面板打不开 */
  async function ensureWallpapers(): Promise<void> {
    if (wallpapersLoaded) return
    try {
      wallpapers.value = await window.workbench.listWallpapers()
      wallpapersLoaded = true
    } catch (error) {
      console.warn('[workbench] 读取内置壁纸失败', error)
    }
  }

  /**
   * 换一张工作区背景。
   *
   * target 可以是磁盘路径、`builtin:<id>` 内置引用，或空串（恢复默认画布）。
   * 一律先读通再落盘：免得把一个读不出来的值写进设置，下次启动才发现是一片空白。
   */
  async function chooseBackground(target: string): Promise<boolean> {
    if (!(await applyBackground(target))) {
      notifyError(backgroundError.value || '这张图片读不出来，请换一张')
      return false
    }
    if (target === settings.value.workspaceBackground) return true

    return updateSettings({ workspaceBackground: target })
  }

  /** 从磁盘上挑一张图当背景 */
  async function pickBackground(): Promise<boolean> {
    const picked = await window.workbench.pickBackground()
    if (!picked) return false

    return chooseBackground(picked)
  }

  /** 点选一张内置壁纸 */
  async function useWallpaper(reference: string): Promise<boolean> {
    return chooseBackground(reference)
  }

  /** 恢复默认画布 */
  async function clearBackground(): Promise<boolean> {
    return chooseBackground('')
  }

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
    { immediate: true }
  )

  async function setCardOpacity(percent: number): Promise<void> {
    const next = clampCardOpacity(percent)
    cardOpacity.value = next
    if (next === settings.value.cardOpacity) return

    await updateSettings({ cardOpacity: next })
  }

  // ---------- 首页布局 ----------

  /**
   * 首页三栏布局（theme.json：外观 + 布局都在这个文件里）。
   *
   * 与终端高度同一套做法：拖动栏宽 / 卡片高度时只改这个 ref 让布局跟手，
   * 松手才整份落盘，免得每动一格就写一次文件。
   *
   * 只读它的布局字段（cards / 栏宽 / 间距）。改成外观那几项走的是 `settings`：
   * 适配层在那边把两份合起来，这里的 `appearance` 可能比适配层旧一拍 ——
   * 无妨，因为每次落盘都是把补丁交给适配层、由它并到自己那份权威值上（见 workbench/state.ts）。
   */
  const themeConfig = ref<ThemeConfig>(sanitizeTheme(bootstrap?.themeConfig ?? DEFAULT_THEME))

  const cardGap = computed(() => themeConfig.value.cardGap)

  function applyThemeConfig(value: ThemeConfig): void {
    themeConfig.value = sanitizeTheme(value)
  }

  async function saveThemeConfig(patch: Partial<ThemeConfig>): Promise<boolean> {
    const result = await window.workbench.updateThemeConfig(patch)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '保存首页布局失败')
      return false
    }
    applyThemeConfig(result.data)
    return true
  }

  /** 把一块卡片挪到某栏的第 index 位：本地先跟手，随即落盘（拖放是一次性动作） */
  async function moveCard(id: HomeCardId, column: CardPlacement['column'], index: number): Promise<void> {
    themeConfig.value.cards = placeCard(themeConfig.value.cards, id, column, index)
    await saveThemeConfig({ cards: themeConfig.value.cards })
  }

  /** 拖动下边缘改高度：过程中只改本地 */
  function setCardHeight(id: HomeCardId, height: number): void {
    themeConfig.value.cards[id].height = clampCardHeight(height, id)
  }

  /** 切换高度模式（固定 / 自适应）；一次性动作，切完直接落盘 */
  async function toggleCardMode(id: HomeCardId): Promise<void> {
    const card = themeConfig.value.cards[id]
    card.mode = card.mode === 'flex' ? 'fixed' : 'flex'
    await commitCards()
  }

  /**
   * 关掉 / 打开首页的某一块卡片。
   *
   * 关掉只是不画它：栏内位置与高度都留着，再打开时回到原来那一格（见 shared/theme.ts）。
   * 与拖动落盘走同一条路（commitCards）：整份送出去，免得别的卡片停在旧快照。
   */
  async function setCardVisible(id: HomeCardId, visible: boolean): Promise<void> {
    themeConfig.value.cards[id].hidden = !visible
    await commitCards()
  }

  /** 松手落盘：所有卡片一起送，避免只有被拖的那块更新、其余停留在旧快照 */
  async function commitCards(): Promise<void> {
    const cards = {} as Record<HomeCardId, CardPlacement>
    for (const id of Object.keys(themeConfig.value.cards) as HomeCardId[]) {
      cards[id] = { ...themeConfig.value.cards[id] }
    }
    await saveThemeConfig({ cards })
  }

  /**
   * 笔记页左栏（目录树）宽度：与首页栏宽同一套做法 —— 拖动时只改本地让界面跟手，
   * 松手才整份落盘（它也在 theme.json 里）。
   */
  function setNoteTreeWidth(width: number): void {
    themeConfig.value.noteTreeWidth = clampNoteTreeWidth(width)
  }

  async function commitNoteTreeWidth(): Promise<void> {
    await saveThemeConfig({ noteTreeWidth: themeConfig.value.noteTreeWidth })
  }

  /** 拖动分栏边界改栏宽：过程中只改本地 */
  function setColumnWidth(side: SideColumnId, width: number): void {
    const fallback = side === 'left' ? themeConfig.value.leftWidth : themeConfig.value.rightWidth
    const next = clampColumnWidth(width, fallback)
    if (side === 'left') themeConfig.value.leftWidth = next
    else themeConfig.value.rightWidth = next
  }

  /** 松手落盘栏宽 */
  async function commitColumns(): Promise<void> {
    await saveThemeConfig({
      leftWidth: themeConfig.value.leftWidth,
      rightWidth: themeConfig.value.rightWidth
    })
  }

  /** 卡片间距是设置项，改完立即落盘（栏间、栏内卡片、项目卡网格同时生效） */
  async function setCardGap(value: number): Promise<void> {
    const next = clampCardGap(value)
    themeConfig.value.cardGap = next
    await saveThemeConfig({ cardGap: next })
  }

  /** 恢复默认布局；栏宽 / 栏内位置 / 高度 / 间距 / 关掉的卡片全部回到默认 */
  async function resetLayout(): Promise<void> {
    const fallback = sanitizeTheme(DEFAULT_THEME)
    themeConfig.value = fallback
    await saveThemeConfig({
      cardGap: fallback.cardGap,
      leftWidth: fallback.leftWidth,
      rightWidth: fallback.rightWidth,
      cards: fallback.cards
    })
  }

  // ---------- 别台机器的外观 ----------

  /**
   * 同步仓库里其它机器（含各自的外观配置快照）。
   *
   * 只读本地那份克隆、不联网，所以设置界面打开时问一次是安全的；内容是上一次同步取回来的样子。
   */
  const syncDevices = ref<SyncDeviceInfo[]>([])

  async function loadSyncDevices(): Promise<void> {
    try {
      syncDevices.value = await window.workbench.listSyncDevices()
    } catch (error) {
      // 取不到就当没有：没填仓库地址、还没同步过都是常态，界面上是一句空态提示
      syncDevices.value = []
      console.warn('[workbench] 读取同步设备失败', error)
    }
  }

  /**
   * 采用另一台机器的配置（设置界面里那一行的「应用」）。
   *
   * **只能由用户点**：配置是「以谁的为准」而不是能合并的数据，两台机器互相自动采用对方的
   * 会来回覆盖、永远收敛不了（详见 shared/sync-config.ts 的文件头）。
   * 走的是既有的 updateThemeConfig 通道 —— 外观与布局在同一个文件里，所以一次写入就够，
   * 主题过渡、终端高度、卡片摆放这些联动不必另写一套。
   */
  async function applySyncAppearance(deviceId: string): Promise<boolean> {
    const device = syncDevices.value.find((item) => item.id === deviceId)
    if (!device?.theme) {
      notifyWarning('那台机器没有可用的配置')
      return false
    }

    if (!(await saveThemeConfig(device.theme))) return false

    notifySuccess(`已应用「${device.name}」的外观与布局`)
    return true
  }

  /**
   * 手动同步一次 Token 用量（绕过自动同步的节流）。
   *
   * 首页的 Token 卡片与设置里的同步按钮共用这一份 —— 拆开之前是两段各自处理
   * 「回包失败 / 同步失败 / 成功」三种分支的重复实现，提示口径还略有出入。
   * 自动同步在后台跑、失败只体现在状态点上，手动点的这一次必须把原因说清楚。
   *
   * 返回后端结果，让调用方按需再取数字（Token 卡片拿到后会立刻重算展示）。
   */
  async function syncNow(): Promise<Result<TokenUsageResult> | null> {
    try {
      const result = await window.workbench.syncTokenUsage()
      if (!result.ok) {
        notifyError(result.error ?? '同步失败')
        return result
      }

      const error = result.data?.sync.error
      if (error) notifyError(error)
      else notifySuccess(`已同步${deviceTextOf(result.data)}`)
      return result
    } catch (err) {
      // 版本不一致、后端没起来都可能走到这里：说一声比按钮转完圈什么都不发生强
      notifyError(err instanceof Error ? err.message : '同步失败')
      return null
    }
  }

  /** 「已同步 · 本机、另一台」里那一段设备名；没开同步就是空串 */
  function deviceTextOf(data: TokenUsageResult | undefined): string {
    const sync = data?.sync
    if (!sync?.enabled) return ''
    const others = sync.devices.map((item) => item.name).join('、')
    return others ? ` · ${sync.deviceName}、${others}` : ` · ${sync.deviceName}`
  }

  // ---------- 载入与订阅 ----------

  /**
   * 拉一次设置与首页布局。
   *
   * **外观必须排在别的调用前面**：主题与布局决定界面长什么样，排到后面的话，
   * 用户会先看见默认外观、几十到几百毫秒后才被换成自己的设置。
   * 首屏快照是启动那一瞬的值（数据目录可能在启动后被换过），所以这里仍照当前值核一遍。
   */
  async function loadAppearance(): Promise<void> {
    settings.value = await window.workbench.getSettings()
    applyTheme(resolveTheme(settings.value), { animate: false })
    applyThemeConfig(await window.workbench.getThemeConfig())
  }

  /** 主进程 / 别的窗口推设置与主题过来时同步本地（由 store 的 init 统一调用） */
  function installListeners(): void {
    window.workbench.onSettingsChanged((value) => {
      settings.value = value
      applyTheme(resolveTheme(value))
    })
    window.workbench.onTheme(applyTheme)
    // 首页布局被改（本地保存或另一个窗口），整份同步
    window.workbench.onThemeConfig(applyThemeConfig)
    // 跟随系统时，系统切换主题要即时响应（主进程那条事件是另一重保险）
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (settings.value.theme === 'system') applyTheme(resolveTheme(settings.value))
    })
  }

  return {
    settings,
    effectiveTheme,
    updateSettings,
    toggleTheme,
    applyTheme,
    setTopBarStyle,
    setAccentColor,
    setAccentInk,
    setViewVisible,
    // 背景
    backgroundImage,
    backgroundName,
    backgroundError,
    backgroundOpacity,
    setBackgroundOpacity,
    setBackgroundVeil,
    wallpapers,
    ensureWallpapers,
    pickBackground,
    useWallpaper,
    clearBackground,
    cardOpacity,
    setCardOpacity,
    // 布局
    themeConfig,
    cardGap,
    applyThemeConfig,
    moveCard,
    setCardHeight,
    toggleCardMode,
    setCardVisible,
    commitCards,
    setColumnWidth,
    commitColumns,
    setNoteTreeWidth,
    commitNoteTreeWidth,
    setCardGap,
    resetLayout,
    // 别台机器的外观
    syncDevices,
    loadSyncDevices,
    applySyncAppearance,
    syncNow,
    // 生命周期
    loadAppearance,
    installListeners
  }
})
