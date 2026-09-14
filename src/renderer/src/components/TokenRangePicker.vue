<script setup lang="ts">
/**
 * Token 用量的时间筛选:与 DeepSeek 用量页同款的预设下拉。
 *
 * 触发器只写当前档位(近 7 天 / 近 30 天 / 本月 / 上月 / 自定义),面板左侧就是这几档,
 * 选中「自定义」时右侧展开双月区间日历 —— 第一下定起点、第二下定终点,定完即时生效。
 *
 * 「点了哪一档」和「日历上选了哪段」都只报给父组件:区间怎么随快照收敛、跨过午夜后
 * 怎么跟着时钟走,都留在 TokenPanel;这里只负责选择本身。
 * 日历里可选的日子限于快照范围(earliestKey ~ latestKey),范围外选了也画不出柱子。
 *
 * 弹层外壳上那两处覆盖要成对看:popover 把 width 默认值 150 当成内联样式写死(内联样式压过
 * 样式表,所以必须在 popper-style 里改回 auto,尺寸才由面板内容决定 —— 否则展开日历后
 * 内容会溢出那 150px 的盒子、画到边框与阴影外面去),global.css 里再去掉它同款的 150px 最小宽度。
 */
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowLeft, ArrowRight, Check } from '@element-plus/icons-vue'
import { TOKEN_RANGE_PRESETS, presetLabel, type TokenRangePreset } from '@shared/token-usage'
import { dayKey } from '@shared/activity'

const props = defineProps<{
  /** 当前生效的区间(含两端) */
  fromKey: string
  toKey: string
  /** 当前生效的档位 */
  preset: TokenRangePreset
  /** 可选下限:快照里最早的那天 */
  earliestKey: string
  /** 可选上限:今天 */
  latestKey: string
}>()

const emit = defineEmits<{
  'pick-preset': [preset: TokenRangePreset]
  'pick-range': [range: { fromKey: string; toKey: string }]
}>()

/** 周日起始,与日历表头一致 */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const open = ref(false)
/** 自定义日历是否展开:点「自定义」才展开,选其他档位就收起 */
const calendarOpen = ref(false)
/** 已点下的起点与终点;终点为空表示这一手还没选完 */
const pickedFrom = ref('')
const pickedTo = ref('')
/** 起点已定、终点未定时,指针停在哪天就预览到哪天 */
const hoverKey = ref('')
/** 左边那格的月份(YYYY-MM),右边紧跟其后 */
const viewMonth = ref('')

/** 每次打开都从当前生效的区间接着改,不在两次打开之间留半截选择 */
watch(open, (visible) => {
  if (!visible) return
  calendarOpen.value = props.preset === 'custom'
  pickedFrom.value = props.fromKey
  pickedTo.value = props.toKey
  hoverKey.value = ''
  viewMonth.value = (props.fromKey || props.latestKey).slice(0, 7)
})

// ---------- 日历网格 ----------

/** 月份位移:入参是 'YYYY-MM';跨年交给 Date 自己进位 */
function shiftMonth(month: string, delta: number): string {
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function monthLabel(month: string): string {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`
}

/** 某月最后一天:下个月的第 0 天 */
function monthEnd(month: string): string {
  return dayKey(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
}

/**
 * 一个月的网格:周日起始,月外的格子留空串。
 * 固定铺 6 行 —— 两个月的行数一样,展开日历时面板高度才不会随月份跳一下(2 月比 31 天的月少一行)。
 */
function monthWeeks(month: string): string[][] {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1
  const first = new Date(year, index, 1)
  const cursor = new Date(year, index, 1 - first.getDay())
  const weeks: string[][] = []
  for (let row = 0; row < 6; row += 1) {
    const week: string[] = []
    for (let day = 0; day < 7; day += 1) {
      week.push(cursor.getMonth() === index ? dayKey(cursor) : '')
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }
  return weeks
}

const currentMonth = computed(() => viewMonth.value || props.latestKey.slice(0, 7))

const months = computed(() => {
  const first = currentMonth.value
  const second = shiftMonth(first, 1)
  return [
    { key: first, label: monthLabel(first), weeks: monthWeeks(first) },
    { key: second, label: monthLabel(second), weeks: monthWeeks(second) }
  ]
})

/** 再往前翻的那个月整月都早于最早那天,翻了也只是空网格 */
const canPrev = computed(() => monthEnd(shiftMonth(currentMonth.value, -1)) >= props.earliestKey)
/** 再往后翻的那个月还没到:今天之后的日期没有数据 */
const canNext = computed(() => shiftMonth(currentMonth.value, 2) <= props.latestKey.slice(0, 7))

// ---------- 选择 ----------

function selectable(key: string): boolean {
  return !!key && key >= props.earliestKey && key <= props.latestKey
}

/** 预览的终点:还没定下终点时跟着指针走,但不早于起点 */
const bandTo = computed(() => {
  if (!pickedFrom.value) return ''
  if (pickedTo.value) return pickedTo.value
  return hoverKey.value > pickedFrom.value ? hoverKey.value : pickedFrom.value
})

function dayState(key: string): Record<string, boolean> {
  const inBand = !!pickedFrom.value && key >= pickedFrom.value && key <= bandTo.value
  return {
    'is-out': !selectable(key),
    'is-band': inBand,
    // 两端的实心圆:起点、终点,以及只定了起点时的起点本身
    'is-edge': inBand && (key === pickedFrom.value || key === pickedTo.value),
    'is-today': key === props.latestKey
  }
}

function pickDay(key: string): void {
  if (!selectable(key)) return
  // 还没起点,或上一段已经选完(两端都在),这一下都算重新起头
  if (!pickedFrom.value || pickedTo.value) {
    pickedFrom.value = key
    pickedTo.value = ''
    return
  }
  if (key < pickedFrom.value) {
    pickedFrom.value = key
    return
  }
  pickedTo.value = key
  emit('pick-range', { fromKey: pickedFrom.value, toKey: key })
  open.value = false
}

function pickPreset(preset: TokenRangePreset): void {
  // 自定义只展开日历,等选完起止日期再收面板
  if (preset === 'custom') {
    calendarOpen.value = true
    return
  }
  calendarOpen.value = false
  open.value = false
  emit('pick-preset', preset)
}
</script>

<template>
  <el-popover
    v-model:visible="open"
    trigger="click"
    placement="bottom-start"
    :show-arrow="false"
    :offset="6"
    popper-class="token-range-pop"
    popper-style="width: auto"
  >
    <template #reference>
      <button
        class="trigger"
        type="button"
        :aria-expanded="open"
        :aria-label="`时间维度：${presetLabel(preset)}`"
        title="按时间维度筛选趋势与占比"
      >
        <span class="trigger__value">{{ presetLabel(preset) }}</span>
        <el-icon class="trigger__caret"><ArrowDown /></el-icon>
      </button>
    </template>

    <div class="picker" :class="{ 'is-wide': calendarOpen }">
      <div class="presets" role="group" aria-label="时间维度">
        <button
          v-for="option in TOKEN_RANGE_PRESETS"
          :key="option.key"
          type="button"
          class="preset"
          :class="{ 'is-current': preset === option.key, 'is-open': option.key === 'custom' && calendarOpen }"
          :aria-pressed="preset === option.key"
          @click="pickPreset(option.key)"
        >
          <span>{{ option.label }}</span>
          <el-icon v-if="preset === option.key" class="preset__check"><Check /></el-icon>
        </button>
      </div>

      <!-- 自定义:双月区间日历,第一下定起点、第二下定终点 -->
      <div v-if="calendarOpen" class="calendar">
        <div class="calendar__head">
          <button
            class="calendar__nav"
            type="button"
            :disabled="!canPrev"
            aria-label="上一个月"
            @click="viewMonth = shiftMonth(currentMonth, -1)"
          >
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <span v-for="month in months" :key="month.key" class="calendar__title">{{ month.label }}</span>
          <button
            class="calendar__nav"
            type="button"
            :disabled="!canNext"
            aria-label="下一个月"
            @click="viewMonth = shiftMonth(currentMonth, 1)"
          >
            <el-icon><ArrowRight /></el-icon>
          </button>
        </div>

        <div class="calendar__months">
          <div v-for="month in months" :key="month.key" class="month">
            <div class="month__weekdays">
              <span v-for="label in WEEKDAYS" :key="label">{{ label }}</span>
            </div>
            <div v-for="(week, row) in month.weeks" :key="row" class="month__week">
              <template v-for="(key, day) in week" :key="day">
                <!-- 月外的格子只占位:铺满整周,行首才不会错位 -->
                <span v-if="!key" class="day is-empty" aria-hidden="true" />
                <button
                  v-else
                  type="button"
                  class="day"
                  :class="dayState(key)"
                  :disabled="!selectable(key)"
                  :aria-label="key"
                  :aria-current="key === latestKey ? 'date' : undefined"
                  @click="pickDay(key)"
                  @mouseenter="hoverKey = key"
                  @mouseleave="hoverKey = ''"
                >
                  <span class="day__num">{{ Number(key.slice(8, 10)) }}</span>
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
/* ---------- 触发器:与图表右侧的页签同款胶囊,上面只写当前档位 ---------- */

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  color: var(--ink);
  font-family: inherit;
  font-size: var(--fs-micro);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.trigger:hover {
  background: var(--border);
}

.trigger__value {
  font-weight: 600;
}

.trigger__caret {
  font-size: 10px;
  color: var(--ink-3);
}

/* ---------- 弹层内容:左预设、右日历 ---------- */

.picker {
  display: flex;
  gap: var(--sp-3);
  padding: var(--sp-2);
}

.presets {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 0 0 auto;
  width: 96px;
}

/* 展开日历时给两栏之间一条细分隔线;收起时它是弹层右缘,不能留 */
.picker.is-wide .presets {
  padding-right: var(--sp-2);
  border-right: 1px solid var(--border);
}

.preset {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-1);
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font-family: inherit;
  font-size: var(--fs-meta);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.preset:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

/* 当前生效的那档:文字压深加粗,右侧一个勾 */
.preset.is-current {
  color: var(--ink);
  font-weight: 600;
}

/* 正在挑自定义日期的这一档:与 hover 同一副样子,表示「面板此刻在它身上」 */
.preset.is-open {
  background: var(--bg-inset);
  color: var(--ink);
}

.preset__check {
  font-size: 11px;
}

/* ---------- 双月日历 ---------- */

.calendar {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

/* 月份标题一行两列,左右翻月按钮绝对定位在两端,不占标题的格子 */
.calendar__head {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  align-items: center;
}

.calendar__title {
  text-align: center;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--ink);
}

.calendar__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-3);
  font-size: 11px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.calendar__nav:first-of-type {
  left: 0;
}

.calendar__nav:last-of-type {
  right: 0;
}

.calendar__nav:hover:not(:disabled) {
  background: var(--bg-inset);
  color: var(--ink);
}

.calendar__nav:disabled {
  opacity: 0.35;
  cursor: default;
}

.calendar__months {
  display: flex;
  gap: var(--sp-3);
}

.month {
  display: flex;
  flex-direction: column;
}

.month__weekdays,
.month__week {
  display: grid;
  grid-template-columns: repeat(7, 28px);
}

.month__weekdays span {
  display: grid;
  place-items: center;
  height: 20px;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* ---------- 日子 ---------- */

.day {
  position: relative;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  cursor: pointer;
}

.day.is-empty {
  cursor: default;
}

/* 快照范围之外(未来,或早于有记录的那天):灰掉但保留位置 */
.day.is-out {
  color: var(--ink-3);
  opacity: 0.45;
  cursor: default;
}

/* 选中区间:底色铺满整格,相邻格子连成一条带子 */
.day.is-band {
  background: var(--bg-inset);
}

/* 两端的实心圆:与趋势里选中的柱子同款,墨色与底色对调,不引入彩色 */
.day.is-edge .day__num {
  background: var(--ink);
  color: var(--bg-surface);
}

.day:not(.is-edge):hover:not(:disabled) .day__num {
  background: var(--border);
}

.day__num {
  position: relative;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
}

/* 今天:数字底下一个小点;落在实心圆里时反过来取底色 */
.day.is-today .day__num::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 1px;
  transform: translateX(-50%);
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--ink-3);
}

.day.is-today.is-edge .day__num::after {
  background: var(--bg-surface);
}
</style>
