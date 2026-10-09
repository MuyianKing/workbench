import type { MailAccount, MailAttachmentInput, MailFolder, ParsedAttachment } from '@workbench/mail'
import type { Result } from '@/types'
import type { MailSummary } from '@/workbench/mail'
import { fail, ok } from '@workbench/core'
import { buildMime, displayDate, displayRecipients, displaySender, htmlBody, isBulkMail, mailAccountReady, mailTime, parseMessage, recipientAddress, senderAddress } from '@workbench/mail'
import { defineStore } from 'pinia'
/**
 * 邮箱页的状态。
 *
 * **数据流**：设置里的账户清单（`settings.mailAccounts`，空 = 出口关闭）→
 * 适配层（`workbench/mail.ts`，invoke mail_* 命令，一个账户一条）→ Rust 现连现断跑
 * IMAP/SMTP → 这一层做策略：多账户的清单合并成一份（每封打上来源账户、按头部日期
 * 新在前 —— 不按来源分组）、正文按 (文件夹, 账户, uid) 缓存（页面会话内存，不落盘）、
 * MIME 解析与沙箱用 HTML 的生成（@workbench/mail 的 parseMessage / htmlBody）。
 *
 * **两个文件夹**（`folder`，左栏头部那颗分段选择器切）：收件箱与已发送。清单一次
 * 只装当前那个文件夹（切过去就重拉，见 `setFolder`）；uid 只在单个文件夹里唯一，
 * 所以身份键（`key`）与正文缓存键都把文件夹带上。广告过滤只对收件箱生效 ——
 * 发件箱里「发件人」是自己，拿它判广告毫无道理。
 *
 * **拉取时机**：进页面 / 手动刷新 / 切文件夹各拉一次；另外 Rust 侧有一条后台监视线程
 * （`mail_watch.rs`，只盯收件箱），按设置的周期（mailPollMinutes，默认 30 分钟、可关）
 * 对配好的账户查新邮件，有未读的新信弹系统通知（账户清单、广告黑名单与周期由
 * `startWatch` 在启动时整份登记过去，改了就重登）。
 * 这个应用不上报任何数据，邮箱的检查目标也只有用户自己配的那台服务器。各账户
 * 并行各拉各的，谁的失败只记谁的一句话（其余照常显示）。
 * **广告邮件不进收件箱清单**（isBulkMail 的三路启发式，见 @workbench/mail）：
 * 单独收进清单底部分开的一段（showBulk 控制折叠），勾选 / 删除 / 右键与正常邮件
 * 同一套 —— 误拦了有地方找。发送成功不主动重拉收件箱（新信未必排得进最近 50 封），
 * 用户自己点刷新；发件箱正开着就顺手重拉一次（服务器自己会把刚发的存进已发送）。
 */
import { computed, ref, watch } from 'vue'
import { notifyError } from '@/notify'
import { deleteMails as deleteMailsOnServer, fetchMailBody, fetchMailList, registerMailWatch, saveMailAttachment, sendMail, setMailSeen } from '@/workbench/mail'
import { useNavStore } from './nav'
import { useSettingsStore } from './settings'

/** 列表一次拉多少封（每个账户各拉这么多）：个人收件箱看个最近一周够用了 */
export const MAIL_LIST_LIMIT = 50

/** 合并清单里的一封：适配层摘要 ＋ 来源账户与它的复合键 */
export type MailListItem = MailSummary & {
  /** 这封信是哪个账户收的（账户地址，就是清单行上标注的来源） */
  account: string
  /** 这封在哪个文件夹里（收件箱 / 已发送）—— 命令与身份键都要它 */
  folder: MailFolder
  /** (文件夹, 账户, uid) 拼成的身份：uid 只在单个文件夹里唯一，跨账户、跨文件夹都会撞 */
  key: string
}

/** 打开的一封信：都是展示层直接能用的形态（解码过、日期格式化过） */
export interface MailMessage {
  account: string
  folder: MailFolder
  key: string
  uid: number
  subject: string
  fromText: string
  fromAddress: string
  /** 收件人（发件箱的阅读栏摆它，回信也发给它）；没有收件人给空串 */
  toText: string
  toAddress: string
  dateText: string
  /** sandbox iframe 用的文档（CSP 已注入、cid 已换成 data URL）；null = 这封没有 HTML 正文 */
  html: string | null
  text: string
  attachments: ParsedAttachment[]
}

/** 回信的预填：用哪个账户发（收信的那个）、收件人、主题与要引用的原文 */
export interface MailReplyTarget {
  from: string
  to: string
  subject: string
  text: string
}

export const useMailStore = defineStore('mail', () => {
  const settings = useSettingsStore()

  /** 配齐了的账户（清单里半截配置的连不了，不进这份） */
  const accounts = computed<MailAccount[]>(() => settings.settings.mailAccounts.filter(mailAccountReady))
  /** 一个配好的账户都没有 = 出口关闭；授权码在不在要到连的时候才知道（在凭据管理器里） */
  const configured = computed(() => accounts.value.length > 0)

  /** 按地址找账户的连接配置（账户删了 / 配置改了之后找不到，就干不了那件事） */
  function accountOf(address: string): MailAccount | undefined {
    return accounts.value.find(account => account.address === address)
  }

  // ---------- 文件夹（收件箱 / 已发送） ----------

  /** 现在在看哪个文件夹：清单、阅读栏、命令与缓存键都跟着它 */
  const folder = ref<MailFolder>('inbox')
  const folderLabel = computed(() => (folder.value === 'sent' ? '已发送' : '收件箱'))

  /**
   * 切文件夹：清单与阅读栏都换一份（正文缓存留着 —— 键里带了文件夹，切回来不用重下），
   * 立刻重拉。切的时候正在途中的那次拉取会被丢掉（见 refreshList 里的比对）。
   */
  function setFolder(next: MailFolder): void {
    if (folder.value === next)
      return
    folder.value = next
    closeMail()
    all.value = []
    listErrors.value = []
    void refreshList()
  }

  // ---------- 清单（当前文件夹、多账户合并） ----------

  /** 拉回来的全部摘要（不筛）；画在清单上的是 list 这份过滤后的视图 */
  const all = ref<MailListItem[]>([])
  /** 广告邮件要不要也画出来（底部那行「已略过 N 封推广」点开的开关，只在收件箱） */
  const showBulk = ref(false)
  const listLoading = ref(false)
  /** 每个拉取失败的账户一句话（其余账户的信照常显示） */
  const listErrors = ref<string[]>([])
  /**
   * 在途的那次拉取：并发调用共享同一个 Promise，而不是各自开一轮（通知点击
   *  与页面挂载可能前后脚各调一次 —— 共享才不会拿着旧清单去找刚到的那封）
   */
  let listInFlight: Promise<void> | null = null

  /** 用户右击「标记为广告」攒下的发件人黑名单（设置里的 mailBulkSenders） */
  const bulkSenders = computed(() => settings.settings.mailBulkSenders)

  /** 发件箱里不筛广告：那儿的「发件人」是自己，按发件人判广告毫无道理 */
  const isSent = computed(() => folder.value === 'sent')

  const list = computed(() =>
    isSent.value ? all.value : all.value.filter(item => !isBulkMail(item, bulkSenders.value)),
  )
  /**
   * 识别成推广 / 广告的那部分：**不进**上面的收件箱清单 —— 收进清单底部分开的一段
   *  （showBulk 控制那段折不折），展开也不与正常邮件混排。发件箱里永远是空的。
   */
  const bulkList = computed(() =>
    isSent.value ? [] : all.value.filter(item => isBulkMail(item, bulkSenders.value)),
  )
  const bulkCount = computed(() => bulkList.value.length)

  /** 一封在某个文件夹里的身份键 —— uid 只在单个文件夹里唯一，三个字段缺一不可 */
  function mailKey(folder: MailFolder, account: string, uid: number): string {
    return `${folder}/${account}/${uid}`
  }

  /**
   * 各账户并行各拉各的，合并成一份：每封打上来源账户，按头部日期新在前（不按来源
   * 分组 —— 看的就是一条时间线）；谁的失败只记谁的一句话，不挡别人。
   * 并发调用共享在途的那次（见 listInFlight）；拉的过程中切了文件夹，这批结果
   * 已经不是用户要看的那份了，丢掉不写进清单（切过去那次拉取会顶上）。
   */
  function refreshList(): Promise<void> {
    if (listInFlight)
      return listInFlight
    if (!configured.value) {
      all.value = []
      listErrors.value = []
      return Promise.resolve()
    }
    const requested = folder.value
    listLoading.value = true
    listErrors.value = []
    listInFlight = (async () => {
      const results = await Promise.all(
        accounts.value.map(async account => ({
          account,
          result: await fetchMailList(account, requested, MAIL_LIST_LIMIT),
        })),
      )
      if (requested !== folder.value)
        return
      const merged: MailListItem[] = []
      const errors: string[] = []
      for (const { account, result } of results) {
        if (result.ok && result.data) {
          for (const summary of result.data) {
            merged.push({
              ...summary,
              account: account.address,
              folder: requested,
              key: mailKey(requested, account.address, summary.uid),
            })
          }
        }
        else {
          errors.push(`「${account.address}」${result.error ?? `拉取${folderLabel.value}失败`}`)
        }
      }
      merged.sort((a, b) => mailTime(b.date) - mailTime(a.date))
      all.value = merged
      listErrors.value = errors
    })().finally(() => {
      listInFlight = null
      listLoading.value = false
    })
    return listInFlight
  }

  // ---------- 读信 ----------

  const active = ref<MailMessage | null>(null)
  /** 左侧高亮跟着它走：点击那一刻就切，不等右侧正文下载回来（active 才是内容） */
  const activeKey = ref<string | null>(null)
  const bodyLoading = ref(false)
  const bodyError = ref('')
  /** 正文按 (文件夹, 账户, uid) 缓存：一封信拉一次，翻回来不再下载（内含整份报文，页面上限几十封没问题） */
  const bodies = new Map<string, MailMessage>()

  /** 正文下载期间又点的那封：等当前这封完事接着开（只记最后一封，连点时中间的都是路过） */
  let queuedItem: MailListItem | null = null

  async function openMail(item: MailListItem): Promise<void> {
    activeKey.value = item.key
    const cached = bodies.get(item.key)
    if (cached) {
      active.value = cached
      return
    }
    if (bodyLoading.value) {
      queuedItem = item
      return
    }
    await loadBody(item)
    // 排队的那封接上去，但只在用户的最新点击仍是它时 —— 期间点了别的（缓存件就地打开）
    // 就把它丢掉，别把内容刷回旧目标
    const next = queuedItem
    queuedItem = null
    if (next && next.key !== item.key && activeKey.value === next.key)
      await openMail(next)
  }

  async function loadBody(item: MailListItem): Promise<void> {
    const account = accountOf(item.account)
    if (!account)
      return
    bodyLoading.value = true
    bodyError.value = ''
    // 已读标记只对收件箱发：发件箱里的信本来就是读过的，别白写一趟服务器
    const raw = await fetchMailBody(account, item.folder, item.uid, item.folder === 'inbox')
    if (!raw.ok || !raw.data) {
      bodyLoading.value = false
      bodyError.value = raw.error ?? '读取邮件失败'
      return
    }
    try {
      const parsed = await parseMessage(raw.data)
      const fromAddress = parsed.from?.address || senderAddress(item.from)
      const message: MailMessage = {
        account: item.account,
        folder: item.folder,
        key: item.key,
        uid: item.uid,
        subject: parsed.subject?.trim() || '(无主题)',
        fromText: parsed.from?.name || fromAddress || '(未知发件人)',
        fromAddress,
        toText: displayRecipients(item.to),
        toAddress: recipientAddress(item.to),
        dateText: displayDate(item.date),
        html: htmlBody(parsed),
        text: parsed.text,
        attachments: parsed.attachments,
      }
      bodies.set(item.key, message)
      // 下载期间用户又点了别的：这封只进缓存不换内容，高亮与内容保持同一封
      if (activeKey.value === item.key)
        active.value = message
      // 打开即已读（收件箱那边 Rust 顺手标了 \Seen），列表上的点就地跟上
      if (item.folder === 'inbox') {
        const summary = all.value.find(entry => entry.key === item.key)
        if (summary && !summary.seen)
          summary.seen = true
      }
    }
    catch (error) {
      bodyError.value = error instanceof Error ? error.message : '邮件解析失败'
    }
    bodyLoading.value = false
  }

  function closeMail(): void {
    active.value = null
    activeKey.value = null
  }

  /** 标记 / 取消已读。列表先就地改，服务器那边失败了再说（返回 Result 给调用方提示）。 */
  async function markSeen(
    target: { folder: MailFolder, account: string, uid: number },
    seen: boolean,
  ): Promise<Result<null>> {
    const config = accountOf(target.account)
    if (!config)
      return fail(`「${target.account}」的账户配置不在了`)
    const result = await setMailSeen(config, target.folder, target.uid, seen)
    if (result.ok) {
      const item = all.value.find(entry => entry.key === mailKey(target.folder, target.account, target.uid))
      if (item)
        item.seen = seen
    }
    return result
  }

  /** 正在删除的邮件（确认之后到服务器 EXPUNGE 回来之前）：行上画转圈、按住不让点 */
  const deletingKeys = ref<string[]>([])

  /**
   * 删一批（右键的「删除邮件」传一封，清单上方勾选条的「删除」传勾选的那几封）：
   * 按 (文件夹, 账户) 分组 —— 一个账户一条连接，把它的整批标 \Deleted 再 EXPUNGE
   * （找不回来，确认在视图层做过；uid 只在单个文件夹里唯一，分组得带上文件夹）。
   * 全程这些行处于「删除中」（变淡 + 转圈），删成的账户本地
   * 立刻跟上：清单摘掉、正文缓存扔掉、正在读的就地关掉 —— 不等下次刷新；
   * 某个账户失败只记它的一句话，其余账户照删。
   */
  async function deleteMails(items: ReadonlyArray<{ folder: MailFolder, account: string, uid: number }>): Promise<Result<null>> {
    const keyOf = (item: { folder: MailFolder, account: string, uid: number }): string =>
      mailKey(item.folder, item.account, item.uid)
    const pending = items.filter(item => !deletingKeys.value.includes(keyOf(item)))
    if (pending.length === 0)
      return ok(null)
    const keys = pending.map(keyOf)
    deletingKeys.value = [...deletingKeys.value, ...keys]

    const groups = new Map<string, { folder: MailFolder, account: string, uids: number[] }>()
    for (const item of pending) {
      const groupKey = `${item.folder}/${item.account}`
      const group = groups.get(groupKey) ?? { folder: item.folder, account: item.account, uids: [] }
      group.uids.push(item.uid)
      groups.set(groupKey, group)
    }
    const failures: string[] = []
    const done = new Set<string>()
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const config = accountOf(group.account)
        if (!config) {
          failures.push(`「${group.account}」的账户配置不在了，删不了`)
          return
        }
        const result = await deleteMailsOnServer(config, group.folder, group.uids)
        if (result.ok) {
          for (const uid of group.uids) done.add(mailKey(group.folder, group.account, uid))
        }
        else {
          failures.push(`「${group.account}」${result.error ?? '删除失败'}`)
        }
      }),
    )
    deletingKeys.value = deletingKeys.value.filter(key => !keys.includes(key))
    if (done.size) {
      all.value = all.value.filter(entry => !done.has(entry.key))
      for (const key of done) bodies.delete(key)
      if (active.value && done.has(active.value.key)) {
        active.value = null
        activeKey.value = null
      }
    }
    return failures.length ? fail(failures.join('；')) : ok(null)
  }

  /**
   * 右击「标记为广告」：发件人地址进黑名单（设置的 mailBulkSenders）——
   * 这个发件人**过去与将来**的信都算广告，清单立刻重筛（标记的这封马上消失、
   * 计入底部那行略过数）。落盘失败飘一条错误，黑名单以设置回推的为准。
   */
  async function markBulk(account: string, uid: number): Promise<void> {
    const item = all.value.find(entry => entry.account === account && entry.uid === uid)
    if (!item)
      return
    const address = senderAddress(item.from).toLowerCase()
    if (!address || bulkSenders.value.includes(address))
      return
    const updated = await settings.updateSettings({ mailBulkSenders: [...bulkSenders.value, address] })
    if (!updated)
      notifyError('标记失败')
  }

  /** 右击「取消广告标记」（对着黑名单里的发件人）：从黑名单里摘掉，信回到清单。 */
  async function unbulk(account: string, uid: number): Promise<void> {
    const item = all.value.find(entry => entry.account === account && entry.uid === uid)
    if (!item)
      return
    const address = senderAddress(item.from).toLowerCase()
    const next = bulkSenders.value.filter(entry => entry !== address)
    if (next.length === bulkSenders.value.length)
      return
    const updated = await settings.updateSettings({ mailBulkSenders: next })
    if (!updated)
      notifyError('取消标记失败')
  }

  // ---------- 发信 ----------

  const sending = ref(false)

  async function send(input: {
    /** 用哪个账户发（写信时用户挑，回信默认收信的那个） */
    from: string
    to: string[]
    subject: string
    text: string
    attachments?: MailAttachmentInput[]
  }): Promise<Result<null>> {
    const account = accountOf(input.from)
    if (!account)
      return fail('先在「账户」里把发件邮箱配好')
    if (sending.value)
      return fail('上一封还在发，等它跑完')
    sending.value = true
    try {
      const mime = buildMime({
        from: account.address,
        to: input.to,
        subject: input.subject,
        text: input.text,
        attachments: input.attachments,
      })
      const result = await sendMail(account, input.to, mime)
      // 发件箱正开着就顺手重拉一次 —— 服务器自己会把刚发的这封存进已发送
      // （应用不补 APPEND，补了会出两封，见 docs/modules/mail.md）。
      // 收件箱那边不打断：切到已发送时 setFolder 本来就会重拉。
      if (result.ok && isSent.value)
        void refreshList()
      return result
    }
    catch (error) {
      return fail(error instanceof Error ? error.message : '报文构建失败')
    }
    finally {
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
    activeKey.value = null
    void refreshList()
  }

  // ---------- 后台新邮件监视（系统通知） ----------

  /** 启动只做一次：登记 + 通知点击订阅都挂在这条上 */
  let watchStarted = false

  /**
   * 起后台监视（App.vue 挂载时调）：把配好的账户、广告黑名单与检查周期整份交给
   * Rust 的监视线程，之后任何一项变了就重登；系统通知被点时换到邮箱页、重拉清单、
   * 把通知里那封打开（唤出窗口是 Rust 做的，这里只管页面内的事）。
   */
  function startWatch(): void {
    if (watchStarted)
      return
    watchStarted = true

    // 用内容签名而不是引用比对：设置里任何一项改动都会换掉 settings 对象，
    // 按引用比会每次都重新登记一遍
    let signature = ''
    watch(
      () =>
        JSON.stringify({
          accounts: accounts.value,
          bulk: bulkSenders.value,
          poll: settings.settings.mailPollMinutes,
        }),
      (next) => {
        if (next === signature)
          return
        signature = next
        void registerMailWatch(accounts.value, bulkSenders.value, settings.settings.mailPollMinutes)
      },
      { immediate: true },
    )

    // 浏览器预览下没有后端，订阅退化成空操作（与 settings.ts 的 setAppName 同一防御）
    window.workbench?.onMailNotifyClick(({ account, uid }) => {
      const nav = useNavStore()
      void nav.setActiveView('mail').then(async () => {
        // 通知说的永远是收件箱里的事：用户正看着发件箱也先切回收件箱（切了会自己重拉）
        setFolder('inbox')
        await refreshList()
        const item = all.value.find(entry => entry.key === mailKey('inbox', account, uid))
        if (item)
          void openMail(item)
      })
    })
  }

  /** 发件人展示名：列表与阅读栏共用同一套解码（@workbench/mail 的 displaySender） */
  function senderText(raw: string): string {
    return displaySender(raw)
  }

  return {
    accounts,
    configured,
    folder,
    folderLabel,
    setFolder,
    list,
    bulkList,
    bulkSenders,
    bulkCount,
    showBulk,
    deletingKeys,
    listLoading,
    listErrors,
    active,
    activeKey,
    bodyLoading,
    bodyError,
    sending,
    refreshList,
    openMail,
    closeMail,
    markSeen,
    deleteMails,
    markBulk,
    unbulk,
    send,
    downloadAttachment,
    invalidate,
    startWatch,
    senderText,
  }
})
