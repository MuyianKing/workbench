<script setup lang="ts">
import type {
  GatewayAccount,
  GatewayActionResult,
  GatewayActivityRow,
  GatewayCredits,
  GatewayGrantAccount,
  GatewayGrowthSummary,
  GatewayGrowthTask,
  GatewayTaskAccount,
} from '@/workbench/gateway'
import {
  Calendar,
  Coin,
  Lightning,
  MagicStick,
  Position,
  Refresh,
  Ticket,
  Trophy,
} from '@element-plus/icons-vue'
import { dailyGrowthCredits, isGrowthPerkPackage } from '@workbench/usage'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import GatewayTable from './GatewayTable.vue'
import PerksCreditsChart from './PerksCreditsChart.vue'

/**
 * 任务福利栏。
 *
 * 口径来自 workbuddy2api-hub 的「任务与福利」页：成长任务 / 签到 / 猫猫旅行 /
 * 连登管家，外加近一个月的积分柱状图（积分包流水）。与参考项目的差别只有
 * 「什么时候去要数据」——这里只在**进这一栏、切账号、点按钮**时取一次，没有定时器；
 * 每个动作都是用户点出来的一次真实上游请求。
 *
 * 这一栏自己不查余额：积分总额取父组件已经查过的快照（`credits`），动作做完由
 * 这一栏发 `credits-refresh` 让父组件重查一遍。这样进这一栏不会为了数字格多打
 * N 次余额查询；柱状图读的是积分流水（每个号一次只读 POST）。
 */
const props = defineProps<{
  accounts: GatewayAccount[]
  credits: Record<string, GatewayCredits>
}>()

const emit = defineEmits<{
  (event: 'credits-refresh'): void
}>()

type ActionKind = 'tasks' | 'checkin' | 'travel' | 'streak'

const selected = ref('all')
const taskAccounts = ref<GatewayTaskAccount[]>([])
const tasks = ref<GatewayGrowthTask[]>([])
const summary = ref<GatewayGrowthSummary>(emptySummary())
const activity = ref<GatewayActivityRow[]>([])
const taskLoading = ref(false)
const running = ref<ActionKind | ''>('')
const loaded = ref(false)
const grants = ref<GatewayGrantAccount[]>([])
const grantsLoading = ref(false)
const grantsError = ref('')
/** 积分流水的请求序号：切账号切得快时只认最后一次的结果 */
let grantsSeq = 0

function emptySummary(): GatewayGrowthSummary {
  return {
    energy: 0,
    streakDays: 0,
    makeupCards: 0,
    lotteryChances: 0,
    travel: { state: 'unknown', dailyLimitReached: false, rewardCredit: 0 },
  }
}

const accounts = computed(() => props.accounts.filter(item => item.enabled))
const busy = computed(() => running.value !== '')

/** 当前选择下要看的号：`all` 是全部已启用的号 */
const scope = computed(() => {
  if (selected.value === 'all')
    return accounts.value
  return accounts.value.filter(item => item.uid === selected.value)
})

/** 今天的某一次尝试（同一 uid + task 取最新一条） */
function todayOf(uid: string, task: string) {
  const rows = activity.value ?? []
  return rows.filter(row => row.uid === uid && row.task === task).pop()
}

const cnDone = computed(() => scope.value.filter(item => todayOf(item.uid, 'checkin')?.ok === true))
const cnCheckinText = computed(() => {
  if (!scope.value.length)
    return '无可用账号'
  const done = cnDone.value.length
  const total = scope.value.length
  if (done === total)
    return `今日已领 (${done}/${total})`
  if (done > 0)
    return `部分已领 (${done}/${total})`
  return `今日未领 (0/${total})`
})
const cnCheckinTone = computed(() => {
  if (!scope.value.length)
    return 'is-muted'
  const done = cnDone.value.length
  if (done === scope.value.length)
    return 'is-ok'
  return done > 0 ? 'is-warn' : 'is-fail'
})

const catState = computed(() => {
  const travel = summary.value.travel
  if (travel.state === 'arrived')
    return { text: '待领奖', tone: 'is-ok' }
  if (travel.state === 'traveling')
    return { text: '旅行中', tone: 'is-warn' }
  if (travel.dailyLimitReached)
    return { text: '今日已完成', tone: 'is-muted' }
  if (travel.state === 'idle')
    return { text: '在家待命', tone: 'is-ok' }
  return { text: '未知', tone: 'is-muted' }
})

/** 福利积分：与柱状图同一条口径（发放来源 / 包名 / 发放原因，见 @workbench/usage） */
function isPerk(pkg: GatewayCredits['packages'][number]): boolean {
  return isGrowthPerkPackage({ source: pkg.grantSource, name: pkg.name, reason: pkg.grantReason })
}

function perkTotal(list: GatewayAccount[], pick: (pkg: GatewayCredits['packages'][number]) => boolean): number | null {
  const entries = list
    .map(item => props.credits[item.uid])
    .filter((item): item is GatewayCredits => Boolean(item))
  if (!entries.length)
    return null
  let total = 0
  for (const entry of entries) {
    for (const pkg of entry.packages) {
      if (pick(pkg))
        total += pkg.size
    }
  }
  return total
}

const granted = computed(() => perkTotal(scope.value, isPerk))

/** 柱状图：当前范围内的积分发放按发放日相加，只留最近 30 天（含今天） */
const creditDays = computed(() => dailyGrowthCredits(grants.value, 30))
const creditTotal = computed(() => creditDays.value.reduce((sum, day) => sum + day.credit, 0))
const creditFailed = computed(() => grants.value.filter(item => item.error).length)
const scopeLabel = computed(() => {
  if (selected.value === 'all')
    return '全部账号合计'
  return accounts.value.find(item => item.uid === selected.value)?.label ?? '当前账号'
})

function fmt(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function grantedText(value: number | null): string {
  return value === null ? '—' : `+${fmt(value)} 积分`
}

function statusOf(task: GatewayGrowthTask): { text: string, tone: string } {
  if (task.unforgeable)
    return { text: '需真实操作', tone: 'is-warn' }
  if (task.status === 'claimed')
    return { text: '已领取', tone: 'is-muted' }
  if (task.status === 'completed' || task.current >= task.target)
    return { text: '待领奖', tone: 'is-ok' }
  if (task.status === 'accepted' || task.status === 'in_progress')
    return { text: '进行中', tone: '' }
  return { text: '未接取', tone: 'is-muted' }
}

function progressOf(task: GatewayGrowthTask): string {
  if (task.status === 'claimed' || task.status === 'completed')
    return '已达成'
  return `${task.current} / ${task.target}`
}

function rewardOf(task: GatewayGrowthTask): string {
  const parts: string[] = []
  if (task.rewardCredit)
    parts.push(`+${task.rewardCredit} 积分`)
  if (task.rewardEnergy)
    parts.push(`+${task.rewardEnergy} 能量`)
  return parts.length ? parts.join(' · ') : '—'
}

function summarize(results: GatewayActionResult[]): string {
  return results.map(item => `${item.nickname}：${item.message}`).join('；')
}

async function loadActivity(): Promise<void> {
  const result = await window.workbench.gatewayActivityToday()
  if (result.ok && result.data)
    activity.value = result.data
}

/**
 * 读当前范围的积分流水。选「全部账号」时后端逐个已启用账号各读一次（只读 POST），
 * 界面按发放日相加；某个号失败只让它自己那条带 `error`，整张图照样画。
 */
async function loadGrants(): Promise<void> {
  const seq = ++grantsSeq
  if (!accounts.value.length) {
    grants.value = []
    grantsError.value = ''
    grantsLoading.value = false
    return
  }
  grantsLoading.value = true
  try {
    const result = await window.workbench.gatewayCreditGrants(
      selected.value === 'all' ? undefined : selected.value,
    )
    if (seq !== grantsSeq)
      return
    if (!result.ok || !result.data) {
      grants.value = []
      grantsError.value = result.error ?? '读取积分流水失败'
      return
    }
    grants.value = result.data
    // 全都失败时不能显示「还没有获得积分」：那是在拿「没读到」冒充「没有」
    grantsError.value = result.data.length > 0 && result.data.every(item => item.error)
      ? result.data.find(item => item.error)?.error ?? '读取积分流水失败'
      : ''
  }
  finally {
    if (seq === grantsSeq)
      grantsLoading.value = false
  }
}

async function loadTasks(): Promise<void> {
  if (!accounts.value.length) {
    taskAccounts.value = []
    tasks.value = []
    summary.value = emptySummary()
    loaded.value = true
    return
  }
  taskLoading.value = true
  try {
    const result = await window.workbench.gatewayTasks(selected.value === 'all' ? undefined : selected.value)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '读取成长任务失败')
      return
    }
    taskAccounts.value = result.data.accounts
    tasks.value = result.data.tasks
    summary.value = result.data.summary
    // 选中的号被删 / 停用后回到「全部」，下次取数不会空转
    if (selected.value !== 'all' && !result.data.accounts.some(item => item.uid === selected.value))
      selected.value = 'all'
  }
  finally {
    taskLoading.value = false
    loaded.value = true
  }
}

async function switchAccount(): Promise<void> {
  await Promise.all([loadTasks(), loadGrants()])
}

async function runAction(kind: ActionKind): Promise<void> {
  if (busy.value)
    return

  const uid = selected.value === 'all' ? undefined : selected.value
  running.value = kind
  try {
    if (kind === 'tasks') {
      const result = await window.workbench.gatewayTasksRun(uid)
      if (!result.ok || !result.data) {
        ElMessage.error(result.error ?? '执行成长任务失败')
        return
      }
      ElMessage.success(`成长任务流水执行完成，共增加 +${result.data.creditAdded} 积分`)
      await Promise.all([loadActivity(), loadTasks(), loadGrants()])
      emit('credits-refresh')
      return
    }

    const result = kind === 'checkin'
      ? await window.workbench.gatewayCheckin(uid)
      : kind === 'travel'
        ? await window.workbench.gatewayTasksTravel(uid)
        : await window.workbench.gatewayTasksStreak(uid)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '操作失败')
      return
    }
    const ok = result.data.some(item => item.ok)
    const text = summarize(result.data)
    if (ok)
      ElMessage.success(text)
    else
      ElMessage.warning(text)
    await Promise.all([loadActivity(), loadTasks(), loadGrants()])
    emit('credits-refresh')
  }
  finally {
    running.value = ''
  }
}

onMounted(() => {
  void loadActivity()
  void loadTasks()
  void loadGrants()
})
</script>

<template>
  <div class="perks">
    <!-- 成长任务与日常福利 -->
    <section class="panel perks__section">
      <header class="perks__head">
        <div class="perks__head-text">
          <h3 class="perks__title">
            任务与福利
          </h3>
          <p class="perks__hint">
            全自动批量接取、事件上报点亮并领取官方成长积分，以及猫猫日常与打卡
          </p>
        </div>
        <div class="perks__actions">
          <el-select
            v-model="selected"
            size="small"
            class="perks__select"
            :disabled="busy || !accounts.length"
            @change="switchAccount"
          >
            <el-option value="all" label="全部账号（批量）" />
            <el-option
              v-for="item in taskAccounts"
              :key="item.uid"
              :value="item.uid"
              :label="item.label"
            />
          </el-select>
          <el-button
            size="small"
            :disabled="busy || !accounts.length"
            :loading="running === 'checkin'"
            @click="runAction('checkin')"
          >
            Buddy 加油站签到
          </el-button>
          <el-button
            size="small"
            type="primary"
            :disabled="busy || !accounts.length"
            :loading="running === 'tasks'"
            @click="runAction('tasks')"
          >
            一键做任务领积分
          </el-button>
          <el-button
            size="small"
            :disabled="busy || !accounts.length"
            :loading="running === 'travel'"
            @click="runAction('travel')"
          >
            猫猫旅行
          </el-button>
          <el-button
            size="small"
            :disabled="busy || !accounts.length"
            :loading="running === 'streak'"
            @click="runAction('streak')"
          >
            连登管家与抽奖
          </el-button>
        </div>
      </header>

      <div class="perks__summary">
        <div class="perks__cell is-gas">
          <span class="perks__icon">
            <el-icon><Calendar /></el-icon>
          </span>
          <div class="perks__cell-body">
            <span class="perks__label">Buddy 加油站</span>
            <span class="perks__value" :class="cnCheckinTone">{{ cnCheckinText }}</span>
          </div>
        </div>
        <div class="perks__cell is-streak">
          <span class="perks__icon">
            <el-icon><Trophy /></el-icon>
          </span>
          <div class="perks__cell-body">
            <span class="perks__label">当前连续登录天数</span>
            <span class="perks__value">{{ summary.streakDays }} 天</span>
          </div>
        </div>
        <div class="perks__cell is-muted">
          <span class="perks__icon">
            <el-icon><Ticket /></el-icon>
          </span>
          <div class="perks__cell-body">
            <span class="perks__label">补签卡余额</span>
            <span class="perks__value">{{ summary.makeupCards }} 张</span>
          </div>
        </div>
        <div class="perks__cell is-warn">
          <span class="perks__icon">
            <el-icon><MagicStick /></el-icon>
          </span>
          <div class="perks__cell-body">
            <span class="perks__label">成长抽奖次数</span>
            <span class="perks__value">{{ summary.lotteryChances }} 次</span>
          </div>
        </div>
        <div class="perks__cell is-cat">
          <span class="perks__icon">
            <el-icon><Position /></el-icon>
          </span>
          <div class="perks__cell-body">
            <span class="perks__label">猫猫旅行状态</span>
            <span class="perks__value" :class="catState.tone">{{ catState.text }}</span>
          </div>
        </div>
        <div class="perks__cell is-energy">
          <span class="perks__icon">
            <el-icon><Lightning /></el-icon>
          </span>
          <div class="perks__cell-body">
            <span class="perks__label">成长能量余额</span>
            <span class="perks__value">{{ summary.energy }}</span>
          </div>
        </div>
        <div class="perks__cell is-grant">
          <span class="perks__icon">
            <el-icon><Coin /></el-icon>
          </span>
          <div class="perks__cell-body">
            <span class="perks__label">已获取福利总积分</span>
            <span class="perks__value">{{ grantedText(granted) }}</span>
          </div>
        </div>
      </div>

      <PerksCreditsChart
        v-if="accounts.length"
        :days="creditDays"
        :total="creditTotal"
        :scope="scopeLabel"
        :failed="creditFailed"
        :loading="grantsLoading"
        :error="grantsError"
      />

      <div class="perks__subhead">
        <h4>成长任务</h4>
        <span class="perks__dim">{{ tasks.length ? `共 ${tasks.length} 项` : '—' }}</span>
      </div>

      <div class="perks__table-wrap">
        <div v-if="!accounts.length" class="panel perks__empty">
          <EmptyState compact :icon="Trophy" text="还没有启用的账号" hint="先在「账号」栏登录一个" />
        </div>
        <div v-else-if="taskLoading && !loaded" class="panel perks__loading">
          <el-icon class="perks__spin">
            <Refresh />
          </el-icon>
          <span>读取成长任务…</span>
        </div>
        <div v-else-if="!tasks.length" class="panel perks__empty">
          <EmptyState compact :icon="Trophy" text="当前账号没有成长任务" hint="企业版账号没有成长体系；普通账号明天再来看看" />
        </div>
        <GatewayTable
          v-else
          :data="tasks"
          row-key="taskCode"
          height="100%"
        >
          <el-table-column label="任务名称 / 代码" align="center">
            <template #default="{ row }">
              <span class="perks__task-name">{{ row.name }}</span>
              <span class="perks__task-code">{{ row.taskCode }}</span>
            </template>
          </el-table-column>
          <el-table-column label="任务说明" align="center">
            <template #default="{ row }">
              <span class="perks__desc">{{ row.description || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="进度" align="center" class-name="gw-num" label-class-name="gw-num">
            <template #default="{ row }">
              {{ progressOf(row) }}
            </template>
          </el-table-column>
          <el-table-column label="奖励" align="center" class-name="gw-num" label-class-name="gw-num">
            <template #default="{ row }">
              {{ rewardOf(row) }}
            </template>
          </el-table-column>
          <el-table-column label="状态" align="center">
            <template #default="{ row }">
              <span class="perks__pill" :class="statusOf(row).tone">{{ statusOf(row).text }}</span>
            </template>
          </el-table-column>
        </GatewayTable>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 整栏撑满页签下面剩下的高度（增长由 GatewayView 给），表格才能吃到窗口底部 */
.perks {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  min-height: 0;
  font-size: var(--gw-fs-body);
}

/* 每一段是一张完整的面板：标题、动作、数字与表格都在同一张卡里，
   不再把标题直接摆在壁纸上（那样它和下面的玻璃卡是两个层级）。 */
.panel.perks__section {
  flex: 1 1 auto;
  min-height: 0;
  gap: var(--sp-3);
  padding-bottom: var(--sp-4);
}

.perks__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
  flex: none;
}

.perks__head-text {
  min-width: 0;
}

.perks__title {
  margin: 0;
  font-size: var(--gw-fs-title);
  font-weight: 600;
  color: var(--ink);
}

.perks__hint {
  margin: 4px 0 0;
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.perks__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.perks__select {
  width: 190px;
}

.perks__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: var(--sp-3);
  flex: none;
}

.perks__cell {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
  padding: var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--stat-color) 14%, transparent);
  border-radius: var(--r-md);
  /* 只用极淡的语义色，不铺灰底：格子浮在面板上，而不是一块块灰砖 */
  background: color-mix(in srgb, var(--stat-color) 7%, transparent);
}

.perks__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--stat-color) 16%, transparent);
  color: var(--stat-color);
  font-size: 17px;
}

/* 这一页的彩色例外（与账号卡、用量 KPI 同一套语义色），只落在图标与状态字上 */
.perks__cell.is-gas {
  --stat-color: #2f6bd8;
}

.perks__cell.is-streak {
  --stat-color: var(--st-ok);
}

.perks__cell.is-muted {
  --stat-color: #8a94a6;
}

.perks__cell.is-warn {
  --stat-color: var(--st-run);
}

.perks__cell.is-cat {
  --stat-color: #7c3aed;
}

.perks__cell.is-energy {
  --stat-color: #0e7490;
}

.perks__cell.is-grant {
  --stat-color: #c2410c;
}

.perks__cell.is-ok {
  --stat-color: var(--st-ok);
}

.perks__cell-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.perks__label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.perks__value {
  font-family: var(--font-mono);
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.perks__value.is-ok {
  color: var(--st-ok);
}

.perks__value.is-warn {
  color: var(--st-run);
}

.perks__value.is-fail {
  color: var(--st-fail);
}

.perks__value.is-muted {
  color: var(--ink-3);
}

/* 表格上方的小标题：与用量页的「用量明细」同一档 */
.perks__subhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
  flex: none;
}

.perks__subhead h4 {
  margin: 0;
  font-size: var(--gw-fs-meta);
  font-weight: 600;
  color: var(--ink);
}

.perks__dim {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

/* 表格填满面板剩下的高度（窗口多高就多高，不写死档位）：表头钉住、表体在卡片里滚。
   高度由外层 flex 链给出 —— 这一栏与这张面板都撑满剩余高度，所以这里的 `height: 100%`
   有确定的参照；**不要改用 max-height**（EP 会把布局切成 fixed，列宽就不再跟内容走）。
   表与空态都是这一格的子项，都由它们自己填满。 */
.perks__table-wrap {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.perks__table-wrap > * {
  flex: 1 1 auto;
  min-height: 0;
}

/* 说明那列最多两行，长句不把整张表撑得没法看 */
.perks__desc {
  display: inline-block;
  max-width: 360px;
  font-size: var(--gw-fs-micro);
  line-height: 1.6;
  color: var(--ink-3);
  text-align: center;
}

.perks__task-name {
  display: block;
  font-weight: 600;
  color: var(--ink);
}

.perks__task-code {
  display: block;
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.perks__pill {
  display: inline-block;
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font-size: var(--gw-fs-micro);
  white-space: nowrap;
}

.perks__pill.is-ok {
  color: var(--st-ok);
}

.perks__pill.is-warn {
  color: var(--st-run);
}

.perks__pill.is-muted {
  color: var(--ink-3);
}

/* 空态 / 读取中也是这一格里的面板（比 .panel 多一档具体度，内边距不被它盖掉） */
.perks__table-wrap > .perks__empty {
  display: flex;
  padding: var(--sp-3);
}

.perks__table-wrap > .perks__loading {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-5);
  color: var(--ink-3);
  font-size: var(--gw-fs-meta);
}

.perks__spin {
  animation: perks-spin 1s linear infinite;
}

@keyframes perks-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
