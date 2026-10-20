<script setup lang="ts">
import type { GatewayAccess, GatewayAccount, GatewayCredits, GatewayStatus, GatewayUsageSummary } from '@/workbench/gateway'
import { Connection } from '@element-plus/icons-vue'
import { gatewayBucketUnit, summarizeGatewayRows } from '@workbench/usage'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onActivated, onBeforeUnmount, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import AccessDialog from './AccessDialog.vue'
import ModelsPane from './ModelsPane.vue'
import RequestsPane from './RequestsPane.vue'
import UsagePane from './UsagePane.vue'

/**
 * 网关页。
 *
 * 布局照 Hub 的看板来：顶上一条统计带，下面按「账号 / 用量 / 请求」分栏。
 * 数据分三处拿 —— 状态（Rust 的 Gateway）、账号余额（每个账号一次查询）、
 * 用量汇总（usage.jsonl 聚合）。**这一页不算数**，数字都是现成的。
 *
 * 余额是**唯一要打上游**的那一项（每个号一次往返），所以它有自己的一套节奏：
 * 进页面查一遍、切回「账号 / 用量」时再对一遍（一分钟内不重复），点「刷新积分」立即查。
 * 状态与用量是本机读文件，跟着 15 秒的轮询走，不必手动刷。
 *
 * 接入信息（地址 / 密钥）不常驻：那张卡会把下面几栏一直往下推，
 * 而它只是配客户端时抄一次的东西 —— 收进 AccessDialog，统计带最后一格点开。
 */
const POLL_INTERVAL = 2000
/** 自动查余额的最小间隔：一个号一次上游往返，切个页签就重查一遍太费 */
const CREDIT_THROTTLE = 60_000

const tab = ref<'accounts' | 'usage' | 'requests' | 'models'>('accounts')
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
  const usable = list.filter(item => item.ready).length
  const disabled = list.filter(item => !item.enabled).length
  const pending = list.filter(item => item.enabled && !item.ready).length
  const remain = Object.values(credits.value).reduce((sum, item) => sum + item.remain, 0)
  const size = Object.values(credits.value).reduce((sum, item) => sum + item.size, 0)
  return { total: list.length, usable, disabled, pending, remain, size }
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
    ElMessage.error(result.error ?? '读取网关状态失败')
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
    accounts.value = list.data
    // 账号删掉后它的余额快照要一起丢掉：统计带那一格是把 map 全部加起来，
    // 留着旧号会让「剩余 / 总额」凭空多出一个号的数
    const alive = new Set(list.data.map(item => item.uid))
    credits.value = Object.fromEntries(
      Object.entries(credits.value).filter(([uid]) => alive.has(uid)),
    )
  }
  if (rows.ok && rows.data)
    usage.value = summarizeGatewayRows(rows.data, gatewayBucketUnit(30))
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

async function startLogin(realm: 'workbuddy' | 'codebuddy'): Promise<void> {
  stopLoginPolling()
  const result = await window.workbench.gatewayLoginStart(realm)
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
  // 新号进来先查一次余额：否则统计带上那个 0/0 会一直挂着，看着像没登上
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
    await refresh()
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
    <el-segmented
      v-model="tab"
      :options="[{ label: '账号', value: 'accounts' }, { label: '用量', value: 'usage' }, { label: '请求', value: 'requests' }, { label: '模型', value: 'models' }]"
      size="small"
      class="gw__tabs"
    />

    <template v-if="tab === 'accounts'">
      <!-- 统计带：一眼看清「几个号、能用几个、还剩多少」。它数的是账号，所以跟着「账号」这一栏走 -->
      <section class="panel gw__stats">
        <div class="gw__stat">
          <span class="gw__stat-num">{{ stats.total }}</span>
          <span class="gw__stat-label">账号总数</span>
        </div>
        <div class="gw__stat">
          <span class="gw__stat-num is-ok">{{ stats.usable }}</span>
          <span class="gw__stat-label">可用</span>
        </div>
        <div class="gw__stat">
          <span class="gw__stat-num">{{ stats.disabled }}</span>
          <span class="gw__stat-label">已停用</span>
        </div>
        <div class="gw__stat">
          <span class="gw__stat-num" :class="{ 'is-warn': stats.pending > 0 }">{{ stats.pending }}</span>
          <span class="gw__stat-label">待续期</span>
        </div>
        <div class="gw__stat">
          <span class="gw__stat-num">{{ number(stats.remain) }} / {{ number(stats.size) }}</span>
          <span class="gw__stat-label">积分剩余 / 总额</span>
        </div>
        <!-- 最后一格是这一页的两个动作：点状态开接入弹层，点右边那枚就地启停 -->
        <div class="gw__stat gw__stat--run">
          <button type="button" class="gw__stat-open" title="接入信息" @click="accessOpen = true">
            <span class="gw__stat-num" :class="{ 'is-ok': running }">{{ running ? '运行中' : '已停止' }}</span>
            <span class="gw__stat-label">{{ running ? `127.0.0.1:${port}` : '未监听' }}</span>
          </button>
          <el-button size="small" text :loading="busy" @click="toggle">
            {{ running ? '停止' : '启动' }}
          </el-button>
        </div>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="gw__panel-title">
            账号池
          </h2>
          <div class="gw__section-actions">
            <el-button size="small" :disabled="!!loggingIn" @click="startLogin('workbuddy')">
              登录 WorkBuddy
            </el-button>
            <el-button size="small" :disabled="!!loggingIn" @click="startLogin('codebuddy')">
              登录 CodeBuddy
            </el-button>
            <el-button
              size="small"
              :disabled="!accounts.length || creditBusy"
              :loading="creditBusy"
              @click="queryAllCredits(true)"
            >
              刷新积分
            </el-button>
          </div>
        </div>

        <div class="panel__body">
          <p v-if="loginHint" class="gw__hint">
            {{ loginHint }}
          </p>

          <EmptyState v-if="!accounts.length" compact :icon="Connection" text="还没有账号" hint="点右上角登录一个" />

          <table v-else class="gw__table">
            <thead>
              <tr>
                <th>账号</th>
                <th>状态</th>
                <th class="gw__col-credits">
                  积分
                </th>
                <th class="gw__cell-num">
                  成功 / 失败
                </th>
                <th class="gw__cell-num">
                  用量
                </th>
                <th class="gw__cell-num">
                  均速
                </th>
                <th class="gw__col-actions">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="account in accounts" :key="account.uid">
                <td>
                  <div class="gw__account">
                    <span class="gw__name">{{ account.label }}</span>
                    <span class="gw__uid">{{ account.uid }}</span>
                  </div>
                </td>
                <td>
                  <span class="gw__tag" :class="account.ready ? 'is-ok' : (account.enabled ? 'is-warn' : 'is-off')">
                    {{ account.ready ? '可用' : (account.enabled ? '待续期' : '已停用') }}
                  </span>
                  <span class="gw__realm">{{ account.realmLabel }}</span>
                </td>
                <td class="gw__col-credits">
                  <template v-if="credits[account.uid]">
                    <div class="gw__credits-line">
                      <span class="gw__num">{{ number(credits[account.uid]!.remain) }}</span>
                      <span class="gw__dim">/ {{ number(credits[account.uid]!.size) }}</span>
                    </div>
                    <span class="gw__meter">
                      <span class="gw__meter-fill" :style="{ width: `${remainPercent(credits[account.uid]!)}%` }" />
                    </span>
                  </template>
                  <span v-else class="gw__dim">未查询</span>
                </td>
                <td class="gw__cell-num">
                  <template v-if="usageOf(account.uid)">
                    <span class="gw__num">{{ usageOf(account.uid)!.requests - usageOf(account.uid)!.failed }}</span>
                    <span class="gw__dim"> / {{ usageOf(account.uid)!.failed }}</span>
                  </template>
                  <span v-else class="gw__dim">—</span>
                </td>
                <td class="gw__cell-num">
                  <span v-if="usageOf(account.uid)" class="gw__chip">
                    {{ compact(usageOf(account.uid)!.promptTokens + usageOf(account.uid)!.completionTokens) }}
                  </span>
                  <span v-else class="gw__dim">—</span>
                </td>
                <td class="gw__cell-num">
                  <span v-if="usageOf(account.uid)" class="gw__dim">
                    {{ usageOf(account.uid)!.tokensPerSec.toFixed(0) }} tok/s
                  </span>
                  <span v-else class="gw__dim">—</span>
                </td>
                <td class="gw__col-actions">
                  <el-button size="small" text :loading="creditPending[account.uid]" @click="queryOne(account)">
                    查余额
                  </el-button>
                  <el-button size="small" text @click="toggleAccount(account)">
                    {{ account.enabled ? '停用' : '启用' }}
                  </el-button>
                  <el-button size="small" text @click="removeAccount(account)">
                    删除
                  </el-button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

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
 * 请求栏与模型栏例外：它们自己撑满剩下的高度，表格在卡片里滚、表头钉住
 * （这两栏的根节点都给了 min-height: 0）。
 */
.gw > :deep(.req),
.gw > :deep(.models) {
  flex: 1 1 auto;
}

.gw__panel-title {
  margin: 0;
  font-size: var(--gw-fs-title);
  font-weight: 600;
  color: var(--ink);
}

/* ---------- 统计带 ---------- */

.gw__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(0, 1.3fr) minmax(0, 1fr);
  gap: var(--sp-4);
  flex: none;
}

.gw__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.gw__stat-num {
  font-size: var(--gw-fs-body);
  font-weight: 600;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gw__stat-num.is-ok {
  color: var(--st-ok);
}

.gw__stat-num.is-warn {
  color: var(--st-fail);
}

.gw__stat-label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

/* ---------- 统计带最后一格：状态可点、右边就地启停 ---------- */

.gw__stat--run {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

/* 用 button 而不是给 div 挂 click：键盘与读屏都按按钮认这一格 */
.gw__stat-open {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.gw__stat-open:hover .gw__stat-num {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.gw__stat-open:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}

/* ---------- 账号池 ---------- */

.gw__section-actions {
  display: flex;
  gap: var(--sp-1);
}

.gw__hint {
  margin: 0;
  font-size: var(--gw-fs-meta);
  color: var(--ink-3);
}

.gw__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--gw-fs-meta);
}

.gw__table th {
  text-align: left;
  font-weight: 400;
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  padding: var(--sp-1) var(--sp-2) var(--sp-1) 0;
  white-space: nowrap;
}

.gw__table td {
  padding: var(--sp-2) var(--sp-2) var(--sp-2) 0;
  color: var(--ink-2);
  vertical-align: middle;
}

.gw__table tbody tr + tr td {
  border-top: 1px solid var(--border);
}

.gw__col-credits {
  width: 168px;
}

/* 数字列：固定宽度 + 居中 —— 表头与数字都落在列心，几行才对得齐 */
.gw__cell-num {
  width: 88px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.gw__table th.gw__cell-num {
  text-align: center;
}

.gw__col-actions {
  width: 200px;
  text-align: center;
  white-space: nowrap;
}

/* 表头得跟着列里的按钮一起居中：`.gw__table th` 的 left 比单类选择器更硬，只能写成 th.xxx */
.gw__table th.gw__col-actions {
  text-align: center;
}

.gw__account {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.gw__name {
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gw__uid {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gw__tag {
  display: inline-block;
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--gw-fs-micro);
}

.gw__tag.is-ok {
  color: var(--st-ok);
}

.gw__tag.is-warn {
  color: var(--st-fail);
}

.gw__tag.is-off {
  color: var(--ink-3);
}

.gw__realm {
  margin-left: var(--sp-1);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.gw__credits-line {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-bottom: 4px;
  font-variant-numeric: tabular-nums;
}

.gw__num {
  color: var(--ink);
}

.gw__dim {
  color: var(--ink-3);
}

/* 余额条：**不上状态色** —— 彩色只表达运行状态，余额高低不是状态 */
.gw__meter {
  display: block;
  height: 4px;
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  overflow: hidden;
}

.gw__meter-fill {
  display: block;
  height: 100%;
  background: var(--ink-3);
}

.gw__chip {
  display: inline-block;
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-2);
  font-size: var(--gw-fs-micro);
  font-variant-numeric: tabular-nums;
}
</style>
