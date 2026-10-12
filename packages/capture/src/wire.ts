/**
 * 截图与钉图这两个域跟后端来回的**线格式**（IPC 契约）。
 *
 * 与 `@workbench/capture` 里那些纯逻辑分开一个文件，是因为它们只描述「跨进程传什么」：
 * 渲染层用不着算，Rust 那边一一对应（见 src-tauri/src/capture.rs 的 MonitorFrame /
 * CaptureOptions / CaptureContext 与 pin.rs 的 PinRecord / PinPatch）。
 *
 * **坐标一律是物理像素**，且都在**虚拟桌面坐标系**里（多屏合成的那张大桌面，
 * 主屏左上角为原点）—— 遮罩与钉图的窗口位置都是照这个摆的（见 coords.ts 的文件头）。
 */

/** 一块屏的几何 + 它那一帧截图落在哪儿 */
export interface CaptureMonitorFrame {
  /** 这场会话里的序号（遮罩窗口的标签就是它） */
  index: number
  /** 显示器名 */
  name: string
  x: number
  y: number
  width: number
  height: number
  /** 这块屏的缩放（物理像素 / CSS 像素） */
  scale: number
}

/** 这次截图要用到的设置（Rust 从数据文件里读，遮罩窗口自己不碰设置存储） */
export interface CaptureOptions {
  /** 自动保存目录，空串 = 还没设置 */
  saveDir: string
  /** 新钉图的初始透明度（百分比） */
  pinOpacity: number
  /** 选区时显示放大镜与像素取色 */
  magnifier: boolean
}

/** 遮罩窗口问「我代表哪块屏」时拿到的东西 */
export interface CaptureContext {
  /**
   * 这一场会话的编号。遮罩画完那一帧之后要把它送回 `capture_show` —— Rust 等到每块屏
   * 都报齐才显示遮罩（抢在帧前面显示就是先闪一块黑）。
   *
   * 编号走这里、不从 `capture:sync` 的载荷里拿：起手补问那一次（订阅生效之前可能已经开了
   * 一场）根本没收到那条事件，只有上下文知道「现在这一场是第几场」。
   */
  session: number
  monitor: CaptureMonitorFrame
  monitors: CaptureMonitorFrame[]
  options: CaptureOptions
}

/** 一张钉图的记账（位置 / 尺寸都是物理像素） */
export interface PinRecord {
  id: string
  /** 图片的绝对路径（用 assetUrl 读） */
  file: string
  x: number
  y: number
  width: number
  height: number
  /** 不透明度（百分比） */
  opacity: number
  /** 鼠标穿透：开着时点它等于点它底下那个窗口 */
  clickThrough: boolean
  /** 图片的原始长宽比（宽 / 高） */
  ratio: number
}

/** 改钉图状态时递上去的补丁（只带改动的那几项） */
export interface PinPatch {
  x?: number
  y?: number
  width?: number
  height?: number
  opacity?: number
  clickThrough?: boolean
}
