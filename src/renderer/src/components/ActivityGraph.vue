<script setup lang="ts">
/**
 * 首页的活跃度图 —— 完全照 GitHub 贡献图的样子：一列一周、一行一周中的一天、
 * 53 列铺满一年，颜色深浅表示当天执行了多少次命令。
 *
 * 数据来自 store.activity（YYYY-MM-DD → 次数），由主进程在用户点「启动 / 打包」时累加。
 * 只算用户主动发起的启动与打包：安装依赖、自定义命令、停止与失败都不计入 ——
 * 活跃度回答的是「这段时间用得勤不勤」，不是「跑得顺不顺」。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { buildActivityCalendar, monthLabels, type ActivityDay } from '@shared/activity'

const store = useProjectsStore()

/** 横向滚动容器：默认要停在最右，先看到今天 */
const scrollEl = ref<HTMLElement | null>(null)

/**
 * 滚到最右。列的宽度是固定的像素（--cell），不依赖字体加载，
 * 所以挂载后量到的 scrollWidth 就是最终宽度，不用等 resize 再补一次。
 * 横轴末端固定是今天，往后新数据也只是把今天的格子填上，图不会变宽。
 */
function scrollToLatest(): void {
  const el = scrollEl.value
  if (el) el.scrollLeft = el.scrollWidth
}

onMounted(() => void nextTick(scrollToLatest))

/** 一列从上到下是周日到周六，只在周一 / 周三 / 周五标一下（GitHub 的做法） */
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

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
  <article class="panel" style="padding-bottom:0">
    <header class="panel__head">
      <span class="eyebrow">活跃度</span>
      <span class="graph__total mono">过去一年共 {{ calendar.total }} 次执行</span>
    </header>

    <div class="graph">
      <div class="graph__dows" aria-hidden="true">
        <span v-for="(label, i) in WEEKDAY_LABELS" :key="i" class="graph__dow">
          {{ label }}
        </span>
      </div>

      <div ref="scrollEl" class="graph__scroll">
        <div class="graph__months">
          <span v-for="(label, i) in months" :key="i" class="graph__month">{{ label }}</span>
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
  /* 月份标签行的高度 + 下边距，星期列靠它对齐到网格 */
  --months-h: 18px;

  /* 星期标签固定在左，只有网格随滚动条横向滚动 */
  display: flex;
  gap: var(--col-gap);
  /* 卡片被拖矮时图自己竖着滚，不会被卡片裁掉半行 */
  min-height: 0;
  overflow-y: auto;

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

/*
 * 53 列在窄栏里必然横向溢出，滚动能力保留（触摸板 / Shift+滚轮），横杆本身也画出来 ——
 * 窄栏里光看截图分不清「就这么多」和「后面还有」，得有个东西明说这里能拖。
 *
 * 外观走 global.css 里那套：**槽位常占着、滑块平时透明、指针移进来才浮现**。
 * 常占位这一条是必须的 —— 悬停时才让横杆出现，它会占掉 10px，
 * 网格底部（以及整张图的高度）就得跟着往上跳一下；占着位、只换颜色，就没有这一下。
 * 代价是图下方常留一条 10px 的空槽（这张卡片把 .panel 的 padding-bottom 压成了 0，
 * 正好由这条空槽抵着卡片下沿，看不太出来）。
 */
.graph__scroll {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  /* 别写 scrollbar-width: none 之类的标准属性：Chromium 里它比 ::-webkit-scrollbar 优先级高，
     一写就把整条滚动条连同占位一起拿掉，「悬停才浮现」也就无从谈起了 */
}

.graph__months,
.graph__grid {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: var(--cell);
  column-gap: var(--gap);
}

.graph__months {
  margin-bottom: 4px;
  height: calc(var(--months-h) - 4px);
}

.graph__month {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 14px;
  color: var(--ink-3);
  white-space: nowrap;
}

.graph__dows {
  display: grid;
  grid-template-rows: repeat(7, var(--cell));
  row-gap: var(--gap);
  /* 与月份标签行等高对齐，让标签正好落在各自的网格行上 */
  margin-top: var(--months-h);
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

/* ---------- 右上角统计 ---------- */
.graph__total {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}
</style>
