<script setup lang="ts">
import type { GatewayModelInfo } from '@/workbench/gateway'
import { CopyDocument, Cpu } from '@element-plus/icons-vue'
import { inferModelMeta } from '@workbench/ai'
import { ElMessage } from 'element-plus'
import { onMounted, ref } from 'vue'
import EmptyState from '@/components/EmptyState.vue'

/**
 * 模型：网关能转发的模型清单。
 *
 * **目录是拉下来的，不是写死的**：点「重新获取」时用第一个可用账号去上游探一次
 * （Rust 的 `wb_models`），结果落进 `models.json`，下次进页面直接读那一份。
 * 不挂定时器 —— 拉一次就是一次真实的对上游往返，而模型一天也不变几回。
 *
 * 上下文、最大输出、思考档位、消费倍率都是上游给的；**拿不到就是 0 / 空，界面显示 `—` 或「未知」**，
 * 不拿本地推断冒充事实（`inferModelMeta` 只在没有上游数据的兜底路径上参与）。
 *
 * 单价由 Rust 算好：价表是**前缀匹配**（`glm-5.2-0930` 也要落到 `glm-5.2` 那个价上），
 * 这条规则只该有 `wb_pricing` 一份，界面照着显示就行。
 */
const models = ref<GatewayModelInfo[]>([])
const loading = ref(false)
const fetching = ref(false)

/**
 * 128_000 → 「128K」，1_048_576 → 「1M」，0 就是不知道。
 * 按 1000 进位而不是 1024：那几张表给的就是 128_000 / 200_000 这种十进制数，
 * 用 1024 一除会变成 125K —— 差出来的 3K 是换算出来的假精度。
 */
function sizeOf(value: number): string {
  if (value <= 0)
    return ''
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000)
    return `${Math.round(value / 1000)}K`
  return String(value)
}

/** 上下文窗口：上游给了就用上游的；没有才退回本地推断，仍认不出写「未知」 */
function contextOf(model: GatewayModelInfo): string {
  const size = sizeOf(model.context)
  if (size)
    return size
  return sizeOf(inferModelMeta(model.id).contextWindow) || '未知'
}

function maxOutputOf(model: GatewayModelInfo): string {
  return sizeOf(model.maxOutput) || '—'
}

/**
 * 思考档位：`low / high / max · 默认 high`。上游没说档位但说支持思考时写「支持」，
 * 明确不支持写「不支持」；两者都没说的（老入口只有 id）才退回本地推断。
 */
function effortsOf(model: GatewayModelInfo): string {
  if (model.efforts.length) {
    const list = model.efforts.join(' / ')
    return model.defaultEffort ? `${list} · 默认 ${model.defaultEffort}` : list
  }
  if (model.defaultEffort)
    return `默认 ${model.defaultEffort}`
  if (model.supportsReasoning)
    return '支持'
  // 拉过目录（有名字）却什么都不说 = 不支持；没拉过的窄条目才去推断
  if (model.name)
    return '不支持'
  return inferModelMeta(model.id).reasoning ? '支持' : '未知'
}

/** 价目统一一位小数：4 与 0.8 摆在一列时，位数一致才像一张价目表 */
function money(value: number | null): string {
  return value === null ? '—' : `¥${value.toFixed(1)}`
}

function priceOf(model: GatewayModelInfo): string {
  if (model.inputCny === null && model.outputCny === null)
    return '未定价'
  return `入 ${money(model.inputCny)} · 出 ${money(model.outputCny)}`
}

function load(): void {
  loading.value = true
  void window.workbench.gatewayModels().then((result) => {
    loading.value = false
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '读取模型清单失败')
      return
    }
    models.value = result.data
  })
}

/** 手动刷新：唯一会真的去打上游的入口 */
function refresh(): void {
  fetching.value = true
  void window.workbench.gatewayModelsRefresh().then((result) => {
    fetching.value = false
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '拉取模型目录失败')
      return
    }
    models.value = result.data
    ElMessage.success(`已拉取 ${result.data.length} 个模型`)
  })
}

async function copy(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id)
    ElMessage.success('已复制模型 ID')
  }
  catch {
    ElMessage.error('复制失败，手动选中即可')
  }
}

onMounted(load)
</script>

<template>
  <div class="models">
    <!-- 条件带在毛玻璃外面：页签已经写着「模型」，这里只留计数与重新获取 -->
    <div class="models__head">
      <span class="models__dim">{{ models.length }} 个模型 · 单价按每百万 token</span>
      <el-button size="small" text :loading="fetching" :disabled="fetching" @click="refresh">
        重新获取
      </el-button>
    </div>

    <section class="panel models__panel">
      <EmptyState
        v-if="!models.length && !loading"
        compact
        :icon="Cpu"
        text="还没拉过模型目录"
        hint="点右上角「重新获取」从上游拉一份"
      />

      <table v-else class="models__table">
        <thead>
          <tr>
            <th>模型</th>
            <th>名称</th>
            <th class="models__cell-num">
              上下文窗口
            </th>
            <th class="models__cell-num">
              最大输出
            </th>
            <th>
              思考档位
            </th>
            <th class="models__cell-num">
              倍率
            </th>
            <th class="models__cell-num">
              单价
            </th>
            <th class="models__col-actions">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="model in models" :key="model.id">
            <td class="models__mono">
              {{ model.id }}
            </td>
            <td :title="model.name">
              {{ model.name || '—' }}
            </td>
            <td class="models__cell-num">
              {{ contextOf(model) }}
            </td>
            <td class="models__cell-num">
              {{ maxOutputOf(model) }}
            </td>
            <td class="models__efforts" :title="effortsOf(model)">
              {{ effortsOf(model) }}
            </td>
            <td class="models__cell-num models__mono">
              {{ model.rate || '—' }}
            </td>
            <td class="models__cell-num models__mono">
              {{ priceOf(model) }}
            </td>
            <td class="models__col-actions">
              <el-tooltip content="复制模型 ID" placement="top">
                <el-button size="small" text :icon="CopyDocument" aria-label="复制模型 ID" @click="copy(model.id)" />
              </el-tooltip>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
/* 外壳交给全局 .panel，这里只排条件带与表格（字号取网关那一档 --gw-fs-*） */
.models {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
}

/* 条件带不套卡片：毛玻璃留给下面那张表，这条带子自己铺在画布上 */
.models__head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  flex: none;
}

.models__dim {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

/**
 * 面板自己滚：`.gw` 是整页滚动，而 `.panel` 的 `overflow: hidden` 会让 sticky 失效，
 * 所以模型清单要像「请求」栏那样把滚动收进面板里，表头才钉得住。
 */
.models__panel {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.models__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--gw-fs-meta);
}

/* 表头钉在面板顶部：底要画出来，否则滚上来的行会从表头文字底下穿过去 */
.models__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  font-weight: 400;
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) 0;
  white-space: nowrap;
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  backdrop-filter: var(--glass-filter);
}

.models__table td {
  padding: var(--sp-2) var(--sp-2) var(--sp-2) 0;
  color: var(--ink-2);
  border-top: 1px solid var(--border);
  white-space: nowrap;
}

.models__table tbody tr:first-child td {
  border-top: none;
}

/* 定宽列居中：几行的值才会竖着对齐 */
.models__cell-num {
  width: 120px;
  text-align: center;
}

.models__table th.models__cell-num {
  text-align: center;
}

/* 思考档位是一串短词，宽度留给它、超出用省略号（全名在 title 里） */
.models__efforts {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.models__mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.models__col-actions {
  width: 72px;
  text-align: right;
}

.models__table th.models__col-actions {
  text-align: right;
}
</style>
