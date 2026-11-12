/**
 * 工作日志按设备分开看。
 *
 * 数据层仍然把所有设备的分片合并进本机 `work-log.json`（见 `work-log-sync.ts`）：
 * 条目可编辑、可删除，合并结果必须有落点。这一层只回答两个显示问题 ——
 * 「这条是哪台设备的」与「切换器里列哪些设备」。
 *
 * **没有 `by` 的老数据一律算本机**：多机同步是 v2 才有的，之前写下的条目只可能来自本机。
 */

import type { WorkLogEntry } from './work-log'

/** 设备切换器里的一项 */
export interface WorkLogDevice {
  id: string
  /** 展示名；本机还没取到名字时为空串（界面显示「本机」），别的设备取不到名字时用 id 前几位 */
  name: string
  /** 是不是本机（页面默认看它，按钮 / 菜单上标「（本机）」） */
  self?: boolean
}

/** 同步分片里带回来的设备身份：只用于给切换器配名字 */
export interface WorkLogDeviceRef {
  id: string
  name: string
}

/** 条目属于哪台设备：没有 by 的老数据算本机 */
export function deviceOfEntry(entry: WorkLogEntry, localDeviceId: string): string {
  return entry.by || localDeviceId
}

/**
 * 只留某台设备的条目。
 *
 * `localDeviceId` 只用来认领没有 `by` 的老数据；`deviceId` 为空表示本机标识还没拿到 /
 * 拿不到 —— 这时**不筛**，宁可把合并后的记录都显示出来，也不要把整份日志藏起来。
 */
export function entriesOfDevice(
  entries: readonly WorkLogEntry[],
  deviceId: string,
  localDeviceId: string,
): WorkLogEntry[] {
  if (!deviceId)
    return [...entries]
  return entries.filter(entry => deviceOfEntry(entry, localDeviceId) === deviceId)
}

/**
 * 切换器里的设备清单：**本机恒在第一位**（哪怕一条记录都没有，用户总得能切回来），
 * 其余取「同步拉到的设备清单」+「条目里实际出现过的设备」的并集 ——
 * 分片已经在盘上、只是还没有带 `by` 的条目时也要列出来（老数据没有来源信息，
 * 那台设备切过去是空态，但用户应该看得见它、也能切）；反过来，条目里出现过、
 * 本轮却没拉到分片的设备同样要列，不能把记录藏在一个选不到的设备下面。
 *
 * 名字优先用分片带来的（同一台机器取它最后一次推上去的那个名字），
 * 没有分片 / 分片没名字时用 id 前 8 位兜底，至少两台机器还分得开。
 */
export function workLogDevices(
  entries: readonly WorkLogEntry[],
  local: WorkLogDeviceRef,
  others: readonly WorkLogDeviceRef[],
): WorkLogDevice[] {
  const names = new Map<string, string>()
  for (const item of others) {
    if (item.id && item.id !== local.id)
      names.set(item.id, item.name)
  }
  for (const entry of entries) {
    const id = deviceOfEntry(entry, local.id)
    if (id !== local.id && !names.has(id))
      names.set(id, '')
  }

  const rest: WorkLogDevice[] = [...names]
    .map(([id, name]) => ({ id, name: name || `设备 ${id.slice(0, 8)}` }))
    .sort((left, right) => left.name.localeCompare(right.name))

  return [{ id: local.id, name: local.name, self: true }, ...rest]
}
