/**
 * 邮箱页的适配层实现。
 *
 * **为什么会出网**：命令在 Rust 侧（`src-tauri/src/mail.rs`），第十条「由用户显式开启」
 * 的出口 —— 连接目标就是账户配置里那两台收发服务器（IMAP 收 / SMTP 发），主机名不设
 * 白名单，与 AI 助手的 Base URL 同属「地址由用户给」的出口。授权码不经过这一层：
 * Rust 从凭据管理器里取，这里只递非敏感的连接参数。
 *
 * 这一层只做「invoke → Result」的收敛，MIME 解析（postal-mime）与发信报文构建
 * （buildMime）在 @workbench/mail 包（有单测），策略（缓存、拉多少封）在 stores/mail.ts。
 */
import type { MailAccount, MailFolder } from '@workbench/mail'
import type { Result } from '@/types'
import { fail, ok } from '@workbench/core'
import { errorText, guard, invoke } from './bridge'

/** Rust 回来的列表摘要（与 mail.rs 的 MailSummary 一致，serde camelCase） */
export interface MailSummary {
  uid: number
  subject: string
  from: string
  /** 收件人头部原文：收件箱的清单行不画它，发件箱画收件人、回信也发给它 */
  to: string
  date: string
  seen: boolean
  hasAttachment: boolean
}

/** 连通性验证（收发两边都试一遍，授权码只在这一趟作参数）。 */
export async function verifyMailAccount(account: MailAccount, secret: string): Promise<Result<null>> {
  return guard(
    invoke<null>('mail_verify', {
      address: account.address,
      secret,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
    }),
    '验证失败',
  )
}

/** 存 / 覆盖这个邮箱的授权码（进凭据管理器，之后 Rust 自己取，渲染层不再持有）。 */
export async function saveMailKey(address: string, secret: string): Promise<Result<null>> {
  return guard(invoke<null>('mail_key_save', { address, secret }), '保存授权码失败')
}

/** 这个邮箱配过授权码没有（只回有没有，界面显示「已配置 / 未配置」）。 */
export async function mailKeyState(address: string): Promise<Result<boolean>> {
  return guard(invoke<boolean>('mail_key_state', { address }), '查询授权码状态失败')
}

/** 清掉这个邮箱的授权码（换地址或删账户时用）。 */
export async function clearMailKey(address: string): Promise<Result<null>> {
  return guard(invoke<null>('mail_key_clear', { address }), '清除授权码失败')
}

/**
 * 一个文件夹里最近 N 封的摘要。folder 是逻辑名（inbox / sent）—— 服务器上的文件夹名
 * （网易是 modified UTF-7 的 `&XfJT0ZAB-`、腾讯是 `Sent Messages`）由 Rust 侧现认。
 */
export async function fetchMailList(account: MailAccount, folder: MailFolder, limit: number): Promise<Result<MailSummary[]>> {
  return guard(
    invoke<MailSummary[]>('mail_list', {
      address: account.address,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      folder,
      limit,
    }),
    '拉取邮件列表失败',
  )
}

/** 拉一封完整报文（base64），MIME 解析在 store 里交给 @workbench/mail。 */
export async function fetchMailBody(account: MailAccount, folder: MailFolder, uid: number, markSeen: boolean): Promise<Result<string>> {
  return guard(
    invoke<string>('mail_fetch_body', {
      address: account.address,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      folder,
      uid,
      markSeen,
    }),
    '读取邮件失败',
  )
}

/** 标记 / 取消一封的已读。 */
export async function setMailSeen(account: MailAccount, folder: MailFolder, uid: number, seen: boolean): Promise<Result<null>> {
  return guard(
    invoke<null>('mail_set_seen', {
      address: account.address,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      folder,
      uid,
      seen,
    }),
    '标记已读失败',
  )
}

/** 删一批（服务器上标 \Deleted 并 EXPUNGE —— 不可找回，调用方先确认过）；单封传一个元素的数组。 */
export async function deleteMails(account: MailAccount, folder: MailFolder, uids: number[]): Promise<Result<null>> {
  return guard(
    invoke<null>('mail_delete', {
      address: account.address,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      folder,
      uids,
    }),
    '删除失败',
  )
}

/** 发一封邮件（mime 是 @workbench/mail 的 buildMime 拼好的完整报文）。 */
export async function sendMail(account: MailAccount, to: string[], mime: string): Promise<Result<null>> {
  return guard(
    invoke<null>('mail_send', {
      address: account.address,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      to,
      mime,
    }),
    '发送失败',
  )
}

/** 附件落盘（路径来自「另存为」，数据是 MIME 解析出的附件 base64）。 */
export async function saveMailAttachment(path: string, base64: string): Promise<Result<null>> {
  try {
    const saved = await invoke<null>('mail_attachment_save', { path, data: base64 })
    return ok(saved)
  }
  catch (error) {
    return fail(errorText(error, '保存附件失败'))
  }
}

/**
 * 把账户清单、广告发件人黑名单与轮询周期交给后台监视（Rust 侧按登记的周期查新邮件，
 * 有未读的新信弹系统通知）。任何一项变了就整份重登；清单为空或周期 0 = 监视空转，
 * 出口依旧是「配了账户才开」。授权码不经过这一层（Rust 连的时候自己取）。
 */
export async function registerMailWatch(
  accounts: MailAccount[],
  bulkSenders: string[],
  pollMinutes: number,
): Promise<Result<null>> {
  return guard(
    invoke<null>('mail_watch_register', {
      accounts: accounts.map(account => ({
        address: account.address,
        imapHost: account.imapHost,
        imapPort: account.imapPort,
      })),
      bulkSenders,
      pollMinutes,
    }),
    '登记邮件监视失败',
  )
}
