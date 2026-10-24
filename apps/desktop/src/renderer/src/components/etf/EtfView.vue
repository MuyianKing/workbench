<script setup lang="ts">
import type { EtfOverview } from '@workbench/etf'
import type { EtfProgress } from '@/workbench/etf'
import { Calendar, TrendCharts } from '@element-plus/icons-vue'
import { formatDayKey } from '@workbench/etf'
import { computed, onActivated, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import { loadEtfOverview, refreshEtf } from '@/workbench/etf'
import EtfCategoryPanel from './EtfCategoryPanel.vue'
import EtfFlowPanel from './EtfFlowPanel.vue'
import EtfHoldingsPanel from './EtfHoldingsPanel.vue'
import EtfMatrixPanel from './EtfMatrixPanel.vue'
import EtfScalePanel from './EtfScalePanel.vue'
import EtfSummaryCards from './EtfSummaryCards.vue'

/**
 * ETF 资金流页：23 只「国家队」重仓宽基 ETF 的每日净申赎。
 *
 * 取数分两步：进页面先读本地缓存立即上屏（`loadEtfOverview`，不联网），
 * 再后台跑一次增量刷新（`refreshEtf`，出网见 workbench/etf.ts 的说明）——
 * 首次使用的五年回填要上千个请求，进度按阶段推进、中途关掉不丢（断点在缓存里）。
 * 刷新期间每隔一秒重读一次缓存重新出视图，回填到哪页面就长到哪。
 */
const overview = ref<EtfOverview | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const progress = ref<EtfProgress | null>(null)
/** 刷新中的失败提示：如实显示，不清掉已上屏的数据 */
const notes = ref<string[]>([])

const FLOW_WINDOW = 21

const flowDays = computed(() => overview.value?.days.slice(-FLOW_WINDOW) ?? [])
const dataAsOfText = computed(() => {
  const day = overview.value?.dataAsOf
  return day ? formatDayKey(day, true) : '—'
})

const PHASE_LABELS: Record<EtfProgress['phase'], string> = {
  nav: '净值',
  szse: '深市份额',
  sse: '沪市份额',
}

const progressText = computed(() => {
  if (refreshing.value && !progress.value)
    return '刷新中…'
  if (!progress.value)
    return ''
  const { phase, done, total } = progress.value
  return total > 0 ? `${PHASE_LABELS[phase]} ${done}/${total}` : ''
})

/** 首次回填的提示：回填窗口有多大、中途关掉不丢（影响当下操作的等待预期） */
const emptyHint = computed(() =>
  refreshing.value && progress.value?.phase === 'sse'
    ? `正在回填沪市份额 ${progress.value.done}/${progress.value.total}，中途关掉下次接着拉`
    : '五年回填要上千个请求，首次拉取需几分钟',
)

async function load(): Promise<void> {
  try {
    overview.value = await loadEtfOverview()
  }
  catch (error) {
    notes.value = [String(error)]
  }
  finally {
    loading.value = false
  }
  void refresh()
}

/** 回填期间按节流重读缓存：数据在 JsonStore 里已经落盘，直接重建视图就行 */
let lastLiveRender = 0

function onProgress(state: EtfProgress): void {
  progress.value = state
  const now = Date.now()
  if (now - lastLiveRender < 1000)
    return
  lastLiveRender = now
  void loadEtfOverview().then((fresh) => {
    overview.value = fresh
  }).catch(() => {})
}

async function refresh(): Promise<void> {
  if (refreshing.value)
    return
  refreshing.value = true
  notes.value = []
  try {
    const outcome = await refreshEtf(onProgress)
    overview.value = outcome.overview
    notes.value = outcome.notes
  }
  catch (error) {
    notes.value = [error instanceof Error ? error.message : String(error)]
  }
  finally {
    refreshing.value = false
    progress.value = null
  }
}

/** 首次进入 mounted 与 activated 挨着各来一次，用闸只放一个（与网关页同一模式） */
let entering = false

async function enter(): Promise<void> {
  if (entering)
    return
  entering = true
  try {
    if (loading.value)
      await load()
    else
      void refresh()
  }
  finally {
    entering = false
  }
}

onMounted(() => {
  void enter()
})

onActivated(() => {
  void enter()
})
</script>

<template>
  <section class="etf">
    <div class="head panel">
      <div class="head__meta">
        <span class="head__date"><el-icon><Calendar /></el-icon>数据日 <b>{{ dataAsOfText }}</b></span>
        <span v-if="progressText" class="head__progress">{{ progressText }}</span>
      </div>
      <el-tooltip content="增量拉取最新份额与净值" placement="bottom">
        <el-button size="small" text :loading="refreshing" @click="refresh">
          刷新
        </el-button>
      </el-tooltip>
    </div>

    <p v-if="notes.length" class="note" :title="notes.join('\n')">
      {{ notes[0] }}{{ notes.length > 1 ? ` 等 ${notes.length} 条` : '' }}
    </p>

    <PanelLoading v-if="loading" text="读取缓存…" />
    <EmptyState
      v-else-if="!overview || overview.days.length === 0"
      :icon="TrendCharts"
      text="还没有份额数据"
      :hint="emptyHint"
    />
    <template v-else>
      <EtfSummaryCards :totals="overview.totals" />
      <EtfFlowPanel :days="flowDays" />
      <EtfScalePanel :days="overview.days" :scale-series="overview.scaleSeries" />
      <!-- 分品种表行数最多，让它弹性长满剩余高度：内容不满一屏时页面不剩大片空白 -->
      <EtfHoldingsPanel class="etf-grow" :etfs="overview.etfs" />
      <EtfCategoryPanel :categories="overview.categories" />
      <EtfMatrixPanel :days="overview.days" :categories="overview.categories" />
    </template>
  </section>
</template>

<style scoped>
/* 与网关页同一副页壳：整页滚动、每块 flex none 不被压；区块间距收紧一档（sp-2），
 * 这页块数多、每块都矮，sp-3 的缝会显出一截截空白 */
.etf {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: var(--sp-3);
}

.etf > * {
  flex: none;
}

/* 唯一的弹性块：吃掉剩余高度（表格转成表内滚动）；窗口太矮时保住一个下限，
 * 撑不下的部分照旧由整页滚动兜 */
.etf > .etf-grow {
  flex: 1 1 auto;
  min-height: 280px;
}

/* 页首一条带子：不画卡片（与网关用量页的 head 同一处理），贴着画布边。
 * flex-direction 必须显式写 row：外壳的 .panel 是 column，没这条声明时它照样生效
 * （级联按属性逐个比），页头就成了「描述居中一行、刷新居中在下方」。 */
.head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 0;
  background: none;
  backdrop-filter: none;
  border-color: transparent;
  box-shadow: none;
}

.head__meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-3);
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

/* 数据日那枚小日历：与文字同基线对齐（meta 行是 baseline，图标得自己居中回来） */
.head__date {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}

.head__date .el-icon {
  flex: none;
  font-size: 13px;
}

.head__meta b {
  font-weight: 600;
  color: var(--ink-2);
}

.head__progress {
  color: var(--ink-accent);
}

.note {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--st-fail);
}
</style>
