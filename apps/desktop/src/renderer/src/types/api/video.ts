/**
 * `window.workbench` 上的一组通道：视频与独立视频窗口。
 * 实现见 `workbench/video.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  VideoNode,
  VideoSource,
  VideoWindowCommand,
  VideoWindowContext,
  VideoWindowEvent,
  VideoWindowOpen,
  VideoWindowReport,
} from '../index'

export interface VideoChannel {
  // ---------- 视频（用户自己挑的一个文件夹里的 MP4） ----------
  /**
   * 视频：**用户自己挑的一个文件夹**里的目录树（文件夹 + MP4 文件）。
   *
   * 与笔记同一条分工：平铺清单由 Rust 扫出来，树由渲染层组（@workbench/video）。
   * root 每次带下去 —— 用户换了文件夹，同一份树就换了来源。
   */
  listVideos: (root: string) => Promise<Result<VideoNode[]>>

  /**
   * 打开一个视频：把**这一个文件**的读取权限授给 asset 协议，回来的是可直接给
   * `<video>` 的地址（webview 自己按文件读，协议自带 Range，拖进度条不用整份下完）。
   *
   * 授权按文件给，与工作区背景图同一条边界 —— tauri.conf.json 的 `assetProtocol.scope`
   * 保持为空，往里写 `**` 等于把整块磁盘敞开给渲染层读。
   * 坏文件（读不出 MP4 文件头的）在这里如实报错，不交给界面静默黑屏。
   */
  loadVideo: (root: string, rel: string) => Promise<Result<VideoSource>>

  /**
   * 把当前视频搬到一扇真正的顶层窗口里播（第五个 HTML 入口 `video.html`）。
   *
   * 主窗口给的是「现在这一部 + 播到哪 + 播放列表」；窗口自己持有 `<video>`，
   * 播完按 `playlist` 自动接下一个。已有窗口时只是更新它（换视频 / 重新开），
   * 不重建 —— 播放状态由两条事件通道同步，见下面几个方法。
   */
  openVideoWindow: (input: VideoWindowOpen) => Promise<Result<null>>

  /** 主窗口 → 独立视频窗口：换视频（`load`）/ 收回（`dock`）/ 关掉（`close`） */
  sendVideoWindowCommand: (command: VideoWindowCommand) => Promise<Result<null>>

  /** 独立视频窗口启动时问自己那份上下文（会话 + 置顶状态）；窗口已经过期时报错 */
  videoWindowContext: () => Promise<Result<VideoWindowContext>>

  /** 独立视频窗口 → 主窗口：当前视频 / 速率变化 / 收回（带时间与暂停态）/ 关闭 */
  reportVideoWindow: (report: VideoWindowReport) => Promise<Result<null>>

  /** 切独立视频窗口的置顶（本次运行内记住，不落盘） */
  setVideoWindowOnTop: (onTop: boolean) => Promise<Result<null>>

  /**
   * 独立视频窗口里的命令（换视频 / 收回）。
   *
   * 只有 `video.html` 那个入口订阅：主窗口用不到的窗口侧通道照样登记在这里，
   * 契约与别的 `on*` 一样是「订阅返回退订函数」。
   */
  onVideoWindowCommand: (fn: (command: VideoWindowCommand) => void) => () => void

  /**
   * 独立视频窗口发回来的状态（当前视频 / 速率 / 收回 / 已关闭）。
   *
   * 只有主窗口订阅：收回时 `dock` 带着播放时间与暂停态，关闭时 `closed` 告诉主窗口
   * 要不要清掉 `active`（收回触发的关闭不清，它已经由 `dock` 交回播放权了）。
   */
  onVideoWindowEvent: (fn: (event: VideoWindowEvent) => void) => () => void
}
