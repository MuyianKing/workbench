/**
 * `window.workbench` 上的一组通道：设置、外观与首页布局。
 * 实现见 `workbench/api-system.ts 与 workbench/state.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  AppSettings,
  BackgroundImage,
  BootstrapSnapshot,
  BuiltinWallpaper,
  DesignWriteOutcome,
  EffectiveTheme,
  ThemeConfig,
} from '../index'

export interface AppearanceChannel {
  /**
   * 同步取一份首屏快照（见 BootstrapSnapshot）。
   * 渲染层在 mount 之前调用，让第一帧就是用户设置的样子，而不是先默认再切换。
   */
  getBootstrap: () => BootstrapSnapshot

  getSettings: () => Promise<Result<AppSettings>>

  updateSettings: (patch: Partial<AppSettings>) => Promise<Result<AppSettings>>

  /** 挑一张图片当工作区背景；只返回路径，落盘交给 updateSettings */
  pickBackground: () => Promise<string | null>

  /** 读取背景图（主进程压好尺寸后回传 data URL），文件不在或读不出来时返回失败 */
  loadBackground: (path: string) => Promise<Result<BackgroundImage>>

  /** 内置壁纸清单（含缩略图）；目录里没有图时返回空数组 */
  listWallpapers: () => Promise<Result<BuiltinWallpaper[]>>

  /** 首页布局配置（theme.json）：八块卡片的位置 / 尺寸与栏宽 */
  getThemeConfig: () => Promise<Result<ThemeConfig>>

  /** 合并保存首页布局；返回收敛后的最终值 */
  updateThemeConfig: (patch: Partial<ThemeConfig>) => Promise<Result<ThemeConfig>>

  /** 数据目录：安装版 `%APPDATA%\Workbench\data`、开发版 `%APPDATA%\Workbench-dev\data`，界面只用来如实显示数据放在哪儿 */
  getDataDir: () => Promise<Result<string>>

  onSettingsChanged: (fn: (settings: AppSettings) => void) => () => void

  onTheme: (fn: (theme: EffectiveTheme) => void) => () => void

  /** 首页布局被改过（本地保存或别的窗口），整份推过来 */
  onThemeConfig: (fn: (config: ThemeConfig) => void) => () => void

  // ---------- 样式参考库（74 套设计语言的 token 是随包静态资源，见 @workbench/appearance 的 design-export） ----------
  /**
   * 把一套设计规范写到项目根目录的 DESIGN.md。
   *
   * 内容是渲染层按 token 现生成的 markdown，这里只负责落盘：目标固定是 `<项目根>/DESIGN.md`，
   * 同名覆盖，回来告诉你原本有没有这个文件（界面据此换提示文案）。
   */
  writeDesign: (projectDir: string, content: string) => Promise<Result<DesignWriteOutcome>>
}
