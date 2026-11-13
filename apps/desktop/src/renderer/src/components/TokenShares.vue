<script setup lang="ts">
import type { TokenCounters, TokenUsageResult, UsageAxis } from '@workbench/usage'
import { CaretRight } from '@element-plus/icons-vue'
import { axisTotal, emptyCounters, flattenSources, formatCredits, formatPercent, formatTokensWan, shareByModel, shareBySource, SOURCE_LABELS, totalTokens } from '@workbench/usage'
import { computed, ref, watch } from 'vue'

/**
 * 用量卡片下方两块占比：模型占比与工具占比（各自可以点开看构成）。
 *
 * 从 `TokenPanel.vue` 拆出来的整块。统计区间由父组件按「选中的桶 / 整个窗口」算好送进来，
 * 展开状态只活在这一次渲染里 —— 换口径时父组件用 `:key="axis"` 重挂，展开自然收掉。
 */
const props = defineProps<{
  result: TokenUsageResult | null
  /** 统计区间（父组件已按选中的桶收敛） */
  fromKey: string
  toKey: string
  axis: UsageAxis
  rangeLabel: string
  /** 模型占比只在 tokens 口径下画（credits 按模型拆没有意义） */
  showModels: boolean
}>()

const days = computed(() => (props.result ? flattenSources(props.result.data) : {}))

const models = computed(() =>
  shareByModel(days.value, props.fromKey, props.toKey).slice(0, 5),
)

/** 工具占比：按参考样式逐工具一行，行下一条细条表示份额；只列当前口径下真有数的工具 */
const sources = computed(() =>
  props.result
    ? shareBySource(props.result.data, props.fromKey, props.toKey, props.axis)
    : [],
)

/** 一组计数在当前口径下的量 */
function amount(counters: TokenCounters): number {
  return axisTotal(counters, props.axis)
}

function formatCounters(counters: TokenCounters): string {
  const value = amount(counters)
  return props.axis === 'credits' ? formatCredits(value) : formatTokensWan(value)
}

const maxModelTotal = computed(() => Math.max(1, totalTokens(models.value[0]?.counters ?? emptyCounters())))

/** 展开明细的模型（同时只展开一个，再点一下收起） */
const expandedModel = ref<string | null>(null)

function toggleModel(key: string): void {
  expandedModel.value = expandedModel.value === key ? null : key
}

/** 展开模型明细的工具（与模型展开互不相干，同样只开一个） */
const expandedTool = ref<string | null>(null)

function toggleTool(key: string): void {
  // credits 口径下工具没有可展开的东西（展开出来是模型，而那一维在那边没意义，见 showModels）
  if (!props.showModels)
    return
  expandedTool.value = expandedTool.value === key ? null : key
}

// 换口径时两块的展开都作废（数字整套都变了）
watch(() => props.axis, () => {
  expandedModel.value = null
  expandedTool.value = null
})

/** 展开的工具里各模型的占比（按该工具自己的天级数据统计） */
const expandedToolModels = computed(() => {
  if (!expandedTool.value || !props.result)
    return []
  const source = props.result.data.sources[expandedTool.value]
  if (!source)
    return []
  return shareByModel(source.days, props.fromKey, props.toKey)
})

/** 一行明细：标签 + 占比 + 数值 */
function detailRows(counters: TokenCounters): Array<{ label: string, value: number }> {
  const rows = [
    { label: '输入(缓存命中)', value: counters.cacheReadTokens },
    { label: '输入(缓存未命中)', value: counters.inputTokens },
    { label: '输出', value: counters.outputTokens },
  ]
  // 思考 token 通常为 0，不占一行
  if (counters.reasoningTokens > 0)
    rows.push({ label: '思考', value: counters.reasoningTokens })
  return rows
}

/** 全部输入 = 缓存命中的那一半 + 未命中的那一半（计数里的 inputTokens 只记未命中） */
function inputTotal(counters: TokenCounters): number {
  return counters.cacheReadTokens + counters.inputTokens
}

/** 缓存命中率：命中占全部输入的比例 */
function hitRateLabel(counters: TokenCounters): string {
  return formatPercent(counters.cacheReadTokens, inputTotal(counters))
}

function shareWidth(counters: TokenCounters): string {
  return `${(totalTokens(counters) / maxModelTotal.value) * 100}%`
}

function sourceWidth(counters: TokenCounters): string {
  const max = Math.max(1, amount(sources.value[0]?.counters ?? emptyCounters()))
  return `${(amount(counters) / max) * 100}%`
}

/** 展开明细里的迷你条：相对同一组内的最大值 */
function detailWidth(value: number, max: number): string {
  return `${(Math.max(0, value) / Math.max(1, max)) * 100}%`
}
</script>

<template>
  <div v-if="showModels" class="share">
    <div class="share__head">
      模型占比
      <span>{{ rangeLabel }} · 点击行看构成</span>
    </div>
    <template v-for="m in models" :key="m.key">
      <button
        type="button"
        class="source model"
        :aria-expanded="expandedModel === m.key"
        @click="toggleModel(m.key)"
      >
        <div class="source__line">
          <span class="source__name mono" :title="m.key">{{ m.key }}</span>
          <span class="source__num mono">
            {{ formatTokensWan(totalTokens(m.counters)) }}
            <el-icon class="share__chevron" :class="{ 'is-open': expandedModel === m.key }">
              <CaretRight />
            </el-icon>
          </span>
        </div>
        <div class="source__track">
          <i :style="{ width: shareWidth(m.counters) }" />
        </div>
      </button>
      <div v-if="expandedModel === m.key" class="share__detail">
        <div v-for="row in detailRows(m.counters)" :key="row.label" class="detail__row">
          <span class="detail__label">{{ row.label }}</span>
          <span class="detail__track">
            <i :style="{ width: detailWidth(row.value, totalTokens(m.counters)) }" />
          </span>
          <span class="detail__pct mono">{{ formatPercent(row.value, totalTokens(m.counters)) }}</span>
          <b class="detail__val mono">{{ formatTokensWan(row.value) }}</b>
        </div>
        <div class="detail__foot">
          请求 {{ m.counters.requests }} 次 · 缓存命中率 {{ hitRateLabel(m.counters) }}
        </div>
      </div>
    </template>
  </div>

  <div class="share">
    <div class="share__head">
      工具占比
      <span>{{ rangeLabel }}{{ showModels ? ' · 点击行看模型' : '' }}</span>
    </div>
    <template v-for="s in sources" :key="s.key">
      <button
        type="button"
        class="tool"
        :class="{ 'tool--toggle': showModels }"
        :aria-expanded="expandedTool === s.key"
        @click="toggleTool(s.key)"
      >
        <span class="tool__name" :title="s.key">{{ SOURCE_LABELS[s.key] ?? s.key }}</span>
        <span class="tool__track"><i :style="{ width: sourceWidth(s.counters) }" /></span>
        <span class="tool__num mono">{{ formatCounters(s.counters) }}</span>
        <el-icon
          v-if="showModels"
          class="share__chevron"
          :class="{ 'is-open': expandedTool === s.key }"
        >
          <CaretRight />
        </el-icon>
      </button>
      <div v-if="expandedTool === s.key" class="share__detail">
        <div v-for="tm in expandedToolModels" :key="tm.key" class="detail__row">
          <span class="detail__label mono" :title="tm.key">{{ tm.key }}</span>
          <span class="detail__track">
            <i :style="{ width: detailWidth(totalTokens(tm.counters), totalTokens(expandedToolModels[0]?.counters ?? emptyCounters())) }" />
          </span>
          <span class="detail__pct mono">{{ formatPercent(totalTokens(tm.counters), totalTokens(s.counters)) }}</span>
          <b class="detail__val mono">{{ formatTokensWan(totalTokens(tm.counters)) }}</b>
        </div>
        <div class="detail__foot">
          请求 {{ s.counters.requests }} 次 · 缓存命中率 {{ hitRateLabel(s.counters) }}
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ---------- 占比 ---------- */

.share {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.share__head {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.share__chevron {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--ink-3);
  transition: transform 0.15s ease;
}

.share__chevron.is-open {
  transform: rotate(90deg);
}

/* 模型行与工具行共用 source 样式；模型行是按钮，重置后 hover 给一点反馈 */
.model {
  width: 100%;
  border: 0;
  background: transparent;
  font-family: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--r-sm);
}

.model:hover .source__name,
.model:hover .source__num {
  color: var(--ink);
}

/* 展开的构成明细：缩进到进度条起点，与参考布局一致 */
.share__detail {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: 2px 0 var(--sp-2);
}

/*
 * 展开的构成明细：标签左、迷你占比条中、百分比与数值右 ——
 * 百分比固定列宽右对齐，多行数字才竖着对齐；条形语言与面板其他部分一致。
 */
.detail__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  /* 缩进收窄，把横向空间尽量让给条形 */
  padding-left: var(--sp-2);
  padding-block: 3px;
  min-width: 0;
}

.detail__label {
  /* 列宽从 40% 收到 34%：短标签（输出/思考）后面不再是大片留白，条形相应变长 */
  flex: 0 0 34%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-micro);
  color: var(--ink-2);
}

.detail__track {
  flex: 1 1 auto;
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  overflow: hidden;
}

.detail__track i {
  display: block;
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--ink-3);
}

.detail__pct {
  flex: 0 0 30px;
  text-align: right;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.detail__val {
  flex: 0 0 56px;
  text-align: right;
  font-weight: 400;
  font-size: var(--fs-micro);
  color: var(--ink-2);
}

.detail__foot {
  padding-left: var(--sp-2);
  margin-top: 1px;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* ---------- 工具占比：名称左、总量右，下面一条全宽细条表示份额 ---------- */

.source {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--sp-1) 0;
}

.source__line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  min-width: 0;
}

.source__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-meta);
  font-weight: 600;
}

.source__num {
  flex: 0 0 auto;
  font-size: var(--fs-micro);
  color: var(--ink-2);
}

.source__track {
  height: 5px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  overflow: hidden;
}

.source__track i {
  display: block;
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--ink);
}

/* ---------- 工具占比：单行紧凑样式（名称左、行内细条、数值右），tokens 口径下点击展开该工具的模型 ---------- */

/*
 * 这一行始终是按钮（tokens 口径下可点开，credits 口径下不可点），所以按钮的默认外观
 * **统一在这里抹掉**，别放进 `.tool--toggle` —— 放进去了，credits 那一档不加那个类，
 * 就会露出浏览器默认的灰底方块（踩过一次：额度那一屏只有 Qoder 一行，一眼就能看见）。
 */
.tool {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  width: 100%;
  /* 行与行之间留半步，行间不至于黏成一坨 */
  padding: var(--sp-1) 0;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  text-align: left;
}

/* 可点开的那一档：鼠标形状与 hover 反馈 */
.tool--toggle {
  cursor: pointer;
  border-radius: var(--r-sm);
}

.tool--toggle:hover .tool__name,
.tool--toggle:hover .tool__num {
  color: var(--ink);
}

.tool__name {
  flex: 0 0 40%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-micro);
}

.tool__track {
  flex: 1 1 auto;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  overflow: hidden;
}

.tool__track i {
  display: block;
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--ink-2);
}

.tool__num {
  flex: 0 0 auto;
  font-size: var(--fs-micro);
  color: var(--ink-2);
}
</style>
