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
 * **目录是拉下来的，不是写死的**：每次进入这一栏都用第一个可用账号去上游探一次
 * （Rust 的 `wb_models`），结果落进 `models.json`；先把缓存读上屏，再在后台刷新。
 * 不挂定时器 —— 进一次拉一次，停在这一栏时不重复请求。
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
    if (result.ok && result.data)
      models.value = result.data
    // 缓存先上屏，再去上游拉一次；拉取失败也不挡着看缓存
    refresh()
  })
}

/**
 * 从上游拉一次。进入这一栏时由 `load` 调起；失败只在空表时提示 ——
 * 有缓存就继续看缓存，不为一次刷新失败弹红条。
 */
function refresh(): void {
  fetching.value = true
  void window.workbench.gatewayModelsRefresh().then((result) => {
    fetching.value = false
    if (!result.ok || !result.data) {
      if (!models.value.length)
        ElMessage.error(result.error ?? '拉取模型目录失败')
      return
    }
    models.value = result.data
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
    <div v-if="!models.length && !loading && !fetching" class="panel">
      <EmptyState
        compact
        :icon="Cpu"
        text="还没拿到模型目录"
        hint="登录一个可用账号后会自动拉取"
      />
    </div>

    <div v-else v-loading="fetching && !models.length" class="models__grid">
      <article v-for="model in models" :key="model.id" class="panel models__card">
        <div class="models__card-head">
          <span class="models__avatar">
            <el-icon><Cpu /></el-icon>
          </span>
          <div class="models__titles">
            <span class="models__id" :title="model.id">{{ model.id }}</span>
            <span class="models__name" :title="model.name">{{ model.name || '—' }}</span>
          </div>
          <el-tooltip content="复制模型 ID" placement="top">
            <el-button size="small" text :icon="CopyDocument" aria-label="复制模型 ID" @click="copy(model.id)" />
          </el-tooltip>
        </div>

        <div class="models__facts">
          <div class="models__fact">
            <span class="models__fact-label">上下文窗口</span>
            <span class="models__fact-value">{{ contextOf(model) }}</span>
          </div>
          <div class="models__fact">
            <span class="models__fact-label">最大输出</span>
            <span class="models__fact-value">{{ maxOutputOf(model) }}</span>
          </div>
          <div class="models__fact">
            <span class="models__fact-label">倍率</span>
            <span class="models__fact-value">{{ model.rate || '—' }}</span>
          </div>
        </div>

        <div class="models__rows">
          <div class="models__row">
            <span class="models__row-label">思考档位</span>
            <span class="models__row-value" :title="effortsOf(model)">{{ effortsOf(model) }}</span>
          </div>
          <div class="models__row">
            <span class="models__row-label">单价</span>
            <span class="models__row-value models__price" :class="{ 'is-unpriced': model.inputCny === null && model.outputCny === null }">{{ priceOf(model) }}</span>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
/* 外壳交给全局 .panel，这里只排卡片网格（字号取网关那一档 --gw-fs-*） */
.models {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
}

/* 卡片网格：一行放不下五张时自动往下排 */
.models__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--sp-3);
}

.panel.models__card {
  gap: var(--sp-2);
  padding: var(--sp-4);
  /* 与账号卡同一套玻璃，只多一层极淡的主题色柔光做区分 */
  background-image: radial-gradient(
    120% 120% at 100% 0%,
    color-mix(in srgb, var(--el-color-primary) 6%, transparent),
    transparent 55%
  );
}

.models__card-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

/* 模型图标取主题色：与页签的选中态、刷新按钮同一条色相 */
.models__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--el-color-primary) 15%, transparent);
  color: var(--el-color-primary);
  font-size: 17px;
}

.models__titles {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
}

.models__id {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-body);
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.models__name {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.models__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.models__fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.models__fact-label,
.models__row-label {
  font-size: var(--gw-fs-micro);
  color: var(--ink-3);
}

.models__fact-value {
  font-family: var(--font-mono);
  font-size: var(--gw-fs-meta);
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.models__rows {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.models__row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.models__row-label {
  flex: none;
  width: 52px;
}

.models__row-value {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--gw-fs-meta);
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 单价是数字串，用等宽体；思考档位仍用正文字体 */
.models__price {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

/* 未定价用琥珀，与账号卡的「额度用完」同一档提示色 */
.models__row-value.is-unpriced {
  color: var(--st-run);
}
</style>
