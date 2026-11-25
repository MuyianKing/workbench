/**
 * `window.workbench` 上的一组通道：窗口外壳、对话框与打开方式。
 * 实现见 `workbench/api-system.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  QuitChoice,
  QuitConfirmPayload,
  WindowState,
} from '../index'

export interface SystemChannel {
  /**
   * 渲染层未捕获异常 → Rust 的 error.log。入口上的 `onerror` / `unhandledrejection` /
   * Vue 的 `errorHandler` 经它转发；实现侧经 guard 收敛、永不 reject ——
   * 报异常的通道自己出异常就是死循环。
   */
  logError: (message: string, stack?: string) => Promise<Result<null>>

  versions: { node: string, chrome: string }

  /**
   * 挑一个目录。
   * title 用于给不同用途换标题（选项目目录 / 选输出目录），不传就是「选择项目目录」。
   * `defaultPath` 是对话框打开时所在的目录：不给就由系统决定，常常落在上次用过的别处 ——
   * 「换一个正在用的目录」这类调用方该传它（技能页就是这么用的）。
   */
  pickDirectory: (title?: string, defaultPath?: string) => Promise<string | null>

  /**
   * 挑一个文件。
   *
   * `filters` 是对话框里的后缀过滤（`[{ name: '技能包', extensions: ['zip'] }]`），
   * 不传就是「所有文件」。用户取消时回 null —— 那不是失败，调用方不该报错。
   */
  pickFile: (
    title?: string,
    filters?: Array<{ name: string, extensions: string[] }>,
  ) => Promise<string | null>

  /** 挑多个文件（邮箱发信的附件用）；取消回 null —— 那不是失败，调用方不该报错 */
  pickFiles: (
    title?: string,
    filters?: Array<{ name: string, extensions: string[] }>,
  ) => Promise<string[] | null>

  /** 「另存为」挑一个保存路径（邮箱附件下载用）；取消回 null，不是失败 */
  pickSavePath: (options: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string, extensions: string[] }>
  }) => Promise<string | null>

  reveal: (targetPath: string) => Promise<Result<null>>

  /**
   * 在 VS Code 里打开目录。
   *
   * 走 VS Code 自己注册的 `vscode://` 协议（Rust 侧直接 ShellExecute），不去猜 `Code.exe`
   * 装在哪 —— 装到哪个盘、PATH 里有没有 `code` 都由安装时定，只有协议处理器才是
   * 「这台机器现在用哪个 VS Code」的可靠答案；路径按 URL 规则转义（空格、中文、`#`），
   * 结尾那个 `/` 表示这是个目录。没装（协议没有关联程序）时按 ShellExecute 的错误码
   * 给出提示，而不是点了没反应。
   */
  openInVSCode: (path: string) => Promise<Result<null>>

  /** 用系统默认浏览器打开 http(s) 链接 */
  openExternal: (url: string) => Promise<Result<null>>

  /**
   * 用系统默认程序打开一个本地文件（知识库页查看预览不了的原始资料时给出去）。
   * 与快捷启动同走一条 `open_path` 通道：按 Windows 的文件关联打开，应用不猜程序路径。
   */
  openPath: (path: string) => Promise<Result<null>>

  /** 按路径读一个文本文件（AI 预览栏、日志解析这类「按需读一份」的解析当数据源） */
  readTextFile: (path: string) => Promise<Result<string>>

  /**
   * 把一段文本写到用户亲手挑的路径（笔记导出用）。路径来自「另存为」，写失败回 Err。
   */
  writeTextFile: (path: string, content: string) => Promise<Result<null>>

  /**
   * 把自包含 HTML 静默导出成 PDF（笔记导出用）。path 来自「另存为」对话框，
   * html 是 buildExportHtml 的产物；Rust 侧用隐藏 WebView2 窗口调 PrintToPdf 直接落盘，
   * 不弹系统打印预览。失败回 Err。
   */
  exportPdf: (path: string, html: string) => Promise<Result<null>>

  /** 按路径读一个二进制文件、以 base64 回传（AI 预览栏的 DOCX / PPTX 是 zip 容器，文本通道读不了） */
  readBinaryFile: (path: string) => Promise<Result<string>>

  /**
   * 把一张图片按**单个文件**授权给 asset 协议，回传 webview 能直接加载的 URL
   * （AI 预览栏显示回答里提到的图片用，与工作区背景图同一条边界）。
   */
  allowPreviewImage: (path: string) => Promise<Result<{ url: string }>>

  /** 标题栏自绘窗口按钮：最小化 / 最大化（已最大化时为还原）/ 关闭（仍走托盘那套逻辑） */
  minimizeWindow: () => void

  toggleMaximizeWindow: () => void

  closeWindow: () => void

  /** 窗口当前是否最大化：首帧靠它决定第三个按钮画「最大化」还是「还原」 */
  getWindowState: () => Promise<WindowState>

  /** 最大化 / 还原状态变化（拖窗口边缘、系统快捷键也会走到这里） */
  onWindowState: (fn: (state: WindowState) => void) => () => void

  /** 主进程请求弹出退出确认框（托盘退出且还有项目在运行时） */
  onQuitConfirm: (fn: (payload: QuitConfirmPayload) => void) => () => void

  /** 回传退出确认框里选中的结果 */
  respondQuitConfirm: (choice: QuitChoice) => void

  /**
   * 把设置里的程序名交给系统画的那两处：窗口标题（任务栏悬停提示）与托盘提示。
   *
   * 自绘的那条标题栏由渲染层自己画，不经过这里；而这两处归系统，只能在 Rust 侧设。
   * 传进去的值必须已经过 `sanitizeAppName` 收敛 —— 空名字会让两边都空掉。
   */
  setAppName: (name: string) => void

  /** 应用自身的版本号（「关于」那一屏显示）；取不到时由适配层给一个占位 */
  getAppVersion: () => Promise<string>

  /**
   * 按当前设置重新装一遍全部全局快捷键（唤起窗口 / 截图）。
   * 三条一起装是插件的硬要求（见 main.rs 的 register_hotkeys），所以只能在改动之后整批重来。
   */
  applyHotkeys: () => Promise<Result<null>>
}
