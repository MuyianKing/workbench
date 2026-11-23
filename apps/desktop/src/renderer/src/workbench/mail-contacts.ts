import type { MailContact, MailContactShard, MailContactSyncOutcome } from '@workbench/mail'
import type { Result } from '@/types'
/**
 * 邮箱联系人的多机同步：拉别的设备的分片 → 合并写回本机设置 → 推本机分片。
 *
 * 与工作日志同一条出口（同一个 git 仓库、同一把锁、同一条 enqueue）：每台机器把合并后的
 * 通讯录快照推到 `mail-contacts/<设备id>.json`（单写者，含墓碑），读回来按地址做
 * 后写胜出并写回本机 —— 联系人可改名、可删除，只在内存里合并就没有落点。
 *
 * 联系人名字与地址以明文进仓库（不是新出口，但建议私有仓库）；没登录 / 没配仓库时
 * 由 api-sync.ts 的 syncRepo() 门禁挡在前面，这里拿到的仓库一定是有效的。
 */
import { fail, ok } from '@workbench/core'
import {
  mailContactShardOf,
  mergeMailContactShards,
  sameMailContacts,
  sanitizeMailContactShard,
  stampMissingContacts,
} from '@workbench/mail'
import { errorText, invoke } from './bridge'
import { emit } from './events'
import * as state from './state'
import { localDevice } from './token'

/**
 * 本机写联系人时打上时间戳与设备 id（删除写墓碑）。
 *
 * 地址是身份；重新添加同一地址时用新的 updatedAt 盖过旧墓碑，正常生效。
 */
export async function stampContact(contact: MailContact, deleted = false): Promise<MailContact> {
  const { id } = await localDevice()
  const stamped: MailContact = {
    name: contact.name,
    address: contact.address,
    updatedAt: Date.now(),
    by: id,
  }
  return deleted ? { ...stamped, deleted: true } : stamped
}

/** 拿本机通讯录：settings 里存的是含墓碑的完整记录，展示时由 store 过滤 */
function localContacts(): MailContact[] {
  return state.settings().mailContacts
}

/** 合并结果写回本机设置，并广播让 Pinia settings store 刷新（updateSettings 本身不 emit） */
function writeBack(contacts: MailContact[]): void {
  state.updateSettings({ mailContacts: contacts })
  emit('settingsChanged', state.settings())
}

/**
 * 同步一轮。
 *
 * `repo` / `device` 由 api-sync.ts 经 syncRepo() + localDevice() 备好；调用方串行化
 * （见 stores/mail.ts 的门禁）。返回 `changed` 表示远端并进来后本机这份真的变过。
 */
export async function syncMailContacts(repo: string, device: { id: string, name: string }): Promise<Result<MailContactSyncOutcome>> {
  try {
    if (!repo.trim())
      return ok({ changed: false })
    if (!device.id)
      return fail('没有设备标识，无法同步联系人')

    // 先拉别的机器的分片（命令里先刷新克隆、跳过本机那份）
    const raw = await invoke<unknown[]>('mail_contacts_sync_pull', { repo, device: device.id })
    const shards: MailContactShard[] = []
    for (const item of Array.isArray(raw) ? raw : []) {
      const shard = sanitizeMailContactShard(item)
      if (shard)
        shards.push(shard)
    }

    // 旧数据没有时间戳：第一次同步时补时刻与本机设备 id 并落盘，之后按正常 LWW 规则参与合并
    const stamped = stampMissingContacts(localContacts(), Date.now(), device.id)
    const merged = mergeMailContactShards(stamped, shards)
    // 补戳、远端合并后只要和本机那份不同就落盘（stamped 里已含合并结果，不必再拼一次）
    const changed = !sameMailContacts(localContacts(), merged)
    if (changed)
      writeBack(merged)

    // 推本机合并后的完整快照（含墓碑，单写者）
    await invoke('mail_contacts_sync_publish', {
      repo,
      device: device.id,
      shard: mailContactShardOf(device.id, device.name, changed ? merged : stamped),
    })

    return ok({ changed })
  }
  catch (error) {
    return fail(errorText(error, '同步联系人失败'))
  }
}
