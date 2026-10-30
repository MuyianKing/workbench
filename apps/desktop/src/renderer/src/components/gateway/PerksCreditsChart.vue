<script setup lang="ts">
import type { GrowthCreditDay } from '@workbench/usage'
import { Coin, Refresh } from '@element-plus/icons-vue'
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'

/**
 * 福利栏的「近一个月积分获取」柱状图。
 *
 * 数据由 `@workbench/usage` 的 `dailyGrowthCredits` 按当前范围汇总好（30 天、旧→新、
 * 缺的天已补 0），这里只做画图：柱高按窗口内的最大值归一，横轴每隔几根标一次日期。
 * 图是手绘的（一排 div），与用量页那张时序图同一套做法 —— 不为一张柱状图引图表库。
 *
 * 柱子取「已获取福利总积分」那枚图标的橙：两者是同一个语义（积分进账）。
 * **不用主题色** —— 主题色只管交互态与首页 / 用量页那两张图（见 accent-color.ts 的文件头）。
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
}>()

const hasData = computed(() => props.days.some(day => day.credit > 0))
const maxCredit = computed(() => Math.max(0, ...props.days.map(day => day.credit)))

/** 纵轴刻度：只有半程与顶格两条（积分量级小，四条刻度会挤成一串重复数字） */
const ticks = computed(() => {
  const max = maxCredit.value
  if (max <= 0)
    return []
  const ratios = max >= 4 ? [0.5, 1] : [1]
  return ratios.map(ratio => ({ pct: ratio * 100, label: String(Math.round(max * ratio)) }))
})

/** 横轴标签抽稀到七来个；最后一天（今天）始终标出来 */
const bars = computed(() => {
  const max = Math.max(1, maxCredit.value)
  const every = Math.max(1, Math.ceil(props.days.length / 6))
  return props.days.map((day, index) => ({
    ...day,
    height: day.credit > 0 ? `${Math.max(3, Math.round(day.credit / max * 100))}%` : '0%',
    label: index % every === 0 || index === props.days.length - 1 ? day.date.slice(5) : '',
  }))
})

function fmt(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function tipOf(day: GrowthCreditDay): string {
  return day.credit > 0
    ? `${day.date} · +${fmt(day.credit)} 积分`
    : `${day.date} · 没有获取积分`
}
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
      :hint="error || '签到或做成长任务后会记在这里'"
    />
    <div v-else class="credits-chart__plot">
      <!-- 纵轴：只标半程与顶格，位置与右下的柱子同高 -->
      <div class="credits-chart__yaxis" aria-hidden="true">
        <span
          v-for="tick in ticks"
          :key="tick.pct"
          class="credits-chart__ytick"
          :style="{ bottom: `${tick.pct}%` }"
        >{{ tick.label }}</span>
      </div>
      <div class="credits-chart__main">
        <div class="credits-chart__plot-area">
          <!-- 虚线网格画在柱子后面 -->
          <span
            v-for="tick in ticks"
            :key="tick.pct"
            class="credits-chart__gridline"
            :style="{ bottom: `${tick.pct}%` }"
          />
          <div
            v-for="bar in bars"
            :key="bar.date"
            class="credits-chart__bar"
            :title="tipOf(bar)"
          >
            <span class="credits-chart__fill" :style="{ height: bar.height }" />
          </div>
        </div>
        <!-- 刻度单独一行：塞进柱子底下会被矮柱子压住 -->
        <div class="credits-chart__axis">
          <span v-for="bar in bars" :key="bar.date" class="credits-chart__axis-slot">{{ bar.label }}</span>
        </div>
      </div>
    </div>
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

.credits-chart__plot {
  display: flex;
  gap: var(--sp-2);
}

/* 纵轴与柱子共用 96px：刻度按 50 / 100% 定位 */
.credits-chart__yaxis {
  position: relative;
  flex: none;
  width: 34px;
  height: 96px;
}

.credits-chart__ytick {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.credits-chart__main {
  flex: 1 1 auto;
  min-width: 0;
}

.credits-chart__plot-area {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 96px;
  border-bottom: 1px solid var(--border);
}

/* 横向网格：虚线、压淡，画在柱子后面 */
.credits-chart__gridline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
  pointer-events: none;
}

.credits-chart__bar {
  position: relative;
  z-index: 1;
  flex: 1 1 0;
  display: flex;
  align-items: flex-end;
  height: 100%;
  min-width: 0;
}

/* 柱子取「已获取福利总积分」那枚图标的橙（同一个语义：积分进账），不是装饰色 */
.credits-chart__fill {
  display: block;
  width: 100%;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
  background: #c2410c;
}

.credits-chart__bar:hover .credits-chart__fill {
  background: #9a3412;
}

/* 每一格与柱子的槽同宽同序，抽稀后剩下的数字仍落在自己那根柱子底下 */
.credits-chart__axis {
  display: flex;
  gap: 3px;
  margin-top: var(--sp-1);
}

.credits-chart__axis-slot {
  flex: 1 1 0;
  min-width: 0;
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

/* 读取中占住与图一样的高度，数据回来时面板不跟着跳 */
.credits-chart__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: 112px;
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
