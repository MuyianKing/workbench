// ! 通讯录的形状与收敛。落盘进 workbench-data.json（与 mailAccounts / mailBulkSenders
// ! 同一份行为配置，**不参与外观同步** —— 判据见 ipc-and-state.md）。
// !
// ! 本机那份是权威：右键「存为联系人」往里攒，写邮件时收件人从它里面挑（也允许当场打一个
// ! 新地址）。**地址就是身份**（按地址去重），名字只是叫法，随便改。
// ! 跨设备共享走同步仓库的 `mail-contacts/<设备id>.json`（与工作日志同一个仓库、同一条出口），
// ! 合并规则见 contacts-sync.ts：按地址取 updatedAt 大者、删除留墓碑。**墓碑一并落在本机**，
// ! 名单展示时由 projectContacts 滤掉。联系人名字与地址会以明文进仓库，建议用私有仓库。

import { sanitizeMailAddress } from './mail'

/** 一个联系人：地址是身份，名字只是叫法。 */
export interface MailContact {
  /** 显示名；空串 = 只知道地址（界面按地址显示） */
  name: string
  /** 邮箱地址（小写）—— 通讯录里它就是身份 */
  address: string
  /** 最后修改时刻（毫秒）；旧数据没有时第一次同步补上 */
  updatedAt?: number
  /** 最后修改的设备 id（同步破平用） */
  by?: string
  /** true = 删除墓碑：保留下来同步到别的机器，名单里不显示 */
  deleted?: boolean
}

/** 通讯录的上限：个人通讯录攒不到这个数，只防手改数据文件塞进一大坨 */
export const MAIL_CONTACTS_MAX = 500
/** 名字的长度上限（地址那一边走 MAIL_ADDRESS_MAX） */
export const MAIL_CONTACT_NAME_MAX = 60

/** 单个联系人的收敛：地址没有 @ 整条作废（回空串地址），名字 trim 后限长，同步字段按形状收敛。 */
export function sanitizeMailContact(value: unknown): MailContact {
  const raw = (value ?? {}) as Partial<Record<keyof MailContact, unknown>>
  const contact: MailContact = {
    name: String(raw.name ?? '').trim().slice(0, MAIL_CONTACT_NAME_MAX),
    address: sanitizeMailAddress(raw.address),
  }
  const updatedAt = raw.updatedAt
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0)
    contact.updatedAt = Math.floor(updatedAt)
  if (typeof raw.by === 'string' && raw.by.trim())
    contact.by = raw.by.trim()
  if (raw.deleted === true)
    contact.deleted = true
  return contact
}

/**
 * 整份通讯录的收敛：没地址的丢掉、按地址去重（先来的那份名字留着）、超上限截断。
 * 与 sanitizeMailAccounts 同一条口径。
 */
export function sanitizeMailContacts(value: unknown): MailContact[] {
  if (!Array.isArray(value))
    return []
  const seen = new Set<string>()
  const contacts: MailContact[] = []
  for (const item of value) {
    const contact = sanitizeMailContact(item)
    if (!contact.address || seen.has(contact.address))
      continue
    seen.add(contact.address)
    contacts.push(contact)
    if (contacts.length >= MAIL_CONTACTS_MAX)
      break
  }
  return contacts
}

/** 下拉与清单里怎么叫一个人：「名字 <地址>」；没名字就只摆地址。 */
export function contactLabel(contact: MailContact): string {
  return contact.name ? `${contact.name} <${contact.address}>` : contact.address
}

/** 按地址找一个联系人（大小写不敏感 —— 存进去的一律是小写，手打进来的不一定）。 */
export function contactOf(contacts: readonly MailContact[], address: string): MailContact | undefined {
  const wanted = address.trim().toLowerCase()
  if (!wanted)
    return undefined
  return contacts.find(contact => contact.address === wanted)
}

/**
 * 写信框收件人那一行的值拆成地址清单：逗号 / 分号（中英文）/ 空白都能当分隔符 ——
 * 粘贴「a@x.com, b@y.com」进来也认得出是两个。空串与纯空白丢掉。
 */
export function splitTypedAddresses(values: readonly string[]): string[] {
  return values
    .flatMap(value => value.split(/[,;，；\s]+/))
    .map(address => address.trim())
    .filter(Boolean)
}
