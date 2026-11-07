import type { ProjectStatus, TerminalKind } from '@/types'
import { creditExpiry, creditExpiryDate, soonestExpiry } from '@workbench/usage'
import { formatTimestamp } from '@/format'

/**
 * 项目状态 → 文案与色带的唯一映射。
 *
 * 这份表原先在 ProjectCard / RecentPanel / ProjectDrawer / TerminalPanel 各抄了一遍，
 * 新增一个状态要改四处，漏一处就会出现「卡片说打包中、抽屉说空闲」这类不一致。
 * tone 对应全局样式里的 `--st-<tone>` 变量。
 *
 * `success` 的文案在这里是最中性的那份（命令跑完了），「打包成功」要由 statusLabel 按
 * 命令类型补上 —— 直接取这张表的 label 只会得到「已结束」，不会把启动说成打包。
 */
export const STATUS_META: Record<ProjectStatus, { label: string, tone: string }> = {
  idle: { label: '空闲', tone: 'idle' },
  installing: { label: '安装中', tone: 'run' },
  running: { label: '运行中', tone: 'run' },
  building: { label: '打包中', tone: 'run' },
  success: { label: '已结束', tone: 'ok' },
  failed: { label: '执行失败', tone: 'fail' },
}

/**
 * 状态文案。
 *
 * 只有**打包**正常退出才叫「打包成功」。启动 / 安装 / 自定义命令退出码同样是 0 时，
 * 只说明那条命令自己跑完了 —— 启动的往往还是个包装命令（`npm run dev` 之下还有
 * `tauri dev`、`beforeDevCommand`），dev server 有没有起来它答不了，说成「打包成功」
 * 既不对又误导。`kind` 缺省时按中性文案走（老运行态、外部探测出来的运行态都没有它）。
 */
export function statusLabel(status: ProjectStatus, kind?: TerminalKind): string {
  if (status === 'success' && kind === 'build')
    return '打包成功'
  return STATUS_META[status].label
}

export function statusTone(status: ProjectStatus): string {
  return STATUS_META[status].tone
}

/** 文案 + 色带。色带只看状态（绿=正常退出），文案还要看是哪类命令 */
export function statusMeta(status: ProjectStatus, kind?: TerminalKind): { label: string, tone: string } {
  return { label: statusLabel(status, kind), tone: STATUS_META[status].tone }
}

/** 忙碌（安装 / 打包）时卡片与抽屉都不允许再次触发命令 */
export function isBusyStatus(status: ProjectStatus): boolean {
  return status === 'installing' || status === 'building'
}

/**
 * 「命令」卡片的状态文案。
 *
 * 状态机与项目共用，但一条命令只有「在跑 / 没跑 / 退出了」这三种结果，
 * 用项目那套说法（空闲、打包成功）都不贴切，所以单独给一份文案；色带仍取 STATUS_META。
 */
export function commandStatusLabel(status: ProjectStatus): string {
  if (status === 'running')
    return '运行中'
  if (status === 'failed')
    return '已退出'
  return '未运行'
}

// ---------- 网关账号池（TBuddy 与 Qoder 两页共用） ----------
//
// 账号卡的状态机、余额条、临期提示原先在 GatewayView 与 QoderView 各抄一份，
// 已经开始漂移（「待续期」vs「待登录」是文案差异，`state-*` vs `is-*` 是类名分叉）。
// 收成这一份之后两页同一套口径；两套账号各自的字段（组织名 / 套餐 / 备注）留在卡上，
// 进来的只有状态机真正要读的那几样。

/** 两套网关账号共有的形状（`GatewayAccount` 与 `QoderAccount` 都满足） */
export interface PoolAccountShape {
  enabled: boolean
  ready: boolean
  quotaExhausted: boolean
  quotaResetsAt: number | null
  modelQuotas: { model: string, resetsAt: number }[]
}

/** 积分快照共有的形状（余额条只看这两个数） */
export interface PoolCreditsShape {
  remain: number
  size: number
}

/** 余额数字：整数直写，带零头给两位（统计卡 / 临期提示同一套） */
export function poolBalanceText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** 余额条的宽度（0..100） */
export function poolRemainPercent(credits: PoolCreditsShape): number {
  if (credits.size <= 0)
    return 0
  return Math.min(100, Math.max(0, (credits.remain / credits.size) * 100))
}

/** 余额条的底色：≥50% 绿、20–50% 琥珀、<20% 红；总量未知时不上色 */
export function poolMeterTone(credits: PoolCreditsShape): string {
  if (credits.size <= 0)
    return ''
  const percent = credits.remain / credits.size * 100
  if (percent < 20)
    return 'is-fail'
  if (percent < 50)
    return 'is-warn'
  return 'is-ok'
}

/** 整号的额度标记（余额 / 积分用完）：这个号暂时整个不可用 */
export function poolQuotaActive(account: PoolAccountShape): boolean {
  return account.enabled && account.ready && account.quotaExhausted
}

/**
 * 按模型的额度标记（上游按模型限流）：只挡这几个模型，号本身还能用别的模型。
 * 与整号标记分开 —— 拿它去算「可用 / 额度用完」会让一个还能用的号被算成下线。
 */
export function poolModelQuotaActive(account: PoolAccountShape): boolean {
  return account.enabled && account.ready && account.modelQuotas.length > 0
}

/** 状态标签：停用 → 待续期 / 待登录 → 额度用完 → 部分模型用完 → 可用 */
export function poolStatusText(account: PoolAccountShape, options: { readyLabel: string }): string {
  if (!account.enabled)
    return '已停用'
  if (!account.ready)
    return options.readyLabel
  if (poolQuotaActive(account))
    return '额度用完'
  return poolModelQuotaActive(account) ? '部分模型用完' : '可用'
}

/** 卡面状态色：只表达状态，不做装饰 */
export function poolStatusTone(account: PoolAccountShape): string {
  if (!account.enabled)
    return 'is-fail'
  if (!account.ready)
    return 'is-muted'
  return poolQuotaActive(account) || poolModelQuotaActive(account) ? 'is-warn' : 'is-ok'
}

/** 额度用完时状态下面那行小字：整号只写恢复时间，按模型的写「模型 + 时间」，还有别的模型就用个数收尾 */
export function poolQuotaHint(account: PoolAccountShape): string {
  if (!account.enabled || !account.ready)
    return ''
  if (poolQuotaActive(account))
    return account.quotaResetsAt ? `${formatTimestamp(account.quotaResetsAt * 1000)} 恢复` : ''
  if (!account.modelQuotas.length)
    return ''
  const [first, ...rest] = account.modelQuotas
  const head = `${first.model} ${formatTimestamp(first.resetsAt * 1000)} 恢复`
  return rest.length ? `${head}（另 ${rest.length} 个模型）` : head
}

/** 临期提示读的快照形状：两套 Credits 都能给出这几样 */
export interface PoolExpirySnapshot {
  packages: { name: string, remain: number, expiresAt: number | null, noExpiry?: boolean, available?: boolean }[]
  /** TBuddy 的企业额度标记（到期文案变成「周期结束回满」） */
  enterprise?: boolean
  /** Qoder 的团队号标记（同上，且个体包没有自己的到期） */
  team?: boolean
}

/**
 * 账号卡行尾那枚临期天数：取还花得出去、到期最近的那个包。
 *
 * 卡上只答一个问题 —— 这个号该先花哪一批；逐包的到期在弹层里。
 * 无期限 / 到期未知 / 已过期 / 已花光都不占位（与弹层那些灰档同一口径：不催动作）。
 * 天数按 UTC+8 自然日（`creditExpiry`），所以和弹层里同一个包的标签一致。
 * 每次都按当前时刻重算，不读快照里的 `earliestExpiring` —— 后者是查询那一刻算的。
 *
 * Qoder 侧只看 `available` 的包、团队号没有个体到期 —— 用 `onlyAvailable` 开关
 * 与 `team` 标记表达；TBuddy 的包不过滤、企业只影响文案。两边同一个实现。
 */
export function poolExpiryHint(
  snapshot: PoolExpirySnapshot | undefined,
  options: { onlyAvailable?: boolean } = {},
): { text: string, title: string } | null {
  if (!snapshot)
    return null
  const now = Math.floor(Date.now() / 1000)
  const packs = snapshot.packages
    .filter(item => !options.onlyAvailable || item.available === true)
    .map(item => ({ ...item, noExpiry: Boolean(snapshot.team) || item.expiresAt === null }))
  const pack = soonestExpiry(packs, now)
  if (!pack || pack.expiresAt === null)
    return null
  const verdict = creditExpiry(pack, now, { enterprise: Boolean(snapshot.enterprise ?? snapshot.team) })
  const days = verdict.days ?? 0
  return {
    text: verdict.tier === 'today' ? '今日到期' : `${days} 天后到期`,
    title: `最早到期：${pack.name} 还剩 ${poolBalanceText(pack.remain)}，${creditExpiryDate(pack.expiresAt)} 作废`,
  }
}
