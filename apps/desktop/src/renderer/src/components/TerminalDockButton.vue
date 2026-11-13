<script setup lang="ts">
import { ArrowLeft } from '@element-plus/icons-vue'
import { computed, onUnmounted, ref } from 'vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { useTerminalStore } from '@/stores/terminal'

/**
 * 终端收起后那颗悬浮按钮：贴在窗口右缘、可上下拖、点一下展开。
 *
 * 从 `TerminalPanel.vue` 拆出来的整块。落点规则（直接拖动 > 存下来的百分比 > 面板中线）
 * 与拖动判定都收在这里；面板中线由父组件按它自己的高度算好当 `autoTop` 递进来 ——
 * 两边只共享这一个数字，不共享拖动状态。
 *
 * 状态点（`tone`）也由父组件算：它还看不见 Tab 上的点，这里是唯一提示。
 */
const props = defineProps<{
  /** 收起且有终端时才画（Transition 要包着按钮本身，所以 v-if 在组件里面） */
  shown: boolean
  /** 还有命令在跑（run）/ 上次失败（fail）/ 都没有（空串） */
  tone: '' | 'run' | 'fail'
  /** 没拖动过时的纵向落点（百分比）：父组件按面板中线算 */
  autoTop: number
  viewportHeight: number
}>()

const emit = defineEmits<{
  expand: []
}>()

const terminal = useTerminalStore()

const DOCK_SIZE = 34
/** 下边留白：按钮贴到底时与窗口下沿的距离 */
const DOCK_MARGIN = 10
/** 顶栏（标题栏 + 欢迎语）占掉的高度：按钮最多贴到它下面 */
const DOCK_TOP_LIMIT = 100

/** 拖动中的临时位置：只影响渲染，松手才写进设置（与面板高度同一套做法） */
const dragDockTop = ref<number | null>(null)
const dockDragging = computed(() => dragDockTop.value !== null)

/**
 * 当前视口下的上下限（百分比）。
 * 窗口特别矮时两条线可能交叉，此时 clampDockTop 取中间那点，仍保证按钮是够得着的。
 */
const dockRange = computed(() => {
  const height = Math.max(1, props.viewportHeight)
  const half = DOCK_SIZE / 2
  return {
    min: ((DOCK_TOP_LIMIT + half) / height) * 100,
    max: ((height - half - DOCK_MARGIN) / height) * 100,
  }
})

function clampDockTop(percent: number): number {
  const { min, max } = dockRange.value
  return Math.min(Math.max(min, max), Math.max(Math.min(min, max), percent))
}

/** 真正渲染的位置：拖动 > 用户存下来的 > 面板中线，再按当前窗口收一次 */
const renderDockTop = computed(() =>
  clampDockTop(dragDockTop.value ?? terminal.terminalButtonTop ?? props.autoTop),
)

/** 这一次拖动把位置改掉了：松手要落盘 */
let dockMoved = false
/**
 * 刚结束的这一按不算「点击」：只在这一按拖动过、或按 Esc 放弃了时置位。
 * 浏览器在 pointerup 之后还会补一个 click，靠它区分「拖」与「点」——
 * 按下没动过的单击要放行（否则要点第二下才展开）。
 */
let dockSuppressClick = false

let endDockDrag: (() => void) | null = null

function startDockDrag(event: PointerEvent): void {
  if (event.button !== 0)
    return

  // 按住时指针相对按钮中心的偏移：拖动中保持它，按钮才不会在指针底下跳一下
  const height = Math.max(1, props.viewportHeight)
  const grabOffset = event.clientY - (renderDockTop.value / 100) * height
  dockMoved = false
  dockSuppressClick = false
  dragDockTop.value = renderDockTop.value

  endDockDrag = startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: 'is-dragging-terminal-dock',
    onMove: (moveEvent, start) => {
      if (Math.abs(moveEvent.clientY - start.y) > 3) {
        dockMoved = true
        dockSuppressClick = true
      }
      const center = moveEvent.clientY - grabOffset
      dragDockTop.value = clampDockTop((center / Math.max(1, props.viewportHeight)) * 100)
    },
    // last 为 null 只说明这一手没移动过；cancelled 才说明是被放弃的（Esc / 系统接管）
    onEnd: (last, cancelled) => {
      const next = dragDockTop.value
      const moved = dockMoved
      dragDockTop.value = null
      dockMoved = false
      if (moved && last && next !== null)
        void terminal.setTerminalButtonTop(next)
      // 拖动过或放弃过：随后补的那个 click 不算「点开面板」（见 expandFromDock）。
      // 这里不能用「dragDockTop 还没归零」来判断 —— onCleanup 早于 onEnd，
      // 那个条件在每次收手时都成立，单击也就被一起吞掉了。
      if (moved || cancelled)
        dockSuppressClick = true
    },
  })
}

/** 按钮可聚焦：上下方向键微调位置，不必非得拖 */
function nudgeDock(delta: number): void {
  void terminal.setTerminalButtonTop(clampDockTop(renderDockTop.value + delta))
}

/** 点开面板；刚拖完 / 刚按 Esc 的那一下不算点 */
function expandFromDock(): void {
  if (dockSuppressClick) {
    dockSuppressClick = false
    return
  }
  emit('expand')
}

onUnmounted(() => {
  // 拖到一半被切走：window 上的监听要收干净（composable 返回的就是收尾函数）
  endDockDrag?.()
})
</script>

<template>
  <!--
    收起后整块面板收成这一颗按钮。
    Teleport 到 body：它要贴在**窗口**最右侧，不参与页面（内容列 / 首页那几个面板）的布局，
    也就不会被任何一层的定位或裁剪带偏；按住可上下拖，位置落盘（见 packages/appearance/src/terminal-dock.ts）。
  -->
  <Teleport to="body">
    <Transition name="dock">
      <button
        v-if="shown"
        class="dock"
        :class="{ 'is-dragging': dockDragging }"
        type="button"
        :style="{ '--dock-top': `${renderDockTop}vh` }"
        title="展开终端（按住可上下拖动）"
        aria-label="展开终端"
        @pointerdown="startDockDrag"
        @keydown.up.prevent="nudgeDock(-2)"
        @keydown.down.prevent="nudgeDock(2)"
        @click="expandFromDock"
      >
        <el-icon><ArrowLeft /></el-icon>
        <i v-if="tone" class="dock__dot" :class="`tone-${tone}`" />
      </button>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ---------- 收起后的悬浮按钮 ---------- */

/**
 * 收起后整块面板就剩这一颗按钮：贴在**窗口**最右侧（Teleport 到 body，见模板），
 * 纵向位置来自设置（百分比，见 packages/appearance/src/terminal-dock.ts）。
 * 用终端自己的深色底：它是终端面板的一部分，明暗主题下都不跟着变。
 */
.dock {
  position: fixed;
  /* 贴死窗口右缘，只留左边两个圆角：看着像挂在窗口边上的一道把手，而不是页面里的一个浮块 */
  right: 0;
  top: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--term-border);
  border-right: 0;
  border-radius: var(--r-md) 0 0 var(--r-md);
  background: var(--term-bg);
  color: var(--term-ink);
  font-size: 15px;
  box-shadow: var(--shadow-pop);
  cursor: grab;
  /* 垂直位置住在 transform 上：--dock-top 是「按钮中心在窗口高度的百分之几」，模板带 vh 绑进来，
     自身再上移一半 —— 键盘微调与位置恢复的滑动都落在合成器上，不碰布局 */
  transform: translateY(var(--dock-top, 50vh)) translateY(-50%);
  transition: transform 0.16s var(--ease-out), background 0.15s ease, color 0.15s ease;
  touch-action: none;
}

.dock:hover {
  background: var(--term-surface);
  color: #ffffff;
}

/* 拖动中关掉过渡，否则按钮会慢半拍地追着指针跑（与面板上沿同一套） */
.dock.is-dragging {
  cursor: grabbing;
  transition: none;
}

/* 状态点钉在右上角，像一枚角标：收起后它就是「还有命令在跑」的唯一提示 */
.dock__dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--st-run);
}

.dock__dot.tone-run {
  animation: dock-dot-pulse 1.3s ease-in-out infinite;
}

.dock__dot.tone-fail {
  background: var(--st-fail);
}

/*
 * 呼吸用透明度而不是 tab 上那圈 box-shadow：这颗点在按钮的角落里，
 * 放大的光晕会溢到按钮外面去。
 */
@keyframes dock-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dock__dot.tone-run {
    animation: none;
  }
}

/* 按钮从窗口右缘滑出来 / 缩回右缘：与面板那一拍错开，看着像面板收进去之后它才冒头 */
.dock.dock-enter-active {
  transition: transform 0.18s var(--ease-out) 0.14s, opacity 0.16s var(--ease-out) 0.14s;
}

.dock.dock-leave-active {
  transition: transform 0.14s var(--ease-out), opacity 0.12s var(--ease-out);
}

.dock.dock-enter-from,
.dock.dock-leave-to {
  opacity: 0;
  transform: translateY(var(--dock-top, 50vh)) translateY(-50%) translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .dock.dock-enter-active,
  .dock.dock-leave-active {
    transition: none;
  }
}
</style>
