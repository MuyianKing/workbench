/**
 * `window.workbench` 上的一组通道：禅道（会话、后台检查、浏览器打开）。
 * 实现见 `workbench/zentao.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  ZentaoBugList,
  ZentaoSession,
} from '../index'

export interface ZentaoChannel {
  /** 禅道会话仅在本机内存中，token 不进入渲染层或数据文件。 */
  zentaoSession: () => Promise<Result<ZentaoSession | null>>

  zentaoLogin: () => Promise<Result<ZentaoSession>>

  zentaoLogout: (sessionId: string) => Promise<Result<null>>

  /** 后台检查用：取一轮完整 Bug 列表（分页聚合在域包；界面不显示它） */
  zentaoBugs: (sessionId: string) => Promise<Result<ZentaoBugList>>

  /** 登记禅道后台检查周期（分钟，0 = 关闭）；间隔没变时后端不动计时 */
  zentaoWatch: (pollMinutes: number) => Promise<Result<null>>

  /** 比出新增之后弹系统通知（点通知用浏览器打开禅道，那一跳在 Rust 侧接） */
  zentaoNotify: (sessionId: string, count: number, title: string) => Promise<Result<null>>

  /** 后台线程到点该查了（取数、比新增与通知都在渲染层接手） */
  onZentaoCheck: (handler: () => void) => Promise<() => void>

  /** 用系统浏览器打开禅道（地址由 Rust 读内嵌配置；通知点击也走它） */
  zentaoOpenSite: () => Promise<Result<null>>
}
