<script setup lang="ts">
import type { GatewayUsageSummary } from '@workbench/usage'
import type { GatewayCredits, GatewayUsageRow } from '@/workbench/gateway'
import type { QoderAccount, QoderCredits, QoderEarningPoint, QoderHeatmapPoint, QoderModelInfo, QoderStatus, QoderTaskSnapshot } from '@/workbench/qoder'
import { Calendar, Coin, CopyDocument, Cpu, Download, Histogram, MagicStick, Plus, Refresh, Search, Upload, User } from '@element-plus/icons-vue'
import { dailyCreditSeries, gatewayBucketUnit, GROWTH_CREDIT_DAYS, summarizeGatewayRows } from '@workbench/usage'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { copyText } from '@/clipboard'
import EmptyState from '@/components/EmptyState.vue'
import AccessDialog from '@/components/gateway/AccessDialog.vue'
import AccountTransferDialog from '@/components/gateway/AccountTransferDialog.vue'
import CreditsDialog from '@/components/gateway/CreditsDialog.vue'
import GatewayTable from '@/components/gateway/GatewayTable.vue'
import GatewayTabs from '@/components/gateway/GatewayTabs.vue'
import PerksCreditsChart from '@/components/gateway/PerksCreditsChart.vue'
import RequestFilters from '@/components/gateway/RequestFilters.vue'
import UsagePane from '@/components/gateway/UsagePane.vue'
import { useCreditPool } from '@/composables/use-credit-pool'
import { formatCompactTokens, formatDecimal, formatTimestamp } from '@/format'
import {
  poolMeterTone as meterClass,
  poolBalanceText as number,
  poolExpiryHint,
  poolStatusText,
  poolQuotaHint as quotaHint,
  poolRemainPercent as remainPercent,
  poolStatusTone as statusClass,
} from '@/status'
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

const tab = ref<'accounts' | 'perks' | 'usage' | 'requests' | 'models'>('accounts')
const status = ref<QoderStatus | null>(null)
const accounts = ref<QoderAccount[]>([])
// 余额快照（credits）与单号在途（creditBusy）在 useCreditPool：与 TBuddy 账号页同一套口径
const { credits, pending: creditBusy, pruneCredits, throttled: poolThrottled, markQueried, resetThrottle, queryCredits: queryPoolCredits } = useCreditPool<QoderCredits>()
const models = ref<QoderModelInfo[]>([])
/** 模型栏的本地查询：只在已拉下来的清单里按 id / key 过滤，不发请求、不触发重新获取 */
const modelKeyword = ref('')
const visibleModels = computed(() => {
  const keyword = modelKeyword.value.trim().toLowerCase()
  if (!keyword)
    return models.value
  return models.value.filter(model =>
    model.id.toLowerCase().includes(keyword) || model.key.toLowerCase().includes(keyword),
  )
})
const access = ref<{ baseUrl: string, apiKey: string, models: string[] } | null>(null)
const accessOpen = ref(false)
/** 账号导出 / 导入弹层：两个模式共用一个实例，`transferMode` 决定打开哪个 */
const transferOpen = ref(false)
const transferMode = ref<'export' | 'import'>('export')
const port = ref(17879)
const busy = ref(false)
const loggingIn = ref(false)
const loginHint = ref('')
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
  if (accountResult.ok && accountResult.data) {
    accounts.value = accountResult.data
    // 账号删掉后它的余额快照要一起丢掉（与 TBuddy 同一口径；统计卡把整个 map 求和，
    // 留着旧号会让「剩余 / 总额」凭空多出一个号的数）
    pruneCredits(new Set(accountResult.data.map(item => item.uid)))
  }
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
  if (poolThrottled(60_000))
    return
  markQueried()
  for (const account of accounts.value) {
    if (!account.enabled)
      continue
    void queryCredits(account.uid)
  }
}

/** 右下角「刷新积分」：跳过一分钟节流，把可用账号各查一遍 */
function refreshCredits(): void {
  resetThrottle()
  void loadCredits()
}

/**
 * 查一个号的余额：快照与在途标记在 useCreditPool。失败就地提示（TBuddy 那边
 * 是批量聚成一条，这里是单号各说各的 —— 节奏不同，快照口径相同）。
 */
async function queryCredits(uid: string): Promise<void> {
  const error = await queryPoolCredits(uid, id => window.workbench.qoderCredits(id), '查询积分失败')
  if (error) {
    ElMessage.error(error)
    return
  }
  const snapshot = credits.value[uid]
  if (snapshot?.error)
    ElMessage.warning(`${uid.slice(0, 8)}：${snapshot.error}`)
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
  markQueried()
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

/** 卡面状态机、余额条与临期提示在 status.ts（与 TBuddy 账号页同一份）；这里只绑各自的快照与文案 */
function expiryHint(account: QoderAccount) {
  return poolExpiryHint(credits.value[account.uid], { onlyAvailable: true })
}

function statusText(account: QoderAccount): string {
  return poolStatusText(account, { readyLabel: '待登录' })
}

/**
 * 签到标签只看上游 status：请求成功不等于「可签」。
 * 上游说活动没开时回空串 —— 卡上不摆这条状态，标签整个不出来。
 */
function checkinLabel(
  status: { ok: boolean, todayCheckedIn: boolean, status: string },
): string {
  if (status.todayCheckedIn)
    return '今日已签'
  if (status.status === 'CLAIMABLE')
    return '可签到'
  if (!status.ok)
    return '读取失败'
  return status.status === 'CLAIMED' ? '今日已签' : ''
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

/**
 * 官方消耗热力：上游回的是**一整年**的点（`items`），这里按近 30 天铺成连续序列
 * （缺的天补 0，与领取图同一窗口口径）；全是 0 时不渲染这张图。
 */
const heatDays = computed(() => dailyCreditSeries(
  heatmap.value.map(item => ({ date: item.date, credit: item.value })),
  GROWTH_CREDIT_DAYS,
))
const heatMax = computed(() => Math.max(1, ...heatDays.value.map(point => point.credit)))
const heatHasData = computed(() => heatDays.value.some(point => point.credit > 0))

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
        <button type="button" class="qd__run-status" title="接入信息" @click="accessOpen = true">
          <span class="qd__run-dot" :class="{ 'is-ok': running }" />
          <span class="qd__run-text">{{ running ? '运行中' : '已停止' }}</span>
          <span class="qd__run-addr">{{ running ? `127.0.0.1:${port}` : '未监听' }}</span>
        </button>
        <el-button size="small" text :loading="busy" @click="toggleRun">
          {{ running ? '停止' : '启动' }}
        </el-button>
      </div>
    </div>

    <!-- 账号：登录与刷新积分在右下角（与 TBuddy 同一套浮动键） -->
    <template v-if="tab === 'accounts'">
      <section class="qd__pane is-accounts" :class="{ 'is-empty': !accounts.length }">
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

            <!-- 额度恢复提示（多数账号平时没有）与优先级并作一排：提示在左、优先级在右，
                 省下单独一行；行高由优先级输入框兜着，提示空着（隐藏但占位）也不影响同排卡片对齐 -->
            <div class="qd-account__meta">
              <span
                class="qd-account__sub"
                :class="{ 'is-empty': !quotaHint(account) }"
                :title="quotaHint(account) || undefined"
              >{{ quotaHint(account) || '—' }}</span>
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
                  {{ usageOf(account.uid) ? formatCompactTokens(usageOf(account.uid)!.promptTokens + usageOf(account.uid)!.completionTokens) : '—' }}
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

      <!-- 右下角：导出 / 导入 + 刷新积分 + 登录（页面数据走 5 秒轮询，刷新这颗只用于手动催一次） -->
      <div class="qd__fab">
        <!-- 账号搬运用：导出成一段 JSON 抄进密码管理器，另一台机器导入后不必再登录一次 -->
        <el-tooltip content="导出账号" placement="top">
          <button
            type="button"
            class="qd__fab-tool"
            :disabled="!accounts.length"
            aria-label="导出账号"
            @click="openTransfer('export')"
          >
            <el-icon><Download /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="导入账号" placement="top">
          <button
            type="button"
            class="qd__fab-tool"
            aria-label="导入账号"
            @click="openTransfer('import')"
          >
            <el-icon><Upload /></el-icon>
          </button>
        </el-tooltip>
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
              <span class="qd-card__avatar" aria-hidden="true">{{ item.account.slice(0, 1).toUpperCase() }}</span>
              <span class="qd-card__name">{{ item.account }}</span>
              <el-tag v-if="checkinLabel(item.checkin)" size="small" effect="dark">
                {{ checkinLabel(item.checkin) }}
              </el-tag>
            </div>
          </header>
          <div class="qd-card__facts is-toned">
            <div class="is-streak">
              <span class="qd-card__fact-icon"><el-icon><Calendar /></el-icon></span>
              <span>连签</span>
              <strong>{{ item.checkin.streakDays }} 天</strong>
            </div>
            <div class="is-total">
              <span class="qd-card__fact-icon"><el-icon><Histogram /></el-icon></span>
              <span>累计</span>
              <strong>{{ item.checkin.totalClaimDays }} 天</strong>
            </div>
            <div class="is-credit">
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
      <div v-if="heatHasData" class="qd-chart panel">
        <div class="qd-chart__head">
          <span>近一个月官方积分消耗</span>
          <span class="qd-card__muted">单日峰值 {{ formatDecimal(heatMax) }}</span>
        </div>
        <div class="qd-chart__bars">
          <div v-for="point in heatDays" :key="point.date" class="qd-chart__bar" :title="`${point.date}：${formatDecimal(point.credit)}`">
            <span :style="{ height: `${Math.round((point.credit / heatMax) * 100)}%` }" />
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
      <RequestFilters
        v-model:keyword="requestKeyword"
        v-model:result="requestResult"
        v-model:limit="requestLimit"
        :count="requestRows.length"
        :ok-count="requestOkCount"
        :loading="requestsLoading"
        @reload="loadRecent"
      />
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
            {{ formatCompactTokens(row.totalTokens) }}
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
        <el-input
          v-model="modelKeyword"
          placeholder="搜索模型"
          clearable
          :prefix-icon="Search"
          class="qd__search"
        />
        <el-button :loading="modelsBusy" @click="refreshModels">
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
      <EmptyState
        v-else-if="!visibleModels.length"
        :icon="Search"
        text="没有匹配的模型"
        hint="换个关键字试试"
      />
      <div v-else class="qd__cards">
        <article v-for="model in visibleModels" :key="model.key" class="qd-model panel">
          <header>
            <span class="qd-model__id">{{ model.id }}</span>
            <el-tag v-if="model.isNew" size="small" effect="dark">
              新
            </el-tag>
            <el-tag v-if="!model.enabled" size="small" effect="dark">
              未开放
            </el-tag>
            <el-tooltip content="复制模型名" placement="top">
              <el-button
                class="qd-model__copy"
                size="small"
                text
                :icon="CopyDocument"
                aria-label="复制模型名"
                @click="copyText(model.id, '模型名')"
              />
            </el-tooltip>
          </header>
          <div class="qd-card__facts">
            <div><span>上下文</span><strong>{{ model.contextLength || '—' }}</strong></div>
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
  min-width: 0;
}

/* 与 TBuddy 页首同一套：裸按钮（状态点 + 状态字 + 地址），点开接入信息；启停是文字按钮 */
.qd__run-status {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  cursor: pointer;
}

.qd__run-status:hover .qd__run-text {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.qd__run-status:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}

/* 状态点：彩色只表达运行状态，这里正好是它该出现的地方 */
.qd__run-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  background: var(--st-idle);
}

.qd__run-dot.is-ok {
  background: var(--st-ok);
}

.qd__run-text {
  font-size: var(--gw-fs-meta);
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
}

.qd__run-addr {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
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

.qd__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex: none;
}

/* 模型栏的搜索框与请求栏那个同宽；高度走默认尺寸（32px），别用 small —— 栏首只有这一行，24px 太矮 */
.qd__search {
  width: 240px;
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
  gap: var(--sp-2);
  padding: var(--sp-3);
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

.qd-account.is-ok {
  --card-color: var(--st-ok);
}

.qd-account.is-warn {
  --card-color: var(--st-run);
}

.qd-account.is-fail {
  --card-color: var(--st-fail);
}

.qd-account.is-muted {
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

.qd-account__tag.is-ok {
  color: var(--st-ok);
}

.qd-account__tag.is-muted {
  color: var(--ink-3);
}

.qd-account__tag.is-warn {
  color: var(--st-run);
}

.qd-account__tag.is-fail {
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
  justify-content: space-between;
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

/* 与优先级同一排的那行小字（目前只有额度恢复时间）。
   空着时也**隐藏而不是删掉**：这一排的高度由优先级输入框兜着，
   它占住左边的位子，同排卡片的积分条与三格才对得齐；太长时截断，完整内容在 title 里。 */
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
  gap: var(--sp-2);
  min-width: 0;
}

/* 卡首首字头像：给每张福利卡一个颜色锚点（紫与账号栏同一个），名字与状态标签跟在后面 */
.qd-card__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: var(--r-pill);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, #8b5cf6 34%, transparent),
    color-mix(in srgb, #4f46e5 22%, transparent)
  );
  color: #7c3aed;
  font-size: var(--fs-sm);
  font-weight: 600;
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

/* 模型卡只列上下文与倍率两格（思考档位不进界面），两格平分栏宽；福利卡仍是三格 */
.qd-model .qd-card__facts {
  grid-template-columns: repeat(2, minmax(0, 1fr));
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

/* 三格各带一枚图标：跨标签与数值两行，像一枚小徽章；默认灰度，福利卡那三格由 is-toned 着色 */
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

/*
 * 福利卡三格的彩色（这一页的彩色例外，与 TBuddy 福利栏的数字格同一套色板）：
 * 图标取语义色、底是同色 16%，格子本身铺一层更淡的同色渐变 + 内描边 —— 卡面才不至于一片灰。
 * 色板口径只在 docs/modules/qoder.md 的「福利栏」一处，别往别处扩。
 */
.qd-card__facts.is-toned > div {
  background:
    linear-gradient(
      color-mix(in srgb, var(--stat-color) 9%, transparent),
      color-mix(in srgb, var(--stat-color) 5%, transparent)
    ),
    rgba(var(--bg-surface-rgb), 0.5);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--stat-color) 14%, transparent);
}

.qd-card__facts.is-toned .qd-card__fact-icon {
  background: color-mix(in srgb, var(--stat-color) 16%, transparent);
  color: var(--stat-color);
}

.qd-card__facts .is-streak {
  --stat-color: var(--st-ok);
}

.qd-card__facts .is-total {
  --stat-color: #2f6bd8;
}

.qd-card__facts .is-credit {
  --stat-color: #c2410c;
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

/* 复制键推到行尾：无底色图标键，悬停才有底（与接入信息弹层那几枚同一形态） */
.qd-model__copy {
  margin-left: auto;
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
