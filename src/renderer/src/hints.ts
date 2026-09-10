import type { AppSettings } from '@shared/types'

/** 一条操作提示：做什么 + 靠什么触发（键位或鼠标动作） */
export interface Hint {
  text: string
  hint: string
}

/**
 * 首页面板与空状态侧栏共用的一份提示。
 *
 * 全局快捷键是用户自己录的，所以只能从设置里取，不能写死。
 */
export function buildHints(settings: AppSettings): Hint[] {
  const hotkey = settings.hotkeyEnabled
    ? settings.hotkey.split('+').map((part) => part.trim()).filter(Boolean).join(' + ')
    : '未启用'

  return [
    { text: '搜索项目名或路径', hint: 'Ctrl K' },
    { text: '唤起 / 隐藏窗口', hint: hotkey },
    { text: '把卡片拖到分组标签即归类', hint: '拖动' },
    { text: '拖动分组标签可调整顺序', hint: '拖动' },
    { text: '点关闭按钮收进托盘，不会退出', hint: '关闭' }
  ]
}
