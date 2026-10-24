<script setup lang="ts">
import type { EtfCategorySummary } from '@workbench/etf'
import { DataAnalysis } from '@element-plus/icons-vue'
import { formatYiNumber } from '@workbench/etf'
import { computed } from 'vue'
import GatewayTable from '@/components/gateway/GatewayTable.vue'

/**
 * 指数类别归集表：跟踪同一指数的多只 ETF 合并观察（按近一月降序），
 * 末行「全部」是合计（自带在数据里，不用 el-table 的合计行——那个自带实底色，
 * 放在透明外壳里会突兀）。外观走 TBuddy 那套透明表格（GatewayTable）。
 */
const props = defineProps<{
  categories: EtfCategorySummary[]
}>()

/** 行:类别各一行 + 末行合计（口径与各列一致：份额一位、市值取整、金额两位） */
interface CategoryRow extends EtfCategorySummary {
  isTotal: boolean
}

const rows = computed<CategoryRow[]>(() => {
  const total: CategoryRow = {
    category: '全部',
    count: 0,
    todayYi: 0,
    weekYi: 0,
    monthYi: 0,
    lastShareYi: 0,
    lastScaleYi: 0,
    isTotal: true,
  }
  for (const row of props.categories) {
    total.count += row.count
    total.todayYi += row.todayYi
    total.weekYi += row.weekYi
    total.monthYi += row.monthYi
    total.lastShareYi += row.lastShareYi
    total.lastScaleYi += row.lastScaleYi
  }
  return [...props.categories.map(row => ({ ...row, isTotal: false })), total]
})

function flowClass(value: number): string {
  return value > 0 ? 'is-in' : value < 0 ? 'is-out' : 'is-flat'
}

/** 合计行加重一点（与明细矩阵的「全部」行同一处理） */
function rowClass({ row }: { row: CategoryRow }): string {
  return row.isTotal ? 'is-total-row' : ''
}
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h3><el-icon><DataAnalysis /></el-icon>按指数归集</h3>
      <span class="dim">亿元 · 按近一月降序</span>
    </div>
    <GatewayTable v-if="rows.length > 1" :data="rows" row-key="category" max-height="500" flat :row-class-name="rowClass">
      <el-table-column label="类别" align="center" min-width="110">
        <template #default="{ row }">
          <b>{{ row.category }}</b><span class="count">{{ row.count }} 只</span>
        </template>
      </el-table-column>
      <el-table-column label="今日" align="center" class-name="gw-num" label-class-name="gw-num">
        <template #default="{ row }">
          <span :class="flowClass(row.todayYi)">{{ formatYiNumber(row.todayYi, true) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="近一周" align="center" class-name="gw-num" label-class-name="gw-num">
        <template #default="{ row }">
          <span :class="flowClass(row.weekYi)">{{ formatYiNumber(row.weekYi, true) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="近一月" align="center" class-name="gw-num" label-class-name="gw-num">
        <template #default="{ row }">
          <span :class="flowClass(row.monthYi)">{{ formatYiNumber(row.monthYi, true) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="份额(亿)" align="center" class-name="gw-num" label-class-name="gw-num">
        <template #default="{ row }">
          {{ row.lastShareYi.toFixed(1) }}
        </template>
      </el-table-column>
      <el-table-column label="市值(亿)" align="center" class-name="gw-num" label-class-name="gw-num">
        <template #default="{ row }">
          {{ row.lastScaleYi.toFixed(0) }}
        </template>
      </el-table-column>
    </GatewayTable>
  </section>
</template>

<style scoped>
.dim {
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.count {
  margin-left: 6px;
  font-size: var(--fs-micro);
  font-weight: 400;
  color: var(--ink-3);
}

:deep(.is-total-row) {
  font-weight: 600;
  background: var(--bg-subtle);
}

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
