/**
 * 工作日志的多机合并：**一台机器一份分片**（`work-log/<设备id>.json`），渲染层负责合并。
 *
 * 为什么不是「活跃度那样只在内存合并」：工作日志条目是可编辑、可删除的，远端条目如果只在内存里
 * 看一眼，用户在这边改了 / 删了也没有落点，下一轮又会被读回来。所以合并结果要**写回本机**
 * `work-log.json`；分片里放的就是本机合并后的完整快照（条目 + 墓碑），单写者、不重复计算。
 *
 * 合并规则（与保险库同一条口径）：
 *  - 按条目 id 取并集；
 *  - 同一个 id 用 `(updatedAt, by)` 比大小，大的赢（后写胜出）；同毫秒按设备 id 破平；
 *  - **墓碑与条目一起参与比较**：删得比改得晚就还是删，改得比删得晚就复活（LWW）；
 *  - 墓碑不自动清理（清掉后离线设备回来会把旧条目再推回来）；
 *  - 输出按 id 排序，两台机器合出来的内容逐字节一致，避免假提交。
 */

import type { WorkLogEntry, WorkLogFile, WorkLogTombstone } from './work-log'
import { newerWorkLogStamp, sanitizeWorkLogEntry, sanitizeWorkLogTombstone, WORK_LOG_VERSION } from './work-log'

export const WORK_LOG_SHARD_VERSION = 1

/** 本机推给同步仓库的分片：合并后的完整快照 + 设备信息（内容由渲染层算，Rust 只负责写盘） */
export interface WorkLogShard {
  version: number
  /** 设备 id（分片文件名就是它）；空分片会被整份丢掉 */
  device: string
  /** 设备名，仅展示 */
  name: string
  /** 这份分片里最新一个节点的时间，仅展示 / 判断有没有东西 */
  updatedAt: number
  entries: WorkLogEntry[]
  tombstones: WorkLogTombstone[]
}

/** 同步一轮的结果：`changed` 表示远端条目并进来后本机这份真的变过（页面据此重画） */
export interface WorkLogSyncOutcome {
  enabled: boolean
  changed: boolean
  device: string
  entries: WorkLogEntry[]
}

type WorkLogNode = WorkLogEntry | WorkLogTombstone

function isTombstone(node: WorkLogNode): node is WorkLogTombstone {
  return !('content' in node)
}

/**
 * 同 id 两个节点谁更新。
 *
 * `newerWorkLogStamp` 只比 `(updatedAt, by)`；两项都相等时（同一台设备同一毫秒产生了两份内容，
 * 基本不可能）再按序列化结果定死一个顺序 —— 合并必须在两端得出同一个答案，否则每次同步都会
 * 互相覆盖出假提交。
 */
function pickNewerNode(left: WorkLogNode, right: WorkLogNode): WorkLogNode {
  if (newerWorkLogStamp(left, right))
    return left
  if (newerWorkLogStamp(right, left))
    return right
  return JSON.stringify(left) >= JSON.stringify(right) ? left : right
}

/** 节点数组 → 按 id 排序的数组（输出稳定，便于逐字节比较） */
function sortedNodes(entries: readonly WorkLogEntry[], tombstones: readonly WorkLogTombstone[]): WorkLogNode[] {
  return [...entries, ...tombstones].sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * 分片收敛：没有设备 id 的分片整份丢掉（分不出是谁的，合并进来只会造成重复）；
 * 条目必须有 id —— 远端缺 id 不能补一个新 UUID，否则每轮同步都会复制出一份新记录。
 */
export function sanitizeWorkLogShard(raw: unknown): WorkLogShard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null

  const input = raw as Partial<WorkLogShard>
  const device = typeof input.device === 'string' ? input.device.trim() : ''
  if (!device)
    return null

  const nodes = new Map<string, WorkLogNode>()
  const put = (node: WorkLogNode): void => {
    const current = nodes.get(node.id)
    nodes.set(node.id, current ? pickNewerNode(current, node) : node)
  }

  for (const item of Array.isArray(input.entries) ? input.entries : []) {
    const entry = sanitizeWorkLogEntry(item, () => '')
    if (entry && entry.id)
      put(entry)
  }
  for (const item of Array.isArray(input.tombstones) ? input.tombstones : []) {
    const tombstone = sanitizeWorkLogTombstone(item)
    if (tombstone)
      put(tombstone)
  }

  const entries: WorkLogEntry[] = []
  const tombstones: WorkLogTombstone[] = []
  for (const node of [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (isTombstone(node))
      tombstones.push(node)
    else
      entries.push(node)
  }

  const updatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) && input.updatedAt > 0
    ? Math.floor(input.updatedAt)
    : [...nodes.values()].reduce((max, node) => Math.max(max, node.updatedAt), 0)

  return {
    version: WORK_LOG_SHARD_VERSION,
    device,
    name: typeof input.name === 'string' ? input.name.trim() : '',
    updatedAt,
    entries,
    tombstones,
  }
}

/**
 * 本机文件 + 别的设备的分片 → 合并后的本机文件。
 *
 * 不修改入参；结果按 id 排序。调用方拿它和本机那份比一下（`sameWorkLogFile`），
 * 真的变了才落盘、才触发界面重画。
 */
export function mergeWorkLogShards(
  local: WorkLogFile,
  shards: readonly WorkLogShard[],
): WorkLogFile {
  const nodes = new Map<string, WorkLogNode>()
  const put = (node: WorkLogNode): void => {
    const current = nodes.get(node.id)
    nodes.set(node.id, current ? pickNewerNode(current, node) : node)
  }

  for (const entry of local.entries) put(entry)
  for (const tombstone of local.tombstones) put(tombstone)
  for (const shard of shards) {
    for (const entry of shard.entries) put(entry)
    for (const tombstone of shard.tombstones) put(tombstone)
  }

  const entries: WorkLogEntry[] = []
  const tombstones: WorkLogTombstone[] = []
  for (const node of [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (isTombstone(node))
      tombstones.push(node)
    else
      entries.push(node)
  }

  return { version: WORK_LOG_VERSION, entries, tombstones }
}

/** 本机文件 → 分片：条目与墓碑都按 id 排序，`updatedAt` 取最新那个节点 */
export function workLogShardOf(device: string, name: string, file: WorkLogFile): WorkLogShard {
  const updatedAt = [...file.entries, ...file.tombstones]
    .reduce((max, node) => Math.max(max, node.updatedAt), 0)

  return {
    version: WORK_LOG_SHARD_VERSION,
    device,
    name,
    updatedAt,
    entries: [...file.entries].sort((left, right) => left.id.localeCompare(right.id)),
    tombstones: [...file.tombstones].sort((left, right) => left.id.localeCompare(right.id)),
  }
}

/** 两份本机文件内容是否一致（只看节点，不看顺序）：用于判断合并结果要不要落盘 */
export function sameWorkLogFile(left: WorkLogFile, right: WorkLogFile): boolean {
  const nodes = (file: WorkLogFile): WorkLogNode[] => sortedNodes(file.entries, file.tombstones)
  return JSON.stringify(nodes(left)) === JSON.stringify(nodes(right))
}
