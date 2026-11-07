<script setup lang="ts">
defineProps<{
  /** 搜索关键字（模型 / 账号 / User-Agent） */
  keyword: string
  /** 结果筛选 */
  result: 'all' | 'ok' | 'fail'
  /** 条数 */
  limit: number
  /** 过滤后的条数 */
  count: number
  /** 其中成功的条数 */
  okCount: number
  /** 重新读取在途 */
  loading: boolean
}>()
defineEmits<{
  'update:keyword': [value: string]
  'update:result': [value: 'all' | 'ok' | 'fail']
  'update:limit': [value: number]
  'reload': []
}>()
/**
 * 请求栏的条件带：搜索 / 结果 / 条数三样筛选 + 计数与「重新读取」。
 *
 * TBuddy 与 Qoder 两个请求栏同一套（原先两边各写一份模板与样式，选项表还各留了一份）；
 * 表格两页各有各的列（TBuddy 全量十四列、Qoder 精简七列），留在这组件外面。
 */
const LIMITS = [
  { label: '最近 50 条', value: 50 },
  { label: '最近 100 条', value: 100 },
  { label: '最近 200 条', value: 200 },
]
const RESULTS = [
  { label: '全部结果', value: 'all' },
  { label: '只看成功', value: 'ok' },
  { label: '只看失败', value: 'fail' },
]
</script>

<template>
  <div class="req-filters">
    <div class="req-filters__picks">
      <el-input
        :model-value="keyword"
        size="small"
        placeholder="搜索模型 / 账号 / User-Agent"
        clearable
        class="req-filters__search"
        @update:model-value="$emit('update:keyword', $event)"
      />
      <!-- 两处筛选用下拉：选项各三条，分段选择器把这一行撑得太长 -->
      <el-select
        :model-value="result"
        size="small"
        class="req-filters__pick"
        @update:model-value="$emit('update:result', $event as 'all' | 'ok' | 'fail')"
      >
        <el-option v-for="item in RESULTS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select
        :model-value="limit"
        size="small"
        class="req-filters__pick"
        @update:model-value="$emit('update:limit', $event as number)"
        @change="$emit('reload')"
      >
        <el-option v-for="item in LIMITS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
    </div>
    <!-- 条数跟着条件带走：页签已经写着「请求」，再为它单起一条带子只多占一行 -->
    <div class="req-filters__actions">
      <span class="req-filters__count">共 {{ count }} 条 · 成功 {{ okCount }}</span>
      <el-button size="small" :loading="loading" class="req-filters__reload" @click="$emit('reload')">
        重新读取
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.req-filters {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex: none;
  margin-bottom: calc(-1 * var(--sp-1));
}

/* 左端那组筛选：窄窗口时自己换行，别把右边那颗按钮挤下去 */
.req-filters__picks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/* 两枚下拉等宽：选项就那么几条，宽度跟着最长的那个标签走 */
.req-filters__pick {
  width: 120px;
}

/* 右端：条数 + 重新读取一起贴右沿；窄窗口时让位的该是左边的搜索框 */
.req-filters__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-left: auto;
}

.req-filters__count {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.req-filters__reload {
  flex: none;
}

.req-filters__search {
  width: 240px;
}
</style>
