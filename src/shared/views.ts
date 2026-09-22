/**
 * 应用页面（左侧导航栏上的每一项）。
 *
 * 项目不引入 Vue Router：当前页只是 store 里的一个 id，App.vue 用
 * `<KeepAlive><component :is>` 换页（KeepAlive 是为了保住各页的滚动位置）。
 * 所以这里只定义「有哪些页」以及 id 的合法值收敛，不涉及任何渲染。
 *
 * 落盘的是这个 id（见 shared/types.ts 的 AppSettings.activeView）：
 * 重启后回到上次那一页，认不出来的值一律回首页。
 *
 * 「导航栏上显示哪几页、按什么顺序」由用户自己配（AppSettings.hiddenViews / viewOrder，
 * 都住在 theme.json 里）：这里只记**被关掉的那些**与**显示的先后**，新加一页时不必去改
 * 谁的数据文件，它就自然出现在导航栏上（排在末尾）。
 */

export const VIEW_IDS = ['home', 'projects', 'work', 'notes', 'skills', 'vault', 'styles'] as const

export type ViewId = (typeof VIEW_IDS)[number]

/** 导航栏上的名字；顺序与 VIEW_IDS 一致（图标在各页组件里给，属于界面层） */
export const VIEW_LABELS: Record<ViewId, string> = {
  home: '首页',
  projects: '项目',
  work: '工作',
  notes: '笔记',
  skills: '技能',
  vault: '密码',
  styles: '样式'
}

export function isViewId(value: unknown): value is ViewId {
  return typeof value === 'string' && (VIEW_IDS as readonly string[]).includes(value)
}

/** 认不出来的值回首页：老数据文件里没有这个字段，手工改坏过也不能让界面白屏 */
export function sanitizeViewId(value: unknown): ViewId {
  return isViewId(value) ? value : 'home'
}

/**
 * 收敛「关掉的页」：只认登记过的 id（重复的、认不出来的、不是数组的一律丢掉），
 * 顺序按 VIEW_IDS 存放 —— 关掉了哪些不影响其余几项在导航栏上的先后。
 *
 * **至少留一页**：全关掉时把首页摘出来。一个入口都不剩的话用户就没法在应用里换页了，
 * 而首页是默认页、也是布局编辑的落点，留它最合适。
 */
export function sanitizeHiddenViews(value: unknown): ViewId[] {
  if (!Array.isArray(value)) return []
  const hidden = VIEW_IDS.filter((id) => value.includes(id))
  return hidden.length >= VIEW_IDS.length ? hidden.filter((id) => id !== 'home') : hidden
}

/** 导航栏上要显示的页（不带顺序参数时按 VIEW_IDS 的默认顺序） */
export function visibleViews(hidden: readonly ViewId[]): ViewId[] {
  return VIEW_IDS.filter((id) => !hidden.includes(id))
}

/**
 * 收敛「导航栏的顺序」（AppSettings.viewOrder，住在 theme.json 里，与 hiddenViews 同一批）：
 * 它必须恰好是全部页面的一个排列 —— 认不出来的 id、重复的丢掉，落下的按 VIEW_IDS 的
 * 默认顺序补到末尾，用户拖出来的相对先后不重排。老数据文件里没有这个字段（undefined）
 * 时得到的就是默认顺序，将来新加一页也自然排在末尾，不必去动谁的数据。
 */
export function sanitizeViewOrder(value: unknown): ViewId[] {
  if (!Array.isArray(value)) return [...VIEW_IDS]
  const known = [...new Set(value.filter((id): id is ViewId => isViewId(id)))]
  const missing = VIEW_IDS.filter((id) => !known.includes(id))
  return [...known, ...missing]
}

/**
 * 导航栏上要显示的页：按用户排的顺序走，关掉的项整项不出现 ——
 * 顺序与显隐是两件独立的事，关掉哪几页不影响其余几页的先后。
 */
export function orderedViews(
  hidden: readonly ViewId[],
  order: readonly ViewId[] = VIEW_IDS
): ViewId[] {
  return order.filter((id) => !hidden.includes(id))
}

/**
 * 当前页被关掉之后退到哪一页：按导航顺序数过去第一页可见的。
 * 收敛保证了它一定存在（见 sanitizeHiddenViews 的「至少留一页」），兜底的 home 只是防御。
 */
export function fallbackView(
  hidden: readonly ViewId[],
  order: readonly ViewId[] = VIEW_IDS
): ViewId {
  return orderedViews(hidden, order)[0] ?? 'home'
}
