<script setup lang="ts">
import type { GatewayUsageSummary } from '@workbench/usage'
import type { GatewayCredits, GatewayUsageRow } from '@/workbench/gateway'
import type { QoderAccount, QoderCredits, QoderEarningPoint, QoderHeatmapPoint, QoderModelInfo, QoderStatus, QoderTaskSnapshot } from '@/workbench/qoder'
import { Calendar, Coin, Cpu, Histogram, MagicStick, Plus, Refresh, User } from '@element-plus/icons-vue'
import { creditExpiry, creditExpiryDate, dailyCreditSeries, gatewayBucketUnit, GROWTH_CREDIT_DAYS, soonestExpiry, summarizeGatewayRows } from '@workbench/usage'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import AccessDialog from '@/components/gateway/AccessDialog.vue'
import AccountTransferDialog from '@/components/gateway/AccountTransferDialog.vue'
import CreditsDialog from '@/components/gateway/CreditsDialog.vue'
import GatewayTable from '@/components/gateway/GatewayTable.vue'
import GatewayTabs from '@/components/gateway/GatewayTabs.vue'
import PerksCreditsChart from '@/components/gateway/PerksCreditsChart.vue'
import UsagePane from '@/components/gateway/UsagePane.vue'
import { formatTimestamp } from '@/format'
import { qoderUsageRows } from '@/workbench/qoder'

/**
 * Qoder 网关页（国内版）。
 *
 * 与 TBuddy 页同构：页签靠左、状态与启停靠右；账号 / 用量 / 请求 / 福利 / 模型五栏。
 * 端口、密钥与随程序启动各自独立（17878 / 17879），两个代理可以同时跑。
 * 用量栏直接复用 TBuddy 的 UsagePane（`:load-rows` / `:load-names` 注入 Qoder 自己的取数），
 * 布局与统计口径跟那一页完全一致。
 */
/** 页签（顺序即显示顺序） */
const TABS = [
  { label: '账号', value: 'accounts' },
  { label: '用量', value: 'usage' },
  { label: '请求', value: 'requests' },
  { label: '福利', value: 'perks' },
  { label: '模型', value: 'models' },
] as const

/** 请求栏的条件：条数 / 结果 / 关键字（与 TBuddy 的请求栏同一套选项） */
const REQUEST_LIMITS = [
  { label: '最近 50 条', value: 50 },
  { label: '最近 100 条', value: 100 },
  { label: '最近 200 条', value: 200 },
] as const
const REQUEST_RESULTS = [
  { label: '全部结果', value: 'all' },
  { label: '只看成功', value: 'ok' },
  { label: '只看失败', value: 'fail' },
] as const

const tab = ref<'accounts' | 'perks' | 'usage' | 'requests' | 'models'>('accounts')
const status = ref<QoderStatus | null>(null)
const accounts = ref<QoderAccount[]>([])
const credits = ref<Record<string, QoderCredits>>({})
const models = ref<QoderModelInfo[]>([])
const access = ref<{ baseUrl: string, apiKey: string, models: string[] } | null>(null)
const accessOpen = ref(false)
/** 账号导出 / 导入弹层：两个模式共用一个实例，`transferMode` 决定打开哪个 */
const transferOpen = ref(false)
const transferMode = ref<'export' | 'import'>('export')
const port = ref(17879)
const busy = ref(false)
const loggingIn = ref(false)
const loginHint = ref('')
const creditBusy = ref<Record<string, boolean>>({})
const modelsBusy = ref(false)

const recent = ref<GatewayUsageRow[]>([])
const requestLimit = ref(100)
const requestResult = ref<'all' | 'ok' | 'fail'>('all')
const requestKeyword = ref('')
const requestsLoading = ref(false)
const taskSnapshots = ref<QoderTaskSnapshot[]>([])
const heatmap = ref<QoderHeatmapPoint[]>([])
const earnings = ref<QoderEarningPoint[]>([])
const earningsLoading = ref(false)
const earningsError = ref('')
const perksBusy = ref(false)
const accountUsage = ref<GatewayUsageSummary | null>(null)
const creditsOpen = ref(false)
const creditsUid = ref('')
let earningsSeq = 0
let earningsPullAt = 0
let earningsPushed = false

let pollTimer: ReturnType<typeof setInterval> | null = null
let loginTimer: ReturnType<typeof setInterval> | null = null
let creditAt = 0

const running = computed(() => status.value?.running === true)
const baseUrl = computed(() => access.value?.baseUrl ?? status.value?.baseUrl ?? `http://127.0.0.1:${port.value}/v1`)
const apiKey = computed(() => access.value?.apiKey ?? '')
const creditsBusy = computed(() => Object.values(creditBusy.value).some(Boolean))
/** 顶部「签到」只跑今天还没签、上游状态是 CLAIMABLE 的号；其余号一个请求都不发 */
const checkinTargets = computed(() => taskSnapshots.value.filter(item => !item.checkin.todayCheckedIn && item.checkin.status === 'CLAIMABLE'))
/** 顶部「领取活动」只跑还有 CLAIMABLE 活动的号；全都领过就一个请求都不发 */
const claimTargets = computed(() => taskSnapshots.value.filter(item => item.campaigns.some(campaign => campaign.status === 'CLAIMABLE')))

/** 打开账号导出 / 导入弹层（同一个实例，切模式） */
function openTransfer(mode: 'export' | 'import'): void {
  transferMode.value = mode
  transferOpen.value = true
}

async function refresh(): Promise<void> {
  const [statusResult, accountResult, accessResult] = await Promise.all([
    window.workbench.qoderStatus(),
    window.workbench.qoderAccounts(),
    window.workbench.qoderAccess(),
  ])
  if (statusResult.ok && statusResult.data) {
    status.value = statusResult.data
    // 弹层里正在改端口时不要被轮询覆盖
    if (!accessOpen.value)
      port.value = statusResult.data.port
  }
  if (accountResult.ok && accountResult.data)
    accounts.value = accountResult.data
  if (accessResult.ok && accessResult.data)
    access.value = accessResult.data
}

async function enter(): Promise<void> {
  await refresh()
  await Promise.all([loadModels(), loadCredits(), loadRecent(), loadAccountUsage()])
}

/** 账号卡底部三格（成功 / 失败、用量、均速）：与 TBuddy 一样取最近 30 天流水 */
async function loadAccountUsage(): Promise<void> {
  const result = await window.workbench.qoderUsageRows(30)
  if (result.ok && result.data)
    accountUsage.value = summarizeGatewayRows(result.data.rows, gatewayBucketUnit(30))
}

async function loadModels(): Promise<void> {
  const result = await window.workbench.qoderModels()
  if (result.ok && result.data)
    models.value = result.data
}

async function refreshModels(): Promise<void> {
  modelsBusy.value = true
  const result = await window.workbench.qoderModelsRefresh()
  modelsBusy.value = false
  if (result.ok && result.data) {
    models.value = result.data
    ElMessage.success(`已拉取 ${result.data.length} 个模型`)
  }
  else {
    ElMessage.error(result.error ?? '拉取模型目录失败')
  }
}

async function loadCredits(): Promise<void> {
  if (Date.now() - creditAt < 60_000)
    return
  creditAt = Date.now()
  for (const account of accounts.value) {
    if (!account.enabled)
      continue
    void queryCredits(account.uid)
  }
}

/** 右下角「刷新积分」：跳过一分钟节流，把可用账号各查一遍 */
function refreshCredits(): void {
  creditAt = 0
  void loadCredits()
}

async function queryCredits(uid: string): Promise<void> {
  creditBusy.value = { ...creditBusy.value, [uid]: true }
  const result = await window.workbench.qoderCredits(uid)
  creditBusy.value = { ...creditBusy.value, [uid]: false }
  if (result.ok && result.data) {
    credits.value = { ...credits.value, [uid]: result.data }
    if (result.data.error)
      ElMessage.warning(`${uid.slice(0, 8)}：${result.data.error}`)
  }
  else {
    ElMessage.error(result.error ?? '查询积分失败')
  }
}

async function toggleRun(): Promise<void> {
  busy.value = true
  if (running.value) {
    const result = await window.workbench.qoderStop()
    if (!result.ok)
      ElMessage.error(result.error ?? '停止失败')
  }
  else {
    const result = await window.workbench.qoderStart(port.value)
    if (result.ok && result.data)
      ElMessage.success(`Qoder 网关已在 ${result.data} 端口启动`)
    else
      ElMessage.error(result.error ?? '启动失败')
  }
  busy.value = false
  await refresh()
}

async function startLogin(): Promise<void> {
  if (loggingIn.value)
    return
  const result = await window.workbench.qoderLoginStart()
  if (!result.ok || !result.data) {
    ElMessage.error(result.error ?? '发起登录失败')
    return
  }
  const { state: loginState, authUrl } = result.data
  const opened = await window.workbench.openExternal(authUrl)
  if (!opened.ok)
    ElMessage.error(opened.error ?? '打开浏览器失败')
  loggingIn.value = true
  loginHint.value = '等待浏览器完成 Qoder 授权…'
  loginTimer = setInterval(async () => {
    const poll = await window.workbench.qoderLoginPoll(loginState)
    if (!poll.ok || !poll.data) {
      stopLogin()
      ElMessage.error(poll.error ?? '轮询登录失败')
      return
    }
    if (poll.data.status === 'pending') {
      loginHint.value = poll.data.message
      return
    }
    stopLogin()
    if (poll.data.status === 'ok') {
      loginHint.value = ''
      ElMessage.success('Qoder 账号已添加')
      await enter()
    }
    else {
      ElMessage.error(poll.data.message)
    }
  }, 2000)
}

function stopLogin(): void {
  loggingIn.value = false
  if (loginTimer) {
    clearInterval(loginTimer)
    loginTimer = null
  }
}

async function toggleAccount(account: QoderAccount): Promise<void> {
  const result = await window.workbench.qoderAccountSet(account.uid, !account.enabled)
  if (!result.ok)
    ElMessage.error(result.error ?? '修改账号失败')
  await refresh()
}

async function changePriority(account: QoderAccount, value: number | undefined): Promise<void> {
  if (value === undefined)
    return
  const result = await window.workbench.qoderAccountPriority(account.uid, value)
  if (!result.ok)
    ElMessage.error(result.error ?? '修改优先级失败')
  await refresh()
}

async function removeAccount(account: QoderAccount): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除账号「${account.label}」？只删本地凭证，不影响 Qoder 账号本身。`, '删除账号', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  }
  catch {
    return
  }
  const result = await window.workbench.qoderAccountDelete(account.uid)
  if (!result.ok)
    ElMessage.error(result.error ?? '删除失败')
  await refresh()
}

async function rotateKey(): Promise<void> {
  const result = await window.workbench.qoderRotateKey()
  if (result.ok && result.data) {
    ElMessage.success('Qoder 密钥已更新（只影响 Qoder）')
    await refresh()
  }
  else {
    ElMessage.error(result.error ?? '重新生成密钥失败')
  }
}

async function loadRecent(): Promise<void> {
  requestsLoading.value = true
  const result = await window.workbench.qoderUsageRecent(requestLimit.value)
  requestsLoading.value = false
  // 流水是旧→新，翻成新→旧；条数与筛选都在前端做，换条件不必再打一次后端
  if (result.ok && result.data)
    recent.value = result.data.slice().reverse()
}

/** UsagePane 的账号名入口：它只要 uid → 名字，不要 Result 外壳（与 TBuddy 的适配层同形） */
async function loadQoderNames(): Promise<Record<string, string>> {
  const result = await window.workbench.qoderAccountNames()
  return result.ok && result.data ? result.data : {}
}

async function loadPerks(): Promise<void> {
  pullEarnings()
  // 领取记录在本机，先跟签到状态并行读；热力图要联网，放到后面
  const [snapshots] = await Promise.all([
    window.workbench.qoderPerksStatus(),
    loadEarnings(),
  ])
  // 上一次会话里自动签到写下的行，进福利栏时补推一次
  publishEarnings()
  if (snapshots.ok && snapshots.data)
    taskSnapshots.value = snapshots.data
  const first = taskSnapshots.value.find(item => item.checkin?.ok)
  if (first) {
    const points = await window.workbench.qoderCreditHeatmap(first.uid)
    if (points.ok && points.data)
      heatmap.value = points.data
  }
}

/**
 * 本机领取记录 → 最近 30 天的每日获取序列。Rust 只回「有进账的日期」，
 * 补日历与窗口在 `dailyCreditSeries`（与 TBuddy 的福利柱状图同一条口径）。
 */
async function loadEarnings(): Promise<void> {
  const seq = ++earningsSeq
  if (!accounts.value.length) {
    earnings.value = []
    earningsError.value = ''
    return
  }
  earningsLoading.value = true
  try {
    const result = await window.workbench.qoderEarnings(GROWTH_CREDIT_DAYS)
    if (seq !== earningsSeq)
      return
    if (!result.ok || !result.data) {
      earnings.value = []
      earningsError.value = result.error ?? '读取积分获取记录失败'
      return
    }
    earnings.value = result.data
    earningsError.value = ''
  }
  finally {
    if (seq === earningsSeq)
      earningsLoading.value = false
  }
}

/** 进福利栏先补拉一次别的设备推上来的账本（一分钟节流），读完重读 */
function pullEarnings(): void {
  if (Date.now() - earningsPullAt < 60_000)
    return
  earningsPullAt = Date.now()
  void window.workbench.qoderEarningsPull().then((result) => {
    if (result.ok)
      void loadEarnings()
  })
}

/** 把本机领取记录推进同步仓库：一次会话最多主动推一次，领完再强制推一次 */
function publishEarnings(force = false): void {
  if (earningsPushed && !force)
    return
  earningsPushed = true
  void window.workbench.qoderEarningsPublish()
}

/**
 * 顶部「签到」：只对还能签的号逐个跑。已经签过、活动未开放的号直接跳过，
 * 一个请求都不发（`checkinTargets` 按快照判断）。串行是为了不和账号文件的写回抢。
 */
async function checkinAll(): Promise<void> {
  if (perksBusy.value)
    return
  if (!checkinTargets.value.length) {
    ElMessage.info('今天没有可签到的账号')
    return
  }
  perksBusy.value = true
  let ok = 0
  let failed = 0
  let credits = 0
  try {
    for (const item of checkinTargets.value) {
      const result = await window.workbench.qoderCheckin(item.uid)
      if (result.ok && result.data) {
        ok += 1
        credits += result.data.rewardCredits
      }
      else {
        failed += 1
      }
    }
  }
  finally {
    perksBusy.value = false
  }
  const summary = `签到完成 ${ok} 个账号${credits > 0 ? `，新增 ${credits} 积分` : ''}`
  if (failed > 0)
    ElMessage.warning(`${summary}；${failed} 个失败`)
  else
    ElMessage.success(summary)
  publishEarnings(true)
  await Promise.all([loadPerks(), loadCredits()])
  creditAt = Date.now()
}

/**
 * 顶部「领取活动」：只对还有 CLAIMABLE 活动的号逐个跑。
 * 全都领过的号不进入 `claimTargets`，连活动列表都不去读。
 */
async function claimAll(): Promise<void> {
  if (perksBusy.value)
    return
  if (!claimTargets.value.length) {
    ElMessage.info('没有可领取的活动')
    return
  }
  perksBusy.value = true
  let ok = 0
  let failed = 0
  let credits = 0
  try {
    for (const item of claimTargets.value) {
      const result = await window.workbench.qoderClaimCampaigns(item.uid)
      if (result.ok && result.data) {
        ok += 1
        credits += result.data.rewardCredits
      }
      else {
        failed += 1
      }
    }
  }
  finally {
    perksBusy.value = false
  }
  const summary = `领取完成 ${ok} 个账号${credits > 0 ? `，新增 ${credits} 积分` : ''}`
  if (failed > 0)
    ElMessage.warning(`${summary}；${failed} 个失败`)
  else
    ElMessage.success(summary)
  publishEarnings(true)
  await loadPerks()
}

function creditOf(uid: string): QoderCredits | null {
  return credits.value[uid] ?? null
}

function usageOf(uid: string) {
  return accountUsage.value?.byAccount.find(item => item.uid === uid)
}

/** 明细弹层在看哪个号（账号删掉后就是 null） */
const creditsAccount = computed(() => accounts.value.find(item => item.uid === creditsUid.value) ?? null)
const creditsDetail = computed(() => {
  const snapshot = creditsUid.value ? credits.value[creditsUid.value] : undefined
  return snapshot ? asGatewayCredits(snapshot) : null
})

function openCredits(account: QoderAccount): void {
  creditsUid.value = account.uid
  creditsOpen.value = true
}

/** 弹层里点「刷新」：只查这一个号，快照仍只有 `credits` 一份 */
async function refreshDetail(): Promise<void> {
  if (creditsUid.value)
    await queryCredits(creditsUid.value)
}

/** Qoder 的积分快照 → TBuddy 明细弹层认的形状（两边都按包列到期） */
function asGatewayCredits(snapshot: QoderCredits): GatewayCredits {
  return {
    remain: snapshot.remain,
    used: Math.max(0, snapshot.size - snapshot.remain),
    size: snapshot.size,
    enterprise: snapshot.team,
    updatedAt: snapshot.fetchedAt,
    earliestExpiring: null,
    packages: snapshot.packages
      .filter(item => item.available)
      .map(item => ({
        name: item.name,
        code: `${item.kind}-${item.name}`,
        grantReason: '',
        grantSource: '',
        remain: item.remain,
        used: item.used,
        size: item.size,
        expiresAt: item.expiresAt,
        // 团队额度是周期重置，不是作废；个人号没给到期日就是无期限
        noExpiry: snapshot.team || item.expiresAt === null,
        daysLeft: null,
      })),
  }
}

function remainPercent(value: QoderCredits): number {
  if (value.size <= 0)
    return 0
  return Math.min(100, Math.max(0, (value.remain / value.size) * 100))
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** 账号卡行尾那枚临期天数：取还花得出去、到期最近的包（与 TBuddy 同一口径） */
function expiryHint(account: QoderAccount): { text: string, title: string } | null {
  const snapshot = credits.value[account.uid]
  if (!snapshot)
    return null
  const now = Math.floor(Date.now() / 1000)
  const packs = snapshot.packages
    .filter(item => item.available)
    .map(item => ({ ...item, noExpiry: snapshot.team || item.expiresAt === null }))
  const pack = soonestExpiry(packs, now)
  if (!pack || pack.expiresAt === null)
    return null
  const verdict = creditExpiry(pack, now, { enterprise: snapshot.team })
  const days = verdict.days ?? 0
  return {
    text: verdict.tier === 'today' ? '今日到期' : `${days} 天后到期`,
    title: `最早到期：${pack.name} 还剩 ${number(pack.remain)}，${creditExpiryDate(pack.expiresAt)} 作废`,
  }
}

/** 余额条：≥50% 绿、20–50% 琥珀、<20% 红；总量未知时不上色 */
function meterClass(value: QoderCredits): string {
  if (value.size <= 0)
    return ''
  const percent = value.remain / value.size * 100
  if (percent < 20)
    return 'is-fail'
  if (percent < 50)
    return 'is-warn'
  return 'is-ok'
}

function quotaActive(account: QoderAccount): boolean {
  return account.enabled && account.ready && account.quotaExhausted
}

function modelQuotaActive(account: QoderAccount): boolean {
  return account.enabled && account.ready && account.modelQuotas.length > 0
}

/** 状态标签：停用 → 待登录 → 额度用完 → 部分模型用完 → 可用 */
function statusText(account: QoderAccount): string {
  if (!account.enabled)
    return '已停用'
  if (!account.ready)
    return '待登录'
  if (quotaActive(account))
    return '额度用完'
  return modelQuotaActive(account) ? '部分模型用完' : '可用'
}

/** 卡面状态色：只表达状态，不做装饰（与 TBuddy 账号卡同一套） */
function statusClass(account: QoderAccount): string {
  if (!account.enabled)
    return 'state-fail'
  if (!account.ready)
    return 'state-muted'
  return quotaActive(account) || modelQuotaActive(account) ? 'state-warn' : 'state-ok'
}

/** 额度用完时状态下面那行小字：整号写恢复时间，按模型写「模型 + 时间」 */
function quotaHint(account: QoderAccount): string {
  if (!account.enabled || !account.ready)
    return ''
  if (quotaActive(account))
    return account.quotaResetsAt ? `${formatTimestamp(account.quotaResetsAt * 1000)} 恢复` : ''
  if (!account.modelQuotas.length)
    return ''
  const [first, ...rest] = account.modelQuotas
  const head = `${first.model} ${formatTimestamp(first.resetsAt * 1000)} 恢复`
  return rest.length ? `${head}（另 ${rest.length} 个模型）` : head
}

function compact(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000)
    return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

/**
 * token 数按千进制收短：≥100 万给 `M`（两位小数）、≥1000 给 `K`（一位小数），再小给整数，
 * 与 TBuddy 用量页的 `compact()` 同一套。**不写「兆」**：中文的兆是万亿，
 * 9.28M 写成「9.28兆」会读大六个数量级（M = 百万）。
 */
function token(value: number): string {
  const n = Math.max(0, Math.round(value))
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)
    return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 签到标签只看上游 status：请求成功不等于「可签」 */
function checkinLabel(
  status: { ok: boolean, todayCheckedIn: boolean, status: string },
): string {
  if (status.todayCheckedIn)
    return '今日已签'
  if (status.status === 'CLAIMABLE')
    return '可签到'
  if (!status.ok)
    return '读取失败'
  return status.status === 'CLAIMED' ? '今日已签' : '活动未开放'
}

/** 请求栏按条件过滤后的行：结果 → 关键字，顺序保持新→旧 */
const requestRows = computed(() => {
  const text = requestKeyword.value.trim().toLowerCase()
  return recent.value
    .filter(row => requestResult.value === 'all' || (requestResult.value === 'ok' ? row.ok : !row.ok))
    .filter((row) => {
      if (!text)
        return true
      // 账号名也进搜索：记得住邮箱的人不会去记那串 uid
      const label = accounts.value.find(item => item.uid === row.uid)?.label ?? ''
      return [row.model, row.uid, label, row.machine ?? '', row.ua, row.effort, row.error]
        .some(field => field.toLowerCase().includes(text))
    })
})
const requestOkCount = computed(() => requestRows.value.filter(row => row.ok).length)

/** 本机领取记录 → 最近 30 天的每日获取序列（补日历在 `dailyCreditSeries`） */
const earningDays = computed(() => dailyCreditSeries(
  earnings.value.map(item => ({ date: item.date, credit: item.credits })),
  GROWTH_CREDIT_DAYS,
))
const earningTotal = computed(() => earningDays.value.reduce((sum, day) => sum + day.credit, 0))

/** 一条流水的键：时间 + 模型 + 账号（同一秒同模型同账号极少） */
function requestRowKey(row: GatewayUsageRow): string {
  return `${row.ts}-${row.model}-${row.uid}`
}

const heatMax = computed(() => Math.max(1, ...heatmap.value.map(point => point.value)))

watch(tab, async (value) => {
  if (value === 'accounts')
    await loadAccountUsage()
  else if (value === 'perks')
    await loadPerks()
  else if (value === 'requests')
    await loadRecent()
  else if (value === 'models')
    await loadModels()
})

onMounted(async () => {
  await enter()
  pollTimer = setInterval(() => {
    void refresh()
  }, 5000)
})
onActivated(async () => {
  await enter()
})
onBeforeUnmount(() => {
  if (pollTimer)
    clearInterval(pollTimer)
  stopLogin()
})
</script>

<template>
  <div class="qd">
    <div class="qd__head">
      <GatewayTabs v-model="tab" :items="TABS" />
      <div class="qd__status">
        <button class="qd__pill" type="button" @click="accessOpen = true">
          <span class="qd__dot" :class="running ? 'is-on' : 'is-off'" />
          {{ running ? `Qoder · 运行中 ${port}` : 'Qoder · 已停止' }}
        </button>
        <el-button size="small" :loading="busy" @click="toggleRun">
          {{ running ? '停止' : '启动' }}
        </el-button>
      </div>
    </div>

    <!-- 账号：登录与刷新积分在右下角（与 TBuddy 同一套浮动键） -->
    <template v-if="tab === 'accounts'">
      <section class="qd__pane is-accounts" :class="{ 'is-empty': !accounts.length }">
        <!-- 账号搬运用：导出成一段 JSON 抄进密码管理器，另一台机器导入后不必再登录一次 -->
        <div class="qd__transfer">
          <el-button size="small" text :disabled="!accounts.length" @click="openTransfer('export')">
            导出
          </el-button>
          <el-button size="small" text @click="openTransfer('import')">
            导入
          </el-button>
        </div>

        <p v-if="loginHint" class="qd__hint">
          {{ loginHint }}
        </p>
        <EmptyState
          v-if="!accounts.length"
          :icon="User"
          text="还没有 Qoder 账号"
          hint="点右下角加号登录一个"
        />
        <div v-else class="qd__accounts">
          <article v-for="account in accounts" :key="account.uid" class="qd-account panel" :class="statusClass(account)">
            <div class="qd-account__head">
              <span class="qd-account__avatar">{{ account.label.slice(0, 1) }}</span>
              <div class="qd-account__id">
                <span class="qd-account__name">{{ account.label }}</span>
                <span
                  class="qd-account__tag"
                  :class="statusClass(account)"
                  :title="account.lastError || undefined"
                >{{ statusText(account) }}</span>
              </div>
              <div class="qd-account__actions">
                <el-button size="small" text :loading="creditBusy[account.uid]" @click="queryCredits(account.uid)">
                  查余额
                </el-button>
                <el-button size="small" text @click="toggleAccount(account)">
                  {{ account.enabled ? '停用' : '启用' }}
                </el-button>
                <el-button size="small" text @click="removeAccount(account)">
                  删除
                </el-button>
              </div>
            </div>

            <div class="qd-account__meta">
              <span class="qd-account__priority">
                <span class="qd-account__dim">优先级</span>
                <el-input-number
                  :model-value="account.priority"
                  :min="1"
                  :max="100"
                  :step="1"
                  size="small"
                  controls-position="right"
                  @change="(value: number | undefined) => changePriority(account, value)"
                />
              </span>
            </div>

            <!-- 额度恢复时间只有部分账号有，但这一行**始终占位**：同一排卡片的积分条与三格才对得齐 -->
            <span
              class="qd-account__sub"
              :class="{ 'is-empty': !quotaHint(account) }"
              :title="quotaHint(account) || undefined"
            >{{ quotaHint(account) || '—' }}</span>

            <!-- 点这一块看逐包到期：卡片只放得下「剩余 / 总额」，说不出哪天作废 -->
            <div
              class="qd-account__credits"
              role="button"
              tabindex="0"
              :aria-label="`查看 ${account.label} 的积分明细`"
              @click="openCredits(account)"
              @keydown.enter.prevent="openCredits(account)"
              @keydown.space.prevent="openCredits(account)"
            >
              <div class="qd-account__credits-line">
                <span class="qd-account__dim">积分</span>
                <template v-if="creditOf(account.uid)">
                  <span class="qd-account__num">{{ number(creditOf(account.uid)!.remain) }}</span>
                  <span class="qd-account__dim">/ {{ number(creditOf(account.uid)!.size) }}</span>
                  <span v-if="creditOf(account.uid)!.size > 0 || expiryHint(account)" class="qd-account__aside">
                    <span v-if="creditOf(account.uid)!.size > 0" class="qd-account__used">
                      已用 <span class="qd-account__used-num">{{ number(Math.max(0, creditOf(account.uid)!.size - creditOf(account.uid)!.remain)) }}</span>
                    </span>
                    <span
                      v-if="expiryHint(account)"
                      class="qd-account__expiry"
                      :title="expiryHint(account)!.title"
                    >{{ expiryHint(account)!.text }}</span>
                  </span>
                </template>
                <span v-else class="qd-account__dim">未查询</span>
              </div>
              <!-- 余额条同样始终占位：没查过余额的卡不能比查过的卡少一截 -->
              <span class="qd-account__meter" :class="{ 'is-empty': !creditOf(account.uid) }">
                <span
                  v-if="creditOf(account.uid)"
                  class="qd-account__meter-fill"
                  :class="meterClass(creditOf(account.uid)!)"
                  :style="{ width: `${remainPercent(creditOf(account.uid)!)}%` }"
                />
              </span>
            </div>

            <div class="qd-account__facts">
              <div class="qd-account__fact">
                <span class="qd-account__fact-label">成功 / 失败</span>
                <span class="qd-account__fact-value">
                  <template v-if="usageOf(account.uid)">
                    {{ usageOf(account.uid)!.requests - usageOf(account.uid)!.failed }} / {{ usageOf(account.uid)!.failed }}
                  </template>
                  <span v-else class="qd-account__dim">—</span>
                </span>
              </div>
              <div class="qd-account__fact">
                <span class="qd-account__fact-label">用量</span>
                <span class="qd-account__fact-value">
                  {{ usageOf(account.uid) ? compact(usageOf(account.uid)!.promptTokens + usageOf(account.uid)!.completionTokens) : '—' }}
                </span>
              </div>
              <div class="qd-account__fact">
                <span class="qd-account__fact-label">均速</span>
                <span class="qd-account__fact-value">
                  {{ usageOf(account.uid) ? `${usageOf(account.uid)!.tokensPerSec.toFixed(0)} tok/s` : '—' }}
                </span>
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- 右下角：刷新积分 + 登录（页面数据走 5 秒轮询，这颗只用于手动催一次） -->
      <div class="qd__fab">
        <el-tooltip content="刷新积分" placement="top">
          <button
            type="button"
            class="qd__fab-tool"
            :class="{ 'is-busy': creditsBusy }"
            :disabled="!accounts.length || creditsBusy"
            aria-label="刷新积分"
            @click="refreshCredits"
          >
            <el-icon><Coin /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="登录账号" placement="top">
          <button
            type="button"
            class="qd__fab-main"
            :disabled="loggingIn"
            aria-label="登录账号"
            @click="startLogin"
          >
            <el-icon><Plus /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </template>

    <!-- 福利 -->
    <section v-else-if="tab === 'perks'" class="qd__pane">
      <div class="qd__toolbar">
        <span class="qd__hint">每日签到（每天 10:00 UTC+8 刷新）</span>
        <div class="qd__actions">
          <el-button size="small" :loading="perksBusy" :disabled="!accounts.length" @click="checkinAll">
            签到
          </el-button>
          <el-button size="small" :loading="perksBusy" :disabled="!accounts.length" @click="claimAll">
            领取活动
          </el-button>
        </div>
      </div>
      <EmptyState
        v-if="!accounts.length"
        :icon="MagicStick"
        text="还没有账号"
        hint="先在「账号」栏登录，再回来签到"
      />
      <div v-else class="qd__cards">
        <article v-for="item in taskSnapshots" :key="item.uid" class="qd-card panel">
          <header class="qd-card__head">
            <div class="qd-card__title">
              <span class="qd-card__name">{{ item.account }}</span>
              <el-tag size="small" effect="dark">
                {{ checkinLabel(item.checkin) }}
              </el-tag>
            </div>
          </header>
          <div class="qd-card__facts">
            <div>
              <span class="qd-card__fact-icon"><el-icon><Calendar /></el-icon></span>
              <span>连签</span>
              <strong>{{ item.checkin.streakDays }} 天</strong>
            </div>
            <div>
              <span class="qd-card__fact-icon"><el-icon><Histogram /></el-icon></span>
              <span>累计</span>
              <strong>{{ item.checkin.totalClaimDays }} 天</strong>
            </div>
            <div>
              <span class="qd-card__fact-icon"><el-icon><Coin /></el-icon></span>
              <span>每日签到</span>
              <strong>{{ item.checkin.rewardCredits }}</strong>
            </div>
          </div>
          <p v-if="item.checkin.error" class="qd-card__error">
            {{ item.checkin.error }}
          </p>
        </article>
      </div>
      <PerksCreditsChart
        :days="earningDays"
        :total="earningTotal"
        scope="全部账号合计 · 本应用领取"
        :failed="0"
        :loading="earningsLoading"
        :error="earningsError"
        hint="签到或领取活动后会记在这里"
      />
      <div v-if="heatmap.length" class="qd-chart panel">
        <div class="qd-chart__head">
          <span>近一个月官方积分消耗</span>
          <span class="qd-card__muted">单日峰值 {{ heatMax }}</span>
        </div>
        <div class="qd-chart__bars">
          <div v-for="point in heatmap" :key="point.date" class="qd-chart__bar" :title="`${point.date}：${point.value}`">
            <span :style="{ height: `${Math.round((point.value / heatMax) * 100)}%` }" />
          </div>
        </div>
      </div>
    </section>

    <!-- 用量：与 TBuddy 共用同一个组件，只把取数与账号名换成 Qoder 的 -->
    <UsagePane
      v-else-if="tab === 'usage'"
      :load-rows="qoderUsageRows"
      :load-names="loadQoderNames"
    />

    <!-- 请求：条件带与 TBuddy 的请求栏同一套（搜索 / 结果 / 条数 + 计数与重读） -->
    <section v-else-if="tab === 'requests'" class="qd__pane">
      <div class="qd-req__filters">
        <div class="qd-req__picks">
          <el-input
            v-model="requestKeyword"
            size="small"
            placeholder="搜索模型 / 账号 / User-Agent"
            clearable
            class="qd-req__search"
          />
          <el-select v-model="requestResult" size="small" class="qd-req__pick">
            <el-option v-for="item in REQUEST_RESULTS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="requestLimit" size="small" class="qd-req__pick" @change="loadRecent">
            <el-option v-for="item in REQUEST_LIMITS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </div>
        <div class="qd-req__actions">
          <span class="qd-req__count">共 {{ requestRows.length }} 条 · 成功 {{ requestOkCount }}</span>
          <el-button size="small" :loading="requestsLoading" @click="loadRecent">
            重新读取
          </el-button>
        </div>
      </div>
      <EmptyState
        v-if="!requestRows.length"
        :icon="Cpu"
        text="还没有请求"
        hint="Qoder 启动后，客户端来的请求会出现在这里"
      />
      <GatewayTable v-else :data="requestRows" :row-key="requestRowKey" height="100%" nowrap class="qd__table">
        <el-table-column label="时间" align="center">
          <template #default="{ row }">
            {{ formatTimestamp(row.ts * 1000) }}
          </template>
        </el-table-column>
        <el-table-column label="账号" align="center">
          <template #default="{ row }">
            {{ accounts.find(a => a.uid === row.uid)?.label ?? row.uid.slice(0, 8) }}
          </template>
        </el-table-column>
        <el-table-column label="模型" prop="model" align="center" />
        <el-table-column label="状态" align="center">
          <template #default="{ row }">
            <span :class="row.ok ? 'is-ok' : 'is-off'">{{ row.ok ? '成功' : '失败' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="token" align="center">
          <template #default="{ row }">
            {{ token(row.totalTokens) }}
          </template>
        </el-table-column>
        <el-table-column label="延迟" align="center">
          <template #default="{ row }">
            {{ row.durationMs }} ms
          </template>
        </el-table-column>
        <el-table-column label="错误" align="center">
          <template #default="{ row }">
            <span class="qd-log__msg" :title="row.error">{{ row.error }}</span>
          </template>
        </el-table-column>
      </GatewayTable>
    </section>

    <!-- 模型 -->
    <section v-else class="qd__pane">
      <div class="qd__toolbar">
        <span class="qd__hint">目录来自上游官方清单；点「重新获取」用第一个可用账号拉一次</span>
        <el-button size="small" :loading="modelsBusy" @click="refreshModels">
          <el-icon><Refresh /></el-icon>
          重新获取
        </el-button>
      </div>
      <EmptyState
        v-if="!models.length"
        :icon="Cpu"
        text="还没有模型清单"
        hint="登录一个可用账号后会自动拉取；也可以点「重新获取」"
      />
      <div v-else class="qd__cards">
        <article v-for="model in models" :key="model.key" class="qd-model panel">
          <header>
            <span class="qd-model__id">{{ model.id }}</span>
            <el-tag v-if="model.isNew" size="small" effect="dark">
              新
            </el-tag>
            <el-tag v-if="!model.enabled" size="small" effect="dark">
              未开放
            </el-tag>
          </header>
          <p class="qd-model__desc">
            {{ model.description || '官方未提供介绍' }}
          </p>
          <div class="qd-card__facts">
            <div><span>上下文</span><strong>{{ model.contextLength || '—' }}</strong></div>
            <div><span>思考档位</span><strong>{{ model.efforts.join(' / ') || '—' }}</strong></div>
            <div><span>倍率</span><strong>{{ model.priceFactor ?? '—' }}</strong></div>
          </div>
          <footer class="qd-model__foot">
            <span v-if="model.vision">图像</span>
            <span v-if="model.toolCalls">工具</span>
            <span v-if="model.isFree">免费</span>
            <span v-if="!model.enabled" class="qd-card__muted">{{ model.disabledReason }}</span>
          </footer>
        </article>
      </div>
    </section>

    <!-- 积分明细：点账号卡上的积分打开（只读展示，查余额仍走这一页） -->
    <CreditsDialog
      v-model="creditsOpen"
      :label="creditsAccount?.label ?? ''"
      :credits="creditsDetail"
      :loading="creditsUid ? creditBusy[creditsUid] === true : false"
      @refresh="refreshDetail"
    />

    <AccessDialog
      v-model="accessOpen"
      v-model:port="port"
      :running="running"
      :base-url="baseUrl"
      :api-key="apiKey"
      @rotate="rotateKey"
    />

    <!-- 账号导出 / 导入：导出给一段 JSON，导入把它贴回来（同 uid 跳过或覆盖当场选） -->
    <AccountTransferDialog
      v-model="transferOpen"
      kind="qoder"
      :mode="transferMode"
      @imported="refresh"
    />
  </div>
</template>

<style scoped>
.qd {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: var(--sp-3);
}

.qd__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex: none;
}

/* 页签本体在 GatewayTabs.vue（TBuddy 与 Qoder 共用同一副大小） */

.qd__status {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.qd__pill {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 4px 10px;
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-full);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  color: var(--ink-2);
  font-size: var(--fs-sm);
  cursor: pointer;
}

.qd__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink-3);
}

.qd__dot.is-on {
  background: var(--st-ok);
}

.qd__pane {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  flex: 1 1 auto;
  min-height: 0;
}

/*
 * 账号栏按内容自然长高，不参与收缩：右下角那颗浮动键要拿到整段滚动范围，
 * 卡一多时才能在滚到最底之前一直钉在页面下沿（收缩的容器会让它的常驻位置提前进屏）。
 * 空态没有可滚的内容，仍旧撑满一栏、居中。
 */
.qd__pane.is-accounts {
  flex: none;
}

.qd__pane.is-accounts.is-empty {
  flex: 1 1 auto;
}

/* 导出 / 导入：账号栏自己的小工具行，不占页首状态区 */
.qd__transfer {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-1);
  margin-bottom: calc(var(--sp-2) * -1);
}

.qd__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex: none;
}

/* 栏首那一对批量动作：与卡片里的工具键同一套间距 */
.qd__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.qd__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-sm);
}

.qd__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--sp-3);
  flex: none;
}

/* 账号卡：一行放不下两张时自动往下排（与 TBuddy 的账号网格同宽） */
.qd__accounts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: var(--sp-3);
  flex: none;
}

/* ---------- 账号卡：与 TBuddy 的账号卡同一套（头像 / 状态色标 / 积分条 / 三格） ---------- */
.panel.qd-account {
  position: relative;
  gap: var(--sp-3);
  padding: var(--sp-4);
  overflow: hidden;
  /* 卡面铺一层极淡的状态色，整页才不至于一片灰 */
  background-image: radial-gradient(
    120% 120% at 100% 0%,
    color-mix(in srgb, var(--card-color) 7%, transparent),
    transparent 55%
  );
}

/* 左侧一截状态色标：颜色只表达状态，不做装饰 */
.qd-account::before {
  content: '';
  position: absolute;
  top: var(--sp-3);
  bottom: var(--sp-3);
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--card-color, transparent);
}

.qd-account.state-ok {
  --card-color: var(--st-ok);
}

.qd-account.state-warn {
  --card-color: var(--st-run);
}

.qd-account.state-fail {
  --card-color: var(--st-fail);
}

.qd-account.state-muted {
  --card-color: var(--ink-3);
}

.qd-account__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-2);
}

/* 账号头像：首字 + 紫色（与 TBuddy 账号卡的账号色同一个） */
.qd-account__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, #7c3aed 15%, transparent);
  color: #7c3aed;
  font-size: var(--gw-fs-title);
  font-weight: 600;
}

.qd-account__id {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.qd-account__id .qd-account__tag {
  align-self: flex-start;
}

.qd-account__name {
  font-size: var(--gw-fs-title);
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qd-account__tag {
  display: inline-block;
  flex: none;
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--gw-fs-micro);
}

.qd-account__tag.state-ok {
  color: var(--st-ok);
}

.qd-account__tag.state-muted {
  color: var(--ink-3);
}

.qd-account__tag.state-warn {
  color: var(--st-run);
}

.qd-account__tag.state-fail {
  color: var(--st-fail);
}

.qd-account__actions {
  display: flex;
  align-items: center;
  flex: none;
  gap: var(--sp-1);
}

.qd-account__meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.qd-account__priority {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.qd-account__priority :deep(.el-input-number) {
  width: 76px;
}

/* 额度恢复时间只有部分账号有，但这一行**始终占位**：同一排卡片的积分条与三格才对得齐 */
.qd-account__sub {
  overflow: hidden;
  font-size: var(--gw-fs-micro);
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink-3);
}

.qd-account__sub.is-empty {
  visibility: hidden;
}

.qd-account__credits {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  margin: calc(var(--sp-1) * -1) calc(var(--sp-2) * -1);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background 120ms var(--ease-out);
}

.qd-account__credits:hover {
  background: color-mix(in srgb, var(--ink-3) 8%, transparent);
}

.qd-account__credits:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}

.qd-account__credits-line {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
  font-size: var(--gw-fs-body);
  font-variant-numeric: tabular-nums;
}

.qd-account__aside {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-left: auto;
}

.qd-account__used {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.qd-account__used-num {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--ink-2);
}

.qd-account__expiry {
  padding-left: var(--sp-2);
  border-left: 1px solid var(--border);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.qd-account__num {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
}

.qd-account__dim {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.qd-account__meter {
  display: block;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  overflow: hidden;
}

.qd-account__meter.is-empty {
  visibility: hidden;
}

.qd-account__meter-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ink-3);
}

.qd-account__meter-fill.is-ok {
  background: var(--st-ok);
}

.qd-account__meter-fill.is-warn {
  background: var(--st-run);
}

.qd-account__meter-fill.is-fail {
  background: var(--st-fail);
}

.qd-account__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.qd-account__fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.qd-account__fact-label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.qd-account__fact-value {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-meta);
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.qd__table {
  flex: 1 1 auto;
  min-height: 0;
  /* 表格再宽也不许把这一栏撑出横向滚动条（min-width: auto 会按表格最小内容宽度算） */
  min-width: 0;
}

/* 请求栏的条件带：一行排完、不套卡片，与 TBuddy 的请求栏同一套 */
.qd-req__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex: none;
  margin-bottom: calc(-1 * var(--sp-1));
}

.qd-req__picks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.qd-req__pick {
  width: 120px;
}

.qd-req__search {
  width: 240px;
}

.qd-req__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-left: auto;
}

.qd-req__count {
  font-size: var(--fs-meta);
  color: var(--ink-3);
  white-space: nowrap;
}

.qd-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
}

.qd-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.qd-card__title {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}

.qd-card__name {
  font-weight: 600;
  color: var(--ink-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qd-card__muted {
  color: var(--ink-3);
  font-size: var(--fs-sm);
}

.qd-card__error {
  color: var(--st-fail);
  font-size: var(--fs-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qd-card__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2);
}

.qd-card__facts > div {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--r-sm);
  background: rgba(var(--bg-surface-rgb), 0.5);
}

/* 三格各带一枚灰度图标：跨标签与数值两行，像一枚小徽章（彩色仍只留给 KPI） */
.qd-card__facts .qd-card__fact-icon {
  grid-row: 1 / span 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--r-sm);
  background: rgba(var(--bg-surface-rgb), 0.65);
  color: var(--ink-3);
  font-size: 16px;
}

.qd-card__facts span {
  color: var(--ink-3);
  font-size: var(--fs-xs);
}

.qd-card__facts strong {
  color: var(--ink-1);
  font-variant-numeric: tabular-nums;
}

.is-ok {
  color: var(--st-ok);
}

.is-off {
  color: var(--st-fail);
}

.qd-chart {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  flex: none;
}

.qd-chart__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--ink-2);
  font-size: var(--fs-sm);
}

.qd-chart__bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 96px;
}

.qd-chart__bar {
  display: flex;
  /* 宽度定死：桶少时（比如 24 小时里只有一个小时有请求）不能把一根柱子拉满整行 */
  flex: 0 0 12px;
  align-items: flex-end;
  height: 100%;
}

.qd-chart__bar span {
  width: 100%;
  border-radius: 3px 3px 0 0;
  background: var(--el-color-primary);
  opacity: 0.75;
}

.qd-log__msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
}

.qd-model {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
}

.qd-model header {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.qd-model__id {
  font-weight: 600;
  color: var(--ink-1);
}

.qd-model__desc {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-sm);
  min-height: 2.4em;
}

.qd-model__foot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-xs);
}

/* ---------- 右下角悬浮动作（与 TBuddy 同一套，口径见 gateway.md） ---------- */

/*
 * 钉在**页面**右下角，不是窗口右下角：`position: sticky` + `margin-top: auto` 停在
 * `.qd` 这个滚动容器里面，终端面板展开、页面变矮时跟着上移 —— 不许改回 `position: fixed`。
 * `bottom` 与两条外边距都写成 `calc(sp-5 - sp-3)`：sticky 的 inset 与外边距都从内容盒量起，
 * 而 `.qd` 自己有一圈 `sp-3` 内边距，减掉才落在离页边 `sp-5`。
 */
.qd__fab {
  position: sticky;
  bottom: calc(var(--sp-5) - var(--sp-3));
  margin-top: auto;
  margin-right: calc(var(--sp-5) - var(--sp-3));
  margin-bottom: calc(var(--sp-5) - var(--sp-3));
  align-self: flex-end;
  z-index: 30;
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
}

/* 刷新积分：一颗常驻圆键（页面数据走 5 秒轮询，这颗只用于手动催一次） */
.qd__fab-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-pill);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  backdrop-filter: var(--glass-filter);
  color: var(--ink-2);
  font-size: 18px;
  box-shadow: var(--shadow-card);
  cursor: pointer;
  transition: color 0.15s ease, box-shadow 0.2s var(--ease-out);
}

.qd__fab-tool:hover:not(:disabled) {
  color: var(--ink);
  box-shadow: var(--shadow-hover);
}

.qd__fab-tool:disabled {
  opacity: 0.45;
  cursor: default;
}

.qd__fab-tool:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 3px;
}

/* 刷新在途：图标转起来，跟页面里的 loading 一致 */
.qd__fab-tool.is-busy :deep(.el-icon) {
  animation: qd-spin 1s linear infinite;
}

@keyframes qd-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 登录：一颗常驻加号 */
.qd__fab-main {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-pill);
  background: var(--el-color-primary);
  color: var(--el-color-white);
  font-size: 22px;
  box-shadow: var(--shadow-hover);
  cursor: pointer;
  transition: transform 0.22s var(--ease-out), box-shadow 0.22s var(--ease-out);
}

.qd__fab-main:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: var(--shadow-pop);
}

.qd__fab-main:disabled {
  opacity: 0.45;
  cursor: default;
}

.qd__fab-main:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 3px;
}
</style>
