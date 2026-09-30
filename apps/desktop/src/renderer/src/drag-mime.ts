/**
 * 拖拽时携带的数据类型。
 *
 * 分三类（项目卡 / 分组标签 / 快捷启动项），落点靠 getData 的类型区分该不该接。
 * 原先字符串散在 4 个组件里，拼写一旦漂移，表现就是「拖过去没反应」且没有任何报错。
 */
export const DRAG_MIME = {
  /** 项目卡：拖到分组标签上即归类 */
  project: 'application/x-workbench-project',
  /** 分组标签：拖动即排序 */
  group: 'application/x-workbench-group',
  /** 快捷启动项：拖动即排序 */
  quickApp: 'application/x-workbench-quick-app'
} as const
