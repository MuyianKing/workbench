<script setup lang="ts">
import type { EtfCategorySummary, EtfDayFlow } from '@workbench/etf'
import { Grid } from '@element-plus/icons-vue'
import { formatDayKey, formatYi } from '@workbench/etf'
import { computed } from 'vue'
import GatewayTable from '@/components/gateway/GatewayTable.vue'

/**
 * 每日净买卖明细矩阵：最近 10 个交易日 × 指数类别（行序沿用归集表的降序），
 * 末行是全表合计。单元格金额为亿元，红买绿卖。
 * 外观走 TBuddy 那套透明表格（GatewayTable）。
 */
const props = defineProps<{
  days: EtfDayFlow[]
  categories: EtfCategorySummary[]
}>()

const COLUMNS = 10

/** 矩阵的列：最近 10 个展示日（旧→新） */
const columnDates = computed(() => props.days.slice(-COLUMNS).map(day => day.date))

/** 行：类别一行 + 全表合计一行；cells 按日期取该类别的当日净买卖（元） */
interface MatrixRow {
  label: string
  count: string
  cells: Record<string, number>
  total: boolean
}

const rows = computed<MatrixRow[]>(() => {
  const byDate = new Map(props.days.map(day => [day.date, day]))
  const categoryRows: MatrixRow[] = props.categories.map(category => ({
    label: category.category,
    count: `${category.count} 只`,
    cells: Object.fromEntries(columnDates.value.map((date) => {
      const day = byDate.get(date)
      return [date, day ? day.byCategory[category.category] ?? 0 : 0]
    })),
    total: false,
  }))
  const totalRow: MatrixRow = {
    label: '全部',
    count: '',
    cells: Object.fromEntries(columnDates.value.map((date) => {
      const day = byDate.get(date)
      return [date, day ? day.total : 0]
    })),
    total: true,
  }
  return [...categoryRows, totalRow]
})

function flowClass(value: number): string {
  return value > 0 ? 'is-in' : value < 0 ? 'is-out' : 'is-flat'
}

function cell(value: number): string {
  return value === 0 ? '0' : formatYi(value, true)
}

/** 合计行加重一点（el-table 的行类名回调） */
function rowClass({ row }: { row: MatrixRow }): string {
  return row.total ? 'is-total-row' : ''
}
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h3><el-icon><Grid /></el-icon>每日明细</h3>
      <span class="dim">最近 {{ COLUMNS }} 个交易日 · 亿元</span>
    </div>
    <GatewayTable v-if="columnDates.length" :data="rows" row-key="label" max-height="500" flat :row-class-name="rowClass">
      <el-table-column label="类别" align="center" min-width="110">
        <template #default="{ row }">
          <b>{{ row.label }}</b><span class="count">{{ row.count }}</span>
        </template>
      </el-table-column>
      <el-table-column
        v-for="date in columnDates"
        :key="date"
        :label="formatDayKey(date)"
        align="center"
        class-name="gw-num"
        label-class-name="gw-num"
      >
        <template #default="{ row }">
          <span :class="flowClass(row.cells[date])">{{ cell(row.cells[date]) }}</span>
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
  color: var(--ink-3);
}
</style>
