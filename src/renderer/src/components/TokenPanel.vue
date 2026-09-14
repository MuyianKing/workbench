<script setup lang="ts">
/**
 * 首页「Token 用量」卡片:读各 AI 工具(ZCode)本地用量库的按天聚合快照,
 * 画 今日/本周/本月 概览、趋势条形图与模型/工具占比。
 * 趋势窗口由头部的预设下拉给出(默认「本月」,与 DeepSeek 用量页同款:
 * 近 7 天 / 近 30 天 / 本月 / 上月 / 自定义;可选的日子限于快照里有记录的那段),
 * 右侧 天/周/月 页签只切换柱子的分桶宽度,窗口本身不变;
 * 占比默认统计整个窗口(全部);点击某根柱子则把占比切到那个桶(那天/那周/那月),再点一下回到全部。
 *
 * 数据是主进程「实读 + max 合并进快照」后的结果,这里不做任何持久化,只拉取与展示:
 * 挂载时取一次,之后每分钟刷新(与主进程的落盘节奏一致),「⋯」外还有标题栏右侧的
 * 手动刷新按钮(与系统状态卡片同款)。缓存读取通常占九成以上,构成拆分收在悬停里,
 * 总量数字才不会因缓存命中波动而误导。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CaretRight, Connection, Refresh } from '@element-plus/icons-vue'
import TokenRangePicker from '@/components/TokenRangePicker.vue'
import {
  SOURCE_LABELS,
  bucketRangeOf,
  buildSeriesRange,
  emptyCounters,
  flattenSources,
  formatPercent,
  formatTokens,
  resolvePresetRange,
  shareByModel,
  shareBySource,
  shortDayLabel,
  sumRange,
  totalTokens,
  type TokenBucket,
  type TokenCounters,
  type TokenGranularity,
  type TokenRangePreset,
  type TokenUsageResult
} from '@shared/token-usage'
import { dayKey } from '@shared/activity'
import { formatRelative } from '@/format'

/** 三档粒度:只决定柱子的分桶宽度,趋势窗口由头部的时间维度下拉给出 */
const GRANULARITIES: Array<{ key: TokenGranularity; label: string }> = [
  { key: 'day', label: '天' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' }
]

const result = ref<TokenUsageResult | null>(null)
const loading = ref(false)
const granularity = ref<TokenGranularity>('day')
/** 生效的时间维度档位;日历上选过区间后即为 custom */
const rangePreset = ref<TokenRangePreset>('thisMonth')
/** 趋势窗口的起止日期(本地日期键,含两端);空串表示还没拿到数据 */
const fromKey = ref('')
const toKey = ref('')
/** 每次刷新时更新,驱动「今天 / 本周 / 本月」与相对时间跟着时钟走 */
const nowTick = ref(Date.now())
/** 手动同步进行中(自动同步在后台做,不给它加转圈,免得每分钟闪一下) */
const syncing = ref(false)
let timer: number | null = null

function applyResult(res: Awaited<ReturnType<typeof window.workbench.getTokenUsage>>): void {
  if (res.ok && res.data) {
    result.value = res.data
    nowTick.value = Date.now()
    clampRange()
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    applyResult(await window.workbench.getTokenUsage())
  } finally {
    loading.value = false
  }
}

/**
 * 手动同步一次(绕过自动同步的节流)。
 * 自动同步失败只会体现在状态点上,手动点的这次必须把原因说清楚,否则用户不知道为什么没同步上。
 */
async function syncNow(): Promise<void> {
  syncing.value = true
  try {
    const res = await window.workbench.syncTokenUsage()
    applyResult(res)
    if (!res.ok) {
      ElMessage.error(res.error ?? '同步失败')
    } else if (res.data?.sync.error) {
      ElMessage.error(res.data.sync.error)
    } else {
      ElMessage.success(`已同步 · ${deviceText.value}`)
    }
  } finally {
    syncing.value = false
  }
}

onMounted(() => {
  void refresh()
  timer = window.setInterval(() => void refresh(), 60_000)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

const days = computed(() => (result.value ? flattenSources(result.value.data) : {}))
const todayKey = computed(() => dayKey(nowTick.value))
/** 实读失败的工具及原因(有失败时底部状态点转红,但不影响其余来源展示) */
const sourceErrorText = computed(() =>
  Object.entries(result.value?.sourceErrors ?? {})
    .map(([id, error]) => `${SOURCE_LABELS[id] ?? id}:${error}`)
    .join(';')
)
const updatedAt = computed(() => result.value?.data.updatedAt ?? 0)
const hasData = computed(() => Object.keys(days.value).length > 0)

// ---------- 同步状态 ----------

/** 同步状态;设置里没填仓库地址时 enabled 为 false,标题行不显示同步那一块 */
const sync = computed(() => result.value?.sync ?? null)
const syncError = computed(() => sync.value?.error ?? '')

/** 参与合并的本机与其它设备名字,拼成一句给悬停提示 */
const deviceText = computed(() => {
  const status = sync.value
  if (!status?.enabled) return ''
  const others = status.devices.map((item) => item.name).join('、')
  return others ? `${status.deviceName}、${others}` : status.deviceName
})

/** 标题行右侧那行字:实读失败优先,其次是同步失败,再次才是更新时间 */
const statusText = computed(() => {
  if (sourceErrorText.value) return '部分来源不可用'
  if (sync.value?.enabled && syncError.value) return '同步失败'
  return updatedAt.value ? `更新于 ${formatRelative(updatedAt.value, nowTick.value)}` : ''
})

/** 悬停提示:实读与同步的具体原因、同步到哪个仓库、还有哪些设备合进来了 */
const statusTitle = computed(() => {
  const parts = [sourceErrorText.value, syncError.value].filter(Boolean)
  const status = sync.value
  if (status?.enabled) {
    parts.push(`同步设备:${deviceText.value}`)
    // 仓库地址写出来:同步打到别的仓库时 git 不报错,不写清楚就只能靠猜
    parts.push(`同步仓库:${status.repo}`)
    if (status.lastSyncAt) {
      parts.push(`上次同步:${formatRelative(status.lastSyncAt, nowTick.value)}`)
    } else {
      parts.push('还没同步过')
    }
  }
  return parts.join('\n') || undefined
})

const statusFail = computed(() => Boolean(sourceErrorText.value || syncError.value))

/** 快照里最早的一天:日历与预设的可选下限(再往前没有记录,选了只会是一片空白) */
const earliestKey = computed(() => Object.keys(days.value).sort()[0] ?? todayKey.value)

/**
 * 把趋势窗口收敛回可选范围:终点不晚于今天,起点不早于快照最早那天。
 * 预设档每次都按「现在」重新解析 —— 跨过午夜后「今天 / 近 7 天 / 本月」才会跟着时钟走;
 * 自定义档只做边界收敛,不动用户选的那一段。
 */
function clampRange(): void {
  const earliest = earliestKey.value
  const latest = todayKey.value
  if (rangePreset.value !== 'custom') {
    const range = resolvePresetRange(rangePreset.value, nowTick.value)
    if (range) {
      fromKey.value = range.fromKey
      toKey.value = range.toKey
    }
  }
  if (!fromKey.value || !toKey.value) {
    // 数据刚到时还没有窗口:铺满可选的这一段
    fromKey.value = earliest
    toKey.value = latest
    return
  }
  if (toKey.value > latest) toKey.value = latest
  // 起点贴到最早那天:只在不会把起点推到终点之后时才收 ——
  // 否则(比如选了「昨天」而昨天还没有记录)那一档本就落在没数据的日子上,该照原样显示,而不是挪到有数据的地方
  if (fromKey.value < earliest && earliest <= toKey.value) fromKey.value = earliest
  // 不变式:起点不晚于终点。日历已按快照范围禁掉越界日期,正常操作碰不到,这里是兜底
  if (fromKey.value > toKey.value) fromKey.value = toKey.value
}

/** 下拉里点了某一档:窗口交给预设解析,再按快照范围收敛 */
function pickPreset(preset: TokenRangePreset): void {
  rangePreset.value = preset
  clampRange()
}

/** 日历里选完一段:这一档随之成为自定义 */
function pickRange(range: { fromKey: string; toKey: string }): void {
  rangePreset.value = 'custom'
  fromKey.value = range.fromKey
  toKey.value = range.toKey
  clampRange()
}

// ---------- 概览 ----------

const today = computed(() => sumRange(days.value, todayKey.value, todayKey.value))
const weekStartKey = computed(() => {
  const monday = new Date(nowTick.value)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  monday.setHours(0, 0, 0, 0)
  return dayKey(monday)
})
const monthStartKey = computed(() => {
  const first = new Date(nowTick.value)
  first.setDate(1)
  first.setHours(0, 0, 0, 0)
  return dayKey(first)
})
const thisWeek = computed(() => sumRange(days.value, weekStartKey.value, todayKey.value))
const thisMonth = computed(() => sumRange(days.value, monthStartKey.value, todayKey.value))

// ---------- 趋势 ----------

/** 占比统计跟随的桶:null 即「全部」(整个趋势窗口);点了柱子锁定那根,再点一下回到全部 */
const selectedBucketIndex = ref<number | null>(null)

// 切粒度或换窗口后桶的含义全变,选中作废,回到全部
watch([granularity, fromKey, toKey], () => {
  selectedBucketIndex.value = null
})

/** 趋势序列:按当前粒度把窗口内的天级数据分桶,没有数据的桶补零 */
const series = computed(() =>
  buildSeriesRange(days.value, granularity.value, fromKey.value, toKey.value)
)

/** 选中柱子时生效的桶;未选中为 null,占比走整个窗口 */
const activeBucket = computed<TokenBucket | null>(() => {
  if (selectedBucketIndex.value === null) return null
  return series.value.buckets[selectedBucketIndex.value] ?? null
})

/** 占比的统计区间:未选中柱子就是整个趋势窗口,选中后是那个桶覆盖的区间 */
const activeRange = computed(() => {
  if (activeBucket.value) {
    const range = bucketRangeOf(activeBucket.value.key, granularity.value)
    if (range.fromKey) return range
  }
  return { fromKey: fromKey.value, toKey: toKey.value }
})

/** 占比区标题:默认是当前窗口的起止日,选中柱子后显示那个桶的坐标标签 */
const shareRangeLabel = computed(() =>
  activeBucket.value
    ? activeBucket.value.label
    : `${shortDayLabel(fromKey.value)} ~ ${shortDayLabel(toKey.value)}`
)

function selectBucket(index: number): void {
  selectedBucketIndex.value = selectedBucketIndex.value === index ? null : index
}

function isSelected(index: number): boolean {
  return selectedBucketIndex.value === index
}

const maxBucketTotal = computed(() =>
  Math.max(1, ...series.value.buckets.map((bucket) => totalTokens(bucket.counters)))
)

function barHeight(bucket: { counters: TokenCounters }): string {
  // 没有数据的桶给一根 2px 的小柱,图不至于大片留白;颜色更淡,与真数据区分
  if (totalTokens(bucket.counters) === 0) return '2px'
  return `${Math.max(2, (totalTokens(bucket.counters) / maxBucketTotal.value) * 100)}%`
}

// ---------- 占比 ----------

const models = computed(() =>
  shareByModel(days.value, activeRange.value.fromKey, activeRange.value.toKey).slice(0, 5)
)
/** 工具占比:按参考样式逐工具一行,行下一条细条表示份额 */
const sources = computed(() =>
  result.value
    ? shareBySource(result.value.data, activeRange.value.fromKey, activeRange.value.toKey)
    : []
)

const maxSourceTotal = computed(() =>
  Math.max(1, totalTokens(sources.value[0]?.counters ?? emptyCounters()))
)

function sourceWidth(counters: TokenCounters): string {
  return `${(totalTokens(counters) / maxSourceTotal.value) * 100}%`
}

const maxModelTotal = computed(() => Math.max(1, totalTokens(models.value[0]?.counters ?? emptyCounters())))

/** 展开明细的模型(同时只展开一个,再点一下收起) */
const expandedModel = ref<string | null>(null)

function toggleModel(key: string): void {
  expandedModel.value = expandedModel.value === key ? null : key
}

/** 展开模型明细的工具(与模型展开互不相干,同样只开一个) */
const expandedTool = ref<string | null>(null)

function toggleTool(key: string): void {
  expandedTool.value = expandedTool.value === key ? null : key
}

/** 展开的工具里各模型的占比(按该工具自己的天级数据统计) */
const expandedToolModels = computed(() => {
  if (!expandedTool.value || !result.value) return []
  const source = result.value.data.sources[expandedTool.value]
  if (!source) return []
  return shareByModel(source.days, activeRange.value.fromKey, activeRange.value.toKey)
})

/** 一行明细:标签 + 占比 + 数值 */
function detailRows(counters: TokenCounters): Array<{ label: string; value: number }> {
  const rows = [
    { label: '输入(缓存命中)', value: counters.cacheReadTokens },
    { label: '输入(缓存未命中)', value: counters.inputTokens },
    { label: '输出', value: counters.outputTokens }
  ]
  // 思考token通常为 0,不占一行
  if (counters.reasoningTokens > 0) rows.push({ label: '思考', value: counters.reasoningTokens })
  return rows
}

/** 全部输入 = 缓存命中的那一半 + 未命中的那一半(计数里的 inputTokens 只记未命中) */
function inputTotal(counters: TokenCounters): number {
  return counters.cacheReadTokens + counters.inputTokens
}

/** 缓存命中率:命中占全部输入的比例 */
function hitRateLabel(counters: TokenCounters): string {
  return formatPercent(counters.cacheReadTokens, inputTotal(counters))
}

function shareWidth(counters: TokenCounters): string {
  return `${(totalTokens(counters) / maxModelTotal.value) * 100}%`
}

/** 展开明细里的迷你条:相对同一组内的最大值 */
function detailWidth(value: number, max: number): string {
  return `${(Math.max(0, value) / Math.max(1, max)) * 100}%`
}
</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <span class="eyebrow">Token 用量</span>
      <!-- 底部的更新时间与状态点合并到标题行右侧,与刷新按钮同一条 flex 中线对齐 -->
      <span class="head__meta" :title="statusTitle">
        <i class="head__dot" :class="statusFail ? 'is-fail' : 'is-ok'" aria-hidden="true" />
        <span class="head__time">{{ statusText }}</span>
      </span>
      <!-- 同步按钮只在设置里填了仓库地址时出现:没开同步就没得同步,按钮放着只会让人点 -->
      <button
        v-if="sync?.enabled"
        class="head__refresh"
        type="button"
        :disabled="syncing || loading"
        title="立即同步"
        aria-label="立即同步"
        @click="syncNow()"
      >
        <el-icon><Connection /></el-icon>
      </button>
      <button
        class="head__refresh"
        type="button"
        :disabled="loading"
        title="重新读取用量"
        aria-label="重新读取用量"
        @click="refresh()"
      >
        <el-icon><Refresh /></el-icon>
      </button>
    </header>

    <!-- 内容区:面板高度不够时自己出滚动条,标题行与刷新按钮钉在顶部 -->
    <div class="panel__body panel__scroll">
    <template v-if="hasData">
      <div class="topline">
        <div class="top">
          <i>今日</i>
          <b class="mono">{{ formatTokens(totalTokens(today)) }}</b>
        </div>
        <div class="top">
          <i>本周</i>
          <b class="mono">{{ formatTokens(totalTokens(thisWeek)) }}</b>
        </div>
        <div class="top">
          <i>本月</i>
          <b class="mono">{{ formatTokens(totalTokens(thisMonth)) }}</b>
        </div>
      </div>

      <div class="chart">
        <div class="chart__head">
          <!-- 趋势窗口:时间维度下拉(预设 + 自定义区间),右侧页签只切换柱子的分桶宽度 -->
          <div class="range" role="group" aria-label="趋势时间范围">
            <TokenRangePicker
              :from-key="fromKey"
              :to-key="toKey"
              :preset="rangePreset"
              :earliest-key="earliestKey"
              :latest-key="todayKey"
              @pick-preset="pickPreset"
              @pick-range="pickRange"
            />
            <!-- 实际生效的起止日:预设按快照收敛后可能与字面含义不同,这里给出确切窗口 -->
            <span class="range__text mono">{{ shortDayLabel(fromKey) }} ~ {{ shortDayLabel(toKey) }}</span>
          </div>
          <div class="chart__tabs" role="tablist">
            <button
              v-for="g in GRANULARITIES"
              :key="g.key"
              type="button"
              class="tab"
              :class="{ 'is-active': granularity === g.key }"
              @click="granularity = g.key"
            >
              {{ g.label }}
            </button>
          </div>
        </div>

        <div class="chart__bars">
          <el-tooltip
            v-for="(bucket, index) in series.buckets"
            :key="bucket.key"
            placement="top"
            :show-after="120"
            :disabled="totalTokens(bucket.counters) === 0"
          >
            <template #content>
              <!-- 一行一个口径:输入那行是「缓存命中 / 全部输入 / 命中率」三段,
                   与展开模型时的构成、下方的占比用的都是同一套口径 -->
              <div class="token-tip mono">
                <p class="token-tip__title">{{ bucket.label }}</p>
                <p>
                  输入：{{ formatTokens(bucket.counters.cacheReadTokens) }}/{{ formatTokens(inputTotal(bucket.counters)) }}/{{ hitRateLabel(bucket.counters) }}
                </p>
                <p>输出：{{ formatTokens(bucket.counters.outputTokens) }}</p>
                <p>思考：{{ formatTokens(bucket.counters.reasoningTokens) }}</p>
                <p>请求：{{ bucket.counters.requests }} 次</p>
              </div>
            </template>
            <!-- 点柱子把下方占比切到那个桶,再点一下回到全部 -->
            <button
              type="button"
              class="bar-slot"
              :class="{ 'is-selected': isSelected(index) }"
              :aria-label="`查看 ${bucket.label} 的占比`"
              @click="selectBucket(index)"
            >
              <i
                class="bar"
                :class="{ 'is-empty': totalTokens(bucket.counters) === 0 }"
                :style="{ height: barHeight(bucket) }"
              />
            </button>
          </el-tooltip>
        </div>
      </div>

      <div class="share">
        <div class="share__head">
          模型占比
          <span>{{ shareRangeLabel }} · 点击行看构成</span>
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
                {{ formatTokens(totalTokens(m.counters)) }}
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
              <b class="detail__val mono">{{ formatTokens(row.value) }}</b>
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
          <span>{{ shareRangeLabel }} · 点击行看模型</span>
        </div>
        <template v-for="s in sources" :key="s.key">
          <button
            type="button"
            class="tool tool--toggle"
            :aria-expanded="expandedTool === s.key"
            @click="toggleTool(s.key)"
          >
            <span class="tool__name" :title="s.key">{{ SOURCE_LABELS[s.key] ?? s.key }}</span>
            <span class="tool__track"><i :style="{ width: sourceWidth(s.counters) }" /></span>
            <span class="tool__num mono">{{ formatTokens(totalTokens(s.counters)) }}</span>
            <el-icon class="share__chevron" :class="{ 'is-open': expandedTool === s.key }">
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
              <b class="detail__val mono">{{ formatTokens(totalTokens(tm.counters)) }}</b>
            </div>
            <div class="detail__foot">
              请求 {{ s.counters.requests }} 次 · 缓存命中率 {{ hitRateLabel(s.counters) }}
            </div>
          </div>
        </template>
      </div>
    </template>

    <div v-else class="empty">
      <p>暂无 Token 用量记录</p>
      <p class="empty__hint">在 ZCode / DeepSeek Harness / CodeBuddy / WorkBuddy 里跑过对话后,这里会出现按天的统计</p>
    </div>
    </div>
  </article>
</template>

<style scoped>
/* ---------- 根面板 ---------- */

/*
 * 卡片(BoardCard)给面板限定了高度:面板必须跟着填满并允许收缩到内容以下,
 * 内容区(.panel__body)的内部滚动条才会出现 —— 否则面板按内容撑高,
 * 超出卡片的部分被卡片直接裁掉,谁都滚不了。
 */
.panel {
  flex: 1 1 auto;
  min-height: 0;
}

/*
 * 标题行:eyebrow 用 margin-right:auto 吃掉剩余空间,把「更新于 + 刷新」推到最右;
 * 三个元素同在 .panel__head 的 flex 中线上(绝对定位那版各对各的,差出一两像素)。
 */
.eyebrow {
  margin-right: auto;
}

.head__refresh {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.head__refresh:hover:not(:disabled) {
  color: var(--ink);
}

.head__refresh:disabled {
  cursor: default;
  opacity: 0.5;
}

/* ---------- 概览 ---------- */

/* 标题行以下的内容区:高度不够时出内部滚动条(全局滚动条样式在 global.css) */
.panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 面板的 gap 只够到这一层,内部间距由它自己延续同款节奏 */
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/*
 * 滚动容器里的子项一律不收缩:空间不够靠滚动解决,而不是把图表压扁。
 * 不加这条,.chart 会被压到 0 高,柱子从框里溢出去盖住下面的占比区。
 */
.panel__body > * {
  flex-shrink: 0;
}

.topline {
  display: flex;
  flex-shrink: 0;
}

/* 三项平分卡片宽度,文字各自居中 */
.top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: 1 1 0;
}

.top i {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.top b {
  font-weight: 600;
  font-size: var(--fs-body);
}

/* ---------- 趋势 ---------- */

/*
 * 图表固定高度,不跟着卡片长高 —— 卡片拖得太高时图表会被拉成一片空旷。
 * 在滚动容器(.panel__body)里也不收缩:空间不够靠滚动解决,压扁只会让柱子溢出压到占比区。
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
  /* 卡片窄到一行放不下时换行,让选择器和页签各占一行,而不是互相挤压 */
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-2);
  flex-shrink: 0;
}

/* 趋势窗口:时间维度下拉 + 实际生效的起止日 */
.range {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/* 收敛后的确切窗口(预设可能被快照范围截短,数字要能对得上) */
.range__text {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  white-space: nowrap;
}

.chart__tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  /* 页签永远贴右边缘:换行到第二行时也一样(只靠 space-between 会掉到左边) */
  margin-left: auto;
}

.tab {
  padding: 1px 8px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  font-size: var(--fs-micro);
  color: var(--ink-3);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.tab:hover {
  color: var(--ink);
}

.tab.is-active {
  background: var(--bg-surface);
  color: var(--ink);
}

/**
 * 柱状图:每个柱子是等宽的弹性槽,槽底对齐;底部一条基线把图「放」在面板上。
 * 柱体最宽 10px 并在槽里居中 —— 窗口短(本月才十几根)时柱子不该长成一块块方砖,
 * 槽本身仍是整格的热区,点击与悬停不受影响。
 * 柱体用灰阶,hover 才落主色 —— 彩色在本界面只表达运行状态,这里不做例外。
 * 高度写死不参与伸缩:面板矮了让内容区出滚动条,而不是把图压扁。
 */
.chart__bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  flex: 0 0 auto;
  height: 90px;
  border-bottom: 1px solid var(--border);
}

/* 柱槽是按钮:点一下把下方占比切到那个桶,再点一下回到全部 */
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

/* 零数据的小柱:更矮更淡,只是示意「这一天是零」 */
.bar.is-empty {
  opacity: 0.22;
}

.bar-slot:hover .bar {
  background: var(--el-color-primary);
  opacity: 0.9;
}

/* 选中的桶:占比区此刻统计的就是它,用实色灰阶标出 */
.bar-slot.is-selected .bar {
  background: var(--ink);
  opacity: 0.9;
}

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

/* 模型行与工具行共用 source 样式;模型行是按钮,重置后 hover 给一点反馈 */
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

/* 展开的构成明细:缩进到进度条起点,与参考布局一致 */
.share__detail {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: 2px 0 var(--sp-2);
}

/*
 * 展开的构成明细:标签左、迷你占比条中、百分比与数值右 ——
 * 百分比固定列宽右对齐,多行数字才竖着对齐;条形语言与面板其他部分一致。
 */
.detail__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  /* 缩进收窄,把横向空间尽量让给条形 */
  padding-left: var(--sp-2);
  padding-block: 3px;
  min-width: 0;
}

.detail__label {
  /* 列宽从 40% 收到 34%:短标签(输出/思考)后面不再是大片留白,条形相应变长 */
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
  padding-left: var(--sp-4);
  margin-top: 1px;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* ---------- 工具占比:名称左、总量右,下面一条全宽细条表示份额 ---------- */

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

/* ---------- 工具占比:单行紧凑样式(名称左、行内细条、数值右),点击展开该工具的模型 ---------- */

.tool {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  /* 行与行之间留半步,行间不至于黏成一坨 */
  padding: var(--sp-1) 0;
}

/* 可点击展开的工具行:按钮重置成普通行,hover 给一点反馈 */
.tool--toggle {
  width: 100%;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  text-align: left;
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

/* ---------- 空态与底部 ---------- */

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  gap: var(--sp-1);
  text-align: center;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.empty__hint {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 标题行右侧的更新时间与状态点(原底部信息合并到这里),与刷新按钮同一条 flex 中线 */
.head__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}

.head__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.head__dot.is-ok {
  background: var(--st-ok);
}

.head__dot.is-fail {
  background: var(--st-fail);
}

.head__time {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/*
 * 柱子悬停提示:一行一个口径,行与行之间留一点点,四行才不像挤在一起的一段。
 * 类名刻意不叫 `tip` —— global.css 里有个同名的 `.tip`(键位提示行,是 flex 行),
 * 撞上它这几行就会被排成一行,正是这个提示以前那副「一长条」的样子。
 * 颜色一律继承 Element Plus(dark 效果在暗色主题下反而是浅底),这里不改,免得两种主题下有一边看不清。
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
