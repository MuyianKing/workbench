<script setup lang="ts">
/**
 * TBuddy 的表格外壳：请求 / 用量明细 / 成长任务三张表共用这一份（ETF 页三张表也用它）。
 *
 * 三张表原先各写一套 EP 变量与 `:deep` 覆盖，表头一张实灰、一张白底、一张透明；
 * 钉住表头的那两张也只有一张留了底色，滚起来就会在字底下透出行文。外观收在这里一处：
 *
 * - **表头常驻一层主色浅底**（`--el-color-primary-light-7`，主色最浅那一档的实色 + 下沿短投影，
 *   与导航栏当前项同一档口径）：行从底下滚过也透不上来，停在顶部也不再整个透掉
 *   （原先「平时透底、滚起来才补底」，一回到顶部就瞬跳回透明）；没配主题色时主色是
 *   中性灰，表头照旧灰阶。**这层底必须不带 alpha** —— 半透明底会让行文从字缝里
 *   透上来（`backdrop-filter` 不采样同一滚动容器里滚过的内容，磨不出真磨砂）。
 * - **面板外壳也归这里**：`flat` 给已经在别人面板里的表用（用量明细），不再套一层卡。
 * - 列宽仍交给内容（`table-layout="auto"`）；列本身由调用方用 `el-table-column` 给。
 */
withDefaults(defineProps<{
  data: unknown[]
  /** 行键：字段名或取键函数（与 `el-table` 的 `row-key` 同义） */
  rowKey?: string | ((row: never) => string)
  /** 表体高度；钉住表头时传 `100%`，外层必须有确定高度 */
  height?: string
  /** 表体最大高度：行多了表内滚动、表头钉住（行少时照内容收，不垫空白） */
  maxHeight?: string
  /** 不铺面板外壳：调用方自己已经有面板了 */
  flat?: boolean
  /** 单元格不换行（一条流水就是一行） */
  nowrap?: boolean
  /** 初始排序（与 `el-table` 的 `default-sort` 同义，配合列上的 `sortable`） */
  defaultSort?: { prop: string, order: 'ascending' | 'descending' }
}>(), {
  rowKey: undefined,
  height: undefined,
  maxHeight: undefined,
  flat: false,
  nowrap: false,
  defaultSort: undefined,
})
</script>

<template>
  <div class="gw-table" :class="{ 'panel': !flat, 'is-flat': flat }">
    <el-table
      :data="data"
      :row-key="rowKey"
      :height="height"
      :max-height="maxHeight"
      :default-sort="defaultSort"
      table-layout="auto"
      class="gw-table__el"
      :class="{ 'is-nowrap': nowrap }"
    >
      <slot />
    </el-table>
  </div>
</template>

<style scoped>
/* 外壳的边距归零：表头与首行直接贴到卡片四边（尺寸、圆角、磨砂与投影取 .panel 那一套） */
.gw-table.panel {
  gap: 0;
  padding: 0;
  min-height: 0;
}

.gw-table.is-flat {
  min-width: 0;
}

.gw-table__el {
  width: 100%;
  /* 去掉 EP 自带底色与四周边线，行间只留一条横线；表头底色也先归零 ——
     常驻那层主色浅底铺在下面的 th 上（EP 会往 th 上盖自己的底色变量，得从那儿盖回去） */
  --el-table-border-color: var(--border);
  --el-table-header-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-bg-color: transparent;
  --el-table-header-text-color: var(--ink-2);
  --el-table-text-color: var(--ink-2);
  --el-table-row-hover-bg-color: transparent;
  font-size: var(--gw-fs-meta);

  /* 表头常驻底：主色最浅那一档（亮色往白里混七成、暗色往画布色里混七成）—— 实色，
     滚过的行不会从表头底下透出来；没配主题色时主色是中性灰 */
  --gw-head-bg: var(--el-color-primary-light-7);
}

/* 面板已经画了外框，表格自己那条底线不要 */
.gw-table__el :deep(.el-table__inner-wrapper::before) {
  display: none;
}

.gw-table__el :deep(.el-table__cell) {
  padding: var(--sp-2) 0;
}

.gw-table__el :deep(.cell) {
  padding: 0 var(--sp-2);
  line-height: 1.5;
}

/* 一条流水 / 一个任务在一行里读完：长文本自己带省略号，不靠换行泄出来 */
.gw-table__el.is-nowrap :deep(.cell) {
  white-space: nowrap;
}

/* 表头：常驻的主色浅底（实色 + 下沿短投影），只剩一条底线描边。
 * 投影的 spread 收得比 blur 还紧，横向不外溢，相邻单元格之间不会叠出竖着的暗缝；
 * 它落在滚动区里，行滚过来时是被压住，不是透上来。
 * 停在顶部时也是这一层 —— 不再「平时透底」，回到顶部不会瞬跳成透明 */
.gw-table__el :deep(th.el-table__cell) {
  font-weight: 400;
  font-size: var(--gw-fs-micro);
  border-bottom: 1px solid var(--border);
  background-color: var(--gw-head-bg);
  box-shadow: 0 8px 14px -14px rgba(17, 21, 27, 0.5);
}

.gw-table__el :deep(td.el-table__cell) {
  border-bottom: 1px solid var(--border);
}

.gw-table__el :deep(.el-table__body tr:last-child td.el-table__cell) {
  border-bottom: none;
}

/* 数字列：等宽体 + 表格数字，位数对齐后竖着扫一列才读得出大小 */
.gw-table__el :deep(.gw-num) {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
</style>
