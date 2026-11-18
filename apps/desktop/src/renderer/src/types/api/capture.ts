/**
 * `window.workbench` 上的一组通道：截图与钉图。
 * 实现见 `workbench/api-events.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  CaptureContext,
  OcrLine,
  PinPatch,
  PinRecord,
} from '../index'

export interface CaptureChannel {
  // ---------- 截图与钉图（见 docs/modules/screenshot.md） ----------
  /**
   * 预先把遮罩窗口建好（每块屏一块）。**按热键到看见遮罩能不能压到两百毫秒级全靠这一条**：
   * 建一个 WebView2 窗口本身就比整个预算还贵，所以窗口是预建、跨场复用的
   * （见 docs/modules/screenshot.md）。设置载入后由渲染层调一次 —— 开着就建、关掉就把池子收掉；
   * 失败不致命（真按热键时 Rust 会现建，只是那一次慢）。
   */
  capturePrewarm: (enabled: boolean) => Promise<Result<null>>

  /** 收工：把遮罩藏起来（窗口留着复用）、丢掉这场会话的几帧 */
  abortCapture: () => Promise<void>

  /** 遮罩窗口问：我代表哪块屏、这场会话一共几块、这次要用的设置是什么 */
  captureContext: () => Promise<Result<CaptureContext>>

  /**
   * 这块屏那一帧的原始 PNG 字节（二进制 IPC，`invoke` 拿到 `ArrayBuffer`）。
   *
   * **不走 base64**：这是截图上最大的一笔载荷，base64 会多 33% 体积与两次编解码。
   * **不用 asset 协议是有原因的**：渲染层要把这一帧画到画布上，还要 `getImageData`
   * （放大镜取色、马赛克）与 `toBlob`（复制 / 保存 / 钉图）；asset 协议对页面是跨源的，
   * 把它的图 drawImage 进画布会**污染画布**，那两个调用都会抛 SecurityError。
   * 字节包成 Blob 是同源，没有这回事。
   */
  captureFrame: () => Promise<Result<ArrayBuffer>>

  /**
   * 遮罩里的 JS 报「这一场的帧已经画到画布上了」。`id` 取自 `captureContext` 返回的
   * `session`（那才是它真画出来的那一场）。
   *
   * Rust 等到**每一块屏**都报齐才把遮罩显示出来 —— 抢在那一帧前面显示，用户看到的就是
   * 「先闪一块黑、再出画面」。编号对不上（上一场那半截、或者已经收工了）一律忽略；
   * 万一一直没人报，Rust 侧还有一秒的看门狗兜底，不会「按了没反应」。
   */
  showCapture: (id: number) => Promise<Result<null>>

  /**
   * 把最终图放进系统剪贴板（base64 的 PNG，与邮箱附件 / 笔记图片同一条路：
   * IPC 只走 JSON，二进制要编一手）。
   */
  copyImage: (png: string) => Promise<Result<null>>

  /**
   * 把一段文本放进系统剪贴板（取色的十六进制 / 取字的 OCR 结果）。
   * 走 Win32 的 `CF_UNICODETEXT`，不经 WebView 的异步剪贴板 —— 后者要权限回调放行、
   * 失败还是静默的（见 clipboard.rs 文件头）。
   */
  copyText: (text: string) => Promise<Result<null>>

  /**
   * 没画标注时的复制快路径：只把这**块屏画布坐标**上的选区交给 Rust，由它从这一场缓存的
   * 原始帧里裁出来写剪贴板 —— 不走「JS 合成 → PNG → base64 → IPC → Rust 再解码」那一圈。
   */
  copyFrame: (rect: { x: number, y: number, width: number, height: number }) => Promise<Result<null>>

  /**
   * 取字：把选区那一块交给 **Windows 自带的 OCR**（本机识别，不新增联网出口、不随包带模型）。
   * 回来的是行与词，坐标是**选区内**的物理像素（原点在选区左上角）—— 中文一字一框、
   * 英文一词一框，文字层照着摆就能逐字选中（见 ocr.rs 与 @workbench/capture 的 layoutOcrSpans）。
   * 遮罩不收：取完字还要回到遮罩里拖选、复制。
   */
  ocrRegion: (rect: { x: number, y: number, width: number, height: number }) => Promise<Result<OcrLine[]>>

  /**
   * 把最终图落盘，返回真正写进去的绝对路径。
   * `unique` 为真时同名加 `-2` / `-3`（自动保存那条路），为假时覆盖（「另存为」用户挑过的那条路）。
   */
  saveImage: (png: string, dir: string, name: string, unique: boolean) => Promise<Result<string>>

  /**
   * 滚动截图开场：Rust 把焦点还给开场时的前台窗口、光标钉进选区中心、遮罩设成鼠标穿透
   * —— 三件事合起来才把滚轮喂进目标窗口（焦点与光标是双保险，穿透挡住遮罩自己吃滚轮）。
   * 矩形口径与 copyFrame 一致：这块屏的画布坐标（物理像素）。
   */
  scrollBegin: (rect: { x: number, y: number, width: number, height: number }) => Promise<Result<null>>

  /**
   * 滚动中抓一次选区的**实时**像素（二进制 IPC，`invoke` 拿到 `ArrayBuffer`，同 captureFrame）。
   * 不走会话缓存 —— 目标窗口正在动，开场冻结的那一帧早过时了。
   */
  scrollGrab: (rect: { x: number, y: number, width: number, height: number }) => Promise<Result<ArrayBuffer>>

  /**
   * 向下滚 `units` 个滚轮单位（120 = 一整格）。渲染层按上一步实际位移自适应：稳态发整格
   * （120 × 齿数），遇到「一格跨过整个选区」的窗口减半细分（60 / 30）找能拼的步长。
   */
  scrollWheel: (units: number) => Promise<Result<null>>

  /** JS 自己停（到底 / 拼不上）：遮罩恢复交互并拿回焦点，进结果相 */
  scrollStop: () => Promise<Result<null>>

  /** 把这张图钉到屏幕上（位置与尺寸按物理像素给），返回它的记账 */
  pinImage: (
    png: string,
    x: number,
    y: number,
    width: number,
    height: number,
    opacity: number,
  ) => Promise<Result<PinRecord>>

  /** 钉图窗口问自己的记账（图片路径、长宽比、不透明度） */
  pinContext: () => Promise<Result<PinRecord>>

  /** 改钉图状态：窗口几何交给系统，记账跟着更新 */
  pinState: (patch: PinPatch) => Promise<Result<PinRecord>>

  /** 关掉这张钉图（窗口、图片、记账一起清掉） */
  pinClose: () => Promise<void>

  /** 关掉所有钉图（托盘菜单里那一项） */
  pinCloseAll: () => Promise<void>

  /** 把这张钉图的图放进剪贴板 */
  pinCopy: () => Promise<Result<null>>

  /** 把这张钉图另存一份 */
  pinSave: (dir: string, name: string, unique: boolean) => Promise<Result<string>>

  /** 截图失败（Rust 侧抓屏 / 铺遮罩出错）：主窗口据此弹一条提示 —— 那时界面多半看不见 */
  onCaptureFailed: (fn: (message: string) => void) => () => void

  /**
   * 「跟当前这场会话对一次」：Rust 在**开场**与**收工**（藏起遮罩之后）各推一条。
   * 开场那条带这一场的编号（**只当「这是开场」用** —— 要送回去的那个编号以
   * `captureContext` 里的 `session` 为准，起手补问那一次收不到这条事件），收工那条是 `null`。
   *
   * 遮罩窗口是**跨场复用**的（预建、藏起来），所以显示 / 隐藏它并不会让里面的 JS 重新开场 ——
   * 两边都靠这一条：开场那条去取上下文与帧，收工那条把上一场的帧、选区与标注丢掉。
   *
   * 订阅要等它真的挂上才 resolve：遮罩是先订阅、再补问一次当前有没有会话，
   * 顺序反了会漏掉中间那一条。
   */
  onCaptureSync: (fn: (id: number | null) => void) => Promise<() => void>

  /**
   * 滚动截图运行中按了截图热键 = **停止**（不是收场，结果留着给结果条）：Rust 已把遮罩
   * 恢复成交互态并拿回焦点，这条只负责叫 JS 停下循环、进结果相。只在滚动运行中发 ——
   * 订阅在遮罩开场就挂上，远早于任何一场滚动，普通 listen 就够。
   */
  onScrollStop: (fn: () => void) => () => void
}
