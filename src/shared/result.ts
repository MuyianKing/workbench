import type { Result } from './types'

/**
 * IPC 返回值的构造工具。
 *
 * 主进程的 handler 一律「成功 resolve 成 Result」而不是 reject，渲染层才好统一判 `ok`。
 * 这套 `{ ok, data } / { ok, error }` 字面量原先在 ipc / quick-launch / background /
 * wallpapers 里各写一份，改动 Result 形状时要满仓库找，统一收在这里。
 */
export function ok<T>(value: T): Result<T> {
  return { ok: true, data: value }
}

export function fail<T = never>(error: string): Result<T> {
  return { ok: false, error }
}

/**
 * 把「可能抛错的操作」收敛成 Result。
 * 主进程 handler 里 reject 会让渲染层的 invoke 变成未处理异常，凡是有抛错风险的操作
 * （打开资源管理器、结束端口进程、启动快捷程序）都该包一层。
 */
export async function toResult<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    return fail((err as Error).message)
  }
}
