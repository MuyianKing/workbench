// ! 邮箱账户配置的形状与收敛。落盘进 workbench-data.json（行为配置，不属于外观 ——
// ! 判据见 ipc-and-state.md），授权码不在这里 —— 那条进 Windows 凭据管理器（Rust 侧）。
// !
// ! 账户是一份清单（可同时配多个，收件箱合并成一份按时间排），服务器地址用户只填一次：
// ! 地址后缀认得出 163 / 126 / QQ 就自动带出官方的收发服务器（见 `presetForAddress`），
// ! 认不出就留空等用户填 —— 支持任意 IMAP/SMTP 服务器。清单为空 = 这条出口整体关闭，
// ! 与 weatherCity 的口径一致。

/** 一个邮箱账户的连接配置。授权码另存（凭据管理器，按地址一条），这里只有非敏感的连接参数。 */
export interface MailAccount {
  /** 邮箱地址；账户清单里它就是身份 */
  address: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
}

/**
 * 邮箱页能看的两个文件夹。**服务器上的文件夹名不在这里** —— 网易把「已发送」报成
 * modified UTF-7 的 `&XfJT0ZAB-`、腾讯报成 `Sent Messages`，认名字是 Rust 侧的活
 * （mail.rs 的 `pick_sent_mailbox`：先认 `\Sent` 特殊用途属性，再按候选名比）。
 * 渲染层只说这两个逻辑名，uid 只在单个文件夹里唯一，所以到处都得带上它。
 */
export type MailFolder = 'inbox' | 'sent'

export const MAIL_ADDRESS_MAX = 80
export const MAIL_HOST_MAX = 100
/** 账户清单的上限：个人邮箱攒不到这个数，只防手改数据文件塞进一大坨 */
export const MAIL_ACCOUNTS_MAX = 5

/**
 * 常见邮箱域名的官方服务器。认不出后缀的地址（含自定义域邮箱）就自己填。
 *  foxmail.com 的邮箱也是腾讯这套收发服务器（与 QQ 邮箱同一把授权码）。
 */
const HOST_PRESETS: Record<string, { imapHost: string, imapPort: number, smtpHost: string, smtpPort: number }> = {
  '163.com': { imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465 },
  '126.com': { imapHost: 'imap.126.com', imapPort: 993, smtpHost: 'smtp.126.com', smtpPort: 465 },
  'qq.com': { imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465 },
  'foxmail.com': { imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465 },
}

/** 按地址后缀查官方服务器预设；认不出返回 null。 */
export function presetForAddress(address: string): { imapHost: string, imapPort: number, smtpHost: string, smtpPort: number } | null {
  const domain = address.trim().toLowerCase().split('@')[1] ?? ''
  return HOST_PRESETS[domain] ?? null
}

/** 邮箱地址：trim、小写、限长。没有 @ 就当没填（返回空串）。 */
export function sanitizeMailAddress(raw: unknown): string {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
    .slice(0, MAIL_ADDRESS_MAX)
  return value.includes('@') ? value : ''
}

/**
 * 服务器主机名：去掉粘贴带进来的协议头与路径，压成干净的主机名。端口不在这一步拆 ——
 *  它是独立的数字字段，混在主机串里说明填错了，照实保留主机、端口交回退值。
 */
export function sanitizeMailHost(raw: unknown): string {
  let text = String(raw ?? '').trim()
  const scheme = text.indexOf('://')
  if (scheme >= 0)
    text = text.slice(scheme + 3)
  const slash = text.search(/[/\\]/)
  if (slash >= 0)
    text = text.slice(0, slash)
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, MAIL_HOST_MAX)
}

/** 端口：整数，0 = 没填。 */
export function sanitizeMailPort(raw: unknown): number {
  const value = Math.floor(Number(raw))
  if (!Number.isFinite(value) || value <= 0 || value > 65535)
    return 0
  return value
}

/** 整份账户配置的收敛：字段逐个过、主机留空就按地址后缀补预设。 */
export function sanitizeMailAccount(value: unknown): MailAccount {
  const raw = (value ?? {}) as Partial<Record<keyof MailAccount, unknown>>
  const account: MailAccount = {
    address: sanitizeMailAddress(raw.address),
    imapHost: sanitizeMailHost(raw.imapHost),
    imapPort: sanitizeMailPort(raw.imapPort),
    smtpHost: sanitizeMailHost(raw.smtpHost),
    smtpPort: sanitizeMailPort(raw.smtpPort),
  }
  const preset = presetForAddress(account.address)
  if (preset) {
    if (!account.imapHost)
      account.imapHost = preset.imapHost
    if (!account.imapPort)
      account.imapPort = preset.imapPort
    if (!account.smtpHost)
      account.smtpHost = preset.smtpHost
    if (!account.smtpPort)
      account.smtpPort = preset.smtpPort
  }
  return account
}

/** 这套配置齐不齐（齐了才值得去连 —— 授权码在不在是另一回事，在凭据管理器里）。 */
export function mailAccountReady(account: MailAccount): boolean {
  return Boolean(
    account.address.includes('@') && account.imapHost && account.imapPort && account.smtpHost && account.smtpPort,
  )
}

/**
 * 整份账户清单的收敛：逐个过 sanitizeMailAccount，没有地址的（没填完的半截）丢掉、
 *  按地址去重、超上限截断。清单为空 = 出口关闭。
 */
export function sanitizeMailAccounts(value: unknown): MailAccount[] {
  if (!Array.isArray(value))
    return []
  const seen = new Set<string>()
  const accounts: MailAccount[] = []
  for (const item of value) {
    const account = sanitizeMailAccount(item)
    if (!account.address || seen.has(account.address))
      continue
    seen.add(account.address)
    accounts.push(account)
    if (accounts.length >= MAIL_ACCOUNTS_MAX)
      break
  }
  return accounts
}

/** 后台新邮件检查的周期（分钟）：0 = 关闭。 */
export const MAIL_POLL_OFF = 0
/** 默认周期：30 分钟。 */
export const MAIL_POLL_DEFAULT = 30
/** 下限：每一轮都是一条全新的 IMAP 连接，一分钟已是能接受的最密节奏。 */
export const MAIL_POLL_MIN = 1
/** 上限：24 小时（再长不如直接关掉）。 */
export const MAIL_POLL_MAX = 1440

/** 后台检查周期的收敛：非数字回默认，0 = 关闭，其余夹进 1..1440（四舍五入取整）。 */
export function sanitizeMailPollMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return MAIL_POLL_DEFAULT
  const minutes = Math.round(value)
  if (minutes === MAIL_POLL_OFF)
    return MAIL_POLL_OFF
  return Math.min(MAIL_POLL_MAX, Math.max(MAIL_POLL_MIN, minutes))
}
