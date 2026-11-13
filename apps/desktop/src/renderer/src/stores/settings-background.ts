import type { Ref } from 'vue'
import type { AppSettings, BuiltinWallpaper } from '@/types'
import { clampBackgroundOpacity } from '@workbench/appearance'
import { ref, watch } from 'vue'
import { notifyError } from '@/notify'
import { DEFAULT_SETTINGS } from '@/types'

/**
 * 工作区背景：磁盘路径 → webview 能读的 asset URL，外加内置壁纸那份按需缓存。
 *
 * 从 `settings.ts` 拆出来的一整块（状态 + 读取 + 四个动作），只认宿主与整份设置：
 * 设置里存路径、这里存解析出来的 URL；图片不进数据文件，换图只是换一个字符串。
 */
export function useSettingsBackground(options: {
  settings: Ref<AppSettings>
  /** 落盘一层（settings store 的 updateSettings） */
  updateSettings: (patch: Partial<AppSettings>) => Promise<boolean>
}) {
  const { settings, updateSettings } = options
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
    { immediate: true },
  )

  async function setBackgroundOpacity(percent: number): Promise<void> {
    const next = clampBackgroundOpacity(percent)
    backgroundOpacity.value = next
    if (next === settings.value.workspaceBackgroundOpacity)
      return

    await updateSettings({ workspaceBackgroundOpacity: next })
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
    if (path === backgroundPath.value && backgroundImage.value)
      return true

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

  // 设置是异步载入的，也可能被设置窗口改写，跟着它同步
  watch(() => settings.value.workspaceBackground, value => void applyBackground(value), {
    immediate: true,
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
    if (wallpapersLoaded)
      return
    try {
      wallpapers.value = await window.workbench.listWallpapers()
      wallpapersLoaded = true
    }
    catch (error) {
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
    if (target === settings.value.workspaceBackground)
      return true

    return updateSettings({ workspaceBackground: target })
  }

  /** 从磁盘上挑一张图当背景 */
  async function pickBackground(): Promise<boolean> {
    const picked = await window.workbench.pickBackground()
    if (!picked)
      return false

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

  return {
    backgroundImage,
    backgroundName,
    backgroundError,
    backgroundPath,
    backgroundOpacity,
    setBackgroundOpacity,
    wallpapers,
    ensureWallpapers,
    chooseBackground,
    pickBackground,
    useWallpaper,
    clearBackground,
  }
}
