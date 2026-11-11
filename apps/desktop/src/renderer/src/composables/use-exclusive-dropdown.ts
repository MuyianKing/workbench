/**
 * 一行一个右键菜单，但**同一时刻只许开一个**。
 *
 * el-dropdown 的「点外面关闭」只听 window 的 click —— 右击另一行不是 click，
 * 第二个菜单会与第一个并排挂着（笔记树 / 视频树的右键菜单都有这个问题）。
 * 这里在 `visible-change` 上收口：新的一开，先把当前开着的那个关掉
 * （`handleClose` 是 el-dropdown 暴露的方法，它自己会再发一次 visible-change(false)）。
 *
 * 用法（每行一个 el-dropdown，key 用行自己的 id / rel）：
 *   :ref="(el) => register(key, el)"
 *   @visible-change="(open: boolean) => onChange(key, open)"
 */
import type { DropdownInstance } from 'element-plus'

export function useExclusiveDropdown() {
  const instances = new Map<string, DropdownInstance>()
  /** 当前开着的那一行的键；空串表示都没开 */
  let openKey = ''

  /** 函数式 ref：行渲染出来时登记，卸载（传 null）时注销 */
  function register(key: string, instance: unknown): void {
    if (instance)
      instances.set(key, instance as DropdownInstance)
    else
      instances.delete(key)
  }

  /**
   * 一个菜单开 / 收。
   *
   * 开的时候先把上一个关掉：那一下会同步触发上一个的 `visible-change(false)`，
   * 它把自己的键清掉 —— 所以 `openKey` 最后才落到新的一行上。
   */
  function onChange(key: string, visible: boolean): void {
    if (!visible) {
      if (openKey === key)
        openKey = ''
      return
    }

    if (openKey && openKey !== key)
      instances.get(openKey)?.handleClose()
    openKey = key
  }

  return { register, onChange }
}
