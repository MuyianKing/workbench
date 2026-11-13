<script setup lang="ts">
import type { TokenCounters, UsageAxis } from '@workbench/usage'
import { axisTotal, formatCredits, formatTokensWan } from '@workbench/usage'

/**
 * 用量卡片顶部那三格概览：今日 / 本周 / 当前窗口。
 *
 * 从 `TokenPanel.vue` 拆出来的纯展示块：只拿三组计数与两个文案，自己按口径换算。
 */
const props = defineProps<{
  today: TokenCounters
  week: TokenCounters
  range: TokenCounters
  rangeLabel: string
  rangeTitle: string
  axis: UsageAxis
}>()

/** 一组计数在当前口径下的显示文字：token 走数量级短写法，额度走小数 */
function formatCounters(counters: TokenCounters): string {
  const value = axisTotal(counters, props.axis)
  return props.axis === 'credits' ? formatCredits(value) : formatTokensWan(value)
}
</script>

<template>
  <div class="topline">
    <div class="top">
      <i>今日</i>
      <b class="mono">{{ formatCounters(today) }}</b>
    </div>
    <div class="top">
      <i>本周</i>
      <b class="mono">{{ formatCounters(week) }}</b>
    </div>
    <div class="top" :title="rangeTitle">
      <i>{{ rangeLabel }}</i>
      <b class="mono">{{ formatCounters(range) }}</b>
    </div>
  </div>
</template>

<style scoped>
.topline {
  display: flex;
  flex-shrink: 0;
}

/* 三项平分卡片宽度，文字各自居中 */
.top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: 1 1 0;
}

.top i {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.top b {
  font-weight: 600;
  font-size: var(--fs-body);
}
</style>
