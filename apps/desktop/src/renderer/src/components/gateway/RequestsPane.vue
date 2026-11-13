<script setup lang="ts">
import type { Result } from '@workbench/core'
import type { GatewayUsageRow } from '@/workbench/gateway'
import { List } from '@element-plus/icons-vue'
import { computed, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import { formatInt, formatTimestamp } from '@/format'
import { gatewayAccountNames } from '@/workbench/gateway'
import GatewayTable from './GatewayTable.vue'
import RequestFilters from './RequestFilters.vue'

/**
 * 请求记录：最近若干条流水的表格。
 *
 * 列照参考面板那一套摆：一行就把「用了什么模型、以什么档位、走了多久、花在哪」看全。
 * 数据全部来自 `usage.jsonl`；上游没给的（积分、思考 token）记成空，界面显示 `—`，不猜。
 *
 * TBuddy 与 Qoder 两页共用这一份：取数与账号名由页面注入（`:load-rows` / `:load-names`），
 * 两边的流水形状相同（`GatewayUsageRow`），列与筛选口径也就该完全一致。
 */
const props = defineProps<{
  /** 取最近若干条流水；默认 TBuddy 的 */
  loadRows?: (limit: number) => Promise<Result<GatewayUsageRow[]>>
  /** uid → 账号名；默认 TBuddy 的账号表 */
  loadNames?: () => Promise<Record<string, string>>
  /** 空态提示（默认 TBuddy 的文案） */
  emptyHint?: string
}>()

const limit = ref(100)
const result = ref<'all' | 'ok' | 'fail'>('all')
const keyword = ref('')
const rows = ref<GatewayUsageRow[]>([])
const loading = ref(false)
/** uid → 账号名：流水里只有 uid */
const names = ref<Record<string, string>>({})

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return rows.value
    .filter(row => result.value === 'all' || (result.value === 'ok' ? row.ok : !row.ok))
    .filter((row) => {
      if (!text)
        return true
      // 名字也进搜索：记得住「152****7052」的人不会去记那串 uid
      return [row.model, row.uid, names.value[row.uid] ?? '', row.machine ?? '', row.ua, row.effort, row.error].some(field => field.toLowerCase().includes(text))
    })
    .slice()
    .reverse()
})

const okCount = computed(() => filtered.value.filter(row => row.ok).length)

/** 查不到名字就退回 uid 前八位：数字难看，但比空着强 */
function nameOf(uid: string): string {
  return names.value[uid] ?? uid.slice(0, 8)
}

/** 毫秒 → 秒。两列（耗时 / 首字）同一套写法，竖着扫才对得齐 */
function secs(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`
}

/**
 * 吐字速度 = 输出 token / 生成阶段耗时。
 * 分母要减掉首字延迟：那一段是排队与预填充，算进「吐字」会把慢在起跑线上的请求显成快。
 * 非流式没有「生成阶段」这回事（首字即整段），给 `—`。
 */
function speedOf(row: GatewayUsageRow): string {
  const generating = row.durationMs - row.ttftMs
  if (row.completionTokens <= 0 || generating <= 0)
    return '—'
  return (row.completionTokens / (generating / 1000)).toFixed(1)
}

/** 缓存命中率 = 命中 token / 输入 token */
function hitOf(row: GatewayUsageRow): string {
  if (row.promptTokens <= 0)
    return '—'
  return `${((row.cachedTokens / row.promptTokens) * 100).toFixed(1)}%`
}

/** 上游没给积分就是 `—`：0 会被读成「这次免费」 */
function creditOf(row: GatewayUsageRow): string {
  return row.credit === null ? '—' : String(Number(row.credit.toFixed(2)))
}

/** 一条流水的键：机器 + 时间 + 模型 + 账号，足够区分（同一毫秒同模型同账号极少） */
function rowKey(row: GatewayUsageRow): string {
  return `${row.machine}-${row.ts}-${row.model}-${row.uid}`
}

function load(): void {
  loading.value = true
  const fetchRows = props.loadRows ?? window.workbench.gatewayUsageRecent
  void fetchRows(limit.value).then((reply) => {
    if (reply.ok && reply.data)
      rows.value = reply.data
    loading.value = false
  })
  // 名字跟着重新读取一起取：新登录的号冒出来的第一条流水，就该是名字
  const fetchNames = props.loadNames ?? gatewayAccountNames
  void fetchNames().then((map) => {
    names.value = map
  })
}

onMounted(load)
</script>

<template>
  <div class="req">
    <!-- 条件带：一行排完，不套卡片（毛玻璃留给表格，它才是这一栏的主体）、紧贴下面的表 -->
    <RequestFilters
      v-model:keyword="keyword"
      v-model:result="result"
      v-model:limit="limit"
      :count="filtered.length"
      :ok-count="okCount"
      :loading="loading"
      @reload="load"
    />

    <div v-if="!filtered.length" class="panel">
      <EmptyState compact :icon="List" text="还没有请求" :hint="props.emptyHint ?? 'TBuddy 启动后，客户端来的请求会出现在这里'" />
    </div>

    <GatewayTable
      v-else
      class="req__table-wrap"
      :data="filtered"
      :row-key="rowKey"
      height="100%"
      nowrap
    >
      <el-table-column label="时间" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ formatTimestamp(row.ts * 1000, true) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="模型" align="center">
        <template #default="{ row }">
          <span class="req__mono req__model" :title="`${row.model} · ${row.ua}`">{{ row.model }}</span>
        </template>
      </el-table-column>
      <el-table-column label="推理强度" align="center">
        <template #default="{ row }">
          <span v-if="row.effort" class="req__pill">{{ row.effort }}</span>
          <span v-else class="req__none">—</span>
        </template>
      </el-table-column>
      <el-table-column label="账号" align="center">
        <template #default="{ row }">
          <span :title="row.uid">{{ nameOf(row.uid) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="模式" align="center">
        <template #default="{ row }">
          <span v-if="row.stream === null" class="req__none">—</span>
          <span v-else class="req__pill req__pill--mode">{{ row.stream ? '流式' : '非流式' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="结果" align="center">
        <template #default="{ row }">
          <span class="req__flag" :class="row.ok ? 'is-ok' : 'is-fail'" :title="row.error || undefined">
            {{ row.ok ? '完成' : '失败' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="耗时" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ secs(row.durationMs) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="首字" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ secs(row.ttftMs) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="速度" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ speedOf(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="输入" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ formatInt(row.promptTokens) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="输出" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ formatInt(row.completionTokens) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="思考" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ formatInt(row.reasoningTokens) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="缓存" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ hitOf(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="总 token" align="center">
        <template #default="{ row }">
          <span class="req__mono req__total">{{ formatInt(row.totalTokens) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="扣除积分" align="center">
        <template #default="{ row }">
          <span class="req__mono">{{ creditOf(row) }}</span>
        </template>
      </el-table-column>
    </GatewayTable>
  </div>
</template>

<style scoped>
/* 同上：面板外壳交给全局 .panel，这里只排筛选带与表格。 */
.req {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
}

/**
 * 条件带：**一行**排完，且不套 `.panel`。
 *
 * `flex-direction: row` 必须写 —— 它原先是 `.panel` 卡片，而行方向只写在 `.panel` 里
 * （那里是 column，卡片按竖排走），于是这四个控件被拆成了四行叠着、还挤在中间。
 * 现在整条带子不带卡片：毛玻璃只留给下面那张表，条件带自己铺在画布上。
 * **左右不缩进**：不需要跟卡片内容对齐，两端就贴着卡片边缘走 —— 这一排控件自己带内边距，
 * 再缩一档反而像被推离了列表。下边距再收 4px，让它是「贴着列表」而不是另一张卡。
 */
.req__table-wrap {
  flex: 1 1 auto;
  min-height: 0;
}

.req__mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.req__model {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

/* 总 token 是这一行的结论，加粗一档；其余数字保持常规 */
.req__total {
  font-weight: 600;
  color: var(--ink);
}

/* 上游没给的字段：留一个短横线，空着会让人以为渲染坏了 */
.req__none {
  color: var(--ink-3);
}

/* 推理档位 / 模式：胶囊里只放一个短词，读的是「这一行是按什么档跑起来的」 */
.req__pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  font-family: var(--font-mono);
  font-size: var(--gw-fs-micro);
  line-height: 1;
  color: var(--ink-2);
}

/* 模式是中文词，等宽体会显得松垮，用正文字体 */
.req__pill--mode {
  font-family: var(--font-ui);
}

.req__flag {
  font-size: var(--gw-fs-micro);
}

.req__flag.is-ok {
  color: var(--st-ok);
}

.req__flag.is-fail {
  color: var(--st-fail);
}
</style>
