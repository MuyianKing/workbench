/**
 * 程序名称的收敛规则。
 *
 * 名字显示在标题栏、托盘提示和窗口标题上，所以主进程（读旧数据、被手工改过的数据文件）
 * 与渲染层（设置里编辑后即存）必须用同一套判定：空白名会让标题栏空掉，
 * 超长名会把标题栏撑开、把右上角的窗口按钮挤走，换行更是直接把一条标题栏变成两行。
 */

/** 默认程序名：brand 那条标题栏上的原始字样 */
export const APP_NAME_DEFAULT = 'WORKBENCH'

/** 名称长度上限：再长就不像程序名，也会挤坏标题栏 */
export const APP_NAME_MAX_LENGTH = 24

/**
 * 收敛成一个可直接上屏的名字：去掉首尾空白、把中间的连续空白压成单个空格，
 * 空串 / 全空白 / 非字符串一律回到默认名，超长截断。
 */
export function sanitizeAppName(value: unknown): string {
  if (typeof value !== 'string') return APP_NAME_DEFAULT

  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return APP_NAME_DEFAULT

  return normalized.slice(0, APP_NAME_MAX_LENGTH)
}
