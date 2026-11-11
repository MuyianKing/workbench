/**
 * 从项目仓库的提交记录生成工作记录：宿主只回原始提交，分组、按天归并、去重都在这里。
 *
 * 口径（与工作日志本身一致）：
 *  - **一个项目一天一条**：一天里的多个提交合成一条 markdown 列表，时间轴的最小刻度仍然是天；
 *  - **只收自己的提交**：仓库配了 `user.email` 时按它过滤（读不到身份就不过滤，宁可多收）；
 *  - **按作者时间落在本地时区的哪一天**分组，而不是 git 的提交时间（rebase / cherry-pick 之后
 *    两者会差很远，而用户记的是「我那天写了什么」）；
 *  - **已导入过的提交不再写**：来源哈希记在 `WorkLogEntry.source.commits` 里，哪怕中间换了范围
 *    再点一次「从提交生成」，同一笔提交也只出现一次。
 *
 * 这里只产出草稿（预览里可以改、可以取消勾选），真正落盘在适配层的 `importGitDrafts`。
 */

import type { WorkLogEntry, WorkRange } from './work-log'
import { dayKey } from '@workbench/core'
import { rangeBounds } from './work-log'

/** 宿主侧读回来的一条提交；`time` 已是毫秒（作者时间） */
export interface GitCommit {
  hash: string
  time: number
  authorEmail: string
  subject: string
}

/** 一个项目目录的读取结果：`isRepo: false` 表示它不在 git 仓库里，不是失败 */
export interface GitCommitLog {
  isRepo: boolean
  /** 仓库配置的 user.email；空串表示读不到，这时不按作者过滤 */
  userEmail: string
  commits: GitCommit[]
}

/** 页面从项目列表里挑出来交给这里的最小形状 */
export interface GitWorkLogProject {
  id: string
  name: string
  path: string
}

/** 一个项目 + 它的提交读取结果 */
export interface GitWorkLogInput {
  project: GitWorkLogProject
  log: GitCommitLog
}

/**
 * 预览里的一条草稿：一个项目的某一天。
 *
 * `appendTo` 有值表示同项目同一天已经有一条生成记录，这次的新提交接在它后面；
 * 没有就是新建一条。
 */
export interface GitWorkLogDraft {
  projectId: string
  projectName: string
  date: string
  /** 这次要写入的 markdown（只含新增的提交，一行一条） */
  content: string
  /** 这次并入的提交哈希 */
  commits: string[]
  appendTo?: string
}

/**
 * 宿主侧返回值 → 可用的提交清单。
 *
 * Rust 侧已经按格式收过一遍，这里再收一次是通道契约的常规做法：手改过的数据文件、
 * 将来字段改名都不该把界面弄崩。缺哈希 / 时间不合法 / 标题为空的条目直接丢掉。
 */
export function parseGitCommitLog(raw: unknown): GitCommitLog {
  const input = (raw ?? {}) as Partial<GitCommitLog>
  const commits: GitCommit[] = []

  if (Array.isArray(input.commits)) {
    for (const item of input.commits) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        continue

      const source = item as Partial<GitCommit>
      const hash = typeof source.hash === 'string' ? source.hash.trim().toLowerCase() : ''
      const time = typeof source.time === 'number' && Number.isFinite(source.time) && source.time > 0
        ? Math.floor(source.time)
        : 0
      const subject = typeof source.subject === 'string' ? source.subject.trim() : ''
      if (!hash || !time || !subject)
        continue

      commits.push({
        hash,
        time,
        authorEmail: typeof source.authorEmail === 'string' ? source.authorEmail.trim() : '',
        subject,
      })
    }
  }

  return {
    isRepo: input.isRepo === true,
    userEmail: typeof input.userEmail === 'string' ? input.userEmail.trim() : '',
    commits,
  }
}

/**
 * 按提交铺出草稿。
 *
 * 范围用的是工作页顶部那几档（`todo` 不是时段，调用方不该把这一档传进来）。
 * 分组键是「项目 + 本地日期」；组内按提交时间从早到晚排，读起来是一条流水。
 */
export function buildGitDrafts(
  inputs: readonly GitWorkLogInput[],
  range: Exclude<WorkRange, 'todo'>,
  now: number,
  entries: readonly WorkLogEntry[],
): GitWorkLogDraft[] {
  const { from, to } = rangeBounds(range, now)

  // 已经导入过的哈希（按项目分：同一个仓库被两个项目指向时，各自该有自己的记录）
  const imported = new Map<string, Set<string>>()
  // 同项目同日已有生成记录时，新提交接到它后面（有多条时认最近改过的那条）
  const targets = new Map<string, WorkLogEntry>()

  for (const entry of entries) {
    const source = entry.source
    if (!source || source.kind !== 'git' || !entry.projectId)
      continue

    const seen = imported.get(entry.projectId) ?? new Set<string>()
    for (const hash of source.commits)
      seen.add(hash)
    imported.set(entry.projectId, seen)

    const key = groupKey(entry.projectId, entry.date)
    const current = targets.get(key)
    if (!current || entry.updatedAt > current.updatedAt)
      targets.set(key, entry)
  }

  const groups = new Map<string, { project: GitWorkLogProject, date: string, commits: GitCommit[], hashes: Set<string> }>()

  for (const { project, log } of inputs) {
    if (!log.isRepo)
      continue

    const selfEmail = log.userEmail.trim().toLowerCase()
    const known = imported.get(project.id)

    for (const commit of log.commits) {
      // 仓库配了身份就只收自己的；读不到身份时不过滤 —— 别把用户自己的提交也挡掉
      if (selfEmail && commit.authorEmail.trim().toLowerCase() !== selfEmail)
        continue

      const date = dayKey(commit.time)
      if (!date || date < from || date > to)
        continue
      if (known?.has(commit.hash))
        continue

      const key = groupKey(project.id, date)
      const group = groups.get(key)
      if (!group) {
        groups.set(key, { project, date, commits: [commit], hashes: new Set([commit.hash]) })
      }
      else if (!group.hashes.has(commit.hash)) {
        group.commits.push(commit)
        group.hashes.add(commit.hash)
      }
    }
  }

  return [...groups.values()]
    .map(({ project, date, commits }) => {
      const sorted = commits
        .slice()
        .sort((left, right) => left.time - right.time || left.hash.localeCompare(right.hash))
      const target = targets.get(groupKey(project.id, date))

      return {
        projectId: project.id,
        projectName: project.name,
        date,
        content: sorted.map(commit => `- ${commit.subject}`).join('\n'),
        commits: sorted.map(commit => commit.hash),
        ...(target ? { appendTo: target.id } : {}),
      }
    })
    // 预览按项目排（与时间轴默认的「按项目」同一副读法），同项目里新的日期在前
    .sort((left, right) => {
      const byProject = left.projectName.localeCompare(right.projectName)
      if (byProject !== 0)
        return byProject
      return left.date < right.date ? 1 : -1
    })
}

/** 把新生成的一段接在已有正文后面：空行分隔，两头不留多余空行 */
export function appendGitContent(existing: string, added: string): string {
  const left = existing.trimEnd()
  const right = added.trim()
  if (!left)
    return right
  if (!right)
    return left
  return `${left}\n\n${right}`
}

/** 把这次导入的哈希并进已有记录：并集、去重、保持原有顺序（老哈希在前） */
export function mergeGitCommits(
  existing: readonly string[] | undefined,
  added: readonly string[],
): string[] {
  return [...new Set([...(existing ?? []), ...added])]
}

/** 分组键：项目 id 里不会有 `\u0000`，拿它拼不会撞 */
function groupKey(projectId: string, date: string): string {
  return `${projectId}\u0000${date}`
}
