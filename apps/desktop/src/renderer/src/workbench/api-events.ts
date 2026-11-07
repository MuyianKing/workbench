import type { BallContext, CaptureContext, NetCounters, OcrLine, PinPatch, PinRecord, WindowState, WorkbenchApi } from '@/types'
import { ok } from '@workbench/core'
import { hotkeyArgs } from './api-system'
import { guard, invoke, listen, listenReady } from './bridge'
import * as events from './events'
import * as state from './state'

/**
 * 事件订阅与「跨窗口共用」的那两组通道：截图 / 钉图、网速球。
 *
 * 这两组通道三个窗口共用：主窗口（托盘提示、设置里的快捷键）、遮罩窗口（capture.html）、
 * 钉图窗口（pin.html）。后两个入口只装这一层适配层，**不装 store、不 initState** ——
 * 装了就会与主窗口抢着写同一批 JSON。
 */

function noop(): void {}

export const eventsApi = {
  // ---------- 事件订阅 ----------
  // 窗口状态来自 Tauri 事件；其余来自适配层内部的广播（见 events.ts），
  // 契约与 preload 版完全一致，组件不需要知道底下换了实现。
  onWindowState: (handler: (value: WindowState) => void) =>
    listen<WindowState>('window:state-changed', handler),
  onLog: (handler: Parameters<WorkbenchApi['onLog']>[0]) => events.subscribe('log', handler),
  onStatus: (handler: Parameters<WorkbenchApi['onStatus']>[0]) =>
    events.subscribe('status', handler),
  onTerminalOpen: (handler: Parameters<WorkbenchApi['onTerminalOpen']>[0]) =>
    events.subscribe('terminalOpen', handler),
  onClear: (handler: (event: { terminal: string }) => void) =>
    events.subscribe('clear', handler),
  onPmInstallLog: (handler: Parameters<WorkbenchApi['onPmInstallLog']>[0]) =>
    events.subscribe('pmInstallLog', handler),
  onProjectChanged: (handler: Parameters<WorkbenchApi['onProjectChanged']>[0]) =>
    events.subscribe('projectChanged', handler),
  /** 活跃度记了一笔（任何一种来源，见 workbench/activity.ts）：首页那张图据此重拉 */
  onActivityChanged: (handler: () => void) => events.subscribe('activityChanged', handler),
  onSettingsChanged: (handler: Parameters<WorkbenchApi['onSettingsChanged']>[0]) =>
    events.subscribe('settingsChanged', handler),
  onTheme: (handler: Parameters<WorkbenchApi['onTheme']>[0]) =>
    events.subscribe('theme', handler),

  onQuickApps: (handler: Parameters<WorkbenchApi['onQuickApps']>[0]) =>
    events.subscribe('quickApps', handler),

  /** 后台自动同步跑完一轮（见 token.ts 的 getTokenUsage）：Token 面板据此立刻重取 */
  onTokenSynced: (handler: () => void) => events.subscribe('tokenSynced', handler),

  onQuitConfirm: (handler: Parameters<WorkbenchApi['onQuitConfirm']>[0]) =>
    events.subscribe('quitConfirm', handler),

  /** 邮件系统通知被点了（Rust 已唤出主窗口）：换页并打开那封信由 store 接手 */
  onMailNotifyClick: (handler: Parameters<WorkbenchApi['onMailNotifyClick']>[0]) =>
    events.subscribe('mailNotifyClick', handler),

  /** 把用户的选择回传后端：后端在另一个线程里等着它决定「停进程还是留着」 */
  respondQuitConfirm: (choice: Parameters<WorkbenchApi['respondQuitConfirm']>[0]) => {
    void invoke('resolve_quit_choice', { choice })
  },

  // ---------- 截图与钉图（见 docs/modules/screenshot.md） ----------
  //
  // 只给验证配方用（界面上没有入口，见 docs/modules/screenshot.md 的「验证」一节）
  beginCapture: () => guard(invoke<number>('capture_begin'), '开始截图失败'),
  // 把「按下热键到看见遮罩」压到两百毫秒级的就这一条：Rust 据此把遮罩窗口先建好，
  // 之后每场截图只是「塞帧 → 摆位置 → 显示」（见 docs/modules/screenshot.md）
  capturePrewarm: (enabled: boolean) =>
    guard(invoke<null>('capture_prewarm', { enabled }), '预建截图遮罩失败'),
  abortCapture: () => {
    void invoke('capture_abort')
    return Promise.resolve()
  },
  captureContext: () => guard(invoke<CaptureContext>('capture_context'), '取截图上下文失败'),
  // 原始 PNG 字节：命令返回 `ipc::Response`，Tauri 的二进制回包在 JS 这边是 ArrayBuffer
  captureFrame: () => guard(invoke<ArrayBuffer>('capture_frame'), '取不到这一帧截图'),
  // 遮罩里的 JS 报「这一场的帧已经画到画布上了」：Rust 等到每一块屏都报齐才显示遮罩 ——
  // 抢在帧前面显示就是先闪一块黑（见 docs/modules/screenshot.md 与 capture.rs 的 capture_show）
  showCapture: (id: number) => guard(invoke<null>('capture_show', { id }), '显示截图遮罩失败'),
  copyImage: (png: string) => guard(invoke<null>('capture_copy', { png }), '复制到剪贴板失败'),
  // 没画标注时走这条：只给选区，由 Rust 从这一场缓存的原始帧里裁（省掉整圈 base64 往返）
  copyFrame: (rect: { x: number, y: number, width: number, height: number }) =>
    guard(invoke<null>('capture_copy_frame', rect), '复制到剪贴板失败'),
  // 取字：Windows 自带的 OCR，Rust 从缓帧里裁选区识别，遮罩不收（还要回去拖选）
  ocrRegion: (rect: { x: number, y: number, width: number, height: number }) =>
    guard(invoke<OcrLine[]>('capture_ocr', rect), '取字失败'),
  saveImage: (png: string, dir: string, name: string, unique: boolean) =>
    guard(invoke<string>('capture_save', { png, dir, name, unique }), '保存截图失败'),
  pinImage: (png: string, x: number, y: number, width: number, height: number, opacity: number) =>
    guard(invoke<PinRecord>('pin_create', { png, x, y, width, height, opacity }), '钉图失败'),
  pinContext: () => guard(invoke<PinRecord>('pin_context'), '取钉图信息失败'),
  pinState: (patch: PinPatch) => guard(invoke<PinRecord>('pin_update', { patch }), '改钉图状态失败'),
  pinClose: () => {
    void invoke('pin_close')
    return Promise.resolve()
  },
  pinCloseAll: () => {
    void invoke('pin_close_all')
    return Promise.resolve()
  },
  pinCopy: () => guard(invoke<null>('pin_copy'), '复制到剪贴板失败'),
  pinSave: (dir: string, name: string, unique: boolean) =>
    guard(invoke<string>('pin_save', { dir, name, unique }), '保存钉图失败'),

  // ---------- 网速球（见 docs/modules/float-ball.md） ----------
  //
  // 角色与 capturePrewarm 一样：**值由渲染层推**，Rust 不去数据文件里读设置
  // （盘上那份在「刚加的字段还没写回盘」那一段是空的）。球窗口与主窗口共用这一层，
  // 它自己只装适配层、不装 store。
  ballApply: (visible: boolean) =>
    guard(invoke<null>('ball_apply', { visible }), '开悬浮球失败'),
  ballContext: () => guard(invoke<BallContext>('ball_context'), '取悬浮球状态失败'),
  ballOpen: (open: boolean) =>
    guard(invoke<BallContext>('ball_open', { open }), '收起 / 展开悬浮球失败'),
  ballDrag: () => guard(invoke<BallContext>('ball_drag'), '拖动悬浮球失败'),
  ballOpenMain: () => {
    void invoke('ball_open_main')
    return Promise.resolve(ok(null))
  },
  netCounters: () => guard(invoke<NetCounters>('net_counters'), '取网速失败'),

  applyHotkeys: () => guard(invoke<null>('apply_hotkeys', hotkeyArgs(state.settings())), '注册全局快捷键失败'),
  // 截图是在工作线程里抓的，失败没法就地报给谁：Rust 推一条事件过来，
  // 主窗口弹提示（那时界面多半藏在托盘里 / 根本没显示）
  onCaptureFailed: (fn: (message: string) => void) => listen<string>('capture:failed', fn),
  // 跟当前这场会话对一次：开场与收工各推一条（开场带这一场的编号，收工带 null）。
  // 遮罩窗口是**跨场复用**的（预建、藏起来），显示 / 隐藏它不会让里面的 JS 重新开场，
  // 两边都靠这一条（见 docs/modules/screenshot.md）。用 listenReady：遮罩要先挂上订阅、
  // 再补问一次当前有没有会话，顺序反了会漏掉中间那一条
  onCaptureSync: (fn: (id: number | null) => void) => listenReady<number | null>('capture:sync', fn),

  // 尚未有人推的一个：首页布局（本地改动的推送方还没补）
  onThemeConfig: () => noop,
} as Partial<WorkbenchApi>
