<script setup lang="ts">
import type { GatewayAccess, GatewayAccount, GatewayCredits, GatewayStatus, GatewayUsageSummary } from '@/workbench/gateway'
import { CircleCheck, CircleClose, Clock, Coin, Connection, Plus, User, Warning } from '@element-plus/icons-vue'
import { gatewayBucketUnit, summarizeGatewayRows } from '@workbench/usage'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onActivated, onBeforeUnmount, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import { formatTimestamp } from '@/format'
import AccessDialog from './AccessDialog.vue'
import ModelsPane from './ModelsPane.vue'
import PerksPane from './PerksPane.vue'
import RequestsPane from './RequestsPane.vue'
import UsagePane from './UsagePane.vue'

/**
 * 网关页。
 *
 * 布局照 Hub 的看板来：顶上一排统计卡，下面按「账号 / 用量 / 请求」分栏。
 * 数据分三处拿 —— 状态（Rust 的 Gateway）、账号余额（每个账号一次查询）、
 * 用量汇总（usage.jsonl 聚合）。**这一页不算数**，数字都是现成的。
 *
 * 余额是**唯一要打上游**的那一项（每个号一次往返），所以它有自己的一套节奏：
 * 进页面查一遍、切回「账号 / 用量」时再对一遍（一分钟内不重复），点「刷新积分」立即查。
 * 状态与用量是本机读文件，跟着 15 秒的轮询走，不必手动刷。
 *
 * 接入信息（地址 / 密钥）不常驻：那张卡会把下面几栏一直往下推，
 * 而它只是配客户端时抄一次的东西 —— 收进 AccessDialog，点页首的状态块打开。
 */
const POLL_INTERVAL = 2000
/** 自动查余额的最小间隔：一个号一次上游往返，切个页签就重查一遍太费 */
const CREDIT_THROTTLE = 60_000

const tab = ref<'accounts' | 'perks' | 'usage' | 'requests' | 'models'>('accounts')
const status = ref<GatewayStatus | null>(null)
const accounts = ref<GatewayAccount[]>([])
const credits = ref<Record<string, GatewayCredits>>({})
const usage = ref<GatewayUsageSummary | null>(null)
const access = ref<GatewayAccess | null>(null)
const accessOpen = ref(false)
const busy = ref(false)
const port = ref(17878)
const loginHint = ref('')
const loggingIn = ref('')
/** 全量查余额在途（整排一起转） */
const creditBusy = ref(false)
/** 按 uid 记的单号在途：行内那枚「查余额」自己转自己的 */
const creditPending = ref<Record<string, boolean>>({})
/** 上一次全量查余额的时刻（毫秒），配合 CREDIT_THROTTLE */
let creditAt = 0
/** 进页面那一套动作是否在途（见 `enter`） */
let entering = false

/**
 * 网关流水按用量自动同步：30 天总 token 每新增这么多就推一次 git。
 * 用量页不再有手动「同步 / 刷新」按钮 —— 刷新走 15 秒轮询，同步走这个阈值。
 */
const SYNC_TOKEN_STEP = 10_000_000
const syncEnabled = ref(false)
/** 上一次同步时的 30 天总 token；null = 还没对齐基线（第一次刷新只记基线） */
let syncedTokens: number | null = null
let autoSyncing = false
/** 同步失败后的重试时刻：别每 15 秒撞一次 git */
let autoSyncRetryAt = 0

let pollTimer: ReturnType<typeof setInterval> | null = null
let loginTimer: ReturnType<typeof setInterval> | null = null
/**
 * 轮询是否在途。**必须有这个闸**：一次往返可能比 2 秒的间隔还长，
 * 第二次请求会在第一次成功后拿到"state 已不存在"，于是刚登录完就弹两条红条。
 */
let polling = false

const running = computed(() => status.value?.running === true)
const baseUrl = computed(() => access.value?.baseUrl ?? status.value?.baseUrl ?? `http://127.0.0.1:${port.value}/v1`)
/** 弹层要的两样：地址与密钥（模型清单在「模型」那一栏，不在这儿重复一遍） */
const apiKey = computed(() => access.value?.apiKey ?? '')
const stats = computed(() => {
  const list = accounts.value
  // 「可用」按选号口径算：token 可用、额度标记已过期；额度用完的单列一格
  const quota = list.filter(item => quotaActive(item)).length
  const usable = list.filter(item => item.ready && !quotaActive(item)).length
  const disabled = list.filter(item => !item.enabled).length
  const pending = list.filter(item => item.enabled && !item.ready).length
  const remain = Object.values(credits.value).reduce((sum, item) => sum + item.remain, 0)
  const size = Object.values(credits.value).reduce((sum, item) => sum + item.size, 0)
  return { total: list.length, usable, disabled, pending, quota, remain, size }
})

function usageOf(uid: string) {
  return usage.value?.byAccount.find(item => item.uid === uid)
}

function remainPercent(value: GatewayCredits): number {
  if (value.size <= 0)
    return 0
  return Math.min(100, Math.max(0, (value.remain / value.size) * 100))
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function compact(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000)
    return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function stopLoginPolling(): void {
  if (loginTimer) {
    clearInterval(loginTimer)
    loginTimer = null
  }
  loggingIn.value = ''
}

async function refresh(): Promise<void> {
  const result = await window.workbench.gatewayStatus()
  if (!result.ok || !result.data) {
    ElMessage.error(result.error ?? '读取 TBuddy 状态失败')
    return
  }
  status.value = result.data
  port.value = result.data.port

  const [list, rows, info] = await Promise.all([
    window.workbench.gatewayAccounts(),
    window.workbench.gatewayUsageRows(30),
    window.workbench.gatewayAccess(),
  ])
  if (info.ok && info.data)
    access.value = info.data
  if (list.ok && list.data) {
    // 旧后端没有 modelQuotas 这个字段：在这里补成空数组，后面的状态判断就不用到处兜空
    accounts.value = list.data.map(item => ({ ...item, modelQuotas: item.modelQuotas ?? [] }))
    // 账号删掉后它的余额快照要一起丢掉：统计卡里的积分是把 map 全部加起来，
    // 留着旧号会让「剩余 / 总额」凭空多出一个号的数
    const alive = new Set(list.data.map(item => item.uid))
    credits.value = Object.fromEntries(
      Object.entries(credits.value).filter(([uid]) => alive.has(uid)),
    )
  }
  if (rows.ok && rows.data) {
    // 30 天的自然日窗口本来就比 24 小时长，取数不会多带行，整批汇总即可
    const next = summarizeGatewayRows(rows.data.rows, gatewayBucketUnit(30))
    usage.value = next
    maybeAutoSync(next.totalTokens)
  }
}

/**
 * 30 天总 token 每新增 10M，把网关流水推一次 git。
 *
 * 流水被清空、或老行滚出 30 天窗口时总数会掉下来 —— 那时只把基线压回当前值，
 * 不从负数开始攒。第一次刷新也只记基线，不立刻推。
 * 失败 5 分钟后再试，避免每 15 秒轮询都撞一次 git。
 */
function maybeAutoSync(totalTokens: number): void {
  if (!syncEnabled.value || autoSyncing || Date.now() < autoSyncRetryAt)
    return
  if (syncedTokens === null || totalTokens < syncedTokens) {
    syncedTokens = totalTokens
    return
  }
  if (totalTokens - syncedTokens < SYNC_TOKEN_STEP)
    return

  autoSyncing = true
  void window.workbench.gatewayUsageSync(true).then((result) => {
    if (result.ok && result.data)
      syncedTokens = totalTokens
    else
      autoSyncRetryAt = Date.now() + 5 * 60_000
  }).catch(() => {
    autoSyncRetryAt = Date.now() + 5 * 60_000
  }).finally(() => {
    autoSyncing = false
  })
}

async function toggle(): Promise<void> {
  busy.value = true
  try {
    if (running.value) {
      const result = await window.workbench.gatewayStop()
      if (!result.ok)
        ElMessage.error(result.error ?? '停止失败')
    }
    else {
      const result = await window.workbench.gatewayStart(port.value)
      if (!result.ok) {
        ElMessage.error(result.error ?? '启动失败')
        return
      }
    }
    await refresh()
  }
  finally {
    busy.value = false
  }
}

async function startLogin(): Promise<void> {
  stopLoginPolling()
  const result = await window.workbench.gatewayLoginStart()
  if (!result.ok || !result.data) {
    ElMessage.error(result.error ?? '发起登录失败')
    return
  }
  const { state, authUrl } = result.data
  loggingIn.value = state
  loginHint.value = '在浏览器里完成授权'
  await window.workbench.openExternal(authUrl)
  loginTimer = setInterval(() => {
    if (polling)
      return
    void pollLogin(state)
  }, POLL_INTERVAL)
}

async function pollLogin(loginState: string): Promise<void> {
  polling = true
  const result = await window.workbench.gatewayLoginPoll(loginState)
  polling = false
  if (!result.ok || !result.data) {
    polling = false
    stopLoginPolling()
    loginHint.value = ''
    ElMessage.error(result.error ?? '轮询登录失败')
    return
  }
  if (!result.data.done) {
    loginHint.value = result.data.message
    return
  }
  stopLoginPolling()
  loginHint.value = ''
  ElMessage.success(`已添加 ${result.data.account?.label ?? '账号'}`)
  await refresh()
  // 新号进来先查一次余额：否则统计卡上那个 0/0 会一直挂着，看着像没登上
  const added = result.data.account
  if (added)
    await queryOne(added)
}

/**
 * 查一个号的余额。成功时返回 `null`，失败返回错误串 —— **这里不弹提示**：
 * 批量查余额时十个号会弹十条红条，由调用方汇总成一条。
 */
async function queryCredits(account: GatewayAccount): Promise<string | null> {
  creditPending.value = { ...creditPending.value, [account.uid]: true }
  try {
    const result = await window.workbench.gatewayCredits(account.uid)
    if (!result.ok || !result.data)
      return result.error ?? '查询余额失败'
    credits.value = { ...credits.value, [account.uid]: result.data }
    return null
  }
  finally {
    const pending = { ...creditPending.value }
    delete pending[account.uid]
    creditPending.value = pending
  }
}

/** 行内那枚「查余额」：单号，失败就地提示 */
async function queryOne(account: GatewayAccount): Promise<void> {
  const error = await queryCredits(account)
  if (error)
    ElMessage.error(`${account.label}：${error}`)
}

/**
 * 把所有账号的余额查一遍。
 *
 * **并发，不排队**：每个号是一次上游往返（1~3 秒），`for + await` 排着查时第二个号
 * 要等第一个号返回才轮到 —— 界面上看起来就是「只刷新了一个」。`allSettled` 还保证
 * 某个号失败（token 过期之类）不会把后面的号一起带走。
 *
 * `force` 只有点「刷新积分」才给：进页面走一分钟的节流。
 */
async function queryAllCredits(force = false): Promise<void> {
  const list = accounts.value
  if (!list.length || creditBusy.value)
    return
  if (!force && Date.now() - creditAt < CREDIT_THROTTLE)
    return

  creditBusy.value = true
  try {
    const results = await Promise.all(list.map(account => queryCredits(account)))
    creditAt = Date.now()
    const failed = results.filter(item => item !== null)
    if (!failed.length) {
      if (force)
        ElMessage.success(`已刷新 ${list.length} 个账号的积分`)
      return
    }
    // 只报第一条错因，其余合并成个数：同一批失败往往就是同一个原因
    ElMessage.error(
      `${failed.length} / ${list.length} 个账号没查到余额：${failed[0]}`,
    )
  }
  finally {
    creditBusy.value = false
  }
}

async function toggleAccount(account: GatewayAccount): Promise<void> {
  const result = await window.workbench.gatewayAccountSet(account.uid, !account.enabled)
  if (!result.ok)
    ElMessage.error(result.error ?? '修改失败')
  await refresh()
}

/**
 * 改优先级。成功后就地改这一行，不整页 refresh ——
 * refresh 会顺带再查一遍余额（一个号一次上游往返），改个数字不值当。
 */
async function setPriority(account: GatewayAccount, value: number | undefined): Promise<void> {
  if (value === undefined || value === account.priority)
    return
  const result = await window.workbench.gatewayAccountPriority(account.uid, value)
  if (!result.ok) {
    ElMessage.error(result.error ?? '修改优先级失败')
    // 输入框里已经是新值了，读回磁盘上的旧值把它掰回去
    await refresh()
    return
  }
  account.priority = value
}

/**
 * 整号的额度标记（余额 / 积分用完）：这个号暂时整个不可用。
 * 停用 / 待续期的号本来就进不了池子，额度标记等 token 修好再说。
 */
function quotaActive(account: GatewayAccount): boolean {
  return account.enabled && account.ready && account.quotaExhausted
}

/**
 * 按模型的额度标记（上游 code 6004）：只挡这几个模型，号本身还能用别的模型。
 * 与整号标记分开 —— 拿它去算「可用 / 额度用完」会让一个还能用的号被算成下线。
 */
function modelQuotaActive(account: GatewayAccount): boolean {
  return account.enabled && account.ready && account.modelQuotas.length > 0
}

/** 状态标签：停用 → 待续期 → 额度用完 → 部分模型用完 → 可用 */
function statusText(account: GatewayAccount): string {
  if (!account.enabled)
    return '已停用'
  if (!account.ready)
    return '待续期'
  if (quotaActive(account))
    return '额度用完'
  return modelQuotaActive(account) ? '部分模型用完' : '可用'
}

function statusClass(account: GatewayAccount): string {
  if (!account.enabled)
    return 'is-fail'
  if (!account.ready)
    return 'is-muted'
  return quotaActive(account) || modelQuotaActive(account) ? 'is-warn' : 'is-ok'
}

/** 余额条的底色：≥50% 绿、20–50% 琥珀、<20% 红；总量未知时不上色 */
function meterClass(value: GatewayCredits): string {
  if (value.size <= 0)
    return ''
  const percent = value.remain / value.size * 100
  if (percent < 20)
    return 'is-fail'
  if (percent < 50)
    return 'is-warn'
  return 'is-ok'
}

/**
 * 额度用完时状态下面那行小字：告诉用户什么时候回来（其余状态不写第二行）。
 * 整号用完只写时间；按模型的写「模型 + 时间」，还有别的模型就用个数收尾。
 */
function quotaHint(account: GatewayAccount): string {
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

async function removeAccount(account: GatewayAccount): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除账号「${account.label}」？本机的登录状态也会一起删掉。`, '删除账号', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  }
  catch {
    return
  }
  const result = await window.workbench.gatewayAccountDelete(account.uid)
  if (!result.ok) {
    ElMessage.error(result.error ?? '删除失败')
    return
  }
  await refresh()
}

async function rotateKey(): Promise<void> {
  try {
    await ElMessageBox.confirm('换一个密钥？正在用旧密钥的客户端会立刻连不上。', '重设密钥', {
      confirmButtonText: '换一个',
      cancelButtonText: '取消',
      type: 'warning',
    })
  }
  catch {
    return
  }
  const result = await window.workbench.gatewayRotateKey()
  if (!result.ok || !result.data) {
    ElMessage.error(result.error ?? '重设失败')
    return
  }
  await refresh()
}

/** 同步开关跟着登录态 / 仓库地址走：进页面与每次切回来都重新对一下 */
async function loadSyncStatus(): Promise<void> {
  try {
    const status = await window.workbench.gatewaySyncStatus()
    syncEnabled.value = status.enabled
  }
  catch {
    // 读不到就按关闭处理：只读本机
  }
}

/**
 * 后台拉一次远端克隆，读到新流水后重读本地副本。
 *
 * 用量页的读路径只读本地克隆，而克隆平时只有在本机推送时才会被顺带 pull ——
 * 本机一天没有流水时，别的机器推上来的今天永远进不来。节流在适配层（一分钟一次）。
 */
async function pullRemote(): Promise<void> {
  if (!syncEnabled.value)
    return
  const result = await window.workbench.gatewayUsagePull()
  if (result.ok && result.data?.changed)
    await refresh()
}

onMounted(() => {
  void enter()
  pollTimer = setInterval(() => {
    void refresh()
  }, 15000)
})

/**
 * 进页面：刷状态与本机数字，再对一遍余额。
 *
 * 页面在 `KeepAlive` 里（见 App.vue），切走不销毁、切回来也不重新 `mounted` ——
 * 「每次进来都刷新」只能挂在 `onActivated` 上。首次进入 mounted 与 activated 会挨着各触发一次，
 * 用 `entering` 只放一个进去，免得对着上游查两遍。
 */
async function enter(): Promise<void> {
  if (entering)
    return
  entering = true
  try {
    await loadSyncStatus()
    await refresh()
    // 放在首屏之后：拉远端要走网络，不该挡住本机数字上屏
    void pullRemote()
    await queryAllCredits()
  }
  finally {
    entering = false
  }
}

onActivated(() => {
  void enter()
})

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  stopLoginPolling()
})
</script>

<template>
  <section class="gw">
    <!-- 页首：左页签、右全局状态。启停不跟着「账号」页签走 —— 在哪一栏都能看到网关开没开 -->
    <div class="gw__head">
      <el-tabs v-model="tab" class="gw__tabs">
        <el-tab-pane label="账号" name="accounts" />
        <el-tab-pane label="用量" name="usage" />
        <el-tab-pane label="请求" name="requests" />
        <el-tab-pane label="福利" name="perks" />
        <el-tab-pane label="模型" name="models" />
      </el-tabs>
      <div class="gw__run">
        <button type="button" class="gw__run-status" title="接入信息" @click="accessOpen = true">
          <span class="gw__run-dot" :class="{ 'is-ok': running }" />
          <span class="gw__run-text">{{ running ? '运行中' : '已停止' }}</span>
          <span class="gw__run-addr">{{ running ? `127.0.0.1:${port}` : '未监听' }}</span>
        </button>
        <el-button size="small" text :loading="busy" @click="toggle">
          {{ running ? '停止' : '启动' }}
        </el-button>
      </div>
    </div>

    <template v-if="tab === 'accounts'">
      <!-- 统计卡：每张一块毛玻璃，图标各取一档语义色（本页唯一的彩色例外） -->
      <section class="gw__stats">
        <div class="panel gw__stat-card is-total">
          <span class="gw__stat-icon">
            <el-icon><User /></el-icon>
          </span>
          <div class="gw__stat-body">
            <span class="gw__stat-label">账号总数</span>
            <span class="gw__stat-value">{{ stats.total }}</span>
          </div>
        </div>
        <div class="panel gw__stat-card is-ok">
          <span class="gw__stat-icon">
            <el-icon><CircleCheck /></el-icon>
          </span>
          <div class="gw__stat-body">
            <span class="gw__stat-label">可用</span>
            <span class="gw__stat-value">{{ stats.usable }}</span>
          </div>
        </div>
        <div class="panel gw__stat-card is-fail">
          <span class="gw__stat-icon">
            <el-icon><CircleClose /></el-icon>
          </span>
          <div class="gw__stat-body">
            <span class="gw__stat-label">已停用</span>
            <span class="gw__stat-value">{{ stats.disabled }}</span>
          </div>
        </div>
        <div class="panel gw__stat-card is-muted">
          <span class="gw__stat-icon">
            <el-icon><Clock /></el-icon>
          </span>
          <div class="gw__stat-body">
            <span class="gw__stat-label">待续期</span>
            <span class="gw__stat-value">{{ stats.pending }}</span>
          </div>
        </div>
        <div class="panel gw__stat-card is-warn">
          <span class="gw__stat-icon">
            <el-icon><Warning /></el-icon>
          </span>
          <div class="gw__stat-body">
            <span class="gw__stat-label">额度用完</span>
            <span class="gw__stat-value">{{ stats.quota }}</span>
          </div>
        </div>
        <div class="panel gw__stat-card is-credit">
          <span class="gw__stat-icon">
            <el-icon><Coin /></el-icon>
          </span>
          <div class="gw__stat-body">
            <span class="gw__stat-label">积分剩余 / 总额</span>
            <span class="gw__stat-value is-credit">{{ number(stats.remain) }} <span class="gw__stat-dim">/ {{ number(stats.size) }}</span></span>
          </div>
        </div>
      </section>

      <section class="gw__pool">
        <p v-if="loginHint" class="gw__hint">
          {{ loginHint }}
        </p>

        <div v-if="!accounts.length" class="panel">
          <EmptyState compact :icon="Connection" text="还没有账号" hint="点右下角加号登录一个" />
        </div>

        <div v-else class="gw__accounts">
          <article
            v-for="account in accounts"
            :key="account.uid"
            class="panel gw__account-card"
            :class="statusClass(account)"
          >
            <div class="gw__account-head">
              <span class="gw__avatar">{{ account.label.slice(0, 1) }}</span>
              <div class="gw__account-id">
                <span class="gw__name">{{ account.label }}</span>
                <span class="gw__tag" :class="statusClass(account)">{{ statusText(account) }}</span>
              </div>
              <div class="gw__account-actions">
                <el-button size="small" text :loading="creditPending[account.uid]" @click="queryOne(account)">
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

            <div class="gw__account-meta">
              <span class="gw__priority">
                <span class="gw__dim">优先级</span>
                <el-input-number
                  :model-value="account.priority"
                  :min="1"
                  :max="100"
                  :step="1"
                  size="small"
                  controls-position="right"
                  @change="(value: number | undefined) => setPriority(account, value)"
                />
              </span>
            </div>

            <!-- 额度恢复时间只有部分账号有，但这行**始终占位**：少了它，同一排卡片的积分条与三格会错开 -->
            <span
              class="gw__sub"
              :class="{ 'is-empty': !quotaHint(account) }"
              :title="quotaHint(account) || undefined"
            >{{ quotaHint(account) || '—' }}</span>

            <div class="gw__account-credits">
              <div class="gw__credits-line">
                <span class="gw__dim">积分</span>
                <template v-if="credits[account.uid]">
                  <span class="gw__num">{{ number(credits[account.uid]!.remain) }}</span>
                  <span class="gw__dim">/ {{ number(credits[account.uid]!.size) }}</span>
                  <span v-if="credits[account.uid]!.size > 0" class="gw__used">
                    已用 <span class="gw__used-num">{{ number(Math.max(0, credits[account.uid]!.size - credits[account.uid]!.remain)) }}</span>
                  </span>
                </template>
                <span v-else class="gw__dim">未查询</span>
              </div>
              <!-- 余额条同样始终占位：没查过余额的卡不能比查过的卡少一截，否则三格又错开 -->
              <span class="gw__meter" :class="{ 'is-empty': !credits[account.uid] }">
                <span
                  v-if="credits[account.uid]"
                  class="gw__meter-fill"
                  :class="meterClass(credits[account.uid]!)"
                  :style="{ width: `${remainPercent(credits[account.uid]!)}%` }"
                />
              </span>
            </div>

            <div class="gw__account-facts">
              <div class="gw__fact">
                <span class="gw__fact-label">成功 / 失败</span>
                <span class="gw__fact-value">
                  <template v-if="usageOf(account.uid)">
                    {{ usageOf(account.uid)!.requests - usageOf(account.uid)!.failed }} / {{ usageOf(account.uid)!.failed }}
                  </template>
                  <span v-else class="gw__dim">—</span>
                </span>
              </div>
              <div class="gw__fact">
                <span class="gw__fact-label">用量</span>
                <span class="gw__fact-value">
                  {{ usageOf(account.uid) ? compact(usageOf(account.uid)!.promptTokens + usageOf(account.uid)!.completionTokens) : '—' }}
                </span>
              </div>
              <div class="gw__fact">
                <span class="gw__fact-label">均速</span>
                <span class="gw__fact-value">
                  {{ usageOf(account.uid) ? `${usageOf(account.uid)!.tokensPerSec.toFixed(0)} tok/s` : '—' }}
                </span>
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- 页面右下角：刷新积分 + 登录（用 sticky 钉在页面可视区里，终端展开时跟着上移）。
           页面数据走 15 秒轮询，不再放手动键 -->
      <div class="gw__fab">
        <el-tooltip content="刷新积分" placement="top">
          <button
            type="button"
            class="gw__fab-tool"
            :class="{ 'is-busy': creditBusy }"
            :disabled="!accounts.length || creditBusy"
            aria-label="刷新积分"
            @click="queryAllCredits(true)"
          >
            <el-icon><Coin /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="登录账号" placement="top">
          <button
            type="button"
            class="gw__fab-main"
            :disabled="!!loggingIn"
            aria-label="登录账号"
            @click="startLogin"
          >
            <el-icon><Plus /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </template>

    <PerksPane
      v-else-if="tab === 'perks'"
      :accounts="accounts"
      :credits="credits"
      @credits-refresh="queryAllCredits(true)"
    />
    <UsagePane v-else-if="tab === 'usage'" />
    <RequestsPane v-else-if="tab === 'requests'" />
    <ModelsPane v-else />

    <!-- 接入信息：地址与密钥，配客户端时点开抄一份（启停只在顶上一格，不重复进来） -->
    <AccessDialog
      v-model="accessOpen"
      v-model:port="port"
      :running="running"
      :base-url="baseUrl"
      :api-key="apiKey"
      @rotate="rotateKey"
    />
  </section>
</template>

<style scoped>
/*
 * 三个面板都用全局的 .panel 外壳（卡片透明度、阴影、内边距都在那儿），
 * 这里只管行列关系 —— 别在局部再画一遍边框与底色。
 */
.gw {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: var(--sp-3);
}

/**
 * 这一页**整体滚动**：每块按内容高度排，一律不许被压。
 *
 * 必须显式写 —— 纵向 flex 的默认收缩是 1，而 `.panel` 又是 `overflow: hidden`，
 * 于是内容一超屏，接入信息那块就被压到只剩标题加半行，正文从卡片里拦腰露出去（页签也跟着挤扁）。
 * `.panel` 的 overflow 把自动最小尺寸也归了零，光靠 min-height 拦不住，只能从 flex-shrink 下手。
 */
.gw > * {
  flex: none;
}

/**
 * 请求栏、福利栏与模型栏例外：它们自己撑满剩下的高度，表格在卡片里滚、表头钉住
 * （这几栏的根节点都给了 min-height: 0）。
 */
.gw > :deep(.req),
.gw > :deep(.perks),
.gw > :deep(.models) {
  flex: 1 1 auto;
}

/* ---------- 页首：页签 + 全局状态 ---------- */

.gw__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex: none;
  min-width: 0;
}

/**
 * 页签用下划线式导航（`el-tabs`），与下面的范围筛选（`el-segmented` 药丸）分开：
 * 两个一模一样的药丸叠在一起时，分不清哪个是「在哪一栏」、哪个是「看多长时间」。
 * 这里只留文字 + 2px 主色下划线，不铺底色、也不拉满整行。
 */
.gw__tabs {
  flex: none;
}

.gw__tabs :deep(.el-tabs__header) {
  margin: 0;
}

/* 不要 EP 那条贯穿整行的底线，只保留选中项下面那一截 */
.gw__tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

.gw__tabs :deep(.el-tabs__item) {
  height: 34px;
  padding: 0;
  margin-right: var(--sp-5);
  font-size: var(--gw-fs-body);
  color: var(--ink-3);
}

.gw__tabs :deep(.el-tabs__item:last-child) {
  margin-right: 0;
}

.gw__tabs :deep(.el-tabs__item.is-active) {
  color: var(--ink);
  font-weight: 600;
}

.gw__tabs :deep(.el-tabs__item:hover) {
  color: var(--ink);
}

.gw__tabs :deep(.el-tabs__active-bar) {
  height: 2px;
  border-radius: var(--r-pill);
  background: var(--el-color-primary);
}

/* 页签只是导航，内容由下面几栏自己渲染 */
.gw__tabs :deep(.el-tabs__content) {
  display: none;
}

.gw__run {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/* 用 button 而不是给 div 挂 click：键盘与读屏都按按钮认这一块 */
.gw__run-status {
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

.gw__run-status:hover .gw__run-text {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.gw__run-status:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}

/* 状态点：彩色只表达运行状态，这里正好是它该出现的地方 */
.gw__run-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--r-pill);
  background: var(--st-idle);
}

.gw__run-dot.is-ok {
  background: var(--st-ok);
}

.gw__run-text {
  font-size: var(--gw-fs-meta);
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
}

.gw__run-addr {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

/* ---------- 统计卡 ---------- */

.gw__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: var(--sp-3);
  flex: none;
}

/* 每张统计卡自己一块毛玻璃；`.panel` 给底、磨砂、描边与阴影，这里只改排布 */
.panel.gw__stat-card {
  flex-direction: row;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  /* 右上角一层同色柔光：色不压字，只让每张卡有自己的色相 */
  background-image: radial-gradient(
    120% 140% at 100% 0%,
    color-mix(in srgb, var(--stat-color) 12%, transparent),
    transparent 60%
  );
}

.gw__stat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--stat-color) 16%, transparent);
  color: var(--stat-color);
  font-size: 18px;
}

/**
 * 统计卡图标的一档语义色 —— **这是这一页唯一的彩色例外**（用户要求）。
 * 可用 / 待续期 / 额度用完 / 已停用取状态色，总数与积分用固定的蓝与紫，
 * 好让六张卡一眼分得开；其余地方仍按「灰度 + 状态色」走。
 */
.gw__stat-card.is-total {
  --stat-color: #2f6bd8;
}

.gw__stat-card.is-ok {
  --stat-color: var(--st-ok);
}

.gw__stat-card.is-muted {
  --stat-color: #8a94a6;
}

.gw__stat-card.is-warn {
  --stat-color: var(--st-run);
}

.gw__stat-card.is-fail {
  --stat-color: var(--st-fail);
}

.gw__stat-card.is-credit {
  --stat-color: #7c3aed;
}

.gw__stat-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.gw__stat-label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.gw__stat-value {
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 积分数值最长（`9557.49 / 10349`），降一档字号才放得下 */
.gw__stat-value.is-credit {
  font-size: 17px;
}

.gw__stat-dim {
  font-size: var(--gw-fs-meta);
  font-weight: 400;
  color: var(--ink-3);
}

/* ---------- 账号池 ---------- */

.gw__pool {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  flex: none;
}

.gw__hint {
  margin: 0;
  font-size: var(--gw-fs-meta);
  color: var(--ink-3);
}

/* 账号卡：一行放不下四张时自动往下排 */
.gw__accounts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: var(--sp-3);
}

.panel.gw__account-card {
  position: relative;
  gap: var(--sp-3);
  padding: var(--sp-4);
  overflow: hidden;
  /* 卡面也铺一层极淡的状态色：整页才不至于一片灰 */
  background-image: radial-gradient(
    120% 120% at 100% 0%,
    color-mix(in srgb, var(--card-color) 7%, transparent),
    transparent 55%
  );
}

/**
 * 左侧一截状态色标：与用量页的积分总账同一套做法 ——
 * 颜色只表达状态（可用绿 / 待续期灰 / 额度用完琥珀 / 已停用红），不做装饰。
 */
.gw__account-card::before {
  content: '';
  position: absolute;
  top: var(--sp-3);
  bottom: var(--sp-3);
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--card-color, transparent);
}

.gw__account-card.is-ok {
  --card-color: var(--st-ok);
}

.gw__account-card.is-warn {
  --card-color: var(--st-run);
}

.gw__account-card.is-fail {
  --card-color: var(--st-fail);
}

.gw__account-card.is-muted {
  --card-color: var(--ink-3);
}

.gw__account-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-2);
}

/* 账号头像：首字 + 账号色（紫，与统计卡的紫同一套），给每张卡一个颜色锚点 */
.gw__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--type-color) 15%, transparent);
  color: var(--type-color);
  font-size: var(--gw-fs-title);
  font-weight: 600;
  --type-color: #7c3aed;
}

.gw__account-id {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

/* 状态标签跟在名称下面：列方向下不拉伸，保持小标签的形状 */
.gw__account-id .gw__tag {
  align-self: flex-start;
}

.gw__name {
  font-size: var(--gw-fs-title);
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gw__tag {
  display: inline-block;
  flex: none;
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--gw-fs-micro);
}

.gw__tag.is-ok {
  color: var(--st-ok);
}

/* 待续期是「等一下」：中性灰；额度用完用琥珀，停用才是红 */
.gw__tag.is-muted {
  color: var(--ink-3);
}

.gw__tag.is-warn {
  color: var(--st-run);
}

.gw__tag.is-fail {
  color: var(--st-fail);
}

.gw__account-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.gw__priority {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.gw__priority :deep(.el-input-number) {
  width: 76px;
}

/* 状态标签下面那行小字（目前只有额度恢复时间）。
   它**始终占位**（没有内容时隐藏而不是删掉）：同一排卡片的高度才能一致，
   积分条与成功 / 失败那三格才对得齐；太长时截断，完整内容在 title 里。 */
.gw__sub {
  overflow: hidden;
  font-size: var(--gw-fs-micro);
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink-3);
}

.gw__sub.is-empty {
  visibility: hidden;
}

.gw__account-credits {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.gw__credits-line {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
  font-variant-numeric: tabular-nums;
}

/* 已用量贴着行尾：剩多少、用了多少在同一行读完 */
.gw__used {
  margin-left: auto;
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.gw__used-num {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--ink-2);
}

.gw__num {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 600;
  color: var(--ink);
}

.gw__dim {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

/**
 * 余额条：彩色那段是**剩余**（≥50% 绿 / 20–50% 琥珀 / <20% 红），
 * 空出来的灰底是**已用** —— 所以底色取 `--bg-inset` 而不是几乎看不见的 `--bg-subtle`。
 * 这是这一页的第二处彩色例外：余额见底是可行动的状态，不是装饰。
 */
.gw__meter {
  display: block;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  overflow: hidden;
}

/* 没查过余额时留出同一条的高度，别让这张卡的三格比旁边高 */
.gw__meter.is-empty {
  visibility: hidden;
}

.gw__meter-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ink-3);
}

.gw__meter-fill.is-ok {
  background: var(--st-ok);
}

.gw__meter-fill.is-warn {
  background: var(--st-run);
}

.gw__meter-fill.is-fail {
  background: var(--st-fail);
}

.gw__account-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.gw__fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.gw__fact-label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.gw__fact-value {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-meta);
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 操作按钮在卡片的右上角 */
.gw__account-actions {
  display: flex;
  align-items: center;
  flex: none;
  gap: var(--sp-1);
}

/* ---------- 右下角悬浮动作 ---------- */

/*
 * 钉在**页面**右下角，不是窗口右下角。
 *
 * 用 sticky 而不是 fixed：它属于「账号」栏，只该浮在这一页自己的可视区里。
 * 终端面板是内容列里的一行 —— 展开后页面变矮，fixed 会照旧贴在窗口底边、
 * 正落在终端面板身上（还被面板的暗底衬出来）；sticky 约束在滚动容器（.gw）内部，
 * 页面可视区一矮它就跟着上移到面板上沿，永远不会压在终端上。
 * 内容不满一屏时靠 margin-top: auto 压到底（没有可滚的余量时 sticky 不生效）。
 *
 * 那几处 sp-5 - sp-3：sticky 的 bottom 与下面的外边距都从滚动容器的**内容盒**量起，
 * 而 .gw 自己有一圈 sp-3 内边距 —— 各减掉这圈，落地才是离页面边 sp-5（与原先贴窗口时一致）。
 */
.gw__fab {
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

/* 唯一一颗常驻工具：刷新积分（页面数据走 15 秒轮询，不必手动） */
.gw__fab-tool {
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

.gw__fab-tool:hover:not(:disabled) {
  color: var(--ink);
  box-shadow: var(--shadow-hover);
}

.gw__fab-tool:disabled {
  opacity: 0.45;
  cursor: default;
}

.gw__fab-tool:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 3px;
}

/* 刷新积分在途：图标转起来，跟页面里的 loading 一致 */
.gw__fab-tool.is-busy :deep(.el-icon) {
  animation: gw-spin 1s linear infinite;
}

@keyframes gw-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 登录：一颗常驻加号 */
.gw__fab-main {
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

.gw__fab-main:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: var(--shadow-pop);
}

.gw__fab-main:disabled {
  opacity: 0.45;
  cursor: default;
}

.gw__fab-main:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 3px;
}
</style>
