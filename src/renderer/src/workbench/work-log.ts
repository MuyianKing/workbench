/**
 * 工作日志（本地 `work-log.json`）的适配层实现。
 *
 * 与 Token 用量那套的区别在于**没有同步**：这份数据只在本机，读写路径就是
 * 「读一次文件 → 内存里增删改 → 整份写回」，没有分片、没有合并、没有跨设备语义
 * （见 shared/work-log.ts 的文件头）。
 *
 * 文件是懒加载的：首屏不读它，第一次进「工作」页时才把整份取回来，
 * 之后一直在内存里维护，每次改动整份落盘（防抖在 Rust 侧）。
 */
import {
  createWorkLogEntry,
  emptyWorkLog,
  parseWorkLog,
  patchWorkLogEntry,
  type WorkLogEntry,
  type WorkLogFile,
  type WorkLogInput,
  type WorkLogPatch
} from '@shared/work-log'
import { fail, ok } from '@shared/result'
import type { Result } from '@shared/types'
import { invoke } from './bridge'

let file: WorkLogFile = emptyWorkLog()
let loaded = false
/** 进行中的加载：并发调用共享同一次读盘，读失败时清掉，下次还能重试 */
let pending: Promise<void> | null = null

async function ensureLoaded(): Promise<void> {
  if (loaded) return

  if (!pending) {
    pending = invoke<unknown>('work_log_load')
      .then((raw) => {
        file = parseWorkLog(raw, () => crypto.randomUUID())
        loaded = true
      })
      .finally(() => {
        pending = null
      })
  }
  await pending
}

/** 变更即写（落盘防抖在 Rust 侧，300ms 合并一次） */
function persist(): void {
  if (loaded) void invoke('work_log_save', { value: file })
}

/**
 * 交给渲染层的值一律是快照，理由与 state.ts 里那段一样：
 * 适配层与渲染层之间原本是进程边界，直接把内部对象递出去，
 * 渲染层的就地修改会绕过这里的落盘逻辑。
 */
function copy<T>(value: T): T {
  return structuredClone(value)
}

function reasonOf(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** 整份列表（新的在前由界面侧的 timelineOf 决定，这里不排序） */
export async function listWorkLogs(): Promise<Result<WorkLogEntry[]>> {
  try {
    await ensureLoaded()
    return ok(copy(file.entries))
  } catch (error) {
    return fail(reasonOf(error, '读取工作日志失败'))
  }
}

export async function addWorkLog(input: WorkLogInput): Promise<Result<WorkLogEntry>> {
  try {
    await ensureLoaded()
    // 工作内容必填：界面已经拦过一次，这里是兜底（与状态机同口径的校验留在 shared）
    const entry = createWorkLogEntry(input, () => crypto.randomUUID())
    if (!entry) return fail('工作内容不能为空')

    file.entries.push(entry)
    persist()
    return ok(copy(entry))
  } catch (error) {
    return fail(reasonOf(error, '保存工作日志失败'))
  }
}

export async function updateWorkLog(
  id: string,
  patch: WorkLogPatch
): Promise<Result<WorkLogEntry>> {
  try {
    await ensureLoaded()
    const index = file.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return fail('找不到这条工作记录')

    const next = patchWorkLogEntry(file.entries[index], patch)
    file.entries[index] = next
    // 内容没变时 patch 返回的是原对象，这里落盘一次也无妨：不产生任何语义变化
    persist()
    return ok(copy(next))
  } catch (error) {
    return fail(reasonOf(error, '更新工作日志失败'))
  }
}

export async function removeWorkLog(id: string): Promise<Result<null>> {
  try {
    await ensureLoaded()
    const next = file.entries.filter((entry) => entry.id !== id)
    if (next.length !== file.entries.length) {
      file.entries = next
      persist()
    }
    return ok(null)
  } catch (error) {
    return fail(reasonOf(error, '删除工作日志失败'))
  }
}
