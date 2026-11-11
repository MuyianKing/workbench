import type { Result, VideoWindowCommand, VideoWindowContext, VideoWindowEvent, VideoWindowOpen, VideoWindowReport } from '@/types'
import { guard, invoke, listen } from './bridge'
/**
 * 独立视频窗口的适配层：主窗口与 `video.html` 那扇窗口共用的五条通道 + 两条事件。
 *
 * 分工与视频本身同一条：窗口怎么摆、什么时候关归 Rust（`video_window.rs`）；
 * 「播到哪、下一个是谁」这类业务语义由两边的 Vue 各持一份，经这里来回传。
 * 播放文件仍走 asset 协议，授权是进程级的 —— 窗口里 `loadVideo` 直接可用。
 *
 * 两扇窗口共用这一份适配层：主窗口用 `openVideoWindow` / `sendVideoWindowCommand`
 * / `onVideoWindowEvent`，独立窗口用 `videoWindowContext` / `reportVideoWindow` /
 * `setVideoWindowOnTop` / `onVideoWindowCommand`。入口只装适配层、不装 store，
 * 与 pin / ball 同一条规矩。
 */

/** 主窗口：把当前视频交给独立窗口（已有窗口就是更新它） */
export async function openVideoWindow(input: VideoWindowOpen): Promise<Result<null>> {
  return guard(invoke<null>('video_window_open', { input }), '打开独立视频窗口失败')
}

/** 主窗口：换视频 / 收回 / 关掉 */
export async function sendVideoWindowCommand(command: VideoWindowCommand): Promise<Result<null>> {
  return guard(invoke<null>('video_window_command', { command }), '独立视频窗口没有响应')
}

/** 独立窗口：启动时取自己那份上下文 */
export async function videoWindowContext(): Promise<Result<VideoWindowContext>> {
  return guard(invoke<VideoWindowContext>('video_window_context'), '取独立视频窗口状态失败')
}

/**
 * 独立窗口：回报当前视频 / 速率 / 收回 / 关闭。
 *
 * `dock` 与 `close` 会在 Rust 处理完这条命令后把窗口关掉 —— 调用方按「发出去就别等
 * 回包」用（`void ...`），窗口关得快时这条 Promise 可能来不及 resolve。
 */
export async function reportVideoWindow(report: VideoWindowReport): Promise<Result<null>> {
  return guard(invoke<null>('video_window_report', { report }), '回报独立视频窗口状态失败')
}

/** 独立窗口：切置顶（Rust 记住，本次运行内有效） */
export async function setVideoWindowOnTop(onTop: boolean): Promise<Result<null>> {
  return guard(invoke<null>('video_window_on_top', { onTop }), '切换置顶失败')
}

/** 独立窗口：订阅主窗口发来的命令 */
export function onVideoWindowCommand(handler: (command: VideoWindowCommand) => void): () => void {
  return listen<VideoWindowCommand>('video-window:command', handler)
}

/** 主窗口：订阅独立窗口发回来的状态 */
export function onVideoWindowEvent(handler: (event: VideoWindowEvent) => void): () => void {
  return listen<VideoWindowEvent>('video-window:event', handler)
}

/** 装配根按域 spread 用的一份（方法名与 WorkbenchApi 一一对应） */
export const videoWindowApi = {
  openVideoWindow,
  sendVideoWindowCommand,
  videoWindowContext,
  reportVideoWindow,
  setVideoWindowOnTop,
  onVideoWindowCommand,
  onVideoWindowEvent,
}
