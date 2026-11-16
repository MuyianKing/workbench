/**
 * `window.workbench` 上的一组通道：网速球。
 * 实现见 `workbench/api-events.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  BallContext,
  NetCounters,
} from '../index'

export interface BallChannel {
  /**
   * 开 / 关网速球。角色与 capturePrewarm 一样：设置改了就推一次，值由渲染层给
   * （Rust 不去数据文件里读设置）。
   */
  ballApply: (visible: boolean) => Promise<Result<null>>

  /** 球窗口问自己贴着哪一侧、收起还是展开（side 为空 = 浮在桌面上） */
  ballContext: () => Promise<Result<BallContext>>

  /** 收起 / 展开（意图与防抖在渲染层，窗口尺寸与位置在 Rust） */
  ballOpen: (open: boolean) => Promise<Result<BallContext>>

  /**
   * 按住球开始拖：**跑到松手才返回**，回包是落定之后的状态（贴边收起 / 浮着摊开）。
   * 窗口由 Rust 按光标位置自己搬 —— 系统那条移动循环对这扇窗只画一个矩形轮廓
   * （见 docs/modules/float-ball.md）。
   */
  ballDrag: () => Promise<Result<BallContext>>

  /** 双击球：把主界面唤出来（它可能收在托盘里） */
  ballOpenMain: () => Promise<Result<null>>

  /**
   * 读一次网卡累计字节与链路速率（一秒一次）。速率 / 单位 / 平滑都在
   * @workbench/net-meter 里算，这一条只取原始数。
   */
  netCounters: () => Promise<Result<NetCounters>>
}
