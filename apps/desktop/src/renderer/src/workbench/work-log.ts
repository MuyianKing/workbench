import type { GitCommitLog, GitWorkLogDraft, WorkLogEntry, WorkLogFile, WorkLogInput, WorkLogPatch } from '@workbench/work-log'
import type { Result } from '@/types'
import { fail, ok } from '@workbench/core'
/**
 * 工作日志（本地 `work-log.json`）的适配层实现。
 *
 * 与 Token 用量那套的区别在于**没有同步**：这份数据只在本机，读写路径就是
 * 「读一次文件 → 内存里增删改 → 整份写回」，没有分片、没有合并、没有跨设备语义
 * （见 packages/work-log/src/work-log.ts 的文件头）。
 *
 * 文件是懒加载的：首屏不读它，第一次进「工作」页时才把整份取回来，
 * 之后一直在内存里维护，每次改动整份落盘（防抖在 Rust 侧）。
 */
import { appendGitContent, createWorkLogEntry, emptyWorkLog, mergeGitCommits, parseGitCommitLog, parseWorkLog, patchWorkLogEntry, sanitizeCommitHashes } from '@workbench/work-log'
import { recordActivity } from './activity'
import { errorText, invoke } from './bridge'

let file: WorkLogFile = emptyWorkLog()
let loaded = false
/** 进行中的加载：并发调用共享同一次读盘，读失败时清掉，下次还能重试 */
let pending: Promise<void> | null = null

async function ensureLoaded(): Promise<void> {
  if (loaded)
    return

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
  if (loaded)
    void invoke('work_log_save', { value: file })
}

/**
 * 交给渲染层的值一律是快照，理由与 state.ts 里那段一样：
 * 适配层与渲染层之间原本是进程边界，直接把内部对象递出去，
 * 渲染层的就地修改会绕过这里的落盘逻辑。
 */
function copy<T>(value: T): T {
  return structuredClone(value)
}

/** 整份列表（新的在前由界面侧的 timelineOf 决定，这里不排序） */
export async function listWorkLogs(): Promise<Result<WorkLogEntry[]>> {
  try {
    await ensureLoaded()
    return ok(copy(file.entries))
  }
  catch (error) {
    return fail(errorText(error, '读取工作日志失败'))
  }
}

export async function addWorkLog(input: WorkLogInput): Promise<Result<WorkLogEntry>> {
  try {
    await ensureLoaded()
    // 工作内容必填：界面已经拦过一次，这里是兜底（与状态机同口径的校验留在 shared）
    const entry = createWorkLogEntry(input, () => crypto.randomUUID())
    if (!entry)
      return fail('工作内容不能为空')

    file.entries.push(entry)
    persist()
    // 记一笔活跃度：这个来源没有 store（组件直接调这里），所以记在这儿 —— 也正好只有写盘成功才走到这
    recordActivity('log')
    return ok(copy(entry))
  }
  catch (error) {
    return fail(errorText(error, '保存工作日志失败'))
  }
}

export async function updateWorkLog(
  id: string,
  patch: WorkLogPatch,
): Promise<Result<WorkLogEntry>> {
  try {
    await ensureLoaded()
    const index = file.entries.findIndex(entry => entry.id === id)
    if (index === -1)
      return fail('找不到这条工作记录')

    const next = patchWorkLogEntry(file.entries[index], patch)
    file.entries[index] = next
    // 内容没变时 patch 返回的是原对象，这里落盘一次也无妨：不产生任何语义变化
    persist()
    return ok(copy(next))
  }
  catch (error) {
    return fail(errorText(error, '更新工作日志失败'))
  }
}

export async function removeWorkLog(id: string): Promise<Result<null>> {
  try {
    await ensureLoaded()
    const next = file.entries.filter(entry => entry.id !== id)
    if (next.length !== file.entries.length) {
      file.entries = next
      persist()
    }
    return ok(null)
  }
  catch (error) {
    return fail(errorText(error, '删除工作日志失败'))
  }
}

/**
 * 读一个项目仓库的提交记录（宿主侧只读、本地）。
 *
 * `since` 是毫秒时间戳：宿主侧拿它做 git 的 `--since` 粗筛，精确到天的过滤在
 * `@workbench/work-log` 的 `buildGitDrafts` 里做 —— git 的日期边界按提交时间算，
 * 而分组按作者时间，两边不是同一套口径，不能拿它当边界。
 *
 * 不是 git 仓库时 `isRepo: false` 是正常结果，不是失败。
 */
export async function projectGitLog(dir: string, since?: number): Promise<Result<GitCommitLog>> {
  try {
    const raw = await invoke<unknown>('project_git_log', { dir, since })
    return ok(parseGitCommitLog(raw))
  }
  catch (error) {
    return fail(errorText(error, '读取项目提交记录失败'))
  }
}

/**
 * 把预览里确认过的草稿写进工作日志。
 *
 * `appendTo` 的草稿并进那条已有记录（正文追加、哈希并集），其余新建一条「已完成」。
 * 一次调用只落一次盘；返回这次被新建 / 改动的记录，页面据此并进内存列表。
 */
export async function importGitDrafts(
  drafts: readonly GitWorkLogDraft[],
): Promise<Result<WorkLogEntry[]>> {
  try {
    await ensureLoaded()
    const now = Date.now()
    const changed: WorkLogEntry[] = []
    let created = 0

    for (const draft of drafts) {
      const commits = sanitizeCommitHashes(draft.commits)
      const content = draft.content.trim()
      // 正文被用户清空、或一个合法哈希都不剩的草稿直接跳过（其余照常导入）
      if (!commits.length || !content || !draft.projectId.trim())
        continue

      const appendTo = draft.appendTo
      if (appendTo) {
        const index = file.entries.findIndex(entry => entry.id === appendTo)
        if (index !== -1) {
          const entry = file.entries[index]
          const next: WorkLogEntry = {
            ...entry,
            content: appendGitContent(entry.content, content),
            source: { kind: 'git', commits: mergeGitCommits(entry.source?.commits, commits) },
            updatedAt: now,
          }
          file.entries[index] = next
          changed.push(copy(next))
          continue
        }
        // 目标记录在预览之后被删掉了：退回「新建一条」，这次导入不丢
      }

      const entry = createWorkLogEntry({
        date: draft.date,
        projectId: draft.projectId,
        content,
        status: 'done',
        source: { kind: 'git', commits },
      }, () => crypto.randomUUID(), now)
      if (!entry)
        continue

      file.entries.push(entry)
      changed.push(copy(entry))
      created += 1
    }

    if (!changed.length)
      return fail('没有可导入的提交')

    persist()
    // 与 addWorkLog 同一条口径：新建一条算一笔；追加不是一条新记录，不记
    for (let index = 0; index < created; index += 1)
      recordActivity('log')

    return ok(changed)
  }
  catch (error) {
    return fail(errorText(error, '导入提交记录失败'))
  }
}
