/**
 * 截图功能的设置项：默认值 + 收敛。
 *
 * 六项全部**只对本机成立**（快捷键是这台机器的、保存目录是这台机器的盘），
 * 所以都住在数据文件里、不参与外观同步 —— 与 `hotkey` / `noteDir` 同一类。
 * 形状与收敛放这里，`AppSettings` 只做类型引用（与 `@workbench/ai` 的
 * AI_PERMISSION_DEFAULT 同一套做法）。
 */
import { clampPinOpacity } from './pin'

/** 截图开关（关掉之后快捷键与托盘项都不再触发，但功能本身还在） */
export const CAPTURE_ENABLED_DEFAULT = true
/** 起截图的全局快捷键。F1 是 Snipaste 的习惯，系统里没别人占 */
export const CAPTURE_HOTKEY_DEFAULT = 'F1'
/** 「切换钉图鼠标穿透」的全局快捷键：钉图一旦穿透就收不到鼠标事件了，只能靠全局键收回来 */
export const PIN_THROUGH_HOTKEY_DEFAULT = 'Control+Shift+X'
/** 自动保存的目录。空串 = 还没选过（保存时弹「另存为」） */
export const CAPTURE_SAVE_DIR_DEFAULT = ''
/** 新钉图的初始透明度（百分比） */
export const CAPTURE_PIN_OPACITY_DEFAULT = 100
/** 选区时显示放大镜与像素取色 */
export const CAPTURE_MAGNIFIER_DEFAULT = true

/**
 * 快捷键串：只做「去空白 + 空则回默认」。**认不认得出交给 Rust** ——
 * 解析器是 tauri-plugin-global-shortcut 那份（`Control+M` 这种写法），
 * 在这儿另写一套判断只会两边对不上；注册失败时会返回错误给设置界面。
 */
export function sanitizeCaptureHotkey(value: unknown, fallback: string): string {
  if (typeof value !== 'string')
    return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

/**
 * 保存目录：去首尾空白、去掉末尾的分隔符（`C:\shots\` → `C:\shots`）。
 * 盘根要留住那个分隔符（`C:\`），否则拼出来会变成当前盘当前目录的相对路径。
 */
export function sanitizeCaptureSaveDir(value: unknown): string {
  if (typeof value !== 'string')
    return CAPTURE_SAVE_DIR_DEFAULT

  let trimmed = value.trim()
  while (trimmed.length > 3 && /[\\/]$/.test(trimmed))
    trimmed = trimmed.slice(0, -1)
  return trimmed
}

export function sanitizeCapturePinOpacity(value: unknown): number {
  if (typeof value !== 'number')
    return CAPTURE_PIN_OPACITY_DEFAULT
  return clampPinOpacity(value)
}

export function sanitizeCaptureMagnifier(value: unknown): boolean {
  return value !== false
}
