<script setup lang="ts">
import type { TokenBucket, TokenCounters, TokenGranularity, TokenRangePreset, UsageAxis } from '@workbench/usage'
import { axisTotal, formatCredits, formatPercent, formatTokensWan, shortDayLabel } from '@workbench/usage'
import { computed } from 'vue'
import TokenRangePicker from '@/components/TokenRangePicker.vue'

/**
 * 用量卡片的趋势图：时间窗口下拉、分桶宽度页签、柱状图与柱子悬停提示。
 *
 * 从 `TokenPanel.vue` 拆出来的整块。窗口（起止日 / 预设 / 可选范围）由父组件持有 ——
 * 占比区还跟着它走；这里只负责把窗口内的桶画出来，并把「换档 / 选窗口 / 点柱子」报上去。
 */
const props = defineProps<{
  buckets: TokenBucket[]
  fromKey: string
  toKey: string
  preset: TokenRangePreset
  earliestKey: string
  latestKey: string
  /** 被选中的桶（点柱子锁定占比的统计区间）；null = 整个窗口 */
  selectedIndex: number | null
  axis: UsageAxis
  showModels: boolean
}>()

const emit = defineEmits<{
  'pick-preset': [preset: TokenRangePreset]
  'pick-range': [range: { fromKey: string, toKey: string }]
  'select': [index: number]
}>()

/** 三档粒度：只决定柱子的分桶宽度，趋势窗口由头部的时间维度下拉给出 */
const GRANULARITIES: Array<{ key: TokenGranularity, label: string }> = [
  { key: 'day', label: '天' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
]

const granularity = defineModel<TokenGranularity>('granularity', { required: true })

/** 一组计数在当前口径下的量：面板上每个数字都从这里出，免得某处漏了换算 */
function amount(counters: TokenCounters): number {
  return axisTotal(counters, props.axis)
}

/** 全部输入 = 缓存命中的那一半 + 未命中的那一半（计数里的 inputTokens 只记未命中） */
function inputTotal(counters: TokenCounters): number {
  return counters.cacheReadTokens + counters.inputTokens
}

/** 缓存命中率：命中占全部输入的比例 */
function hitRateLabel(counters: TokenCounters): string {
  return formatPercent(counters.cacheReadTokens, inputTotal(counters))
}

const maxBucketTotal = computed(() =>
  Math.max(1, ...props.buckets.map(bucket => amount(bucket.counters))),
)

function barHeight(bucket: { counters: TokenCounters }): string {
  // 没有数据的桶给一根 2px 的小柱，图不至于大片留白；颜色更淡，与真数据区分
  if (amount(bucket.counters) === 0)
    return '2px'
  return `${Math.max(2, (amount(bucket.counters) / maxBucketTotal.value) * 100)}%`
}
</script>

<template>
  <div class="chart">
    <div class="chart__head">
      <!-- 趋势窗口：时间维度下拉（预设 + 自定义区间），右侧页签只切换柱子的分桶宽度 -->
      <div class="range" role="group" aria-label="趋势时间范围">
        <TokenRangePicker
          :from-key="fromKey"
          :to-key="toKey"
          :preset="preset"
          :earliest-key="earliestKey"
          :latest-key="latestKey"
          @pick-preset="preset => emit('pick-preset', preset)"
          @pick-range="range => emit('pick-range', range)"
        />
        <!-- 实际生效的起止日：预设按快照收敛后可能与字面含义不同，这里给出确切窗口 -->
        <span class="range__text mono">{{ shortDayLabel(fromKey) }} ~ {{ shortDayLabel(toKey) }}</span>
      </div>
      <!-- 分桶宽度的三档页签：Element Plus 的分段控件（外观见 global.css） -->
      <el-segmented
        v-model="granularity"
        class="chart__tabs"
        :options="GRANULARITIES"
        :props="{ label: 'label', value: 'key' }"
        aria-label="趋势分桶宽度"
      />
    </div>

    <div class="chart__bars">
      <el-tooltip
        v-for="(bucket, index) in buckets"
        :key="bucket.key"
        placement="top"
        :show-after="120"
        :disabled="amount(bucket.counters) === 0"
      >
        <template #content>
          <!-- 一行一个口径：输入那行是「缓存命中 / 全部输入 / 命中率」三段，
             与展开模型时的构成、下方的占比用的都是同一套口径。
             额度的柱子上没有这几段可拆，就只报这一口径的总数。 -->
          <div class="token-tip mono">
            <p class="token-tip__title">
              {{ bucket.label }}
            </p>
            <template v-if="showModels">
              <p>
                输入：{{ formatTokensWan(bucket.counters.cacheReadTokens) }}/{{ formatTokensWan(inputTotal(bucket.counters)) }}/{{ hitRateLabel(bucket.counters) }}
              </p>
              <p>输出：{{ formatTokensWan(bucket.counters.outputTokens) }}</p>
              <p>思考：{{ formatTokensWan(bucket.counters.reasoningTokens) }}</p>
            </template>
            <p v-else>
              额度：{{ formatCredits(bucket.counters.credits) }}
            </p>
            <p>请求：{{ bucket.counters.requests }} 次</p>
          </div>
        </template>
        <!-- 点柱子把下方占比切到那个桶，再点一下回到全部 -->
        <button
          type="button"
          class="bar-slot"
          :class="{ 'is-selected': selectedIndex === index }"
          :aria-label="`查看 ${bucket.label} 的占比`"
          @click="emit('select', index)"
        >
          <i
            class="bar"
            :class="{ 'is-empty': amount(bucket.counters) === 0 }"
            :style="{ height: barHeight(bucket) }"
          />
        </button>
      </el-tooltip>
    </div>
  </div>
</template>

<style scoped>
/*
 * 图表固定高度，不跟着卡片长高 —— 卡片拖得太高时图表会被拉成一片空旷。
 * 在滚动容器（.panel__body）里也不收缩：空间不够靠滚动解决，压扁只会让柱子溢出压到占比区。
 */
.chart {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  flex: 0 0 auto;
}

.chart__head {
  display: flex;
  align-items: center;
  /* 卡片窄到一行放不下时换行，让选择器和页签各占一行，而不是互相挤压 */
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-2);
  flex-shrink: 0;
}

/* 趋势窗口：时间维度下拉 + 实际生效的起止日 */
.range {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/* 收敛后的确切窗口（预设可能被快照范围截短，数字要能对得上） */
.range__text {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

/* 分段控件的外壳（底色、圆角、内边距）在 global.css；这里只留这一处的排版：
   贴右边缘 + 最小一档字号。 */
.chart__tabs.el-segmented {
  margin-left: auto;
  font-size: var(--fs-micro);
}

.chart__tabs :deep(.el-segmented__item) {
  padding: 1px 8px;
}

/**
 * 柱状图：每个柱子是等宽的弹性槽，槽底对齐；底部一条基线把图「放」在面板上。
 * 柱体最宽 10px 并在槽里居中 —— 窗口短（本月才十几根）时柱子不该长成一块块方砖，
 * 槽本身仍是整格的热区，点击与悬停不受影响。
 * 柱体用灰阶，hover 才落主色 —— 彩色在本界面只表达运行状态，这里不做例外。
 * 高度写死不参与伸缩：面板矮了让内容区出滚动条，而不是把图压扁。
 */
.chart__bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  flex: 0 0 auto;
  height: 90px;
  border-bottom: 1px solid var(--border);
}

/* 柱槽是按钮：点一下把下方占比切到那个桶，再点一下回到全部 */
.bar-slot {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  flex: 1 1 0;
  height: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.bar {
  width: 100%;
  max-width: 10px;
  border-radius: 2px 2px 0 0;
  background: var(--ink-3);
  opacity: 0.55;
  transition: opacity 0.15s ease, background-color 0.15s ease;
}

/* 零数据的小柱：更矮更淡，只是示意「这一天是零」 */
.bar.is-empty {
  opacity: 0.22;
}

.bar-slot:hover .bar {
  background: var(--el-color-primary);
  opacity: 0.9;
}

/* 选中的桶：占比区此刻统计的就是它，用实色灰阶标出 */
.bar-slot.is-selected .bar {
  background: var(--ink);
  opacity: 0.9;
}

/*
 * 柱子悬停提示：一行一个口径，行与行之间留一点点，四行才不像挤在一起的一段。
 * 类名刻意不叫 `tip` —— global.css 里有个同名的 `.tip`（键位提示行，是 flex 行），
 * 撞上它这几行就会被排成一行，正是这个提示以前那副「一长条」的样子。
 * 颜色一律继承 Element Plus（dark 效果在暗色主题下反而是浅底），这里不改，免得两种主题下有一边看不清。
 */
.token-tip p {
  margin: 0;
}

.token-tip p + p {
  margin-top: 2px;
}

.token-tip__title {
  font-weight: 600;
}
</style>
