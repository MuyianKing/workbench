<script setup lang="ts">
import type { EtfOverview } from '@workbench/etf'
import type { Component } from 'vue'
import { AlarmClock, Calendar, Clock, Coin, Flag, Timer, Watch } from '@element-plus/icons-vue'
import { formatYiNumber } from '@workbench/etf'

/**
 * 顶部一排 KPI 小卡：窗口净买卖（红买绿卖）+ 当前总规模。
 * 金额都已经是亿元，口径（过百取整、正数补加号）在 packages/etf 的 formatYiNumber。
 * 每张卡配一枚时间系小图标（总规模是钱币），随标签走弱墨色。
 */
defineProps<{
  totals: EtfOverview['totals']
}>()

const CARDS: Array<{ key: keyof EtfOverview['totals'], label: string, icon: Component }> = [
  { key: 'todayYi', label: '最新交易日', icon: Calendar },
  { key: 'weekYi', label: '近一周', icon: Clock },
  { key: 'monthYi', label: '近一月', icon: Timer },
  { key: 'halfYearYi', label: '近半年', icon: AlarmClock },
  { key: 'yearYi', label: '近一年', icon: Watch },
  { key: 'ytdYi', label: '今年以来', icon: Flag },
]

/** 净买卖的符号着色：红 = 净买入、绿 = 净卖出（A 股惯例，取 --st-fail / --st-ok 的色相） */
function flowClass(value: number): string {
  if (value > 0)
    return 'is-in'
  if (value < 0)
    return 'is-out'
  return 'is-flat'
}
</script>

<template>
  <div class="cards">
    <div v-for="card in CARDS" :key="card.key" class="card">
      <span class="card__label"><el-icon><component :is="card.icon" /></el-icon>{{ card.label }}</span>
      <span class="card__value" :class="flowClass(totals[card.key])">
        {{ formatYiNumber(totals[card.key], true) }}<span class="card__unit">亿</span>
      </span>
    </div>
    <div class="card">
      <span class="card__label"><el-icon><Coin /></el-icon>当前总规模</span>
      <span class="card__value">{{ formatYiNumber(totals.scaleYi) }}<span class="card__unit">亿</span></span>
    </div>
  </div>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--sp-2);
}

/* 与网关用量页的 KPI 卡同一配方：玻璃底、不叠阴影，六七块小卡各带一片阴影太吵。
 * 只有两行（标签 + 数值），单位并进数值行 —— 不为一句「净买入 亿元」垫第三行的空白 */
.card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--glass-border-color);
  border-radius: var(--r-md);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  backdrop-filter: var(--glass-filter);
}

.card__label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.card__label .el-icon {
  flex: none;
  font-size: 13px;
}

.card__value {
  font-size: var(--fs-title);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.card__unit {
  margin-left: 2px;
  font-size: var(--fs-micro);
  font-weight: 400;
  color: var(--ink-3);
}

/* 本页唯一的彩色例外：净买红 / 净卖绿（A 股惯例），色相取状态色的红与绿，别处不扩 */
.is-in {
  color: var(--st-fail);
}

.is-out {
  color: var(--st-ok);
}

.is-flat {
  color: var(--ink-2);
}
</style>
