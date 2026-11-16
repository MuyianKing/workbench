/**
 * `window.workbench` 上的一组通道：邮箱事件（其余收发通道在 workbench/mail.ts，不经 window.workbench）。
 * 实现见 `workbench/mail.ts`；这里只有形状。
 */

import type {
  MailNotifyPayload,
  MailUnreadPayload,
} from '../index'

export interface MailChannel {
  /**
   * 邮件后台监视弹的系统通知被点了：Rust 已唤出主窗口，这里换到邮箱页并把
   * 通知里那封打开。载荷是通知对应的（账户, uid）—— 那封信可能已被删掉或在
   * 广告段里，找不到时只开页面不报错。
   */
  onMailNotifyClick: (fn: (payload: MailNotifyPayload) => void) => () => void

  /**
   * 后台监视每轮推上来的收件箱未读摘要（导航栏邮箱角标据此计数）。
   * 载荷只信「这一轮开始取数之后本地没改过」的情况（见 stores/mail.ts 的 checkedAt 守卫）。
   */
  onMailUnread: (fn: (payload: MailUnreadPayload) => void) => () => void
}
