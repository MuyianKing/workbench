/**
 * 宿主返回值的收敛：Git 页的通道契约与全应用一样 —— 渲染层不假设宿主一定回了什么。
 *
 * 字段缺失、类型不对、手改过的数据文件都不该把界面弄崩，所以每一项都在这里过一遍：
 * 提交号只留十六进制、时间只留正数、状态只留首字母、路径只留非空字符串。
 * Rust 侧已经按同一条口径收过一次，这里再收一次是通道的常规做法（与 work-log 的
 * `parseGitCommitLog` 同一条路）。
 */

import type {
  GitChangedFile,
  GitCommit,
  GitCommitDetail,
  GitCommitPage,
  GitCompare,
  GitFileStatus,
  GitPatch,
  GitRepoInfo,
  GitTreeEntry,
  GitTreeEntryType,
  GitTreePage,
} from './types'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 仓库内路径：**不 trim**。文件名可以以空格开头（Windows 允许），
 * 统一裁掉首尾空白会把它指到另一个文件去；它不是给人读的展示字段。
 */
function asPath(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asBool(value: unknown): boolean {
  return value === true
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 提交号只认十六进制（7 ~ 64 位，短号与完整号都收） */
export function isCommitHash(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 7
    && value.length <= 64
    && /^[\da-f]+$/i.test(value)
}

/** 短号：界面里显示前 7 位（与技能版本历史同一口径） */
export function shortHash(hash: string, length = 7): string {
  return hash.slice(0, length)
}

/** 状态字母 → 界面文案 */
export function statusLabel(status: GitFileStatus): string {
  switch (status) {
    case 'A':
      return '新增'
    case 'M':
      return '修改'
    case 'D':
      return '删除'
    case 'R':
      return '重命名'
    case 'C':
      return '复制'
    case 'T':
      return '类型变化'
    default:
      return '修改'
  }
}

function parseRepoInfo(raw: unknown): GitRepoInfo | null {
  const value = asRecord(raw)
  const root = asText(value.root)
  if (!root)
    return null
  const name = asText(value.name) || root.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || root
  return {
    root,
    name,
    head: asText(value.head).toLowerCase(),
    shortHead: asText(value.shortHead).toLowerCase(),
    branch: asText(value.branch),
    detached: asBool(value.detached),
    empty: asBool(value.empty),
  }
}

function parseCommit(raw: unknown): GitCommit | null {
  const value = asRecord(raw)
  const hash = asText(value.hash).toLowerCase()
  const time = asNumber(value.time)
  if (!isCommitHash(hash) || time <= 0)
    return null

  const parents = asArray(value.parents)
    .map(asText)
    .map(parent => parent.toLowerCase())
    .filter(isCommitHash)

  return {
    hash,
    time: Math.floor(time),
    author: asText(value.author),
    authorEmail: asText(value.authorEmail),
    parents,
    refs: asText(value.refs),
    subject: asText(value.subject),
  }
}

function parseTreeEntry(raw: unknown): GitTreeEntry | null {
  const value = asRecord(raw)
  const path = asPath(value.path)
  if (!path)
    return null

  const rawType = asText(value.type)
  const type: GitTreeEntryType = rawType === 'dir' || rawType === 'symlink' || rawType === 'submodule'
    ? rawType
    : 'file'
  const name = asPath(value.name) || path.split('/').pop() || path

  return {
    name,
    path,
    type,
    size: Math.max(0, Math.floor(asNumber(value.size))),
  }
}

function parseChangedFile(raw: unknown): GitChangedFile | null {
  const value = asRecord(raw)
  const path = asPath(value.path)
  if (!path)
    return null

  const rawStatus = asText(value.status).toUpperCase()
  const status: GitFileStatus = rawStatus ? rawStatus[0] : 'M'

  return {
    path,
    status,
    added: Math.max(0, Math.floor(asNumber(value.added))),
    deleted: Math.max(0, Math.floor(asNumber(value.deleted))),
    binary: asBool(value.binary),
  }
}

function parseChangedFiles(raw: unknown): GitChangedFile[] {
  const files: GitChangedFile[] = []
  for (const item of asArray(raw)) {
    const file = parseChangedFile(item)
    if (file)
      files.push(file)
  }
  return files
}

export function parseCommitPage(raw: unknown): GitCommitPage {
  const value = asRecord(raw)
  const commits: GitCommit[] = []
  for (const item of asArray(value.commits)) {
    const commit = parseCommit(item)
    if (commit)
      commits.push(commit)
  }
  return {
    commits,
    hasMore: asBool(value.hasMore),
  }
}

export function parseTreePage(raw: unknown): GitTreePage {
  const value = asRecord(raw)
  const entries: GitTreeEntry[] = []
  for (const item of asArray(value.entries)) {
    const entry = parseTreeEntry(item)
    if (entry)
      entries.push(entry)
  }
  return {
    entries,
    truncated: asBool(value.truncated),
  }
}

export function parseCommitDetail(raw: unknown): GitCommitDetail | null {
  const value = asRecord(raw)
  const commit = parseCommit(value)
  if (!commit)
    return null

  const body = asText(value.body)
  const parents = commit.parents
  return {
    ...commit,
    body: body || commit.subject,
    subject: asText(value.subject) || commit.subject || body.split('\n')[0]?.trim() || '',
    isMerge: asBool(value.isMerge) || parents.length > 1,
    isRoot: asBool(value.isRoot) || parents.length === 0,
    // 宿主总会带 base；缺了就从父提交补 —— 根提交没有父，仍是空串
    base: asText(value.base).toLowerCase() || parents[0] || '',
    files: parseChangedFiles(value.files),
    filesTruncated: asBool(value.filesTruncated),
  }
}

export function parseCompare(raw: unknown): GitCompare | null {
  const value = asRecord(raw)
  const base = asText(value.base).toLowerCase()
  const target = asText(value.target).toLowerCase()
  if (!isCommitHash(base) || !isCommitHash(target))
    return null
  return {
    base,
    target,
    files: parseChangedFiles(value.files),
    filesTruncated: asBool(value.filesTruncated),
  }
}

export function parseGitPatch(raw: unknown): GitPatch {
  const value = asRecord(raw)
  return {
    patch: typeof value.patch === 'string' ? value.patch : '',
    binary: asBool(value.binary),
    tooLarge: asBool(value.tooLarge),
    lossy: asBool(value.lossy),
    truncated: asBool(value.truncated),
  }
}

export { parseRepoInfo }
