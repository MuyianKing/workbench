<script setup lang="ts">
import type { EtfDayFlow } from '@workbench/etf'
import { Histogram } from '@element-plus/icons-vue'
import { formatDayKey, formatYi } from '@workbench/etf'
import { computed } from 'vue'
import { usePlotHover } from '@/composables/use-plot-hover'
import EtfPlotTip from './EtfPlotTip.vue'

/**
 * 每日净买卖柱状图：柱子手绘（一排 div，正负各占半区、零线居中），
 * 与网关用量页同一套画法。悬停（composables/use-plot-hover）落在哪一格，
 * 竖参考线就竖在哪根柱上，浮卡给日期 / 净买卖。
 */
const props = defineProps<{
  days: EtfDayFlow[]
}>()

/** 固定看最近 21 个交易日：再长就该去下面的明细矩阵翻了 */
const WINDOW = 21

const bars = computed(() => {
  const list = props.days.slice(-WINDOW)
  const maxAbs = Math.max(1, ...list.map(day => Math.abs(day.total)))
  const every = Math.max(1, Math.ceil(list.length / 8))
  return list.map((day, index) => ({
    date: day.date,
    value: day.total,
    // 半区归一：零线在 50%，正柱往上、负柱往下
    height: day.total !== 0 ? Math.max(2, Math.round(Math.abs(day.total) / maxAbs * 50)) : 0,
    label: index % every === 0 ? formatDayKey(day.date) : '',
  }))
})

/** 纵轴刻度：零线居中，上下对称取 1/2/5×10ᵏ 的整档；还没有任何非零数据时给 1 亿的档 */
const ticks = computed(() => {
  const list = props.days.slice(-WINDOW)
  const peak = Math.max(0, ...list.map(day => Math.abs(day.total)))
  let top = 1
  if (peak > 0) {
    const base = 10 ** Math.floor(Math.log10(peak / 1e8))
    for (const multiple of [1, 2, 5, 10]) {
      if (peak / 1e8 <= multiple * base) {
        top = multiple * base
        break
      }
    }
  }
  return { top, bottom: -top }
})

// ---------- 悬停 ----------

const { hoverIndex, pointerX, containerWidth, onPlotMove, onPlotLeave } = usePlotHover(() => bars.value.length)

/** 竖参考线落在悬停那格的中心(百分比定位,横跨柱区) */
const guideLeft = computed(() => {
  const index = hoverIndex.value
  if (index === null || bars.value.length === 0)
    return null
  return `${((index + 0.5) / bars.value.length * 100).toFixed(2)}%`
})

/** 浮卡横坐标：跟随指针，按半卡宽（约 64px）夹在容器里 */
const tipX = computed(() =>
  Math.min(Math.max(pointerX.value, 64), Math.max(64, containerWidth.value - 64)))

/** 浮卡内容：日期 + 净买卖（红买绿卖） */
const tip = computed(() => {
  const index = hoverIndex.value
  const bar = index !== null ? bars.value[index] : undefined
  if (!bar)
    return null
  const rows: Array<{ label: string, value: string, tone?: 'in' | 'out' }> = [
    { label: '净买卖', value: `${formatYi(bar.value, true)} 亿`, tone: bar.value > 0 ? 'in' : bar.value < 0 ? 'out' : undefined },
  ]
  return { caption: formatDayKey(bar.date, true), rows }
})
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h3><el-icon><Histogram /></el-icon>每日净买卖</h3>
      <span class="dim">近 21 个交易日 · 亿元</span>
    </div>
    <template v-if="bars.length">
      <div class="plot">
        <div class="yaxis" aria-hidden="true">
          <span class="ytick" style="top: 0">{{ `+${ticks.top}` }}</span>
          <span class="ytick" style="top: 50%">0</span>
          <span class="ytick" style="top: 100%">{{ ticks.bottom }}</span>
        </div>
        <!-- 悬停挂在柱区与横轴的共同容器上：格位、参考线与浮卡都从它起算 -->
        <div class="flow-body" @mousemove="onPlotMove" @mouseleave="onPlotLeave">
          <div class="chart">
            <div class="grid" aria-hidden="true">
              <span class="gridline" style="top: 0" />
              <span class="gridline is-zero" style="top: 50%" />
              <span class="gridline" style="top: 100%" />
            </div>
            <div v-for="bar in bars" :key="bar.date" class="slot">
              <span
                v-if="bar.height > 0"
                class="bar"
                :class="bar.value > 0 ? 'is-in' : 'is-out'"
                :style="bar.value > 0
                  ? { bottom: '50%', height: `${bar.height}%` }
                  : { top: '50%', height: `${bar.height}%` }"
              />
            </div>
          </div>
          <div class="axis">
            <span v-for="bar in bars" :key="bar.date" class="axis-slot">{{ bar.label }}</span>
          </div>
          <span v-if="guideLeft" class="guide" :style="{ left: guideLeft }" />
          <EtfPlotTip v-if="tip" :x="tipX" :caption="tip.caption" :rows="tip.rows" />
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

.plot {
  display: flex;
  gap: var(--sp-1);
}

.yaxis {
  position: relative;
  width: 2.5em;
  flex: none;
  height: 150px;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.ytick {
  position: absolute;
  right: 4px;
  transform: translateY(-50%);
  white-space: nowrap;
}

/* 悬停容器：柱区与横轴纵着摞，参考线与浮卡拿它定位 */
.flow-body {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.chart {
  position: relative;
  display: flex;
  /* 柱间只留一条细缝：21 根柱铺满整行，稀了整片都是空档 */
  gap: var(--sp-1);
  height: 150px;
}

.grid {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.gridline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
}

/* 零线画实线：正负半区的分界是读数的基准 */
.gridline.is-zero {
  border-top-style: solid;
  border-top-color: var(--border-strong);
}

.slot {
  position: relative;
  z-index: 1;
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
}

/* 柱子铺满整个槽（最宽 36px），红买绿卖是本页唯一的彩色 */
.bar {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: 36px;
}

.bar.is-in {
  background: var(--st-fail);
  border-radius: var(--r-sm) var(--r-sm) 0 0;
}

.bar.is-out {
  background: var(--st-ok);
  border-radius: 0 0 var(--r-sm) var(--r-sm);
}

/* 刻度行与柱区同一套槽宽与间隙，数字才落在自己那根柱子底下 */
.axis {
  display: flex;
  gap: var(--sp-1);
  margin-top: var(--sp-1);
}

.axis-slot {
  flex: 1 1 0;
  min-width: 0;
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

/* 悬停竖参考线：横跨柱区与横轴 */
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 1;
  width: 1px;
  background: var(--border-strong);
  pointer-events: none;
}
</style>
