<script setup lang="ts">
import type { EtfDayFlow } from '@workbench/etf'
import { TrendCharts } from '@element-plus/icons-vue'
import { formatDayKey, formatYi } from '@workbench/etf'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { usePlotHover } from '@/composables/use-plot-hover'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import EtfPlotTip from './EtfPlotTip.vue'

/**
 * 总规模曲线：23 只 ETF 的「份额 × 净值」合计（全体持有人口径，不是汇金持仓）。
 * 主图**默认只看近一年**（约 242 个交易日，与 KPI 的「近一年」同口径），
 * 下面那条概览条画全量五年：拖亮窗平移、拖两侧把手改宽度、点窗口外直接跳过去，
 * 头部的「近 1 年 / 近 3 年 / 全部」是快捷档——手动拖过之后就不再是任何一档。
 * 悬停（composables/use-plot-hover）落在窗口内哪格，参考线与浮卡就给那天的日期与规模。
 */
const props = defineProps<{
  days: EtfDayFlow[]
  scaleSeries: number[]
}>()

/** 近一年 ≈ 242 个交易日；近三年翻三倍 */
const YEAR_POINTS = 242
const THREE_YEAR_POINTS = 726
/** 窗口最少 20 个交易日，再窄就读不出形状了 */
const MIN_WINDOW = 20

const windowStart = ref(0)
const windowCount = ref(0)

/**
 * 窗口随数据变化：首次默认近一年贴末尾；之后增量更新保住用户选的宽度，
 * 窗口本来贴着末尾的（默认态）继续贴末尾，挪到中间看的保持位置。
 */
watch(() => props.scaleSeries.length, (total, before) => {
  if (!before) {
    windowCount.value = Math.min(YEAR_POINTS, total)
    windowStart.value = total - windowCount.value
    return
  }
  const atEnd = windowStart.value + windowCount.value >= before
  windowCount.value = Math.min(windowCount.value, total)
  windowStart.value = atEnd
    ? total - windowCount.value
    : Math.min(windowStart.value, Math.max(0, total - windowCount.value))
}, { immediate: true })

const totalPoints = computed(() => props.scaleSeries.length)

/** 主图画的就是窗口这一段 */
const visible = computed(() => ({
  days: props.days.slice(windowStart.value, windowStart.value + windowCount.value),
  values: props.scaleSeries.slice(windowStart.value, windowStart.value + windowCount.value),
}))

/** 折线的 SVG 路径：点位在格中心((i+0.5)/n)，与悬停的格位口径一致 */
function buildPath(values: number[]): { path: string, min: number, max: number } | null {
  if (values.length < 2)
    return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = 1000 / values.length
  // y 留上下各一成当内边距：贴着边画的线像被裁过
  const path = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${((index + 0.5) * step).toFixed(1)} ${(88 - (value - min) / span * 80).toFixed(1)}`)
    .join(' ')
  return { path, min, max }
}

const line = computed(() => buildPath(visible.value.values))
const overview = computed(() => buildPath(props.scaleSeries)?.path ?? '')

// ---------- 悬停 ----------

const { hoverIndex, pointerX, containerWidth, onPlotMove, onPlotLeave } = usePlotHover(() => visible.value.values.length)

const guideLeft = computed(() => {
  const index = hoverIndex.value
  if (index === null || visible.value.values.length === 0)
    return null
  return `${((index + 0.5) / visible.value.values.length * 100).toFixed(2)}%`
})

/** 浮卡横坐标：跟随指针，按半卡宽（约 64px）夹在容器里 */
const tipX = computed(() =>
  Math.min(Math.max(pointerX.value, 64), Math.max(64, containerWidth.value - 64)))

const tip = computed(() => {
  const index = hoverIndex.value
  const day = index !== null ? visible.value.days[index] : undefined
  const value = index !== null ? visible.value.values[index] : undefined
  if (!day || value === undefined)
    return null
  const rows: Array<{ label: string, value: string, tone?: 'in' | 'out' }>
    = [{ label: '总规模', value: `${formatYi(value)} 亿` }]
  return { caption: formatDayKey(day.date, true), rows }
})

// ---------- 快捷档 ----------

const RANGE_PRESETS = [
  { label: '近1年', value: 'y1' },
  { label: '近3年', value: 'y3' },
  { label: '全部', value: 'all' },
]

const preset = ref('y1')

watch(preset, (value) => {
  const total = totalPoints.value
  if (!value || total === 0)
    return
  const width = value === 'all' ? total : Math.min(value === 'y3' ? THREE_YEAR_POINTS : YEAR_POINTS, total)
  windowCount.value = width
  windowStart.value = total - width
})

// ---------- 概览条拖动 ----------

type DragMode = 'pan' | 'left' | 'right'

const stripEl = ref<HTMLElement | null>(null)
/** 这一次拖动的准备值：位移换算的基准，Esc 取消时也拿它还原 */
let dragBase: { start: number, count: number, mode: DragMode, pxPerPoint: number } | null = null
let activeFinisher: (() => void) | null = null

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}

function beginDrag(mode: DragMode, event: PointerEvent): void {
  const strip = stripEl.value
  if (!strip || activeFinisher)
    return
  event.preventDefault()
  const width = strip.getBoundingClientRect().width
  dragBase = {
    start: windowStart.value,
    count: windowCount.value,
    mode,
    pxPerPoint: width / Math.max(1, totalPoints.value),
  }
  activeFinisher = startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: mode === 'pan' ? 'is-panning-etf-range' : 'is-resizing-etf-range',
    onMove: move => applyDrag(move.clientX - event.clientX),
    onEnd: (_last, cancelled) => {
      if (cancelled && dragBase) {
        windowStart.value = dragBase.start
        windowCount.value = dragBase.count
      }
      dragBase = null
      activeFinisher = null
    },
  })
}

/** 位移（px）换算成窗口的变化：平移移动起点，两侧把手只动自己那条边 */
function applyDrag(dx: number): void {
  const base = dragBase
  if (!base)
    return
  const total = totalPoints.value
  const minWindow = Math.min(MIN_WINDOW, total)
  const delta = Math.round(dx / base.pxPerPoint)
  if (base.mode === 'pan') {
    windowStart.value = clamp(base.start + delta, 0, total - base.count)
    windowCount.value = base.count
  }
  else if (base.mode === 'left') {
    const left = clamp(base.start + delta, 0, base.start + base.count - minWindow)
    windowStart.value = left
    windowCount.value = base.start + base.count - left
  }
  else {
    const right = clamp(base.start + base.count + delta, base.start + minWindow, total)
    windowCount.value = right - base.start
  }
  preset.value = '' // 手动拖过就不再是任何快捷档
}

/** 概览条上按下：窗口内起手平移；窗口外先把窗口居中到按下处、接着还能继续拖 */
function onStripDown(event: PointerEvent): void {
  const strip = stripEl.value
  if (!strip)
    return
  const box = strip.getBoundingClientRect()
  const x = event.clientX - box.left
  const winLeftPx = windowStart.value / Math.max(1, totalPoints.value) * box.width
  const winWidthPx = windowCount.value / Math.max(1, totalPoints.value) * box.width
  if (x < winLeftPx || x > winLeftPx + winWidthPx) {
    const count = windowCount.value
    const index = x / box.width * totalPoints.value
    windowStart.value = clamp(Math.round(index - count / 2), 0, totalPoints.value - count)
  }
  beginDrag('pan', event)
}

function onHandleDown(mode: 'left' | 'right', event: PointerEvent): void {
  beginDrag(mode, event)
}

onBeforeUnmount(() => {
  activeFinisher?.()
})

/** 亮窗在概览条上的位置（百分比） */
const winPct = computed(() => {
  const total = Math.max(1, totalPoints.value)
  return {
    left: windowStart.value / total * 100,
    width: windowCount.value / total * 100,
  }
})
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h3><el-icon><TrendCharts /></el-icon>总规模</h3>
      <div class="head-right">
        <span v-if="line" class="dim">{{ formatYi(line.min) }} ~ {{ formatYi(line.max) }} 亿元</span>
        <el-segmented v-model="preset" :options="RANGE_PRESETS" size="small" />
      </div>
    </div>
    <template v-if="line">
      <div class="scale-body" @mousemove="onPlotMove" @mouseleave="onPlotLeave">
        <svg
          class="line"
          viewBox="0 0 1000 100"
          preserveAspectRatio="none"
          role="img"
          aria-label="23 只 ETF 总规模走势"
        >
          <path :d="line.path" fill="none" stroke="var(--ink-2)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
        </svg>
        <span v-if="guideLeft" class="guide" :style="{ left: guideLeft }" />
        <EtfPlotTip v-if="tip" :x="tipX" :caption="tip.caption" :rows="tip.rows" />
      </div>
      <div class="range">
        <span>{{ formatDayKey(visible.days[0].date, true) }}</span>
        <span>{{ formatDayKey(visible.days[visible.days.length - 1].date, true) }}</span>
      </div>
      <!-- 概览条：全量五年一条迷你线，亮窗就是上面的主图在看的范围 -->
      <div ref="stripEl" class="strip" @pointerdown="onStripDown">
        <svg class="strip__svg" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
          <path v-if="overview" :d="overview" fill="none" stroke="var(--ink-3)" stroke-width="1" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="strip__dim is-left" :style="{ right: `${100 - winPct.left}%` }" />
        <div class="strip__dim is-right" :style="{ left: `${winPct.left + winPct.width}%` }" />
        <div class="strip__win" :style="{ left: `${winPct.left}%`, width: `${winPct.width}%` }">
          <span class="strip__handle is-left" @pointerdown.stop="onHandleDown('left', $event)" />
          <span class="strip__handle is-right" @pointerdown.stop="onHandleDown('right', $event)" />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.dim {
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.head-right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

/* 悬停容器：折线、参考线与浮卡都拿它定位 */
.scale-body {
  position: relative;
}

/* 折线取中性灰：主题色在这张卡里只上概览条的亮窗（交互控件），曲线本身不上色 */
.line {
  display: block;
  width: 100%;
  height: 96px;
}

.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-strong);
  pointer-events: none;
}

.range {
  display: flex;
  justify-content: space-between;
  margin-top: var(--sp-1);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 概览条：整条可拖（窗口内平移、窗口外跳转），把手改宽度。
 * 做成一条看得出来的滑轨——轨道底 + 圆角 + 亮窗浮起 + 带描边的抓手，
 * 三样凑齐才像控件，不然就是一条看不出能拖的线 */
.strip {
  position: relative;
  height: 40px;
  margin-top: var(--sp-2);
  border-radius: var(--r-md);
  cursor: grab;
  touch-action: none;
  background: var(--bg-inset);
  border: 1px solid var(--border);
}

.strip__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* 窗口外的部分再压一层画布色的暗纱，亮窗里的迷你线才突出来 */
.strip__dim {
  position: absolute;
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--bg-canvas) 52%, transparent);
  pointer-events: none;
}

/* 亮窗：主色浅纱 + 主色描边 + 轻微浮起，悬停时描边到主色实色（拖不拖得动一眼可辨）。
 * 主色没配时是中性灰，整条照旧灰阶 —— 口径见 accent-color.ts 文件头 */
.strip__win {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 50%, transparent);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--el-color-primary) 16%, transparent);
  box-shadow: 0 1px 6px -1px rgba(17, 21, 27, 0.22);
}

.strip:hover .strip__win {
  border-color: var(--el-color-primary);
}

.strip__handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 12px;
  cursor: ew-resize;
}

.strip__handle.is-left {
  left: -1px;
}

.strip__handle.is-right {
  right: -1px;
}

/* 抓手：一枚带描边的小圆杠，比裸竖线像「捏得住」的东西；悬停加深 */
.strip__handle::after {
  content: '';
  position: absolute;
  top: 50%;
  width: 3px;
  height: 14px;
  transform: translateY(-50%);
  border-radius: 2px;
  background: var(--ink-2);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--bg-surface) 55%, transparent);
}

.strip__handle.is-left::after {
  left: 3px;
}

.strip__handle.is-right::after {
  right: 3px;
}

.strip__handle:hover::after {
  background: var(--ink);
}
</style>
