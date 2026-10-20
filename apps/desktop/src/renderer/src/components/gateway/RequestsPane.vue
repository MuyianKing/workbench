<script setup lang="ts">
import type { GatewayUsageRow } from '@/workbench/gateway'
import { List } from '@element-plus/icons-vue'
import { computed, onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import { gatewayAccountNames } from '@/workbench/gateway'

/**
 * 请求记录：最近若干条流水的表格。
 *
 * 列照参考面板那一套摆：一行就把「用了什么模型、以什么档位、走了多久、花在哪」看全。
 * 数据全部来自 `usage.jsonl`；上游没给的（积分、思考 token）记成空，界面显示 `—`，不猜。
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

/** 时间带日期：跨天的流水只写时分秒分不清是哪天 */
function timeOf(ts: number): string {
  const date = new Date(ts * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
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

/** token 数带千分位：6 位数字一眼读不出量级 */
function int(value: number): string {
  return value.toLocaleString('en-US')
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

function load(): void {
  loading.value = true
  void window.workbench.gatewayUsageRecent(limit.value).then((reply) => {
    if (reply.ok && reply.data)
      rows.value = reply.data
    loading.value = false
  })
  // 名字跟着重新读取一起取：新登录的号冒出来的第一条流水，就该是名字
  void gatewayAccountNames().then((map) => {
    names.value = map
  })
}

onMounted(load)
</script>

<template>
  <div class="req">
    <!-- 条件带：一行排完，不套卡片（毛玻璃留给表格，它才是这一栏的主体）、紧贴下面的表 -->
    <div class="req__filters">
      <div class="req__picks">
        <el-input
          v-model="keyword"
          size="small"
          placeholder="搜索模型 / 账号 / User-Agent"
          clearable
          class="req__search"
        />
        <!-- 两处筛选用下拉：选项各三条，分段选择器把这一行撑得太长 -->
        <el-select v-model="result" size="small" class="req__pick">
          <el-option v-for="item in RESULTS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-select v-model="limit" size="small" class="req__pick" @change="load">
          <el-option v-for="item in LIMITS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </div>
      <!-- 条数跟着条件带走：页签已经写着「请求」，再为它单起一条带子只多占一行 -->
      <div class="req__actions">
        <span class="req__count">共 {{ filtered.length }} 条 · 成功 {{ okCount }}</span>
        <el-button size="small" :loading="loading" class="req__reload" @click="load">
          重新读取
        </el-button>
      </div>
    </div>

    <div v-if="!filtered.length" class="panel">
      <EmptyState compact :icon="List" text="还没有请求" hint="网关启动后，客户端来的请求会出现在这里" />
    </div>

    <div v-else class="panel req__table-wrap">
      <table class="req__table">
        <thead>
          <tr>
            <th class="req__left">
              时间
            </th>
            <th class="req__left">
              模型
            </th>
            <th>推理强度</th>
            <th>账号</th>
            <th>模式</th>
            <th>结果</th>
            <th>耗时</th>
            <th>首字</th>
            <th>速度</th>
            <th class="req__num">
              输入
            </th>
            <th class="req__num">
              输出
            </th>
            <th class="req__num">
              思考
            </th>
            <th class="req__num">
              缓存
            </th>
            <th class="req__num req__total">
              总 token
            </th>
            <th class="req__num">
              扣除积分
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filtered" :key="`${row.machine}-${row.ts}-${row.model}-${row.uid}`">
            <td class="req__mono req__left">
              {{ timeOf(row.ts) }}
            </td>
            <td class="req__mono req__model req__left" :title="`${row.model} · ${row.ua}`">
              {{ row.model }}
            </td>
            <td>
              <span v-if="row.effort" class="req__pill">{{ row.effort }}</span>
              <span v-else class="req__none">—</span>
            </td>
            <td :title="row.uid">
              {{ nameOf(row.uid) }}
            </td>
            <td>
              <span v-if="row.stream === null" class="req__none">—</span>
              <span v-else class="req__pill req__pill--mode">{{ row.stream ? '流式' : '非流式' }}</span>
            </td>
            <td>
              <span class="req__flag" :class="row.ok ? 'is-ok' : 'is-fail'" :title="row.error || undefined">
                {{ row.ok ? '完成' : '失败' }}
              </span>
            </td>
            <td class="req__mono">
              {{ secs(row.durationMs) }}
            </td>
            <td class="req__mono">
              {{ secs(row.ttftMs) }}
            </td>
            <td class="req__mono">
              {{ speedOf(row) }}
            </td>
            <td class="req__mono req__num">
              {{ int(row.promptTokens) }}
            </td>
            <td class="req__mono req__num">
              {{ int(row.completionTokens) }}
            </td>
            <td class="req__mono req__num">
              {{ int(row.reasoningTokens) }}
            </td>
            <td class="req__mono req__num">
              {{ hitOf(row) }}
            </td>
            <td class="req__mono req__num req__total">
              {{ int(row.totalTokens) }}
            </td>
            <td class="req__mono req__num">
              {{ creditOf(row) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
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
.req__filters {
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
.req__picks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/* 两枚下拉等宽：选项就那么几条，宽度跟着最长的那个标签走 */
.req__pick {
  width: 120px;
}

/* 右端：条数 + 重新读取一起贴右沿；窄窗口时让位的该是左边的搜索框 */
.req__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-left: auto;
}

.req__count {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.req__reload {
  flex: none;
}

.req__search {
  width: 240px;
}

.req__table-wrap {
  overflow: auto;
  min-height: 0;
  /* 条件带就贴在面板上沿，表头再留一圈 16px 会显得中间空了一截；下边距沿用 .panel 的收法 */
  padding-top: var(--sp-1);
  padding-bottom: var(--sp-2);
}

.req__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--gw-fs-meta);
}

/**
 * 表头钉在面板顶部：这一栏一屏就是十几行，滚下去还要知道每列是什么。
 * **底必须是实的**：sticky 元素在滚动容器里拿不到背景模糊 —— `backdrop-filter` 不会采样
 * 同一个滚动容器里滚过的内容（在浏览器里实测过，加 transform / will-change 也救不回来），
 * 半透明底只会变成一条「行从字底下穿过去」的透明带。取 `--bg-subtle`，与面板里的 KPI 卡同档，
 * 暗色下也不刺眼；下沿补一条线，滚起来才分得清表头与第一行。
 */
.req__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: center;
  font-weight: 400;
  color: var(--ink-3);
  background: var(--bg-subtle);
  padding: var(--sp-2);
  white-space: nowrap;
  border-bottom: 1px solid var(--border);
}

/* 短值列居中：秒数、token 数这类两边留白平均才不显得歪；时间与模型靠左，见 `.req__left` */
.req__table td {
  padding: var(--sp-2);
  color: var(--ink-2);
  border-top: 1px solid var(--border);
  white-space: nowrap;
  text-align: center;
}

/* 时间与模型是这一行的「何时 / 用什么」，贴着左边读更快；只有这两列例外 */
.req__table .req__left {
  text-align: left;
}

.req__table tbody tr:first-child td {
  border-top: none;
}

.req__mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.req__model {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 数字列只做等宽与等位对齐（居中已由上面的 td 规则统一给） */
.req__table .req__num {
  font-variant-numeric: tabular-nums;
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
