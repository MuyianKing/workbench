import type { GitCommitLog, GitWorkLogDraft, WorkLogEntry, WorkLogFile, WorkLogInput, WorkLogPatch, WorkLogShard, WorkLogSyncOutcome } from '@workbench/work-log'
import type { Result } from '@/types'
import { fail, ok } from '@workbench/core'
/**
 * 工作日志（本地 `work-log.json`）的适配层实现。
 *
 * 本机读写是「读一次文件 → 内存里增删改 → 整份写回」；配了同步仓库时再按设备分片
 * 推 / 拉（`work-log/<设备id>.json`，合并规则在 @workbench/work-log 的 `work-log-sync.ts`）。
 * 同步走 Token 同步那个仓库，没登录 / 没配地址时安静跳过 —— 本机数据照常完整。
 *
 * 文件是懒加载的：首屏不读它，第一次进「工作」页时才把整份取回来，
 * 之后一直在内存里维护，每次改动整份落盘（防抖在 Rust 侧）。
 */
import { appendGitContent, createWorkLogEntry, emptyWorkLog, mergeGitCommits, mergeWorkLogShards, parseGitCommitLog, parseWorkLog, patchWorkLogEntry, sameWorkLogFile, sanitizeCommitHashes, sanitizeWorkLogShard, workLogShardOf } from '@workbench/work-log'
import { recordActivity } from './activity'
import { errorText, invoke } from './bridge'
import { localDevice } from './token'

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

/**
 * 本机设备标识（工作页按设备分开显示要用）。
 *
 * 与同步分片同一个来源（数据目录的 `device.json`）；拿不到时 id / name 都是空串 ——
 * 页面据此不按设备筛，宁可多显示，也不要把整份日志藏起来。
 */
export function workLogLocalDevice(): Promise<{ id: string, name: string }> {
  return localDevice()
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
    const device = await localDevice()
    const entry = createWorkLogEntry({ ...input, by: device.id }, () => crypto.randomUUID())
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
    const index = file.entries.findIndex(entry => entry.id === id)
    if (index !== -1) {
      const [removed] = file.entries.splice(index, 1)
      // 删除留墓碑：别的设备靠它知道这条被删了，而不是下一轮又把它读回来
      const device = await localDevice()
      const deletedAt = Math.max(Date.now(), removed.updatedAt + 1)
      file.tombstones = [
        ...file.tombstones.filter(item => item.id !== id),
        { id, updatedAt: deletedAt, by: device.id },
      ]
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
 * `since` / `until` 是毫秒时间戳：宿主侧拿它们做 git 的 `--since` / `--until` 粗筛，
 * 精确到天的过滤在 `@workbench/work-log` 的 `buildGitDrafts` 里做 —— git 的日期边界按提交时间算，
 * 而分组按作者时间，两边不是同一套口径，不能拿它当边界。
 *
 * 不是 git 仓库时 `isRepo: false` 是正常结果，不是失败。
 */
export async function projectGitLog(
  dir: string,
  since?: number,
  until?: number,
): Promise<Result<GitCommitLog>> {
  try {
    const raw = await invoke<unknown>('project_git_log', { dir, since, until })
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
 * `deviceId` 指定新建条目属于哪台设备（「从提交生成」弹窗里可以选），留空落本机；
 * 追加的那条本来就属于某台设备，不改它的 `by`。
 */
export async function importGitDrafts(
  drafts: readonly GitWorkLogDraft[],
  deviceId?: string,
): Promise<Result<WorkLogEntry[]>> {
  try {
    await ensureLoaded()
    const now = Date.now()
    const local = await localDevice()
    const by = deviceId?.trim() || local.id
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
          const projectName = entry.projectName ?? draft.projectName
          const next: WorkLogEntry = {
            ...entry,
            content: appendGitContent(entry.content, content),
            source: { kind: 'git', commits: mergeGitCommits(entry.source?.commits, commits) },
            updatedAt: now,
            ...(projectName ? { projectName } : {}),
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
        projectName: draft.projectName,
        content,
        status: 'done',
        source: { kind: 'git', commits },
        by,
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

/**
 * 同步一轮：拉别的设备的分片 → 合并进本机 → 推本机分片。
 *
 * 与活跃度不同：合并结果**写回本机**（条目可编辑 / 可删除，只在内存里看一眼的话，
 * 这边改了删了没有落点，下一轮又从别处读回来）。分片是本机合并后的快照，单写者。
 */
export async function syncWorkLog(
  repo: string,
  device: { id: string, name: string },
): Promise<Result<WorkLogSyncOutcome>> {
  try {
    await ensureLoaded()
    if (!repo.trim())
      return ok({ enabled: false, changed: false, device: device.id, entries: copy(file.entries), devices: [{ id: device.id, name: device.name }] })

    // 先拉最新：命令里先刷新克隆再读（本机那份由 Rust 跳过，避免把自己再合一遍）
    const raw = await invoke<unknown>('work_log_sync_pull', { repo, device: device.id })
    const shards: WorkLogShard[] = []
    for (const item of Array.isArray(raw) ? raw : []) {
      const shard = sanitizeWorkLogShard(item)
      if (shard)
        shards.push(shard)
    }

    const merged = mergeWorkLogShards(file, shards)
    const changed = !sameWorkLogFile(file, merged)
    if (changed) {
      file = merged
      persist()
    }

    // 设备清单：本机在第一位，其余是分片里的（分片名就是设备名，页面拿它显示切换器）
    const devices = [
      { id: device.id, name: device.name },
      ...shards.map(shard => ({ id: shard.device, name: shard.name })),
    ]

    // 有内容才建分片：一台从没记过工作日志的机器不必在仓库里留下一个空文件
    if (file.entries.length || file.tombstones.length) {
      await invoke('work_log_sync_publish', {
        repo,
        device: device.id,
        shard: workLogShardOf(device.id, device.name, file),
      })
    }

    return ok({ enabled: true, changed, device: device.id, entries: copy(file.entries), devices })
  }
  catch (error) {
    return fail(errorText(error, '同步工作日志失败'))
  }
}
