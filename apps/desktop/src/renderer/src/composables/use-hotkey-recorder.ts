/**
 * 全局快捷键的录制：把浏览器给的 KeyboardEvent 转成 tauri-plugin-global-shortcut 认的那串
 * （`Control+Shift+W` 这种写法，解析与注册都在 Rust 侧）。
 *
 * 这套表原先长在设置·通用那一屏里。截图那两条快捷键要用同一套 —— 三处录制的口径必须一致：
 * 同一种按法在三处录出来的串得一模一样，否则「这个键能用、那个键不能用」会很难解释。
 */
import { ref } from 'vue'

/** 只按住这些键时还不构成组合，继续等下一个键 */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'])

/** 浏览器事件名 → 快捷键串里那一段 */
const KEY_ALIAS: Record<string, string> = {
  ' ': 'Space',
  'ArrowUp': 'Up',
  'ArrowDown': 'Down',
  'ArrowLeft': 'Left',
  'ArrowRight': 'Right',
  'Escape': 'Escape',
  'Enter': 'Return',
  'Tab': 'Tab',
  'Backspace': 'Backspace',
  'Delete': 'Delete',
  'Home': 'Home',
  'End': 'End',
  'PageUp': 'PageUp',
  'PageDown': 'PageDown',
}

const PUNCTUATION = '`-=[]\\;\',./'

export const HOTKEY_MODIFIER_MESSAGE = '快捷键至少需要一个修饰键（Ctrl / Shift / Alt）'

/** 一个按键能不能当快捷键的「主键」；不能就返回 null */
export function normalizeHotkeyKey(key: string): string | null {
  if (/^[a-z]$/i.test(key))
    return key.toUpperCase()
  if (/^\d$/.test(key))
    return key
  // F1~F24
  if (/^F([1-9]|1\d|2[0-4])$/.test(key))
    return key
  if (KEY_ALIAS[key])
    return KEY_ALIAS[key]
  if (PUNCTUATION.includes(key))
    return key
  return null
}

/** 展示形式：`Control+Shift+W` → `Ctrl + Shift + W` */
export function hotkeyLabel(accelerator: string): string {
  return accelerator
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)
    .join(' + ')
}

export interface HotkeyRecorderOptions {
  /**
   * 是否必须有修饰键。唤起窗口那条要求（单按一个字母会把整个键盘吃掉）；
   * 截图那两条不要求 —— F1 本来就天生没有修饰键（Snipaste 的习惯）。
   */
  requireModifier?: boolean
  /** 录到一个组合就回调（录完自动退出录制态） */
  onCapture: (accelerator: string) => void
  /** 不合规（缺修饰键）时的提示 */
  onReject?: (message: string) => void
}

export function useHotkeyRecorder(options: HotkeyRecorderOptions) {
  const recording = ref(false)

  function start(): void {
    recording.value = true
  }

  function stop(): void {
    recording.value = false
  }

  function capture(event: KeyboardEvent): void {
    // Esc 是「放弃这次录制」的正常路径：静默退出录制态，并拦住事件 ——
    // 不拦的话它会冒泡到 el-dialog 的 close-on-press-escape，把整个设置弹窗一起关掉
    if (event.key === 'Escape') {
      recording.value = false
      event.stopPropagation()
      return
    }

    const key = normalizeHotkeyKey(event.key)
    if (MODIFIER_KEYS.has(event.key) || !key)
      return

    const parts: string[] = []
    if (event.ctrlKey)
      parts.push('Control')
    if (event.shiftKey)
      parts.push('Shift')
    if (event.altKey)
      parts.push('Alt')
    if (event.metaKey)
      parts.push('Super')

    if (options.requireModifier !== false && parts.length === 0) {
      options.onReject?.(HOTKEY_MODIFIER_MESSAGE)
      return
    }

    recording.value = false
    options.onCapture([...parts, key].join('+'))
  }

  return { recording, start, stop, capture }
}
