<script setup lang="ts">
import type { GrowthCreditDay } from '@workbench/usage'
import type { EChartsCoreOption, EChartsType } from 'echarts/core'
import { Coin, Refresh } from '@element-plus/icons-vue'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { init, use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import { useSettingsStore } from '@/stores/settings'

/**
 * 福利栏的「近一个月积分获取」柱状图。
 *
 * 数据由 `@workbench/usage` 的 `dailyGrowthCredits` 按当前范围汇总好（30 天、旧→新、
 * 缺的天已补 0），这里只做画图：柱高按窗口内的最大值归一，横轴每隔几根标一次日期。
 *
 * 图用 ECharts 画，**按需引入**（`echarts/core` + Bar / Grid / Tooltip + Canvas，
 * 不引整包）：项目里本来就带着 echarts（pptx-renderer 的传递依赖），这里只是把它提成
 * 直接依赖。纵轴仍只标半程与顶格两条 —— 积分量级小，四条刻度会挤成一串重复数字。
 *
 * 柱子取「已获取福利总积分」那枚图标的橙：两者是同一个语义（积分进账）。
 * **不用主题色** —— 主题色只管交互态与首页 / 用量页那两张图（见 accent-color.ts 的文件头）。
 * 文字与网格线取设计令牌（每次画图现读 CSS 变量），明暗切换跟着 store 的
 * `effectiveTheme` 重画，不写死两套颜色。
 */
const props = defineProps<{
  /** 最近 30 天，旧→新 */
  days: GrowthCreditDay[]
  /** 窗口内合计（含所有账号） */
  total: number
  /** 当前看的是谁：全部账号合计 / 某个号 */
  scope: string
  /** 没读到的账号数（其余账号照常画） */
  failed: number
  loading: boolean
  /** 整张图没读到的原因 */
  error: string
  /** 空态第二行：Qoder 没有成长任务，用它换掉默认文案 */
  hint?: string
}>()

// ECharts 按需注册：只登记这张图用到的能力，不引整包
use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

const settings = useSettingsStore()

/** 柱子与悬停色：固定取「福利积分的橙」，不跟主题色走 */
const BAR_COLOR = '#c2410c'
const BAR_HOVER = '#9a3412'

const host = ref<HTMLDivElement | null>(null)
let chart: EChartsType | null = null
let resizeObserver: ResizeObserver | null = null

const hasData = computed(() => props.days.some(day => day.credit > 0))
const maxCredit = computed(() => Math.max(0, ...props.days.map(day => day.credit)))

function fmt(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** 设计令牌：画布上要的是具体颜色，CSS 变量得现读（明暗各一份） */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** 悬停浮卡：axis 触发时参数是数组，取第一项的下标回查原始数据 */
function tipText(raw: unknown): string {
  const list = Array.isArray(raw) ? raw : [raw]
  const index = (list[0] as { dataIndex?: number } | undefined)?.dataIndex
  const day = typeof index === 'number' ? props.days[index] : undefined
  if (!day)
    return ''
  return day.credit > 0
    ? `${day.date} · +${fmt(day.credit)} 积分`
    : `${day.date} · 没有获取积分`
}

function buildOption(): EChartsCoreOption {
  const days = props.days
  const max = maxCredit.value
  // 纵轴刻度：半程与顶格（量级太小时只留顶格，否则两条刻度会重复）
  const interval = max >= 4 ? max / 2 : max
  // 横轴标签抽稀到七来个；最后一天（今天）始终标出来
  const every = Math.max(1, Math.ceil(days.length / 6))
  const ink = token('--ink', '#1b212a')
  const ink3 = token('--ink-3', '#5a6472')
  const border = token('--border', '#e1e4e9')
  const surface = token('--bg-surface', '#ffffff')
  const mono = token('--font-mono', 'monospace')

  return {
    animationDuration: 240,
    animationDurationUpdate: 200,
    grid: { left: 40, right: 0, top: 10, bottom: 18 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: surface,
      borderColor: border,
      borderRadius: 6,
      padding: [6, 10],
      textStyle: { color: ink, fontSize: 12 },
      axisPointer: {
        type: 'shadow',
        shadowStyle: { color: 'rgba(128, 138, 152, 0.10)' },
      },
      formatter: (raw: unknown) => tipText(raw),
    },
    xAxis: {
      type: 'category',
      data: days.map(day => day.date.slice(5)),
      axisLine: { lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: {
        color: ink3,
        fontFamily: mono,
        fontSize: 10.5,
        margin: 8,
        interval: (index: number) => index % every === 0 || index === days.length - 1,
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max,
      interval,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: ink3,
        fontFamily: mono,
        fontSize: 10.5,
        // 0 不标：底线本身就是轴，标出来只会多一行灰字
        formatter: (value: number) => (value === 0 ? '' : String(Math.round(value))),
      },
      splitLine: { lineStyle: { color: border, type: 'dashed' } },
    },
    series: [
      {
        type: 'bar',
        data: days.map(day => day.credit),
        barCategoryGap: '3px',
        itemStyle: { color: BAR_COLOR, borderRadius: [6, 6, 0, 0] },
        emphasis: { itemStyle: { color: BAR_HOVER } },
      },
    ],
  }
}

function render(): void {
  if (!hasData.value) {
    disposeChart()
    return
  }
  // 等 v-else 把画布容器挂上再 init（数据从加载态切过来时容器还不存在）
  void nextTick(() => {
    if (!host.value || !hasData.value)
      return
    // 加载态会把容器整块换掉：旧实例还挂在已被移除的节点上，得重建
    if (chart && chart.getDom() !== host.value)
      disposeChart()
    if (!chart) {
      chart = init(host.value, undefined, { renderer: 'canvas' })
      resizeObserver = new ResizeObserver(() => {
        if (host.value && host.value.clientWidth > 0)
          chart?.resize()
      })
      resizeObserver.observe(host.value)
    }
    chart.setOption(buildOption(), true)
  })
}

function disposeChart(): void {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.dispose()
  chart = null
}

watch(() => props.days, render, { deep: true })
// 加载结束时要重画：加载态把画布容器换掉了，光靠 days 变化不一定触发
watch(() => props.loading, render)
// 明暗切换：文字 / 网格线 / 浮卡要重取令牌（柱子色不变）
watch(() => settings.effectiveTheme, render)
onMounted(render)
onBeforeUnmount(disposeChart)
</script>

<template>
  <section class="credits-chart">
    <header class="credits-chart__head">
      <h4 class="credits-chart__title">
        近一个月积分获取
      </h4>
      <span class="credits-chart__dim">
        {{ scope }}<template v-if="failed"> · {{ failed }} 个账号未读到</template>
        <template v-if="hasData"> · 合计 +{{ fmt(total) }} 积分</template>
      </span>
    </header>

    <div v-if="loading" class="credits-chart__loading">
      <el-icon class="credits-chart__spin">
        <Refresh />
      </el-icon>
      <span>读取积分流水…</span>
    </div>
    <EmptyState
      v-else-if="!hasData"
      compact
      :icon="Coin"
      :text="error ? '读取积分流水失败' : '近一个月还没有获得积分'"
      :hint="error || hint || '签到或做成长任务后会记在这里'"
    />
    <div v-else ref="host" class="credits-chart__plot" />
  </section>
</template>

<style scoped>
/* 这一段不参与面板的伸缩：高度固定，表格那一格继续吃满剩下的高度 */
.credits-chart {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  flex: none;
}

.credits-chart__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  min-width: 0;
}

.credits-chart__title {
  margin: 0;
  font-size: var(--gw-fs-meta);
  font-weight: 600;
  color: var(--ink);
}

.credits-chart__dim {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 画布容器：ECharts 要一个定高的宿主（宽度由 flex 给）；高度与原来的手绘图同量级 */
.credits-chart__plot {
  height: 120px;
}

/* 读取中占住与图一样的高度，数据回来时面板不跟着跳 */
.credits-chart__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: 120px;
  color: var(--ink-3);
  font-size: var(--gw-fs-meta);
}

.credits-chart__spin {
  animation: credits-chart-spin 1s linear infinite;
}

@keyframes credits-chart-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
