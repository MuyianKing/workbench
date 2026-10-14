<script setup lang="ts">
/**
 * 悬浮球：桌面上随便摆的一颗网速球，拖到屏幕左右那条边才收成一条竖流量条。
 *
 * 这个窗口是独立的 JS 上下文（见 float-ball.md）：只装适配层，不装 store、不 initState。
 * 窗口的尺寸与位置全在 Rust 侧（ball.rs），这里只做三件事：
 *
 *  一，每秒问一次 `net_counters`，用 `@workbench/net-meter` 把累计字节算成速率与显示值；
 *  二，鼠标进出时告诉 Rust 收起 / 展开 —— 意图（含防抖）在这一侧，窗口操作在 Rust 那一侧；
 *      **浮在桌面上的球不收**（收起是「贴边」的形态），Rust 那边再拦一道；
 *  三，整块标 `data-tauri-drag-region="deep"` 把拖动交给系统（Rust 在 Moved / Resized 里把
 *      两个方向都夹进工作区，松手后判贴没贴边 —— 拖到哪就停在哪儿，不吸附）。
 *      **必须是 `deep`（整棵子树）**：裸属性只认「正好按在带属性的那个元素上」，
 *      球中间的数字、单位与刻度线都是子元素，按在那儿起不了拖动 —— 现象是「球抓不住、
 *      只能摸到某几处才拖得动」。球里没有一个可点元素（没有 a / button / tabindex），
 *      deep 不会顺手把别的交互吃掉。
 *
 * 尺寸单位一律用 vmin / vh / vw：窗口本身就是视口，而窗口尺寸（6×48 / 76×76 逻辑像素）
 * 由 Rust 按 DPI 设 —— 用百分比或 v* 单位，缩放屏上就自动跟着对。
 */
import type { BallSide, NetCounters, NetRate } from '@workbench/net-meter'
import {
  directionShare,
  formatSpeed,
  isBusy,
  linkRatio,
  rateOf,
  SAMPLE_INTERVAL_MS,
  smoothRate,
  tickMarks,
  totalRate,
} from '@workbench/net-meter'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/** 鼠标移开多久之后收起 */
const COLLAPSE_DELAY_MS = 1500
/**
 * 刚展开这一小段里收到的 mouseleave 不作数。
 *
 * 展开是「窗口长大 + 往屏内挪」同时发生的：窗口刚挪完，指针可能正好落在球外面，
 * 于是立刻收到一个 mouseleave —— 不设这条就会「展开→收回→再展开」来回抖。
 */
const OPEN_GUARD_MS = 600

/**
 * 形状与位置都以 Rust 那边为准，而它是异步取回来的。
 *
 * **拿到之前什么都不画**：一上来 `open` 还是 false，可窗口很可能已经是 76 见方的展开态
 * （浮在桌面上的球就是），那一帧会照收起态画成一条拉满窗口的竖条（一个怪圆饼）。
 * 窗口本来透明，空白一帧比画错一帧干净。
 */
const ready = ref(false)
/** 贴着屏幕哪一侧；null = 浮在桌面上（这时鼠标移开也不收，见 onLeave） */
const side = ref<BallSide | null>(null)
const open = ref(false)
const rate = ref<NetRate>({ down: 0, up: 0 })
const link = ref({ down: 0, up: 0 })

/** 上一次的原始计数与时刻：速率靠两次的差算，不假设正好间隔一秒 */
let previous: NetCounters | null = null
let lastAt = 0
let sampleTimer = 0
let collapseTimer = 0
let openedAt = 0
/**
 * 上一次真的推给 Rust 的意图。
 *
 * 「还要不要再推一次」拿它判，不拿 `open`：`open` 是**窗口的实际状态**，而展开 / 收起
 * 各自要走一趟 IPC —— 收起还在路上时指针又移回球上，用 `open` 判就会把那次展开吞掉
 * （窗口停在收起那一档、指针却明明在球上，得先把指针挪开再回来才好）。
 * 每次拿到回包（同步 / 推完）都拿实际状态对齐一遍：Rust 会自己改这一档（松手贴边就收起），
 * 不同步的话下次 hover 正好撞上那条判重，窗口明明收着、指针移上去却没反应。
 */
let requested: boolean | null = null

const downParts = computed(() => formatSpeed(rate.value.down))
const upParts = computed(() => formatSpeed(rate.value.up))
/**
 * 整条链路当作一条管子：分母取上下行里大的那条（同一块网卡两者一般相等）。
 * 刻度环亮多少格 = 上下行合计占这条管子的比例；点亮的那一段里靠前的是下行的份。
 */
const pipe = computed(() => Math.max(link.value.down, link.value.up))
const ticks = computed(() => tickMarks(
  linkRatio(totalRate(rate.value), pipe.value),
  directionShare(rate.value).down,
))
const busy = computed(() => isBusy(rate.value))
/** 收起态那条竖条：总高 = 总吞吐占链路带宽的比例 */
const barPercent = computed(() => {
  const ratio = linkRatio(totalRate(rate.value), pipe.value)
  return `${Math.round((ratio ?? 0) * 100)}%`
})
/** 竖条上绿橙的分界：下行的份 */
const barSplit = computed(() => `${(directionShare(rate.value).down * 100).toFixed(1)}%`)

async function sample(): Promise<void> {
  const result = await window.workbench.netCounters()
  if (!result.ok || !result.data)
    return

  const now = Date.now()
  const elapsed = now - lastAt
  const next = rateOf(previous, result.data, elapsed)
  previous = result.data
  lastAt = now
  link.value = { down: result.data.downLink, up: result.data.upLink }

  // 第一帧、以及间隔不合理（被节流 / 挂起）的那一帧都不更新读数：
  // 保留上一次的数，而不是把「五分钟的平均值」当成一个瞬时速度
  if (next)
    rate.value = smoothRate(rate.value, next)
}

async function applyOpen(next: boolean): Promise<void> {
  // 拿「上一次推的意图」判重（见 requested 的说明）：换成拿 `open` 判会吞掉在途的那次反向意图
  if (requested === next)
    return
  requested = next
  const result = await window.workbench.ballOpen(next)
  if (!result.ok || !result.data) {
    // 没推成：把意图放开，下次进出还能再试一遍（不放开就再也不推了）
    requested = null
    return
  }
  open.value = result.data.open
  side.value = result.data.side
  // 推完以**实际状态**为准：Rust 可能没照办（浮着的球不收，见 onLeave）、也可能自己改过
  // （松手落到边上会自动收起，见 ball.rs 的 settle_drop）—— 记错了下一次进出就被判重吞掉
  requested = result.data.open
  if (result.data.open)
    openedAt = Date.now()
}

function onEnter(): void {
  window.clearTimeout(collapseTimer)
  void applyOpen(true)
}

function onLeave(): void {
  // **浮着的不收**：收起是「贴边」的形态 —— 屏幕中间摆着的一条 6×48 竖条既不像东西、
  // 也没地方可贴。只有贴着左右边的球才按延迟收回去（Rust 那边也拦一道）
  if (!side.value)
    return
  window.clearTimeout(collapseTimer)
  const sinceOpen = Date.now() - openedAt
  const delay = sinceOpen < OPEN_GUARD_MS
    ? OPEN_GUARD_MS - sinceOpen + COLLAPSE_DELAY_MS
    : COLLAPSE_DELAY_MS
  collapseTimer = window.setTimeout(() => void applyOpen(false), delay)
}

/** 双击把主界面唤出来（球本身是常驻的，主窗口可能收在托盘里） */
function openMain(): void {
  void window.workbench.ballOpenMain()
}

/**
 * 从 Rust 那边把状态读回来。
 *
 * 画哪一副样子（贴边的竖条还是整颗球）**以窗口的实际状态为准**，不是以本地那个 ref 为准：
 * 窗口尺寸是 Rust 设的，本地这份只是个镜像 —— 挂在 resize 上再读一次，
 * 任何不是这条 hover 路径改出来的变化（松手贴边自动收起 / 摊开、改尺寸、以后加别的入口）
 * 都能自动跟上。
 */
async function syncContext(): Promise<void> {
  const result = await window.workbench.ballContext()
  if (result.ok && result.data) {
    side.value = result.data.side
    open.value = result.data.open
    requested = result.data.open
  }
  // 取不到也放行：宁可先画成收起态，也别让窗口一直空着（取不到就已经有别的问题了）
  ready.value = true
}

onMounted(async () => {
  await syncContext()
  await sample()
  sampleTimer = window.setInterval(() => void sample(), SAMPLE_INTERVAL_MS)
  // 收起 / 展开就是一次窗口 resize：跟着它把状态对齐
  window.addEventListener('resize', onResize)
})

function onResize(): void {
  void syncContext()
}

onBeforeUnmount(() => {
  window.clearInterval(sampleTimer)
  window.clearTimeout(collapseTimer)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <!-- 形状还没从 Rust 取回来之前什么都不画（见 ready 的说明） -->
  <div
    v-if="ready"
    class="ball"
    :class="[open ? 'ball--open' : 'ball--tucked', { 'is-busy': busy }]"
    data-tauri-drag-region="deep"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @dblclick="openMain"
  >
    <!-- 收起：贴着屏幕边的一条双色竖流量条（窗口就是它本身） -->
    <div v-if="!open" class="tab">
      <span class="tab__bar">
        <span
          class="tab__fill"
          :style="{ 'height': barPercent, '--split': barSplit }"
        />
      </span>
    </div>

    <!-- 展开：整颗刻度环球（一圈 48 格，亮起的那一段前半是下行、后半是上行） -->
    <template v-else>
      <svg class="dial" viewBox="0 0 76 76" aria-hidden="true">
        <line
          v-for="(tick, index) in ticks"
          :key="index"
          class="tick"
          :class="`tick--${tick.state}`"
          :x1="tick.x1"
          :y1="tick.y1"
          :x2="tick.x2"
          :y2="tick.y2"
        />
      </svg>
      <span class="hub">
        <span class="hub__hero">
          <span class="hub__arrow hub__arrow--down">↓</span>
          <span class="hub__value">{{ downParts.value }}</span>
          <span class="hub__unit">{{ downParts.unit }}</span>
        </span>
        <span class="hub__sub">
          <span class="hub__arrow hub__arrow--up">↑</span>
          <span class="hub__value">{{ upParts.value }}</span>
          <span class="hub__unit">{{ upParts.unit }}</span>
        </span>
      </span>
    </template>
  </div>
</template>

<style scoped>
/* 窗口本身就是视口：底必须真透明（窗口是 transparent 的，压一层底色就把桌面挡掉了） */
.ball {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  background: transparent;
  font-family: var(--font-mono);
}

/*
  展开态是**一整颗玻璃球**：刻度环画在这层玻璃上，不是飘在桌面上。
  没有这层底的话，未点亮的那几十格（8% 白）压在浅色桌面上等于没有，
  整圈看着只剩亮起来的一段 —— 设计稿里那圈「暗刻度」就是这么来的。

  **外面那圈投影只能不要**：窗口就是这 76×76，而投影（模糊 22、下移 10）一定画到窗口外面去，
  系统会把多出来的部分齐着窗口边切掉 —— 落在桌面上就是一个「中间圆、四边直的灰方块」，
  四个角尤其明显。球填满窗口时没有哪种投影能不越界，所以这层深度只留内侧高光。
*/
.ball--open {
  border-radius: 50%;
  background:
    radial-gradient(118% 118% at 28% -8%, rgb(92 108 130 / 55%), rgb(24 30 38 / 96%) 58%),
    #151a22;
  border: 1px solid rgb(255 255 255 / 5.5%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 9%);
}

/* ---------- 收起：就一条竖流量条 ---------- */

/*
  收起态**只有那条竖条**：外面没有半圆底、没有边框、没有阴影（窗口尺寸就是它的尺寸，
  多出来的透明区域会把桌面上的点击吃掉）。所以「底」这一层只负责排版与拖动。
*/
.tab {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
}

.tab__bar {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  align-items: flex-end;
  justify-content: center;
  overflow: hidden;
  border-radius: 999px;
  /* 轨道得自己够实：没有半圆底之后，9% 白压在浅色桌面上等于没有 */
  background: rgb(21 26 34 / 92%);
  border: 1px solid rgb(255 255 255 / 8%);
}

.tab__fill {
  width: 100%;
  border-radius: 999px;
  /* 绿是下行的份、橙是上行的份，分界由 --split 给（见 script 里的 barSplit） */
  background: linear-gradient(
    180deg,
    var(--st-ok) 0 var(--split, 60%),
    var(--st-run) var(--split, 60%) 100%
  );
  transition: height 0.9s linear;
}

/* 静止：条退成一条中性色，球看起来是「睡着了」而不是还在报 0 */
.ball:not(.is-busy) .tab__fill {
  background: rgb(255 255 255 / 16%);
}

/* ---------- 展开：刻度环 ---------- */

.dial {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* 刻度粗细与半径都在 dial.ts 里定（viewBox 是 76，窗口也就是 76 逻辑像素，1:1） */
.tick {
  stroke: rgb(255 255 255 / 8%);
  stroke-width: 1.7;
  stroke-linecap: round;
}

.tick--down {
  stroke: var(--st-ok);
}

.tick--up {
  stroke: var(--st-run);
}

/* 静止：亮的格全退成暗轨道（刻度本身本来就不亮），数字一起降级 */
.ball:not(.is-busy) .tick--down,
.ball:not(.is-busy) .tick--up {
  stroke: rgb(255 255 255 / 8%);
}

/* 中心那颗抬起来的钮：两层高差是这套设计的主心骨（见 float-ball.md） */
.hub {
  position: relative;
  display: flex;
  box-sizing: border-box;
  width: 62%;
  height: 62%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(180deg, #2a3340 0%, #1a212a 58%, #151a22 100%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 8%),
    inset 0 -1px 0 rgb(0 0 0 / 45%),
    0 2px 5px rgb(0 0 0 / 50%);
  letter-spacing: -0.02em;
}

.hub__hero,
.hub__sub {
  display: flex;
  align-items: baseline;
  white-space: nowrap;
}

/* 字号按 vmin：窗口 76 见方，20vmin = 15.2px（设计稿的 15.5 是 76 的 0.2 倍） */
.hub__hero {
  color: var(--ink);
  font-size: 20vmin;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.hub__sub {
  margin-top: 2.4vmin;
  color: var(--ink-3);
  font-size: 14.3vmin;
  font-variant-numeric: tabular-nums;
}

/* 单位缩到 0.72 倍、降到 62% 不透明度：主角是数值，单位只是一句备注 */
.hub__unit {
  margin-left: 1.1vmin;
  opacity: 0.62;
}

.hub__arrow {
  margin-right: 3vmin;
  font-size: 14.3vmin;
}

.hub__arrow--down {
  color: var(--st-ok);
}

.hub__arrow--up {
  color: var(--st-run);
  opacity: 0.9;
}

/* 静止时数字一起降级 */
.ball:not(.is-busy) .hub__hero {
  color: var(--ink-3);
}

.ball:not(.is-busy) .hub__arrow {
  color: var(--ink-3);
}

@media (prefers-reduced-motion: reduce) {
  .tab__fill {
    transition: none;
  }
}
</style>
