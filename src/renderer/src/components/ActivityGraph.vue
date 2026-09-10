<script setup lang="ts">
/**
 * 首页的活跃度图 —— 完全照 GitHub 贡献图的样子：一列一周、一行一周中的一天、
 * 53 列铺满一年，颜色深浅表示当天执行了多少次命令。
 *
 * 数据来自 store.activity（YYYY-MM-DD → 次数），由主进程在每条命令结束时累加。
 * 只画次数不画成败：活跃度回答的是「这段时间用得勤不勤」，不是「跑得顺不顺」。
 */
import { computed } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { buildActivityCalendar, monthLabels, type ActivityDay } from '@shared/activity'

const store = useProjectsStore()

/** 一列从上到下是周日到周六，只在周一 / 周三 / 周五标一下（GitHub 的做法） */
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

const LEVELS = [0, 1, 2, 3, 4]

/**
 * 横轴末端是今天，所以拿 store.dayStart（今天 00:00，跨天变一次）当基准 ——
 * 用每秒跳的 clock 的话，371 个格子会被每秒重铺一遍。
 */
const calendar = computed(() => buildActivityCalendar(store.activity, store.dayStart))
const months = computed(() => monthLabels(calendar.value.weeks))

function tipOf(day: ActivityDay): string {
  if (day.future) return ''
  const [year, month, date] = day.date.split('-')
  const label = `${year}年${Number(month)}月${Number(date)}日`
  return day.count ? `${label} · ${day.count} 次执行` : `${label} · 无执行`
}

</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <span class="eyebrow">活跃度</span>
      <span class="graph__total mono">过去一年共 {{ calendar.total }} 次执行</span>
    </header>

    <div class="graph">
      <div class="graph__scroll scroll-dark">
        <div class="graph__months">
          <span v-for="(label, i) in months" :key="i" class="graph__month">{{ label }}</span>
        </div>

        <div class="graph__body">
          <div class="graph__dows" aria-hidden="true">
            <span v-for="(label, i) in WEEKDAY_LABELS" :key="i" class="graph__dow">
              {{ label }}
            </span>
          </div>

          <div
            class="graph__grid"
            role="img"
            :aria-label="`过去一年共 ${calendar.total} 次命令执行`"
          >
            <div v-for="(week, wi) in calendar.weeks" :key="wi" class="graph__week">
              <i
                v-for="day in week.days"
                :key="day.date"
                class="cell"
                :class="[`is-${day.level}`, { 'is-future': day.future }]"
                :title="tipOf(day)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="graph__foot">
      <div class="legend">
        <span class="legend__word">少</span>
        <i v-for="level in LEVELS" :key="level" class="cell" :class="`is-${level}`" />
        <span class="legend__word">多</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.graph {
  /* 一格的边长与间隙：12px × 53 列 ≈ 636px，窄窗口时下面横向滚动 */
  --cell: 10px;
  --gap: 2px;
  --col-gap: 5px;
  /* 星期标签列的宽度：要放得下 Mon / Wed / Fri 三个字母 */
  --dow-w: 26px;

  /**
   * 深浅五档，纯黑到浅灰。
   * 图里的颜色只表达「多与少」，不表达运行状态，所以不上绿色那套状态色——
   * 最深一档就是 --ink 本身，浅色主题下往黑走、暗色主题下反过来往白走。
   */
  --lv-0: var(--bg-inset);
  --lv-1: #ced3da;
  --lv-2: #9aa1ab;
  --lv-3: #5c6472;
  --lv-4: var(--ink);
}

:root[data-theme='dark'] .graph {
  --lv-1: #3d4550;
  --lv-2: #5a6472;
  --lv-3: #8b96a5;
}

/* 网格整体左对齐：内容宽度不够一整行时不要被拉散 */
.graph__scroll {
  overflow-x: auto;
  padding-bottom: 2px;
}

.graph__months,
.graph__grid {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: var(--cell);
  column-gap: var(--gap);
}

.graph__months {
  /* 让开星期标签那一列，月份才和各自的列对齐 */
  margin-left: calc(var(--dow-w) + var(--col-gap));
  margin-bottom: 4px;
  height: 14px;
}

.graph__month {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 14px;
  color: var(--ink-3);
  white-space: nowrap;
}

.graph__body {
  display: flex;
  gap: var(--col-gap);
}

.graph__dows {
  display: grid;
  grid-template-rows: repeat(7, var(--cell));
  row-gap: var(--gap);
  flex-shrink: 0;
  width: var(--dow-w);
}

.graph__dow {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--cell);
  text-align: right;
  color: var(--ink-3);
  white-space: nowrap;
}

.graph__week {
  display: grid;
  grid-template-rows: repeat(7, var(--cell));
  row-gap: var(--gap);
}

.cell {
  width: var(--cell);
  height: var(--cell);
  border-radius: 2px;
  background: var(--lv-0);
}

.cell.is-1 {
  background: var(--lv-1);
}

.cell.is-2 {
  background: var(--lv-2);
}

.cell.is-3 {
  background: var(--lv-3);
}

.cell.is-4 {
  background: var(--lv-4);
}

/* 未来日期只占位：留着它最后一列才是完整的七个格 */
.cell.is-future {
  background: transparent;
}

/* ---------- 上下两条说明 ---------- */
.graph__total {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.graph__foot {
  display: flex;
  justify-content: flex-end;
  min-width: 0;
}

.legend {
  display: inline-flex;
  align-items: center;
  gap: var(--gap);
  flex-shrink: 0;
}

.legend__word {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}
</style>
