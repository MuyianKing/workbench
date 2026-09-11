import { promises as fs, statSync } from 'node:fs'

/**
 * 文件系统探测的一组小工具。
 *
 * 原先 ipc / scanner / nvm / quick-launch 各自写了一遍「try stat，失败就当不存在」，
 * 且同步异步混用、返回形状不一。统一到这里，调用方按同步或异步选一个。
 */

export async function statOrNull(
  target: string
): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(target)
  } catch {
    return null
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  const stat = await statOrNull(target)
  return stat?.isDirectory() ?? false
}

export function isDirectorySync(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}
