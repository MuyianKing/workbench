/**
 * 悬浮球与宿主之间的线上格式（IPC 契约）。
 *
 * 这里只放「跨进程传的东西」，纯逻辑在 meter.ts。Rust 侧对应的定义在
 * `apps/desktop/src-tauri/src/net.rs`（NetCounters）与 `ball.rs`（BallSide / BallContext）。
 */

/** 球贴在屏幕哪一侧 */
export type BallSide = 'left' | 'right'

/**
 * 球窗口问「我现在是什么状态」（`ball_context` / `ball_open` 的返回）。
 *
 * 画哪一副样子（贴边的竖条还是整颗球）由窗口尺寸决定，而那件事由 Rust 设 ——
 * 渲染层据此决定画哪一副。`side` 为空就是**浮在桌面上**：那时球永远是整颗球，
 * 鼠标移开也不收起（收起是「贴边」的形态，见 float-ball.md）。
 */
export interface BallContext {
  side: BallSide | null
  /** 窗口上沿的 y（物理像素） */
  y: number
  open: boolean
}

/**
 * 一次采样的原始计数（`net_counters` 的原样返回）。
 *
 * **速率不在这里**：Rust 只报累计字节，速率 / 单位 / 平滑全在 meter.ts 算
 * （后端只做「取原始数据」，业务语义留在适配层）。
 */
export interface NetCounters {
  /** 累计收到的字节数（所有计入的网卡之和） */
  inOctets: number
  /** 累计发出的字节数 */
  outOctets: number
  /** 接收链路速率合计（bit/s）。0 = 取不到，弧按「未知」不画 */
  downLink: number
  /** 发送链路速率合计（bit/s） */
  upLink: number
  /** 计入了多少张网卡 */
  interfaces: number
}
