<script setup lang="ts">
import type { GatewayUsageSummary } from '@workbench/usage'
import type { GatewayUsageRow } from '@/workbench/gateway'
import { Bottom, CircleCheck, DataLine, Histogram, Timer, Top } from '@element-plus/icons-vue'
import { gatewayBucketUnit, recentHourBuckets, summarizeGatewayRows } from '@workbench/usage'
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import { gatewayAccountNames } from '@/workbench/gateway'
import GatewayTable from './GatewayTable.vue'

/**
 * 用量总览。
 *
 * 布局照 Hub 的看板：一排 KPI、一张独立的「积分总账」面板 + 一张可切换维度的明细表、最后是时序柱状图。
 * 积分与缓存的汇总单独成一张毛玻璃面板（左侧主数字 + 右侧 2×2 佐证），放在表格上面，不再与明细同面板；
 * **时序图在最底下**——先看这段时间花了多少、分在谁身上，再往下看最近这一天的节奏。
 * 明细表**只有一张**：用量（请求 / 失败 / token / 延迟 / 速度）与积分（扣除积分 / 匹配 Token /
 * 比率 / 缓存命中率）是同一行上的两截，按账号或按模型由同一个切换控制 ——
 * 两处各摆一张表时，同一个账号要在上下两处对齐看，请求数还写了两遍。
 * 图是手绘的（一排 div），不引图表库 —— 仓库的依赖规矩不允许为几张柱状图引一整套运行时。
 *
 * 时序图固定看**最近 24 小时**（逐小时，带纵轴）：页面顶上的时间范围只管 KPI 与明细表，
 * 不再决定图表的粒度 —— 两者回答的不是同一个问题（「这段时间一共多少」vs「最近这一天的节奏」）。
 * 时间范围按**自然日**算（UTC+8 零点起）：`今日` = 今天 0 点到现在，`昨日` = 昨天一整天，
 * `近 3 天` = 今天加前两天。取回的行会盖住最近 24 小时（图要用），统计前按 `since` 再裁一次。
 *
 * 所有数字来自 Rust 的 `wb_gateway_usage`，这一页只做格式化。
 */

/** 一天的秒数：`since` 一定是自然日零点，加它正好是次日零点 */
const DAY_SECONDS = 86_400

interface RangeOption {
  label: string
  value: string
  /** 传给 Rust 的窗口天数（从今天零点往前数，含今天） */
  days: number
  /** 「昨日」：窗口取两天（昨天 + 今天），统计前把今天那一段裁掉 */
  previousDay?: boolean
}

/**
 * 时间范围。Rust 只认「从今天零点往前数 N 天」这一种窗口，所以「昨日」取 `days = 2`，
 * 再用 `previousDay` 把今天裁掉（上界是 `since` 加一整天）。
 */
const RANGES: RangeOption[] = [
  { label: '今日', value: 'today', days: 1 },
  { label: '昨日', value: 'yesterday', days: 2, previousDay: true },
  { label: '近 3 天', value: 'last3', days: 3 },
  { label: '近 7 天', value: 'last7', days: 7 },
  { label: '近 30 天', value: 'last30', days: 30 },
]
const DIMENSIONS = [
  { label: '按账号', value: 'account' },
  { label: '按模型', value: 'model' },
]

/** 默认「今日」：进页面先看当天，要更长的窗口再手动切 */
const rangeKey = ref('today')
/** 明细表唯一的维度切换：用量列与积分列一起切，不再各留一个 */
const dimension = ref<'account' | 'model'>('account')
const summary = ref<GatewayUsageSummary | null>(null)
/** 窗口内的原始流水：图表固定看最近 24 小时，要从这里重新分桶 */
const rows = ref<GatewayUsageRow[]>([])
const loading = ref(false)
/** 读取失败的原因：失败时页面不能只留一排 0 */
const loadError = ref('')
/** uid → 账号名：明细表里要显示名字，流水里只有 uid */
const names = ref<Record<string, string>>({})

/** 明细表的一行：账号与模型两种维度摊平成同一个形状，模板只写一遍 */
interface DetailRow {
  key: string
  requests: number
  failed: number
  promptTokens: number
  completionTokens: number
  avgTtftMs: number
  tokensPerSec: number
  credits: number
  creditSamples: number
  creditTokens: number
  creditsPer1MTokens: number
  cacheHitPct: number
}

/**
 * 图表固定看最近 24 小时，不跟页面上选的时间范围走：从当前小时往前数 24 格，
 * 没有请求的小时补 0，横轴的格数与位置才是稳定的。
 */
const chartBuckets = computed(() => recentHourBuckets(rows.value, 24, Date.now() / 1000))

/** 这 24 小时里有没有请求：全为 0 就显示空态，不画一排零高度的柱子 */
const hasChartData = computed(() => chartBuckets.value.some(item => item.requests > 0))

/**
 * 柱状图的柱子。24 小时的标签要抽稀（隔一根标一个），
 * 否则每个柱子底下一串日期会糊成一条灰带 —— 抽到十来个，够读节奏就行。
 */
const bars = computed(() => {
  const list = chartBuckets.value
  const max = Math.max(1, ...list.map(item => item.totalTokens))
  const every = Math.max(1, Math.ceil(list.length / 12))
  return list.map((item, index) => ({
    ...item,
    height: item.totalTokens > 0 ? Math.max(2, Math.round(item.totalTokens / max * 100)) : 0,
    label: index % every === 0 ? item.bucket.slice(5) : '',
  }))
})

/**
 * 纵轴：刻度取整数，单位只写在轴顶一次（M / K）。
 * 单位按峰值挑一档，保证四格刻度在缩放后仍是不同的整数（1.2M 用 K 而不是 1/1/1）。
 */
const yAxis = computed(() => {
  const max = Math.max(0, ...chartBuckets.value.map(item => item.totalTokens))
  if (max <= 0)
    return { unit: '', ticks: [] as { pct: number, label: string }[] }

  const divisor = max >= 4_000_000 ? 1_000_000 : max >= 4_000 ? 1_000 : 1
  const unit = divisor === 1_000_000 ? 'M' : divisor === 1_000 ? 'K' : ''
  return {
    unit,
    ticks: [0.25, 0.5, 0.75, 1].map(ratio => ({
      pct: ratio * 100,
      label: String(Math.round(max * ratio / divisor)),
    })),
  }
})

/** 悬停时看全：小时桶补上 `:00` */
function barTitle(item: { bucket: string, totalTokens: number, requests: number }): string {
  return `${item.bucket}:00 · ${compact(item.totalTokens)} token · ${item.requests} 次`
}

const detailRows = computed<DetailRow[]>(() => {
  const data = summary.value
  if (!data)
    return []
  if (dimension.value === 'model') {
    return data.byModel.map(item => ({
      key: item.model,
      requests: item.requests,
      failed: item.failed,
      promptTokens: item.promptTokens,
      completionTokens: item.completionTokens,
      avgTtftMs: item.avgTtftMs,
      tokensPerSec: item.tokensPerSec,
      credits: item.credits,
      creditSamples: item.creditSamples,
      creditTokens: item.creditTokens,
      creditsPer1MTokens: item.creditsPer1MTokens,
      cacheHitPct: item.cacheHitPct,
    }))
  }
  return data.byAccount.map(item => ({
    key: item.uid,
    requests: item.requests,
    failed: item.failed,
    promptTokens: item.promptTokens,
    completionTokens: item.completionTokens,
    avgTtftMs: item.avgTtftMs,
    tokensPerSec: item.tokensPerSec,
    credits: item.credits,
    creditSamples: item.creditSamples,
    creditTokens: item.creditTokens,
    creditsPer1MTokens: item.creditsPer1MTokens,
    cacheHitPct: item.cacheHitPct,
  }))
})

/** 没有有效积分样本的模型数：有 token、但 credit 缺失或为 0 —— 这部分不参与折算，也不该显示成 0 */
const missingCreditCount = computed(() =>
  (summary.value?.byModel ?? []).filter(item => item.creditSamples === 0 && item.totalTokens > 0).length,
)

function compact(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000)
    return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`
}

/** 积分保留两位，去掉无意义的尾零：0 显示成 `0`，不显示成 `0.00` */
function credit(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * 积分 / 1M Token。分母是**积分大于 0 的请求的总 token**（`creditTokens`）——
 * 缺积分与 credit = 0 的免费请求都不进分母，否则比率会被零消耗的 token 稀释。没有样本就显示 `—`，
 * 不拿 0 冒充「测出来是零」。跨模型时后端用两个总量直接除，不是各组比率的平均。
 */
function ratioValue(value: number, samples: number): string {
  if (samples <= 0)
    return '—'
  return String(Number(value.toFixed(4)))
}

/** 表格那列的单位已经写在表头里，这里带上一截，方便单独读 */
function creditRatio(value: number, samples: number): string {
  if (samples <= 0)
    return '—'
  return `${ratioValue(value, samples)} / 1M`
}

/**
 * 命中率的颜色即健康度：≥90% 绿 / 80–90% 黄 / 以下红。
 * 前缀缓存没命中时同样的输入要重新计一遍费，掉到 80% 以下扣的积分是数倍往上走的。
 */
function hitClass(pct: number): string {
  if (pct <= 0)
    return ''
  if (pct >= 90)
    return 'usage__hit-ok'
  if (pct >= 80)
    return 'usage__hit-warn'
  return 'usage__hit-fail'
}

/** 流水里只有 uid；显示前换成名字，查不到就退回 uid 前八位 */
function nameOf(uid: string): string {
  return names.value[uid] ?? uid.slice(0, 8)
}

function load(): void {
  const range = RANGES.find(item => item.value === rangeKey.value) ?? RANGES[0]
  loading.value = true
  void window.workbench.gatewayUsageRows(range.days).then((result) => {
    if (result.ok && result.data) {
      // Rust 只取数：分组 / 分桶 / 比率的口径在 @workbench/usage。
      // 取回来的行盖住了最近 24 小时（图表要用），统计只算 `since` 之后的那一段；
      // 「昨日」取的是昨天 + 今天两天，上界再收在 `since` 加一天（今天零点）。
      const { since, rows: fetched } = result.data
      const until = range.previousDay ? since + DAY_SECONDS : Number.POSITIVE_INFINITY
      rows.value = fetched
      summary.value = summarizeGatewayRows(
        fetched.filter(row => row.ts >= since && row.ts < until),
        gatewayBucketUnit(range.days),
      )
      loadError.value = ''
    }
    else {
      // 读失败时不能只显示 0：那会被当成「这段时间真的没有请求」
      loadError.value = result.error ?? '读取用量失败'
    }
    loading.value = false
  }).catch((error) => {
    loadError.value = String(error)
    loading.value = false
  })
  // 名字跟着刷新一起取：新登录的号在这一栏出现时，不该先看到一串数字
  void gatewayAccountNames().then((map) => {
    names.value = map
  })
}

/**
 * 本机读文件很便宜，但这一页**必须自己跟**：它只在挂载时读一次，
 * 而页面在 KeepAlive 里 —— 切走再回来不会重新 mounted，只靠 mount 的话
 * 打开那一刻读到什么就一直是它（清空流水后正好读到空文件，于是一直显示 0）。
 * 15 秒与 `GatewayView` 的轮询同一个节奏；页面被缓存时停掉，切回来立即补一次。
 */
const POLL_INTERVAL = 15_000
let pollTimer: ReturnType<typeof setInterval> | null = null
let active = true
/** 首次激活紧跟 mounted，别把同一份数据读两遍 */
let firstActivation = true

onMounted(() => {
  load()
  pollTimer = setInterval(() => {
    if (active)
      load()
  }, POLL_INTERVAL)
})

onActivated(() => {
  active = true
  if (firstActivation) {
    firstActivation = false
    return
  }
  load()
})

onDeactivated(() => {
  active = false
})

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<template>
  <div class="usage">
    <div class="panel usage__head">
      <div class="panel__head">
        <el-segmented v-model="rangeKey" :options="RANGES" size="small" @change="load" />
      </div>
      <p v-if="loadError" class="usage__error">
        {{ loadError }}
      </p>
    </div>

    <div class="usage__cards">
      <div class="usage__card is-requests">
        <span class="usage__card-icon"><el-icon><DataLine /></el-icon></span>
        <div class="usage__card-body">
          <span class="usage__label">请求数</span>
          <span class="usage__value">{{ summary?.requests ?? 0 }}</span>
          <span class="usage__sub">其中失败 {{ summary?.failed ?? 0 }} 次</span>
        </div>
      </div>
      <div class="usage__card is-tokens">
        <span class="usage__card-icon"><el-icon><Histogram /></el-icon></span>
        <div class="usage__card-body">
          <span class="usage__label">总 token</span>
          <span class="usage__value">{{ compact(summary?.totalTokens ?? 0) }}</span>
          <span class="usage__sub">入 {{ percent((summary?.promptTokens ?? 0) / Math.max(1, summary?.totalTokens ?? 1) * 100) }} · 出 {{ percent((summary?.completionTokens ?? 0) / Math.max(1, summary?.totalTokens ?? 1) * 100) }}</span>
        </div>
      </div>
      <div class="usage__card is-input">
        <span class="usage__card-icon"><el-icon><Bottom /></el-icon></span>
        <div class="usage__card-body">
          <span class="usage__label">输入</span>
          <span class="usage__value">{{ compact(summary?.promptTokens ?? 0) }}</span>
        </div>
      </div>
      <div class="usage__card is-output">
        <span class="usage__card-icon"><el-icon><Top /></el-icon></span>
        <div class="usage__card-body">
          <span class="usage__label">输出</span>
          <span class="usage__value">{{ compact(summary?.completionTokens ?? 0) }}</span>
        </div>
      </div>
      <div class="usage__card is-success">
        <span class="usage__card-icon"><el-icon><CircleCheck /></el-icon></span>
        <div class="usage__card-body">
          <span class="usage__label">成功率</span>
          <span class="usage__value">{{ percent(summary?.successPct ?? 0) }}</span>
          <span class="usage__sub">失败 {{ summary?.failed ?? 0 }} 次</span>
        </div>
      </div>
      <div class="usage__card is-latency">
        <span class="usage__card-icon"><el-icon><Timer /></el-icon></span>
        <div class="usage__card-body">
          <span class="usage__label">平均延迟</span>
          <span class="usage__value">{{ ((summary?.avgTtftMs ?? 0) / 1000).toFixed(2) }}s</span>
          <span class="usage__sub">吐字 {{ (summary?.tokensPerSec ?? 0).toFixed(1) }} tok/s</span>
        </div>
      </div>
    </div>

    <!--
      积分总账：独立一张面板（外壳就是 .panel 的毛玻璃），左侧主数字占满两行、右侧 2×2 佐证；
      与下面的明细表各成一块 —— 明细面板不再把它套在里面。
    -->
    <section class="panel usage__cost">
      <div class="usage__cost-hero">
        <span class="usage__cost-label">扣除积分</span>
        <span class="usage__cost-value">{{ (summary?.creditSamples ?? 0) > 0 ? credit(summary?.credits ?? 0) : '—' }}</span>
        <span class="usage__cost-sub">按上游 usage.credit 累计</span>
      </div>
      <div class="usage__cost-item is-avg">
        <span class="usage__cost-label">平均积分 / 1M Token</span>
        <span class="usage__cost-value is-ok">{{ ratioValue(summary?.creditsPer1MTokens ?? 0, summary?.creditSamples ?? 0) }}</span>
        <span class="usage__cost-sub">分母为总 token · 越低越省</span>
      </div>
      <div class="usage__cost-item is-match">
        <span class="usage__cost-label">匹配 Token</span>
        <span class="usage__cost-value">{{ (summary?.creditSamples ?? 0) > 0 ? compact(summary?.creditTokens ?? 0) : '—' }}</span>
        <span class="usage__cost-sub">与积分同时观测到的总 token</span>
      </div>
      <div class="usage__cost-item is-samples">
        <span class="usage__cost-label">有效积分样本</span>
        <span class="usage__cost-value">{{ summary?.creditSamples ?? 0 }}</span>
        <span class="usage__cost-sub">{{ missingCreditCount }} 个模型不参与折算</span>
      </div>
      <div class="usage__cost-item is-hit">
        <span class="usage__cost-label">缓存命中率</span>
        <span class="usage__cost-value">{{ percent(summary?.cacheHitPct ?? 0) }}</span>
        <span class="usage__cost-sub">命中 / 输入 token · 低命中更贵</span>
      </div>
    </section>

    <section class="panel usage__section">
      <div class="usage__section-head">
        <h3>用量明细</h3>
        <el-segmented v-model="dimension" :options="DIMENSIONS" size="small" />
      </div>

      <!-- 列宽交给内容（table-layout="auto"）：不再写死每列的像素宽 -->
      <GatewayTable
        v-if="detailRows.length"
        :data="detailRows"
        row-key="key"
        flat
      >
        <el-table-column :label="dimension === 'account' ? '账号' : '模型'" align="center">
          <template #default="{ row }">
            <template v-if="dimension === 'account'">
              <span class="usage__cell-name">{{ nameOf(row.key) }}</span>
              <span class="usage__cell-id">{{ row.key.slice(0, 8) }}</span>
            </template>
            <span v-else class="usage__mono" :title="row.key">{{ row.key }}</span>
          </template>
        </el-table-column>
        <el-table-column label="请求" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ row.requests }}
          </template>
        </el-table-column>
        <el-table-column label="失败" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            <span :class="{ usage__fail: row.failed > 0 }">{{ row.failed || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="输入" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ compact(row.promptTokens) }}
          </template>
        </el-table-column>
        <el-table-column label="输出" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ compact(row.completionTokens) }}
          </template>
        </el-table-column>
        <el-table-column label="合计" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ compact(row.promptTokens + row.completionTokens) }}
          </template>
        </el-table-column>
        <el-table-column label="均延迟" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ (row.avgTtftMs / 1000).toFixed(2) }}s
          </template>
        </el-table-column>
        <el-table-column label="均速率" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ row.tokensPerSec.toFixed(1) }} tok/s
          </template>
        </el-table-column>
        <el-table-column label="扣除积分" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ row.creditSamples > 0 ? credit(row.credits) : '未记录' }}
          </template>
        </el-table-column>
        <el-table-column label="匹配 Token" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ row.creditSamples > 0 ? compact(row.creditTokens) : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="积分 / 1M Token" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            {{ creditRatio(row.creditsPer1MTokens, row.creditSamples) }}
          </template>
        </el-table-column>
        <el-table-column label="缓存命中率" align="center" class-name="gw-num" label-class-name="gw-num">
          <template #default="{ row }">
            <span :class="hitClass(row.cacheHitPct)">{{ percent(row.cacheHitPct) }}</span>
          </template>
        </el-table-column>
      </GatewayTable>

      <EmptyState v-else compact :icon="Histogram" text="还没有数据" />
    </section>

    <section class="panel usage__section">
      <div class="usage__section-head">
        <h3>Token 时序</h3>
        <span class="usage__dim">近 24 小时</span>
      </div>
      <template v-if="hasChartData">
        <div class="usage__plot">
          <!-- 纵轴：整数刻度，单位统一标在轴顶 -->
          <div class="usage__yaxis" aria-hidden="true">
            <span v-if="yAxis.unit" class="usage__yunit">{{ yAxis.unit }}</span>
            <span
              v-for="tick in yAxis.ticks"
              :key="tick.pct"
              class="usage__ytick"
              :style="{ bottom: `${tick.pct}%` }"
            >{{ tick.label }}</span>
          </div>
          <div class="usage__plot-main">
            <div class="usage__chart">
              <!-- 虚线网格画在柱子后面 -->
              <div class="usage__grid" aria-hidden="true">
                <span
                  v-for="tick in yAxis.ticks"
                  :key="tick.pct"
                  class="usage__gridline"
                  :style="{ bottom: `${tick.pct}%` }"
                />
              </div>
              <div v-for="item in bars" :key="item.bucket" class="usage__bar" :title="barTitle(item)">
                <span class="usage__bar-fill" :style="{ height: `${item.height}%` }" />
              </div>
            </div>
            <!-- 刻度单独一行：塞进柱子底下会被矮柱子压住 -->
            <div class="usage__axis">
              <span v-for="item in bars" :key="item.bucket" class="usage__axis-slot">{{ item.label }}</span>
            </div>
          </div>
        </div>
      </template>
      <EmptyState v-else compact :icon="Histogram" text="最近 24 小时还没有请求" />
    </section>
  </div>
</template>

<style scoped>
/*
 * 统一用全局 .panel 外壳，这里只排内容。
 * 彩色只有这三处：顶上六格的图标、运行状态，以及这张柱状图 —— 柱子取**主题色**，
 * 与选中块同一条色相（口径见 accent-color.ts 的文件头；KPI 图标的色板见 gateway.md 的彩色例外）。
 */
.usage {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/**
 * 顶上这条只放范围选择（靠左）与右侧按钮：**不画卡片**（`.panel` 那套底、磨砂、描边、阴影全撤掉），
 * 让它和下面那排玻璃格子分开层级 —— 一条带子 + 一排卡片，比两张卡叠着干净。
 * 内边距也归零：范围选择要跟下面那排卡片贴着同一条画布边（12px），才对得上。
 */
.usage__head {
  padding: 0;
  background: none;
  backdrop-filter: none;
  border-color: transparent;
  box-shadow: none;
}

/* 读取失败的原因：不能拿一排 0 假装「这段时间真的没有请求」 */
.usage__error {
  margin: 0;
  font-size: var(--gw-fs-micro);
  color: var(--st-fail);
}

.usage__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--sp-2);
}

/**
 * 六张 KPI 小卡：左图标、右三行（标签 / 数值 / 补充行）。
 * 玻璃与 `.panel` 同一套配方（底色跟着「卡片不透明度」走、磨砂取 `--glass-filter`、
 * 描边取设置里那档），只是不叠阴影 —— 六块小卡各带一片阴影太吵。
 * 用子代选择器只挑这一排：下面那张积分总账面板（`.usage__cost`）本身就是带底的面。
 */
.usage > .usage__cards > .usage__card {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-md);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  backdrop-filter: var(--glass-filter);
}

.usage__card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--usage-icon) 16%, transparent);
  color: var(--usage-icon);
  font-size: 16px;
}

/* 每张卡一档色：与账号统计卡同一套语汇（蓝 / 紫 / 青 / 橙 / 绿 / 琥珀） */
.usage__card.is-requests {
  --usage-icon: #2f6bd8;
}

.usage__card.is-tokens {
  --usage-icon: #7c3aed;
}

.usage__card.is-input {
  --usage-icon: #0e7490;
}

.usage__card.is-output {
  --usage-icon: #c2410c;
}

.usage__card.is-success {
  --usage-icon: var(--st-ok);
}

.usage__card.is-latency {
  --usage-icon: var(--st-run);
}

.usage__card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.usage__label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.usage__value {
  font-size: var(--gw-fs-title);
  font-weight: 600;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.usage__sub {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.usage__section {
  padding-bottom: var(--sp-2);
}

.usage__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.usage__section-head h3 {
  margin: 0;
  font-size: var(--gw-fs-meta);
  font-weight: 600;
  color: var(--ink);
}

.usage__dim {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

/**
 * 积分总账：一张独立面板，回答一句「花了多少、划不划算」。
 *
 * 外壳就是 `.panel` 的那层毛玻璃（底色跟卡片不透明度、磨砂取 --glass-filter）—— 所以这里只把
 * 五格排开：左边一格主数字（扣除积分）占满两行，右边 2×2 放佐证（平均成本 / 匹配 token / 样本 / 命中率）。
 * 发丝分隔线要铺到卡片四边，因此把 .panel 的内边距与间距都收掉，留白由每个格子自己给。
 * 具体度要比 `.panel` 高一层（两条规则的权重相同的话，组件样式排在全局样式之前，覆盖会静默失效）。
 */
.usage__cost.panel {
  display: grid;
  grid-template-columns: minmax(210px, 0.72fr) repeat(2, minmax(0, 1fr));
  grid-template-areas:
    'hero avg match'
    'hero samples hit';
  gap: 0;
  padding: 0;
}

.usage__cost-hero {
  grid-area: hero;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: var(--sp-5) var(--sp-5) var(--sp-5) var(--sp-6);
  border-right: 1px solid var(--border);
}

/* 左侧一截主题色标：这一格是整块的总数，其余四格都是它的注脚 */
.usage__cost-hero::before {
  content: '';
  position: absolute;
  top: var(--sp-4);
  bottom: var(--sp-4);
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--ink-accent);
}

.usage__cost-item {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: var(--sp-4) var(--sp-5);
}

.usage__cost-item.is-avg {
  grid-area: avg;
}

.usage__cost-item.is-match {
  grid-area: match;
  border-left: 1px solid var(--border);
}

.usage__cost-item.is-samples {
  grid-area: samples;
  border-top: 1px solid var(--border);
}

.usage__cost-item.is-hit {
  grid-area: hit;
  border-top: 1px solid var(--border);
  border-left: 1px solid var(--border);
}

/* 窗口窄到主数字与 2×2 并排放不下时，主数字占满一行，佐证仍按两列排 */
@media (max-width: 1240px) {
  .usage__cost.panel {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-areas:
      'hero hero'
      'avg match'
      'samples hit';
  }

  .usage__cost-hero {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}

@media (max-width: 760px) {
  .usage__cost.panel {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'hero'
      'avg'
      'match'
      'samples'
      'hit';
  }

  .usage__cost-hero {
    border-bottom: none;
  }

  /* 单列时每个格子都靠上边框分隔，横向那两条不再需要 */
  .usage__cost-item {
    border-top: 1px solid var(--border);
  }

  .usage__cost-item.is-match,
  .usage__cost-item.is-hit {
    border-left: none;
  }
}

.usage__cost-label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 数字用等宽体：位数对齐后，主数字与四个佐证一眼分得出主次 */
.usage__cost-value {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.usage__cost-hero .usage__cost-value {
  margin-top: 8px;
  font-size: 36px;
  letter-spacing: -0.035em;
  color: var(--ink-accent);
}

/* 折算率划不划算用状态色的绿：它是这四格里唯一带判断的一项 */
.usage__cost-value.is-ok {
  color: var(--st-ok);
}

.usage__cost-sub {
  margin-top: 6px;
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 账号格两行：名字在上、域与 uid 前缀在下（流水里只有 uid，名字查不到就退回它） */
.usage__cell-name {
  display: block;
  color: var(--ink);
}

.usage__cell-id {
  display: block;
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.usage__hit-ok {
  color: var(--st-ok);
}

.usage__hit-warn {
  color: var(--st-run);
}

.usage__hit-fail {
  color: var(--st-fail);
}

/* ---------- 时序图：纵轴 + 24 根小时柱 ---------- */

.usage__plot {
  display: flex;
  gap: var(--sp-2);
  /* 轴顶那枚单位标签在 132px 之外，留出它的位置 */
  margin-top: var(--sp-6);
}

/* 纵轴与柱子共用 132px：刻度按 25 / 50 / 75 / 100% 定位 */
.usage__yaxis {
  position: relative;
  flex: none;
  width: 48px;
  height: 132px;
}

/* 单位只写一次，落在轴顶（100% 刻度标签的上方） */
.usage__yunit {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.usage__ytick {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.usage__plot-main {
  flex: 1 1 auto;
  min-width: 0;
}

.usage__chart {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  gap: var(--sp-3);
  height: 132px;
  border-bottom: 1px solid var(--border);
}

/* 横向网格：虚线、压淡，画在柱子后面 */
.usage__grid {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.usage__gridline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
}

.usage__bar {
  position: relative;
  z-index: 1;
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  height: 100%;
  min-width: 0;
}

/**
 * 柱子只占槽的一半（最宽 28px）：24 根柱子铺满整行，间隙靠槽宽撑开。
 * 颜色取主题色：它表达「多与少」，主题色正好是用户自己挑的那条色相。
 */
.usage__bar-fill {
  width: 100%;
  max-width: 28px;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
  background: var(--el-color-primary);
}

/* hover 只挪一档深浅（EP 的 dark-2），别把柱子换成另一种颜色 */
.usage__bar:hover .usage__bar-fill {
  background: var(--el-color-primary-dark-2);
}

/**
 * 刻度行：每一格与柱子的槽同宽同序（同样的 flex 权重与 gap），
 * 所以抽稀之后剩下的那几个数字仍然落在自己那根柱子底下。
 * 空的格子照样占位 —— 位置是靠它们撑出来的，不是靠文字。
 */
.usage__axis {
  display: flex;
  gap: var(--sp-3);
  margin-top: var(--sp-1);
}

.usage__axis-slot {
  flex: 1 1 0;
  min-width: 0;
  text-align: center;
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.usage__mono {
  font-family: var(--font-mono);
}

.usage__fail {
  color: var(--st-fail);
}
</style>
