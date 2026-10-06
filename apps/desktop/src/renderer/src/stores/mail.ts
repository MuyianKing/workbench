/**
 * 邮箱页的状态。
 *
 * **数据流**：设置里的账户（`settings.mailAccount`，地址空 = 出口关闭）→
 * 适配层（`workbench/mail.ts`，invoke mail_* 命令）→ Rust 现连现断跑 IMAP/SMTP →
 * 这一层做策略：列表缓存、正文按 uid 缓存（页面会话内存，不落盘）、MIME 解析与
 * 沙箱用 HTML 的生成（@workbench/mail 的 parseMessage / htmlBody）。
 *
 * **拉取时机**：进页面 / 手动刷新才联网，不后台轮询 —— 这个应用不上报任何数据，
 * 邮箱也不该自己偷偷跑流量。发送成功不主动重拉列表（新信未必排得进最近 50 封），
 * 用户自己点刷新。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  buildMime,
  displayDate,
  displaySender,
  htmlBody,
  mailAccountReady,
  parseMessage,
  senderAddress,
  type MailAccount,
  type MailAttachmentInput,
  type ParsedAttachment
} from '@workbench/mail'
import { fail, ok } from '@workbench/core'
import type { Result } from '@/types'
import { fetchMailBody, fetchMailList, saveMailAttachment, sendMail, setMailSeen, type MailSummary } from '@/workbench/mail'
import { useSettingsStore } from './settings'

/** 列表一次拉多少封：个人收件箱看个最近一周够用了 */
export const MAIL_LIST_LIMIT = 50

/** 打开的一封信：都是展示层直接能用的形态（解码过、日期格式化过） */
export interface MailMessage {
  uid: number
  subject: string
  fromText: string
  fromAddress: string
  dateText: string
  /** sandbox iframe 用的文档（CSP 已注入、cid 已换成 data URL）；null = 这封没有 HTML 正文 */
  html: string | null
  text: string
  attachments: ParsedAttachment[]
}

/** 回信的预填：收件人、主题与要引用的原文 */
export interface MailReplyTarget {
  to: string
  subject: string
  text: string
}

export const useMailStore = defineStore('mail', () => {
  const settings = useSettingsStore()

  const account = computed<MailAccount>(() => settings.settings.mailAccount)
  /** 地址与收发服务器齐了才算配置好；授权码在不在要到连的时候才知道（在凭据管理器里） */
  const configured = computed(() => mailAccountReady(account.value))

  // ---------- 收件箱列表 ----------

  const list = ref<MailSummary[]>([])
  const listLoading = ref(false)
  const listError = ref('')
  let listInFlight = false

  async function refreshList(): Promise<void> {
    if (!configured.value) {
      list.value = []
      listError.value = ''
      return
    }
    if (listInFlight) return
    listInFlight = true
    listLoading.value = true
    listError.value = ''
    const result = await fetchMailList(account.value, MAIL_LIST_LIMIT)
    listLoading.value = false
    listInFlight = false
    if (result.ok && result.data) {
      list.value = result.data
    } else {
      listError.value = result.error ?? '拉取收件箱失败'
    }
  }

  // ---------- 读信 ----------

  const active = ref<MailMessage | null>(null)
  const bodyLoading = ref(false)
  const bodyError = ref('')
  /** 正文按 uid 缓存：一封信拉一次，翻回来不再下载（内含整份报文，页面上限几十封没问题） */
  const bodies = new Map<number, MailMessage>()

  async function openMail(uid: number): Promise<void> {
    const cached = bodies.get(uid)
    if (cached) {
      active.value = cached
      return
    }
    if (!configured.value || bodyLoading.value) return
    bodyLoading.value = true
    bodyError.value = ''
    const raw = await fetchMailBody(account.value, uid, true)
    if (!raw.ok || !raw.data) {
      bodyLoading.value = false
      bodyError.value = raw.error ?? '读取邮件失败'
      return
    }
    try {
      const parsed = await parseMessage(raw.data)
      const summary = list.value.find((item) => item.uid === uid)
      const fromAddress = parsed.from?.address || (summary ? senderAddress(summary.from) : '')
      const message: MailMessage = {
        uid,
        subject: parsed.subject?.trim() || '(无主题)',
        fromText: parsed.from?.name || fromAddress || '(未知发件人)',
        fromAddress,
        dateText: displayDate(summary?.date ?? ''),
        html: htmlBody(parsed),
        text: parsed.text,
        attachments: parsed.attachments
      }
      bodies.set(uid, message)
      active.value = message
      // 打开即已读（Rust 侧 markSeen），列表上的点就地跟上
      if (summary && !summary.seen) summary.seen = true
    } catch (error) {
      bodyError.value = error instanceof Error ? error.message : '邮件解析失败'
    }
    bodyLoading.value = false
  }

  function closeMail(): void {
    active.value = null
  }

  /** 标记 / 取消已读。列表先就地改，服务器那边失败了再说（返回 Result 给调用方提示）。 */
  async function markSeen(uid: number, seen: boolean): Promise<Result<null>> {
    const result = await setMailSeen(account.value, uid, seen)
    if (result.ok) {
      const item = list.value.find((entry) => entry.uid === uid)
      if (item) item.seen = seen
    }
    return result
  }

  // ---------- 发信 ----------

  const sending = ref(false)

  async function send(input: {
    to: string[]
    subject: string
    text: string
    attachments?: MailAttachmentInput[]
  }): Promise<Result<null>> {
    if (!configured.value) return fail('先把邮箱账户配好（邮箱页右上角的「账户」）')
    if (sending.value) return fail('上一封还在发，等它跑完')
    sending.value = true
    try {
      const mime = buildMime({
        from: account.value.address,
        to: input.to,
        subject: input.subject,
        text: input.text,
        attachments: input.attachments
      })
      return await sendMail(account.value, input.to, mime)
    } catch (error) {
      return fail(error instanceof Error ? error.message : '报文构建失败')
    } finally {
      sending.value = false
    }
  }

  // ---------- 附件 ----------

  async function downloadAttachment(path: string, base64: string): Promise<Result<null>> {
    return saveMailAttachment(path, base64)
  }

  /** 账户换过 / 授权码重填过之后，缓存的正文还在没问题（报文不变），但列表该重拉 */
  function invalidate(): void {
    bodies.clear()
    active.value = null
    void refreshList()
  }

  /** 发件人展示名：列表与阅读栏共用同一套解码（@workbench/mail 的 displaySender） */
  function senderText(raw: string): string {
    return displaySender(raw)
  }

  return {
    account,
    configured,
    list,
    listLoading,
    listError,
    active,
    bodyLoading,
    bodyError,
    sending,
    refreshList,
    openMail,
    closeMail,
    markSeen,
    send,
    downloadAttachment,
    invalidate,
    senderText
  }
})
