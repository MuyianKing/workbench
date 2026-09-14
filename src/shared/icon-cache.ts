/**
 * 程序图标的落盘缓存（纯逻辑：形状收敛与失效判断，不碰文件系统）。
 *
 * 抽一张图标要打开程序文件、解析 PE 资源、编码 PNG 再 base64（实测 .lnk 每个 27~53ms），
 * 而图标几乎不变 —— 每次启动重抽一遍纯属白干。所以把图标连同判断依据一起存下来：
 * 程序文件的修改时间没变就直接用，变了（程序升级换了图标）就重新抽。
 *
 * key 用程序路径而不是快捷启动项的 id：同一个程序被加两次只该存一份，
 * 与适配层那个会话缓存的 key 保持一致。
 */
import type { IconCacheEntry } from './types'

/** 只认内联图片：不是 data:image/ 的一律当脏数据丢掉 */
function isIconDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/')
}

/**
 * 把磁盘上读到的缓存收敛成合法形状。
 *
 * validTargets 是当前快捷启动列表里的程序路径：只留还在用的条目 ——
 * 用户删掉一个程序之后，它的图标不该一直占着数据文件。
 */
export function sanitizeIconCache(
  raw: unknown,
  validTargets: ReadonlySet<string>
): Record<string, IconCacheEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const out: Record<string, IconCacheEntry> = {}
  for (const [target, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!validTargets.has(target)) continue
    if (!entry || typeof entry !== 'object') continue

    const value = entry as Partial<IconCacheEntry>
    if (typeof value.mtime !== 'number' || !Number.isFinite(value.mtime)) continue
    if (!isIconDataUrl(value.dataUrl)) continue

    out[target] = { mtime: value.mtime, dataUrl: value.dataUrl }
  }
  return out
}

/**
 * 缓存还能不能用。
 *
 * 问不到修改时间（文件不存在 / 没权限）时不认缓存：交给抽取那条路去如实报错，
 * 拿一个说不清新旧的值顶上去只会让界面显示一个早就过期的图标。
 */
export function iconCacheHit(
  entry: IconCacheEntry | undefined,
  mtime: number | null
): entry is IconCacheEntry {
  if (!entry || mtime === null) return false
  return entry.mtime === mtime
}
