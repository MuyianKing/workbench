// ! 广告 / 营销邮件的识别。**两条判法，用户标记远在前**：
// !
// !  1. **用户右击「标记为广告」攒下的发件人清单**（设置里的 `mailBulkSenders`）——
// !     一个地址进去，这个发件人**过去与将来**的信全算广告。这是唯一可靠的判法：
// !     收件箱里什么算广告只有主人说了算，标记一次终身生效。
// !  2. **保守的自动启发式**（发件人地址的批量前缀、主题广告词）—— 只兜显然的那种，
// !     宁可放过也不误拦。
// !
// ! 曾经还用过第三条信号 `List-Unsubscribe` 头，**已弃用**：实测网易邮箱里大量正常的通知
// ! 邮件（网站注册、订单提醒这类）也带这个头，单凭它一拦就是几十封误伤 —— 广告过滤的
// ! 头等原则是**误伤一封真信比放过一封广告难看得多**，宁可整条撤掉、靠用户标记补。

import { senderAddress } from './parse'

/** 判一条摘要像不像广告邮件。字段与适配层的 MailSummary 对齐（只认这两样）。 */
export interface BulkSignals {
  subject: string
  from: string
}

/**
 * 发件人地址的本地部分一眼就是批量发的：推广 / 营销 / 订阅这些，不含 order / service
 *  这类事务性前缀 —— 订单确认、账单通知不能误伤。裸的 `news` 也刻意不收：LinkedIn
 *  这类正常网站的职位 / 互动通知就从 news@ 发，收了它误伤一串。
 */
const BULK_FROM_PREFIX = /^(promo|promotions|promotion|marketing|newsletter|ads|advertising|ad-?campaign|offers|deals|bulletin)[\-.@]/

/**
 * 主题里的广告词。中文按包含认（这类词出现在主题里基本就是营销），英文按整词认 ——
 *  standalone 的 sale 不能把 wholesale 误伤。词表刻意收得窄：只留不可能出现在事务信里
 *  的词 —— 「优惠 / 折扣 / 限时 / 优惠券 / 上新 / 红包 / 周刊」这类在续费提醒、券过期
 *  通知、订阅的周刊标题里照样出现，收了就是一串误伤（实测翻车过一轮）。误伤一封真信
 *  比放过一封广告难看得多，漏网的靠用户右击「标记为广告」补。
 */
const BULK_SUBJECT_CN = [
  '促销',
  '秒杀',
  '大促',
  '满减',
  '返现',
  '钜惠',
  '狂欢',
  '双11',
  '双十一',
  '年货节',
  '黑五',
]
const BULK_SUBJECT_EN
  = /\b(unsubscribe|promo(?:tion)?s?|deals?|discount|sale|flash\s?sale)\b/i

/** 发件人黑名单的上限：个人邮箱攒不到这个数，只防手改数据文件塞进一大坨 */
export const MAIL_BULK_SENDERS_MAX = 500

/** 收敛发件人黑名单（设置的 `mailBulkSenders`）：trim、小写、去重，认不出像地址的丢掉 */
export function sanitizeMailBulkSenders(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  const seen = new Set<string>()
  for (const item of value) {
    const address = typeof item === 'string' ? item.trim().toLowerCase() : ''
    if (!address.includes('@') || /\s/.test(address))
      continue
    seen.add(address)
    if (seen.size >= MAIL_BULK_SENDERS_MAX)
      break
  }
  return [...seen]
}

/** 一条摘要是不是广告 / 营销邮件：黑名单说了算，其次才是启发式。 */
export function isBulkMail(summary: BulkSignals, bulkSenders: readonly string[] = []): boolean {
  const address = senderAddress(summary.from).toLowerCase()
  if (address && bulkSenders.includes(address))
    return true
  if (BULK_FROM_PREFIX.test(address))
    return true
  const subject = summary.subject.toLowerCase()
  if (BULK_SUBJECT_CN.some(word => subject.includes(word)))
    return true
  return BULK_SUBJECT_EN.test(summary.subject)
}
