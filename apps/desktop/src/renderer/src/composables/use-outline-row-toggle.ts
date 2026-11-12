/**
 * 大纲整行收展：笔记页大纲栏与独立 Markdown 窗口目录栏共用的一套点击委托。
 *
 * Vditor 自带的大纲条目（`li > span[data-target-id]`）里，**有子级**的那几条后面
 * 跟一个 `<ul>`；原生只有条目内那枚 `svg.vditor-outline__action` 箭头认点击
 * （Vditor 在每次重建的根 `ul` 上绑监听）。这里在宿主栏上挂一个 **capture 阶段**
 * 的委托（capture 先于 Vditor 的冒泡监听），点到有子级的条目行任意位置就复刻
 * Vditor 的收展 —— svg 加/去 `--close`、旁侧的 `<ul>` 切 `display`。
 *
 * 返回 `true` 表示这一下已由这里收展，调用方的 capture 监听要把事件
 * `stopPropagation` 拦掉：否则点在箭头本身上时 Vditor 自己那份监听也会跑
 * （它按 `event.target` 向上找 `__action`），同一下点击就收展两次、互相抵消。
 * 返回 `false`（空白处 / 标题 / 叶子条目）不拦：叶子条目交给 Vditor 去跳标题。
 *
 * 事件由调用方挂在宿主元素上（`@click.capture="..."`），这个组合式不碰任何
 * 生命周期：大纲元素由 Vditor 重建时委托跟着宿主元素走，天然不受影响。
 */

/** Vditor 收起态的箭头类名：svg 带它时旋转 -90°（见 vditor 的 outlineRender） */
const CLOSE_CLASS = 'vditor-outline__action--close'

/**
 * 处理一次大纲栏内的点击：点到有子级的条目就收展它，返回要不要拦下事件。
 */
export function toggleOutlineRow(target: EventTarget | null): boolean {
  if (!(target instanceof Element))
    return false

  // 从点击点向上找最近的条目 span；没落进任何条目（栏的空白处 / 栏首标题）不管
  const item = target.closest('span[data-target-id]')
  if (!item)
    return false

  // 只有带子级 `ul` 的条目才收展（叶子条目交给 Vditor 去跳标题）
  const subList = item.nextElementSibling
  if (!(subList instanceof HTMLElement))
    return false

  // 收展箭头：条目 span 的直接子元素（outlineRender 把它插在文字前面）
  const action = item.querySelector(':scope > svg.vditor-outline__action')
  if (!action)
    return false

  // **用 CSSOM 赋值，不写行内 style 属性**：独立 Markdown 窗口的 HTML 里有内联
  // <style>（见 markdown.html），生产态 Tauri 给它们加 nonce 后 CSP 的
  // `style-src 'unsafe-inline'` 整体失效 —— setAttribute('style', …) 写的行内样式
  // 属性会被 CSP 静默丢弃（现象是箭头转了、列表收不起来）。`el.style.display = …`
  // 走 CSS 对象模型，不经属性解析，CSP 不管这一路，两个窗口都成立。
  if (action.classList.contains(CLOSE_CLASS)) {
    action.classList.remove(CLOSE_CLASS)
    subList.style.display = ''
  }
  else {
    action.classList.add(CLOSE_CLASS)
    subList.style.display = 'none'
  }
  return true
}
