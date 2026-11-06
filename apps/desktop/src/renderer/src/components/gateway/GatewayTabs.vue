<script setup lang="ts" generic="T extends string">
defineProps<{
  items: ReadonlyArray<{ label: string, value: T }>
}>()

/**
 * 网关页共用页签（TBuddy 与 Qoder）。
 *
 * 为什么收成一个组件：两个页签必须是**同一副大小** —— EP 的默认字号走全局
 * `--el-font-size-base`（13px），而网关页比全局大一号（`--gw-fs-body`，14px）；
 * 各写一份 CSS 时，哪边漏掉字号就会小一圈（Qoder 的页签之前就是这么小掉的）。
 * 样式只在这里定义，两个页面都别再自己写 `el-tabs` 的 deep 规则。
 *
 * 下划线式导航，只留文字 + 2px 主色下划线，不铺底色、也不拉满整行。
 */
const model = defineModel<T>({ required: true })

function onChange(value: string | number): void {
  model.value = String(value) as T
}
</script>

<template>
  <el-tabs
    class="gw-tabs"
    :model-value="model"
    @update:model-value="onChange"
  >
    <el-tab-pane v-for="item in items" :key="item.value" :label="item.label" :name="item.value" />
  </el-tabs>
</template>

<style scoped>
.gw-tabs {
  flex: none;
}

.gw-tabs :deep(.el-tabs__header) {
  margin: 0;
}

/* 不要 EP 那条贯穿整行的底线，只保留选中项下面那一截 */
.gw-tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

/* 字号必须是网关页那一套（14px）：EP 默认吃全局的 13px */
.gw-tabs :deep(.el-tabs__item) {
  height: 34px;
  padding: 0;
  margin-right: var(--sp-5);
  font-size: var(--gw-fs-body);
  color: var(--ink-3);
}

.gw-tabs :deep(.el-tabs__item:last-child) {
  margin-right: 0;
}

.gw-tabs :deep(.el-tabs__item.is-active) {
  color: var(--ink);
  font-weight: 600;
}

.gw-tabs :deep(.el-tabs__item:hover) {
  color: var(--ink);
}

.gw-tabs :deep(.el-tabs__active-bar) {
  height: 2px;
  border-radius: var(--r-pill);
  background: var(--el-color-primary);
}

/* 页签只是导航，内容由下面几栏自己渲染 */
.gw-tabs :deep(.el-tabs__content) {
  display: none;
}
</style>
