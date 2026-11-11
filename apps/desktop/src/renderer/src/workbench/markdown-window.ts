import type { MarkdownWindowContext, Result } from '@/types'
import { guard, invoke, listen } from './bridge'
/**
 * 独立 Markdown 编辑窗口的适配层（`markdown.html`）。
 *
 * 与 video-window.ts 同一条分工：窗口怎么开、哪个文件、什么时候关归 Rust
 * （`md_window.rs`）；正文与保存状态由窗口自己持有，经这里读写。
 *
 * **路径不经过这一层**：Rust 按窗口 label 查会话，`markdownWindowContext` /
 * `markdownWindowSave` 都不接受路径参数 —— 这扇窗只能碰它被打开的那一个文件。
 */

/** 窗口启动时取自己那份上下文（文件名 / 正文 / mtime） */
export async function markdownWindowContext(): Promise<Result<MarkdownWindowContext>> {
  return guard(invoke<MarkdownWindowContext>('markdown_window_context'), '读取 Markdown 文件失败')
}

/**
 * 保存正文，回来的是写完之后文件的 mtime。
 *
 * `expectedMtimeMs` 必须带：它是「这份正文基于磁盘上哪个版本改的」，
 * 文件被别处改过 / 删掉时 Rust 会拒绝这一笔（与笔记页同一条规则）。
 */
export async function markdownWindowSave(
  content: string,
  expectedMtimeMs?: number,
): Promise<Result<number>> {
  return guard(
    invoke<number>('markdown_window_save', { content, expectedMtimeMs }),
    '保存 Markdown 文件失败',
  )
}

/** 正文已经交出去：真正销毁窗口 */
export async function markdownWindowClose(): Promise<Result<null>> {
  return guard(invoke<null>('markdown_window_close'), '关闭编辑窗口失败')
}

/** 回执：撤掉 Rust 那次关闭的兜底计时（保存 / 确认要花多久都行），窗口不动 */
export async function markdownWindowCancelClose(): Promise<Result<null>> {
  return guard(invoke<null>('markdown_window_cancel_close'), '取消关闭编辑窗口失败')
}

/** 窗口被点了关闭：请先回 `markdownWindowCancelClose`，再冲刷正文 */
export function onMarkdownWindowFlushRequest(handler: () => void): () => void {
  return listen<null>('markdown-window:flush', () => handler())
}

/** 装配根按域 spread 用的一份（方法名与 WorkbenchApi 一一对应） */
export const markdownWindowApi = {
  markdownWindowContext,
  markdownWindowSave,
  markdownWindowClose,
  markdownWindowCancelClose,
  onMarkdownWindowFlushRequest,
}
