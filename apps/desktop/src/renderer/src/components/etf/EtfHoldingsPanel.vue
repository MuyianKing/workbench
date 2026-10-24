<script setup lang="ts">
import type { EtfHoldingSummary } from '@workbench/etf'
import { List } from '@element-plus/icons-vue'
import { formatYiNumber } from '@workbench/etf'
import GatewayTable from '@/components/gateway/GatewayTable.vue'

/**
 * 分品种表：23 只 ETF 的最新份额 / 净值与三个窗口的净买卖（按近一月降序）。
 * 外观走 TBuddy 那套透明表格外壳（GatewayTable）：表体透底、表头只剩一条底线；
 * 列宽交给内容，列全部居中、数字列等宽（gw-num）。
 */
defineProps<{
  etfs: EtfHoldingSummary[]
}>()

/** 净买卖着色：红买绿卖（本页唯一的彩色例外，口径见 EtfSummaryCards） */
function flowClass(value: number): string {
  return value > 0 ? 'is-in' : value < 0 ? 'is-out' : 'is-flat'
}

function navText(nav: number): string {
  return nav > 0 ? nav.toFixed(3) : '—'
}
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h3><el-icon><List /></el-icon>分品种</h3>
      <span class="dim">亿元 · 按近一月降序</span>
    </div>
    <!-- height 100%：外层面板是这页唯一的弹性块，表格吃满它、表内滚动（表头钉住） -->
    <GatewayTable v-if="etfs.length" :data="etfs" row-key="code" height="100%" flat>
      <el-table-column label="品种" align="center" min-width="170">
        <template #default="{ row }">
          <span class="mkt">{{ row.market === 'sh' ? '沪' : '深' }}</span>{{ row.name }}<span class="code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column label="类别" align="center" class-name="gw-num" label-class-name="gw-num">
        <template #default="{ row }">
          {{ row.category }}
        </template>
      </el-table-column>
      <el-table-column label="份额(亿)" align="center" class-name="gw-num" label-class-name="gw-num">
        <template #default="{ row }">
          {{ row.lastShareYi.toFixed(2) }}
        </template>
      </el-table-column>
      <el-table-column label="净值" align="center" class-name="gw-num" label-class-name="gw-num">
        <template #default="{ row }">
          {{ navText(row.lastNav) }}
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
    </GatewayTable>
  </section>
</template>

<style scoped>
/* 面板被 EtfView 标成这页的弹性块后，表格外壳跟着吃满面板剩余高度
 * （面板本就是 .panel 的纵向 flex，el-table 的 height 100% 才有着落） */
:deep(.gw-table) {
  flex: 1 1 auto;
  min-height: 0;
}

.dim {
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.mkt {
  display: inline-block;
  margin-right: 6px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.code {
  margin-left: 6px;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 净买卖红绿（取状态色色相，本页唯一彩色例外） */
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
