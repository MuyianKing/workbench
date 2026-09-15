/**
 * 应用页面（左侧导航栏上的每一项）。
 *
 * 项目不引入 Vue Router：当前页只是 store 里的一个 id，App.vue 用
 * `<KeepAlive><component :is>` 换页（KeepAlive 是为了保住各页的滚动位置）。
 * 所以这里只定义「有哪些页」以及 id 的合法值收敛，不涉及任何渲染。
 *
 * 落盘的是这个 id（见 shared/types.ts 的 AppSettings.activeView）：
 * 重启后回到上次那一页，认不出来的值一律回首页。
 */

export const VIEW_IDS = ['home', 'projects'] as const

export type ViewId = (typeof VIEW_IDS)[number]

/** 导航栏上的名字；顺序与 VIEW_IDS 一致（图标在各页组件里给，属于界面层） */
export const VIEW_LABELS: Record<ViewId, string> = {
  home: '首页',
  projects: '项目'
}

export function isViewId(value: unknown): value is ViewId {
  return typeof value === 'string' && (VIEW_IDS as readonly string[]).includes(value)
}

/** 认不出来的值回首页：老数据文件里没有这个字段，手工改坏过也不能让界面白屏 */
export function sanitizeViewId(value: unknown): ViewId {
  return isViewId(value) ? value : 'home'
}
