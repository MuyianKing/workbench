//! 邮箱账户配置的形状与收敛。落盘进 workbench-data.json（行为配置，不属于外观 ——
//! 判据见 ipc-and-state.md），授权码不在这里 —— 那条进 Windows 凭据管理器（Rust 侧）。
//!
//! 服务器地址用户只填一次：地址后缀认得出 163 / 126 就自动带出官方的收发服务器
//! （见 `presetForAddress`），认不出就留空等用户填 —— 支持任意 IMAP/SMTP 服务器。
//! 地址留空 = 这条出口整体关闭，与 weatherCity 的口径一致。

/** 一个邮箱账户的连接配置。授权码另存（凭据管理器），这里只有非敏感的连接参数。 */
export interface MailAccount {
  /** 邮箱地址；留空 = 出口关闭 */
  address: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
}

export const MAIL_ADDRESS_MAX = 80
export const MAIL_HOST_MAX = 100

/** 常见网易域名的官方服务器。认不出后缀的地址（含自定义域邮箱）就自己填。 */
const HOST_PRESETS: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  '163.com': { imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465 },
  '126.com': { imapHost: 'imap.126.com', imapPort: 993, smtpHost: 'smtp.126.com', smtpPort: 465 }
}

/** 按地址后缀查官方服务器预设；认不出返回 null。 */
export function presetForAddress(address: string): { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number } | null {
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

/** 服务器主机名：去掉粘贴带进来的协议头与路径，压成干净的主机名。端口不在这一步拆 ——
 *  它是独立的数字字段，混在主机串里说明填错了，照实保留主机、端口交回退值。 */
export function sanitizeMailHost(raw: unknown): string {
  let text = String(raw ?? '').trim()
  const scheme = text.indexOf('://')
  if (scheme >= 0) text = text.slice(scheme + 3)
  const slash = text.search(/[/\\]/)
  if (slash >= 0) text = text.slice(0, slash)
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, MAIL_HOST_MAX)
}

/** 端口：整数，0 = 没填。 */
export function sanitizeMailPort(raw: unknown): number {
  const value = Math.floor(Number(raw))
  if (!Number.isFinite(value) || value <= 0 || value > 65535) return 0
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
    smtpPort: sanitizeMailPort(raw.smtpPort)
  }
  const preset = presetForAddress(account.address)
  if (preset) {
    if (!account.imapHost) account.imapHost = preset.imapHost
    if (!account.imapPort) account.imapPort = preset.imapPort
    if (!account.smtpHost) account.smtpHost = preset.smtpHost
    if (!account.smtpPort) account.smtpPort = preset.smtpPort
  }
  return account
}

/** 这套配置齐不齐（齐了才值得去连 —— 授权码在不在是另一回事，在凭据管理器里）。 */
export function mailAccountReady(account: MailAccount): boolean {
  return Boolean(
    account.address.includes('@') && account.imapHost && account.imapPort && account.smtpHost && account.smtpPort
  )
}
