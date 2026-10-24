<script setup lang="ts">
/**
 * 手写图表的悬停浮卡:顶行日期 + 若干数据行,绝对定位在图表容器里。
 * 位置由调用方给(x 已按容器宽夹过),这里只管外观与翻转;不接鼠标事件,
 * 悬停的格位计算在 composables/use-plot-hover。
 */
defineProps<{
  /** 相对图表容器的横向位置(px,调用方已夹在容器内) */
  x: number
  /** 顶行:日期 */
  caption: string
  /** 数据行:标签 + 值;in = 净买入红、out = 净卖出绿,默认中性 */
  rows: Array<{ label: string, value: string, tone?: 'in' | 'out' }>
}>()
</script>

<template>
  <div class="tip" :style="{ left: `${x}px` }">
    <span class="tip__caption">{{ caption }}</span>
    <span v-for="row in rows" :key="row.label" class="tip__row">
      <span class="tip__label">{{ row.label }}</span>
      <span class="tip__value" :class="row.tone">{{ row.value }}</span>
    </span>
  </div>
</template>

<style scoped>
.tip {
  position: absolute;
  top: var(--sp-1);
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 120px;
  padding: 4px 8px;
  transform: translateX(-50%);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-surface);
  box-shadow: var(--shadow-pop);
  font-size: var(--fs-micro);
  pointer-events: none;
  white-space: nowrap;
}

.tip__caption {
  font-weight: 600;
  color: var(--ink-2);
}

.tip__row {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-3);
}

.tip__label {
  color: var(--ink-3);
}

.tip__value {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.tip__value.in {
  color: var(--st-fail);
}

.tip__value.out {
  color: var(--st-ok);
}
</style>
