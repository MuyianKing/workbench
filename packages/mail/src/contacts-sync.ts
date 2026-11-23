/**
 * 通讯录的多机合并：**一台机器一份分片**（`mail-contacts/<设备id>.json`），渲染层负责合并。
 *
 * 与工作日志同一条口径：本机 `settings.mailContacts` 是权威，合并结果**写回本机** ——
 * 联系人可改名、可删除，只在内存里看一眼的话这边改了删了没有落点，下一轮又会被读回来。
 * 分片里放的是本机合并后的完整快照（记录 + 墓碑），单写者、不重复计算。
 *
 * 合并规则：
 *  - 按地址（身份，小写）取并集；
 *  - 同一个地址用 `(updatedAt, by)` 比大小，大的赢（后写胜出）；同值按序列化结果破平，
 *    保证两台机器算出的结果逐字节一致，不产生假提交；
 *  - **墓碑按删除时刻参与比较**：离线设备带回来的旧记录输给较新的墓碑，不会被重新拉回；
 *    若用户在另一台机器上更晚重新添加同一地址（新的时间戳），则是新的一次添加，照常生效；
 *  - 墓碑不自动清理（清掉后离线设备回来会把旧记录再推回来）；
 *  - 输出按地址排序。
 *
 * 联系人名字与地址会以明文进同步仓库，建议用私有仓库；不新增网络出口，复用同一个仓库、
 * 同一把 `sync::lock_workflow` 锁、同一条 enqueue 队列。
 */

import type { MailContact } from './contacts'
import { sanitizeMailContact } from './contacts'

export const MAIL_CONTACTS_SHARD_VERSION = 1

/** 推给同步仓库的分片：合并后的完整快照（含墓碑），只写自己那份 */
export interface MailContactShard {
  version: number
  /** 设备 id（分片文件名就是它） */
  device: string
  /** 设备名，仅展示 */
  name: string
  /** 记录（含墓碑），按地址排序 */
  contacts: MailContact[]
}

/** 同步一轮的结果：`changed` 表示远端并进来后本机这份真的变过 */
export interface MailContactSyncOutcome {
  changed: boolean
}

/**
 * 同地址两个记录谁更新。updatedAt 大的赢； ties 用 by 破平；再相等按序列化结果定死顺序。
 */
function pickNewer(left: MailContact, right: MailContact): MailContact {
  if ((left.updatedAt ?? 0) !== (right.updatedAt ?? 0))
    return (left.updatedAt ?? 0) > (right.updatedAt ?? 0) ? left : right
  const byLeft = left.by ?? ''
  const byRight = right.by ?? ''
  if (byLeft !== byRight)
    return byLeft > byRight ? left : right
  return JSON.stringify(left) >= JSON.stringify(right) ? left : right
}

/** 记录数组 → 按地址收敛成 Map（同地址只留较新的那份） */
function byAddress(contacts: readonly MailContact[]): Map<string, MailContact> {
  const map = new Map<string, MailContact>()
  for (const contact of contacts) {
    if (!contact.address)
      continue
    const current = map.get(contact.address)
    map.set(contact.address, current ? pickNewer(current, contact) : contact)
  }
  return map
}

function sorted(map: Map<string, MailContact>): MailContact[] {
  return [...map.values()].sort((a, b) => a.address.localeCompare(b.address))
}

/**
 * 分片收敛：没有设备 id 的分片整份丢掉（分不出是谁的，合并进来只会造成重复）。
 * 记录过 sanitizeMailContact（地址小写、名字限长、同步字段按形状收敛），同地址取较新的。
 */
export function sanitizeMailContactShard(raw: unknown): MailContactShard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null

  const input = raw as Partial<MailContactShard>
  const device = typeof input.device === 'string' ? input.device.trim() : ''
  if (!device)
    return null

  const map = byAddress((Array.isArray(input.contacts) ? input.contacts : []).map(sanitizeMailContact))
  return {
    version: MAIL_CONTACTS_SHARD_VERSION,
    device,
    name: typeof input.name === 'string' ? input.name.trim() : '',
    contacts: sorted(map),
  }
}

/**
 * 本机记录 + 别的设备的分片 → 合并后的本机记录（含墓碑，按地址排序）。
 *
 * 不修改入参。调用方拿它和本机那份比一下（`sameMailContacts`），真的变了才落盘、才重画。
 */
export function mergeMailContactShards(
  local: readonly MailContact[],
  shards: readonly MailContactShard[],
): MailContact[] {
  const map = byAddress(local)
  for (const shard of shards) {
    for (const contact of shard.contacts) {
      const current = map.get(contact.address)
      map.set(contact.address, current ? pickNewer(current, contact) : contact)
    }
  }
  return sorted(map)
}

/** 本机记录 → 分片：含墓碑、按地址排序 */
export function mailContactShardOf(device: string, name: string, contacts: readonly MailContact[]): MailContactShard {
  return {
    version: MAIL_CONTACTS_SHARD_VERSION,
    device,
    name,
    contacts: sorted(byAddress(contacts)),
  }
}

/**
 * 两份本机记录是否一致（按地址排序后比）。顺序无关，用于判断合并结果要不要落盘。
 */
export function sameMailContacts(left: readonly MailContact[], right: readonly MailContact[]): boolean {
  const normalize = (list: readonly MailContact[]): MailContact[] => sorted(byAddress(list))
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

/** 名单展示用：滤掉删除墓碑，保留原始记录（不改入参） */
export function projectContacts(contacts: readonly MailContact[]): MailContact[] {
  return contacts.filter(contact => !contact.deleted)
}

/**
 * 旧数据没有 updatedAt：第一次同步时补齐时刻与本机设备 id 并落盘，之后按正常 LWW 规则参与合并。
 * 已经有时间戳的不动（保留原来的修改时刻与来源设备）。
 */
export function stampMissingContacts(
  contacts: readonly MailContact[],
  now: number,
  device: string,
): MailContact[] {
  return contacts.map(contact => (contact.updatedAt && contact.updatedAt > 0 && contact.by
    ? contact
    : { ...contact, updatedAt: contact.updatedAt && contact.updatedAt > 0 ? contact.updatedAt : now, by: contact.by || device }))
}
