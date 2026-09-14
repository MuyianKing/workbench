/**
 * 快捷启动：启动程序、取程序图标。
 *
 * 图标提取走 Rust 的原生 Win32 抽取（按边长直取，程序只带小图时也不退回默认图），
 * 这里负责缓存与「取不到就如实失败」——界面拿失败去画首字母兜底。
 */
import { fail, ok } from '@shared/result'
import { iconCacheHit } from '@shared/icon-cache'
import type { Result } from '@shared/types'
import { invoke } from './bridge'
import { emit } from './events'
import * as state from './state'

function reason(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

// ---------- 启动 ----------

/**
 * 启动一个快捷启动项。
 * 用系统最自然的方式打开（ShellExecute）：.lnk 解析到自己的目标、
 * .exe 直接运行、.bat/.cmd 自己开控制台。进程不归我们管，应用退出也不影响它。
 */
export async function launch(id: string): Promise<Result<null>> {
  const entry = state.quickApps().find((item) => item.id === id)
  if (!entry) return fail('该快捷启动项已不存在')

  const target = entry.target.trim()
  if (!target) return fail('这个启动项还没有选择程序')

  // 先确认还在：ShellExecute 失败时给的是系统文案，不如这里说得清楚
  if (!(await invoke<boolean>('fs_exists', { path: target }))) {
    return fail(`程序不存在或已被移动：${target}`)
  }

  try {
    await invoke('open_path', { path: target })
  } catch (error) {
    return fail(reason(error, '启动失败'))
  }

  // 记下最近使用时间，并把整份列表推回界面（与 Electron 版一致）
  state.touchQuickApp(id, Date.now())
  emit('quickApps', await state.quickAppList())
  return ok(null)
}

// ---------- 图标 ----------

/**
 * 会话内的图标缓存，按「来源 + 修改时间」索引。
 * 落盘的那一份在 state 里（见 state.iconCache），这里只是省掉同一进程内的重复往返。
 */
const iconCache = new Map<string, string>()
const ICON_CACHE_LIMIT = 64

/** 写进会话缓存，顺带做容量控制：超了就丢最早放进来的那条 */
function remember(key: string, dataUrl: string): void {
  if (iconCache.size >= ICON_CACHE_LIMIT) {
    const oldest = iconCache.keys().next().value
    if (oldest !== undefined) iconCache.delete(oldest)
  }
  iconCache.set(key, dataUrl)
}

export async function icon(target: string): Promise<Result<string>> {
  const source = target.trim()
  if (!source) return fail('没有可用的程序路径')

  const mtime = await invoke<number | null>('fs_stat_mtime', { path: source })
  const key = `${source}::${mtime ?? 0}`

  const cached = iconCache.get(key)
  if (cached) return ok(cached)

  // 落盘的那一份先看：图标几乎不变，命中就不必再打开程序解析 PE 资源（实测每个 27~53ms）
  const stored = state.iconCache()[source]
  if (iconCacheHit(stored, mtime)) {
    remember(key, stored.dataUrl)
    return ok(stored.dataUrl)
  }

  // 失败原因由后端带出来：只回一句「取不到图标」对排查毫无帮助
  let dataUrl: string
  try {
    dataUrl = await invoke<string>('extract_icon', { source })
  } catch (error) {
    return fail(reason(error, '取不到这个程序的图标'))
  }

  remember(key, dataUrl)
  // 问不到修改时间就不落盘：没有判断依据的缓存下次只能被当成脏数据丢掉
  if (mtime !== null) state.setIconCacheEntry(source, { mtime, dataUrl })

  return ok(dataUrl)
}
