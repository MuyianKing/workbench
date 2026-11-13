<script setup lang="ts">
import type { TokenBucket, TokenCounters, TokenGranularity, TokenRangePreset, UsageAxis } from '@workbench/usage'
import { Connection, Histogram, Refresh } from '@element-plus/icons-vue'
import { dayKey } from '@workbench/core'
import { axisTotal, bucketRangeOf, buildSeriesRange, flattenSources, presetLabel, resolvePresetRange, shortDayLabel, SOURCE_LABELS, sumRange } from '@workbench/usage'
/**
 * 首页「Coding 用量」卡片:读各 AI 工具本地用量数据(ZCode / DeepSeek Harness / CodeBuddy /
 * WorkBuddy / Qoder)的按天聚合快照,画 今日/本周/当前窗口 概览、趋势条形图与模型/工具占比。
 *
 * 计数有两个口径(见 @workbench/usage 的 UsageAxis):token 计数,与按额度记账的工具
 * 报的 credits(Qoder)。标题行右侧的分段控件切换,一次只画一个 —— 两者量纲不同,
 * 相加或同轴都没有意义;切口径即换一整套数字,有数的那几天也可能不同,所以窗口要重新收敛。
 * credits 那边不画模型占比(那一维在额度上没有意义,见 showModels),只留工具占比。
 *
 * 趋势窗口由头部的预设下拉给出(默认「近 30 天」,与 DeepSeek 用量页同款:
 * 近 7 天 / 近 30 天 / 本月 / 上月 / 全部 / 自定义;可选的日子限于当前口径下有记录的那段),
 * 右侧 天/周/月 页签只切换柱子的分桶宽度,窗口本身不变;
 * 概览那一行的第三格**跟着这个窗口走**(标签与数字都换) —— 前两格是「此刻」的口径
 * (今天 / 本周至今),第三格报当前看的那一段,数字等于图上柱子之和;
 * 占比默认统计整个窗口(全部);点击某根柱子则把占比切到那个桶(那天/那周/那月),再点一下回到全部。
 *
 * 数据是主进程「实读 + max 合并进快照」后的结果,这里不做任何持久化,只拉取与展示:
 * 挂载时**先出本地那份快照**、再实读覆盖它(boot),之后每分钟刷新(轮询只在首页可见时跑,
 * 切回来会立刻补读一次 —— 见 use-token-usage),「⋯」外还有标题栏右侧的手动刷新按钮。
 * 后台的自动同步跑完还会广播一次,收到也重取 —— 同步不挡出数,别的机器的新数据靠这一下补上。
 * 缓存读取通常占九成以上,构成拆分收在悬停里,总量数字才不会因缓存命中波动而误导。
 *
 * 这一层只管窗口状态与三块内容的编排：取数与轮询在 `composables/use-token-usage.ts`，
 * 概览 / 趋势图 / 占比分别在 `TokenOverview.vue` / `TokenTrendChart.vue` / `TokenShares.vue`。
 */
import { computed, ref, watch } from 'vue'
import PanelLoading from '@/components/PanelLoading.vue'
import TokenOverview from '@/components/TokenOverview.vue'
import TokenShares from '@/components/TokenShares.vue'
import TokenTrendChart from '@/components/TokenTrendChart.vue'
import { useTokenUsage } from '@/composables/use-token-usage'
import { formatRelative } from '@/format'

/**
 * 两个口径:token 计数,与按额度记账的工具(Qoder)报的 credits。
 *
 * 一次只画一个:两者量纲不同,相加或同轴都没有意义。默认 tokens ——
 * 那是这个面板一直以来的样子,credits 是后来的、只有用 Qoder 的人才有的那一份。
 */
const AXES: Array<{ key: UsageAxis, label: string }> = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'credits', label: 'Credits' },
]

/** 取数与轮询在 composable 里（单页状态，不造 store，见 ipc-and-state.md） */
const { result, loading, syncing, nowTick, readOnce, refresh, syncNow } = useTokenUsage({
  onData: () => clampRange(),
})
const granularity = ref<TokenGranularity>('day')
/** 当前口径;切换即换一整套数字(总览、趋势、占比都跟着走) */
const axis = ref<UsageAxis>('tokens')
/** 生效的时间维度档位;日历上选过区间后即为 custom */
const rangePreset = ref<TokenRangePreset>('last30')
/** 趋势窗口的起止日期(本地日期键,含两端);空串表示还没拿到数据 */
const fromKey = ref('')
const toKey = ref('')

const days = computed(() => (result.value ? flattenSources(result.value.data) : {}))
const todayKey = computed(() => dayKey(nowTick.value))
/** 实读失败的工具及原因(有失败时底部状态点转红,但不影响其余来源展示) */
const sourceErrorText = computed(() =>
  Object.entries(result.value?.sourceErrors ?? {})
    .map(([id, error]) => `${SOURCE_LABELS[id] ?? id}:${error}`)
    .join(';'),
)
const updatedAt = computed(() => result.value?.data.updatedAt ?? 0)

/** 一组计数在当前口径下的量:面板上每个数字都从这里出,免得某处漏了换算 */
function amount(counters: TokenCounters): number {
  return axisTotal(counters, axis.value)
}

/** 某一天在当前口径下有没有数(日期下限与空态都按它判) */
function dayHasData(models: Record<string, TokenCounters>): boolean {
  return Object.values(models).some(counters => amount(counters) > 0)
}

/**
 * 模型占比只在 tokens 口径下画。
 *
 * credits 那边按模型拆没有意义 —— Qoder 的会话里模型名只有上游的内部别名(`qfmodel`),
 * 拆出来是一行看不出任何东西的明细,不如把地方让给工具占比。
 */
const showModels = computed(() => axis.value === 'tokens')

/**
 * 当前口径下有没有数据。
 *
 * 不能只看「快照里有没有天数」:有 token 记录不代表有额度记录,
 * 反过来也一样 —— 只看天数的话,切到没数据的那个口径会画出一片空图,而不是空态。
 */
const hasData = computed(() => Object.values(days.value).some(dayHasData))

// ---------- 同步状态 ----------

/** 同步状态;设置里没填仓库地址时 enabled 为 false,标题行不显示同步那一块 */
const sync = computed(() => result.value?.sync ?? null)
const syncError = computed(() => sync.value?.error ?? '')

/** 参与合并的本机与其它设备名字,拼成一句给悬停提示 */
const deviceText = computed(() => {
  const status = sync.value
  if (!status?.enabled)
    return ''
  const others = status.devices.map(item => item.name).join('、')
  return others ? `${status.deviceName}、${others}` : status.deviceName
})

/** 标题行右侧那行字:实读失败优先,其次是同步失败,再次才是更新时间 */
const statusText = computed(() => {
  if (sourceErrorText.value)
    return '部分来源不可用'
  if (sync.value?.enabled && syncError.value)
    return '同步失败'
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
    }
    else {
      parts.push('还没同步过')
    }
  }
  return parts.join('\n') || undefined
})

const statusFail = computed(() => Boolean(sourceErrorText.value || syncError.value))

/**
 * 当前口径下最早有数的那天:日历与预设的可选下限(再往前没有记录,选了只会是一片空白)。
 * 按口径算 —— Qoder 的额度只有这两天的记录时,credits 那张图的日历不该让人选到半年前。
 */
const earliestKey = computed(
  () =>
    Object.keys(days.value)
      .filter(date => dayHasData(days.value[date]))
      .sort()[0] ?? todayKey.value,
)

/**
 * 把趋势窗口收敛回可选范围:终点不晚于今天,起点不早于快照最早那天。
 * 预设档每次都按「现在」重新解析 —— 跨过午夜后「今天 / 近 7 天 / 本月」才会跟着时钟走;
 * 「全部」没有固定的字面区间,起点取快照里最早有数的那天,重读把历史补得更早时它也跟着前移;
 * 自定义档只做边界收敛,不动用户选的那一段。
 */
function clampRange(): void {
  const earliest = earliestKey.value
  const latest = todayKey.value
  if (rangePreset.value === 'all') {
    fromKey.value = earliest
    toKey.value = latest
    return
  }
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
  if (toKey.value > latest)
    toKey.value = latest
  // 起点贴到最早那天:只在不会把起点推到终点之后时才收 ——
  // 否则(比如选了「昨天」而昨天还没有记录)那一档本就落在没数据的日子上,该照原样显示,而不是挪到有数据的地方
  if (fromKey.value < earliest && earliest <= toKey.value)
    fromKey.value = earliest
  // 不变式:起点不晚于终点。日历已按快照范围禁掉越界日期,正常操作碰不到,这里是兜底
  if (fromKey.value > toKey.value)
    fromKey.value = toKey.value
}

/**
 * 下拉里点了某一档:窗口交给预设解析,再按快照范围收敛。
 *
 * 「全部」铺满整个快照(最长 53 周),逐日柱子在那里既挤不下也看不出形状 ——
 * 当前还是「天」就顺手落到「月」;已经是周 / 月则不动,那是用户自己定的宽度。
 */
function pickPreset(preset: TokenRangePreset): void {
  rangePreset.value = preset
  if (preset === 'all' && granularity.value === 'day')
    granularity.value = 'month'
  clampRange()
}

/** 日历里选完一段:这一档随之成为自定义 */
function pickRange(range: { fromKey: string, toKey: string }): void {
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
const thisWeek = computed(() => sumRange(days.value, weekStartKey.value, todayKey.value))
/**
 * 第三格跟着趋势窗口走:标签是当前档位,数字是那段窗口的合计(= 图上柱子之和)。
 *
 * 不写真名「本月」—— 档位换成近 7 天 / 上月 / 自定义时那个名字就成了谎话;
 * 收敛后的确切起止日(预设被快照截短时与字面含义不同)挂在悬停上,与图表头部那行小字同源。
 */
const rangeLabel = computed(() => presetLabel(rangePreset.value))
const rangeTotal = computed(() => sumRange(days.value, fromKey.value, toKey.value))
const rangeTitle = computed(() => `${shortDayLabel(fromKey.value)} ~ ${shortDayLabel(toKey.value)}`)

// ---------- 趋势 ----------

/** 占比统计跟随的桶:null 即「全部」(整个趋势窗口);点了柱子锁定那根,再点一下回到全部 */
const selectedBucketIndex = ref<number | null>(null)

// 切粒度或换窗口后桶的含义全变,选中作废,回到全部
watch([granularity, fromKey, toKey], () => {
  selectedBucketIndex.value = null
})

/**
 * 换口径:数字整套都变了,展开的行与选中的柱子都属于上一个口径,一并作废;
 * 窗口按新口径重新收敛 —— 两个口径有数的那几天不一定一样(见 earliestKey)。
 * 占比区那两块由下面的 `:key="axis"` 重挂，展开状态随之收掉（见 TokenShares）。
 */
watch(axis, () => {
  selectedBucketIndex.value = null
  clampRange()
})

/** 趋势序列:按当前粒度把窗口内的天级数据分桶,没有数据的桶补零 */
const series = computed(() =>
  buildSeriesRange(days.value, granularity.value, fromKey.value, toKey.value),
)

/** 选中柱子时生效的桶;未选中为 null,占比走整个窗口 */
const activeBucket = computed<TokenBucket | null>(() => {
  if (selectedBucketIndex.value === null)
    return null
  return series.value.buckets[selectedBucketIndex.value] ?? null
})

/** 占比的统计区间:未选中柱子就是整个趋势窗口,选中后是那个桶覆盖的区间 */
const activeRange = computed(() => {
  if (activeBucket.value) {
    const range = bucketRangeOf(activeBucket.value.key, granularity.value)
    if (range.fromKey)
      return range
  }
  return { fromKey: fromKey.value, toKey: toKey.value }
})

/** 占比区标题:默认是当前窗口的起止日,选中柱子后显示那个桶的坐标标签 */
const shareRangeLabel = computed(() =>
  activeBucket.value
    ? activeBucket.value.label
    : `${shortDayLabel(fromKey.value)} ~ ${shortDayLabel(toKey.value)}`,
)

function selectBucket(index: number): void {
  selectedBucketIndex.value = selectedBucketIndex.value === index ? null : index
}
</script>

<template>
  <article class="panel" aria-label="Coding 用量">
    <header class="panel__head">
      <!-- 口径切换:token 计数与额度是两套量纲,一次只画一个(见 UsageAxis)。
           卡片名不在这儿画 —— 编辑态由 BoardCard 标出来,这里只留控件 -->
      <el-segmented
        v-model="axis"
        class="head__axis"
        :options="AXES"
        :props="{ label: 'label', value: 'key' }"
        aria-label="用量口径"
      />
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
        <TokenOverview
          :today="today"
          :week="thisWeek"
          :range="rangeTotal"
          :range-label="rangeLabel"
          :range-title="rangeTitle"
          :axis="axis"
        />
        <TokenTrendChart
          v-model:granularity="granularity"
          :buckets="series.buckets"
          :from-key="fromKey"
          :to-key="toKey"
          :preset="rangePreset"
          :earliest-key="earliestKey"
          :latest-key="todayKey"
          :selected-index="selectedBucketIndex"
          :axis="axis"
          :show-models="showModels"
          @pick-preset="pickPreset"
          @pick-range="pickRange"
          @select="selectBucket"
        />
        <TokenShares
          :key="axis"
          :result="result"
          :from-key="activeRange.fromKey"
          :to-key="activeRange.toKey"
          :axis="axis"
          :range-label="shareRangeLabel"
          :show-models="showModels"
        />
      </template>

      <!-- 空态分两种:实读还没回来时是「读取中」,回来过才是「确实没有」——
           把前者说成后者,有数据的用户会以为自己的记录没了 -->
      <PanelLoading
        v-else-if="!readOnce"
        text="正在读取用量…"
        hint="首次读取要解析各工具的本地日志，稍等一下"
      />

      <div v-else class="empty">
        <template v-if="axis === 'credits'">
          <el-icon class="empty__icon">
            <Histogram />
          </el-icon>
          <p>暂无额度记录</p>
          <p class="empty__hint">
            在 Qoder 里跑过对话后,这里会出现按天的额度消耗
          </p>
        </template>
        <template v-else>
          <el-icon class="empty__icon">
            <Histogram />
          </el-icon>
          <p>暂无 Token 用量记录</p>
          <p class="empty__hint">
            在 ZCode / DeepSeek Harness / CodeBuddy / WorkBuddy 里跑过对话后,这里会出现按天的统计
          </p>
        </template>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* 这块空态在卡片里，行距比别处紧一档（基础样式见 global.css 的 .empty） */
.empty {
  gap: var(--sp-1);
}

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
 * 标题行:只剩口径切换与右侧那行状态 —— 卡片名不在这儿画(编辑态由 BoardCard 标出)。
 * 口径切换用 margin-right:auto 吃掉剩余空间,把「更新于 + 刷新」推到最右;
 * 卡片窄的时候先让那行更新时间收没(它自带 min-width:0),口径切换与两颗按钮留着。
 */
.head__axis.el-segmented {
  margin-right: auto;
  font-size: var(--fs-micro);
}

.head__axis :deep(.el-segmented__item) {
  padding: 1px 8px;
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

/* ---------- 空态与底部 ---------- */

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
</style>
