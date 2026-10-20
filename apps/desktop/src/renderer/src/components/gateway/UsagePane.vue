<script setup lang="ts">
import type { GatewayUsageSummary } from '@workbench/usage'
import { Histogram } from '@element-plus/icons-vue'
import { gatewayBucketUnit, summarizeGatewayRows } from '@workbench/usage'
import { ElMessage } from 'element-plus'
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import { gatewayAccountNames } from '@/workbench/gateway'

/**
 * 用量总览。
 *
 * 布局照 Hub 的看板：一排 KPI、一张时序柱状图、一张可切换维度的明细表，
 * 末尾是「积分与缓存」那一组 KPI 卡。
 * 明细表**只有一张**：用量（请求 / 失败 / token / 延迟 / 速度）与积分（扣除积分 / 匹配 Token /
 * 比率 / 缓存命中率）是同一行上的两截，按账号或按模型由同一个切换控制 ——
 * 两处各摆一张表时，同一个账号要在上下两处对齐看，请求数还写了两遍。
 * 图是手绘的（一排 div），不引图表库 —— 仓库的依赖规矩不允许为几张柱状图引一整套运行时。
 *
 * 时序的粒度不在这一页定：一周以内按小时、再长按天，由 Rust 的 `bucket_unit` 给，
 * 这一页只照着 `bucketUnit` 排柱子与标签（见 `bars`）。
 *
 * 所有数字来自 Rust 的 `wb_gateway_usage`，这一页只做格式化。
 */
const RANGES = [
  { label: '今日', value: 1 },
  { label: '近 3 天', value: 3 },
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
]
const DIMENSIONS = [
  { label: '按账号', value: 'account' },
  { label: '按模型', value: 'model' },
]

const days = ref(3)
/** 明细表唯一的维度切换：用量列与积分列一起切，不再各留一个 */
const dimension = ref<'account' | 'model'>('account')
const summary = ref<GatewayUsageSummary | null>(null)
const loading = ref(false)
/** 读取失败的原因：失败时页面不能只留一排 0 */
const loadError = ref('')
/** 同步开关（登录 + 配了仓库才有）；关着的时候不显示「同步」按钮 */
const syncEnabled = ref(false)
const syncing = ref(false)
/** uid → 账号名：明细表里要显示名字，流水里只有 uid */
const names = ref<Record<string, string>>({})

/** 明细表的一行：账号与模型两种维度摊平成同一个形状，模板只写一遍 */
interface DetailRow {
  key: string
  realm: string
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
 * 柱状图的柱子。粒度由后端定：一周以内一小时一根（看尖峰），长窗口一天一根。
 * 按天那档最多三十根，标签全画得下；按小时那档一周有 168 根，标签要抽稀，
 * 否则每个柱子底下一串数字会糊成一条灰带 —— 抽到十来个，够读节奏就行。
 */
const bars = computed(() => {
  const list = summary.value?.byBucket ?? []
  const max = Math.max(1, ...list.map(item => item.totalTokens))
  const every = Math.max(1, Math.ceil(list.length / 12))
  return list.map((item, index) => ({
    ...item,
    height: Math.max(2, Math.round(item.totalTokens / max * 100)),
    label: index % every === 0 ? item.bucket.slice(5) : '',
  }))
})

const bucketLabel = computed(() => (summary.value?.bucketUnit === 'hour' ? '按小时' : '按天'))

/** 悬停时看全：按小时那档把 `14` 补成 `14:00`，按天那档原样 */
function barTitle(item: { bucket: string, totalTokens: number, requests: number }): string {
  const when = summary.value?.bucketUnit === 'hour' ? `${item.bucket}:00` : item.bucket
  return `${when} · ${compact(item.totalTokens)} token · ${item.requests} 次`
}

const detailRows = computed<DetailRow[]>(() => {
  const data = summary.value
  if (!data)
    return []
  if (dimension.value === 'model') {
    return data.byModel.map(item => ({
      key: item.model,
      realm: '',
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
    realm: item.realm,
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

/** 没有积分观测的模型数：有 token、但上游没给 credit —— 这部分不参与折算，也不该显示成 0 */
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
 * 积分 / 1M Token。分母是**与积分同时观测到的总 token**（`creditTokens`）——
 * 缺积分的历史不进分母，否则比率会被无积分的 token 稀释。没有样本就显示 `—`，
 * 不拿 0 冒充「测出来是零」。跨模型时后端用两个总量直接除，不是各组比率的平均。
 */
function creditRatio(value: number, samples: number): string {
  if (samples <= 0)
    return '—'
  return `${String(Number(value.toFixed(4)))} / 1M`
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
  loading.value = true
  void window.workbench.gatewayUsageRows(days.value).then((result) => {
    if (result.ok && result.data) {
      // Rust 只取数：分组 / 分桶 / 比率的口径在 @workbench/usage
      summary.value = summarizeGatewayRows(result.data, gatewayBucketUnit(days.value))
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

/** 手动同步：强制走一次 git（不受一小时节流影响），成功后重新读一遍用量 */
async function syncNow(): Promise<void> {
  if (syncing.value)
    return
  syncing.value = true
  try {
    const result = await window.workbench.gatewayUsageSync(true)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '同步失败')
      return
    }
    if (!result.data.enabled) {
      ElMessage.info('未开启同步')
      return
    }
    ElMessage.success(result.data.changed ? '已同步' : '已是最新')
    load()
  }
  catch {
    ElMessage.error('同步失败')
  }
  finally {
    syncing.value = false
  }
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
  // 同步开关跟登录态 / 仓库地址走；拿不到就当作没开，页面照常读本机
  void window.workbench.gatewaySyncStatus().then((status) => {
    syncEnabled.value = status.enabled
  }).catch(() => undefined)
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
        <h2 class="usage__panel-title">
          用量总览
        </h2>
        <div class="usage__head-right">
          <el-segmented v-model="days" :options="RANGES" size="small" @change="load" />
          <el-button v-if="syncEnabled" size="small" text :loading="syncing" @click="syncNow">
            同步
          </el-button>
          <el-button size="small" text :loading="loading" @click="load">
            刷新
          </el-button>
        </div>
      </div>
      <p v-if="loadError" class="usage__error">
        {{ loadError }}
      </p>
    </div>

    <div class="usage__cards">
      <div class="usage__card">
        <span class="usage__label">请求数</span>
        <span class="usage__value">{{ summary?.requests ?? 0 }}</span>
        <span class="usage__sub">其中失败 {{ summary?.failed ?? 0 }} 次</span>
      </div>
      <div class="usage__card">
        <span class="usage__label">总 token</span>
        <span class="usage__value">{{ compact(summary?.totalTokens ?? 0) }}</span>
        <span class="usage__sub">入 {{ percent((summary?.promptTokens ?? 0) / Math.max(1, summary?.totalTokens ?? 1) * 100) }} · 出 {{ percent((summary?.completionTokens ?? 0) / Math.max(1, summary?.totalTokens ?? 1) * 100) }}</span>
      </div>
      <div class="usage__card">
        <span class="usage__label">输入</span>
        <span class="usage__value is-run">{{ compact(summary?.promptTokens ?? 0) }}</span>
      </div>
      <div class="usage__card">
        <span class="usage__label">输出</span>
        <span class="usage__value is-ok">{{ compact(summary?.completionTokens ?? 0) }}</span>
      </div>
      <div class="usage__card">
        <span class="usage__label">成功率</span>
        <span class="usage__value">{{ percent(summary?.successPct ?? 0) }}</span>
        <span class="usage__sub">失败 {{ summary?.failed ?? 0 }} 次</span>
      </div>
      <div class="usage__card">
        <span class="usage__label">平均延迟</span>
        <span class="usage__value">{{ ((summary?.avgTtftMs ?? 0) / 1000).toFixed(2) }}s</span>
        <span class="usage__sub">吐字 {{ (summary?.tokensPerSec ?? 0).toFixed(1) }} tok/s</span>
      </div>
    </div>

    <section class="panel usage__section">
      <div class="usage__section-head">
        <h3>Token 时序</h3>
        <span class="usage__dim">{{ bucketLabel }} · 峰值 {{ compact(Math.max(0, ...(summary?.byBucket ?? []).map(item => item.totalTokens))) }}</span>
      </div>
      <EmptyState v-if="!bars.length" compact :icon="Histogram" text="这段时间还没有请求" />
      <template v-else>
        <div class="usage__chart" :class="{ 'usage__chart--hour': summary?.bucketUnit === 'hour' }">
          <div v-for="item in bars" :key="item.bucket" class="usage__bar" :title="barTitle(item)">
            <span class="usage__bar-fill" :style="{ height: `${item.height}%` }" />
          </div>
        </div>
        <!-- 刻度单独一行：塞进柱子底下会被矮柱子压住，按小时那档还会跟邻柱撞在一起 -->
        <div class="usage__axis" :class="{ 'usage__axis--hour': summary?.bucketUnit === 'hour' }">
          <span v-for="item in bars" :key="item.bucket" class="usage__axis-slot">{{ item.label }}</span>
        </div>
      </template>
    </section>

    <section class="panel usage__section">
      <div class="usage__section-head">
        <h3>用量明细</h3>
        <el-segmented v-model="dimension" :options="DIMENSIONS" size="small" />
      </div>

      <table v-if="detailRows.length" class="usage__table">
        <thead>
          <tr>
            <th>{{ dimension === 'account' ? '账号' : '模型' }}</th>
            <th class="usage__num">
              请求
            </th>
            <th class="usage__num">
              失败
            </th>
            <th class="usage__num">
              输入
            </th>
            <th class="usage__num">
              输出
            </th>
            <th class="usage__num">
              合计
            </th>
            <th class="usage__num">
              均延迟
            </th>
            <th class="usage__num">
              均速率
            </th>
            <th class="usage__num">
              扣除积分
            </th>
            <th class="usage__num">
              匹配 Token
            </th>
            <th class="usage__num">
              积分 / 1M Token
            </th>
            <th class="usage__num">
              缓存命中率
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in detailRows" :key="row.key">
            <td v-if="dimension === 'account'" :title="row.key">
              <span class="usage__cell-name">{{ nameOf(row.key) }}</span>
              <span class="usage__cell-id">{{ row.realm }} · {{ row.key.slice(0, 8) }}</span>
            </td>
            <td v-else class="usage__mono" :title="row.key">
              {{ row.key }}
            </td>
            <td class="usage__num">
              {{ row.requests }}
            </td>
            <td class="usage__num" :class="{ usage__fail: row.failed > 0 }">
              {{ row.failed || '—' }}
            </td>
            <td class="usage__num">
              {{ compact(row.promptTokens) }}
            </td>
            <td class="usage__num">
              {{ compact(row.completionTokens) }}
            </td>
            <td class="usage__num">
              {{ compact(row.promptTokens + row.completionTokens) }}
            </td>
            <td class="usage__num">
              {{ (row.avgTtftMs / 1000).toFixed(2) }}s
            </td>
            <td class="usage__num">
              {{ row.tokensPerSec.toFixed(1) }} tok/s
            </td>
            <td class="usage__num">
              {{ row.creditSamples > 0 ? credit(row.credits) : '未记录' }}
            </td>
            <td class="usage__num">
              {{ row.creditSamples > 0 ? compact(row.creditTokens) : '—' }}
            </td>
            <td class="usage__num">
              {{ creditRatio(row.creditsPer1MTokens, row.creditSamples) }}
            </td>
            <td class="usage__num" :class="hitClass(row.cacheHitPct)">
              {{ percent(row.cacheHitPct) }}
            </td>
          </tr>
        </tbody>
      </table>

      <EmptyState v-else compact :icon="Histogram" text="还没有数据" />
    </section>

    <section class="panel usage__section usage__credit">
      <div class="usage__section-head usage__section-head--rule">
        <h3>积分与缓存</h3>
      </div>

      <div class="usage__kpis">
        <div class="usage__kpi is-accent">
          <span class="usage__kpi-label">扣除积分</span>
          <span class="usage__kpi-value">{{ (summary?.creditSamples ?? 0) > 0 ? credit(summary?.credits ?? 0) : '—' }}</span>
          <span class="usage__kpi-sub">按上游 usage.credit 累计</span>
        </div>
        <div class="usage__kpi">
          <span class="usage__kpi-label">匹配 Token</span>
          <span class="usage__kpi-value">{{ (summary?.creditSamples ?? 0) > 0 ? compact(summary?.creditTokens ?? 0) : '—' }}</span>
          <span class="usage__kpi-sub">与积分同时观测到的总 token</span>
        </div>
        <div class="usage__kpi is-ok">
          <span class="usage__kpi-label">平均积分 / 1M Token</span>
          <span class="usage__kpi-value">{{ creditRatio(summary?.creditsPer1MTokens ?? 0, summary?.creditSamples ?? 0) }}</span>
          <span class="usage__kpi-sub">分母为总 token · 越低越省</span>
        </div>
        <div class="usage__kpi">
          <span class="usage__kpi-label">有效积分样本</span>
          <span class="usage__kpi-value">{{ summary?.creditSamples ?? 0 }}</span>
          <span class="usage__kpi-sub">缺字段 {{ missingCreditCount }} 个模型不参与折算</span>
        </div>
        <div class="usage__kpi">
          <span class="usage__kpi-label">缓存命中率</span>
          <span class="usage__kpi-value">{{ percent(summary?.cacheHitPct ?? 0) }}</span>
          <span class="usage__kpi-sub">命中 / 输入 token · 低命中更贵</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/*
 * 统一用全局 .panel 外壳，这里只排内容。
 * 彩色只有两处：顶上那几格运行状态，以及这张柱状图 —— 柱子取**主题色**，
 * 与选中块同一条色相（口径见 accent-color.ts 的文件头）。
 */
.usage {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.usage__panel-title {
  margin: 0;
  font-size: var(--gw-fs-title);
  font-weight: 600;
  color: var(--ink);
}

/**
 * 顶上这条只放标题与范围选择：**不画卡片**（`.panel` 那套底、磨砂、描边、阴影全撤掉），
 * 让它和下面那排玻璃格子分开层级 —— 一条带子 + 一排卡片，比两张卡叠着干净。
 * 内边距也归零：左边那几格是贴着画布边（12px）的卡片，标题跟着落到同一条线上才对得上。
 */
.usage__head {
  padding: 0;
  background: none;
  backdrop-filter: none;
  border-color: transparent;
  box-shadow: none;
}

.usage__head-right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

/* 读取失败的原因：不能拿一排 0 假装「这段时间真的没有请求」 */
.usage__error {
  margin: 0;
  font-size: var(--gw-fs-micro);
  color: var(--st-fail);
}

.usage__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--sp-2);
}

/* 底子是「不画底」：这两排格子本身不是卡片 */
.usage__card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-1) 0;
}

/**
 * 但直接铺在画布上的那排 KPI **自成一格毛玻璃** —— 与 `.panel` 同一套配方
 * （底色跟着「卡片不透明度」走、磨砂取 `--glass-filter`、描边取设置里那档），只是不叠阴影：
 * 六块小卡各带一片阴影太吵。
 *
 * 用子代选择器只挑这一排：「积分与缓存」那排（`.usage__kpis`）本身就是卡片，
 * 再套一层就是卡片套卡片，里外的磨砂还会互相叠着采一次样。
 */
.usage > .usage__cards > .usage__card {
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-md);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  backdrop-filter: var(--glass-filter);
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
 * 「积分与缓存」这一段的排法：标题在左，再往下一行五格积分卡 ——
 * 明细已经并进上面「用量明细」那一张表，这里只剩汇总卡，不再有第二张表。
 *
 * 卡片的左沿是 3px 色轨 —— 这一组里唯一的重色，用来一眼分出「扣了多少、效率如何」；
 * 卡底取 `--bg-subtle`（比面板底低一档），落在这张玻璃面板里才有「卡中卡」的层次。
 */
.usage__section-head--rule {
  margin-bottom: var(--sp-4);
}

.usage__kpis {
  display: grid;
  /* 五张卡一行排满：这一组是一句话（扣了多少、按多少 token），断行会把「积分」和「效率」分开看 */
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

/* 窗口窄到放不下五列时先塌成三列、再塌成两列：数字是等宽体，压到 140px 以下就要截断了 */
@media (max-width: 1240px) {
  .usage__kpis {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .usage__kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.usage__kpi {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  padding: 11px 14px 12px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-subtle);
}

.usage__kpi::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--kpi-color, var(--border-strong));
  opacity: 0.9;
}

/* 两张带色的卡各表达一件事：点一次花掉多少（主题色）、折算率划不划算（状态色的绿） */
.usage__kpi.is-accent {
  --kpi-color: var(--ink-accent);
}

.usage__kpi.is-ok {
  --kpi-color: var(--st-ok);
}

.usage__kpi-label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 数字用等宽体：四张卡并排时位数才会对齐，扫一眼就能读出量级 */
.usage__kpi-value {
  margin-top: 5px;
  font-family: var(--font-mono);
  font-size: 23px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.02em;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.usage__kpi.is-accent .usage__kpi-value {
  color: var(--ink-accent);
}

.usage__kpi.is-ok .usage__kpi-value {
  color: var(--st-ok);
}

.usage__kpi-sub {
  margin-top: 4px;
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 数字列右对齐：位数对齐后纵向扫一列才读得出大小（表头与单元格一起转） */
.usage__table .usage__num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
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

.usage__chart {
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  gap: var(--sp-2);
  height: 132px;
  padding-top: var(--sp-1);
  border-bottom: 1px solid var(--border);
}

/**
 * 按小时那档一周有 168 根，间隔收到 3px 才放得下 ——
 * 柱子本身靠 flex 摊薄，留白比柱子还宽的话图就散成点阵了。
 */
.usage__chart--hour {
  gap: 3px;
}

.usage__bar {
  flex: 1 1 0;
  max-width: 56px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  height: 100%;
  min-width: 0;
}

/* 柱子取主题色：它表达「多与少」，主题色正好是用户自己挑的那条色相 */
.usage__bar-fill {
  width: 100%;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
  background: var(--el-color-primary);
}

/* hover 只挪一档深浅（EP 的 dark-2），别把柱子换成另一种颜色 */
.usage__bar:hover .usage__bar-fill {
  background: var(--el-color-primary-dark-2);
}

/**
 * 刻度行：每一格与柱子**同宽同序**（同样的 flex 权重与 max-width、同样的 gap），
 * 所以抽稀之后剩下的那几个数字仍然落在自己那根柱子底下。
 * 空的格子照样占位 —— 位置是靠它们撑出来的，不是靠文字。
 */
.usage__axis {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}

.usage__axis--hour {
  gap: 3px;
}

.usage__axis-slot {
  flex: 1 1 0;
  min-width: 0;
  max-width: 56px;
  text-align: center;
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.usage__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--gw-fs-meta);
}

.usage__table th {
  text-align: left;
  font-weight: 400;
  color: var(--ink-3);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) 0;
  white-space: nowrap;
}

.usage__table td {
  padding: var(--sp-2) var(--sp-2) var(--sp-2) 0;
  color: var(--ink-2);
  border-top: 1px solid var(--border);
  white-space: nowrap;
}

.usage__table tbody tr:first-child td {
  border-top: none;
}

.usage__mono {
  font-family: var(--font-mono);
}

.usage__fail {
  color: var(--st-fail);
}
</style>
