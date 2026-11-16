/**
 * `window.workbench` 上的一组通道：独立 Markdown 编辑窗口（markdown.html）。
 * 实现见 `workbench/markdown-window.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  MarkdownWindowContext,
} from '../index'

export interface MarkdownWindowChannel {
  // ---------- 独立 Markdown 编辑窗口（markdown.html，资源管理器「打开方式」） ----------
  /**
   * 独立编辑窗口启动时取自己那份上下文（文件名 / 正文 / mtime）。
   *
   * 路径不经过渲染层：Rust 按窗口 label 查会话，这扇窗只能读它被打开的那一个文件。
   */
  markdownWindowContext: () => Promise<Result<MarkdownWindowContext>>

  /**
   * 保存正文。`expectedMtimeMs` 是读盘 / 上次落盘拿到的基准：
   * 文件在别处被改过或删掉时 Rust 拒绝写入并把原因交回来（与笔记页同一套规则）。
   */
  markdownWindowSave: (content: string, expectedMtimeMs?: number) => Promise<Result<number>>

  /** 关闭握手：渲染层交完正文后调它真正销毁窗口 */
  markdownWindowClose: () => Promise<Result<null>>

  /** 回执：撤掉 Rust 那次关闭的兜底计时（保存 / 确认要花多久都行）；窗口不动 */
  markdownWindowCancelClose: () => Promise<Result<null>>

  /** 窗口被点了关闭：先回 `markdownWindowCancelClose`，再冲刷正文，完成后调 `markdownWindowClose` */
  onMarkdownWindowFlushRequest: (fn: () => void) => () => void

  /** 这扇窗当前是不是最大化（窗口控制按钮画「最大化」还是「还原」） */
  markdownWindowIsMaximized: () => Promise<boolean>

  /** 最小化这扇编辑窗口（无边框改版后窗口键自绘） */
  markdownWindowMinimize: () => void

  /** 最大化 / 向下还原这扇编辑窗口 */
  markdownWindowToggleMaximize: () => void

  /** 最大化状态从窗口事件推：拖边缘、双击拖动带、系统快捷键都算 */
  onMarkdownWindowState: (fn: (state: { maximized: boolean }) => void) => () => void
}
