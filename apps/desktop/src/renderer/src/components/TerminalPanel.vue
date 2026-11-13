<script setup lang="ts">
import type { TerminalState } from '@/stores/terminal'
import type { ProjectStatus } from '@/types'
import { ArrowRight, Close, Delete } from '@element-plus/icons-vue'
import { clampTerminalHeight, maxTerminalHeightFor, TERMINAL_HEIGHT_MIN } from '@workbench/appearance'
import { computed, onUnmounted, ref } from 'vue'
import TerminalDockButton from '@/components/TerminalDockButton.vue'
import TerminalLogView from '@/components/TerminalLogView.vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { statusTone } from '@/status'
import { useCatalogStore } from '@/stores/catalog'
import { useProjectsStore } from '@/stores/projects'
import { useTerminalStore } from '@/stores/terminal'

/**
 * 终端面板：贴底的一条可调高度的条（Tab / 工具栏 / 日志）。
 *
 * 两块彼此独立的内容住在同目录的组件里：收起后的悬浮按钮（`TerminalDockButton.vue`）
 * 与日志正文（`TerminalLogView.vue`）。这一层只管面板自己的高度、收起状态与标签。
 */
const store = useProjectsStore()
const terminal = useTerminalStore()
const catalog = useCatalogStore()

const collapsed = computed({
  get: () => terminal.terminalCollapsed,
  set: (value: boolean) => terminal.setTerminalCollapsed(value),
})

// ---------- 拖动调整高度 ----------

/** 拖动中的临时高度：只影响渲染，松手才写进设置 */
const dragHeight = ref<number | null>(null)
const resizing = computed(() => dragHeight.value !== null)

/** 展开时的高度：拖动中跟手，其余时间取设置里存的值 */
const panelHeight = computed(() => dragHeight.value ?? terminal.terminalHeight)

/**
 * 高度上下限：先按硬边界收敛（顺带挡住 NaN 与小数），
 * 再压到当前窗口允许的最大值，保证上面始终留得住项目列表。
 */
const heightLimit = ref(maxTerminalHeightFor(window.innerHeight))

/**
 * 视口高度。
 * 收起后那颗悬浮按钮的上下限按它现算（见 autoDockTop），窗口一变就跟着收敛。
 */
const viewportHeight = ref(window.innerHeight)

/**
 * 真正渲染的高度。
 * 窗口变矮时只临时压低显示，不去改用户存下来的值 —— 窗口再变大，原有高度自己就回来了。
 */
const renderHeight = computed(() => Math.min(panelHeight.value, heightLimit.value))

/** 无障碍属性用的整数高度 */
const ariaHeight = computed(() => Math.round(renderHeight.value))

function clampHeight(px: number): number {
  return Math.min(clampTerminalHeight(px), heightLimit.value)
}

let endResize: (() => void) | null = null

function startResize(event: PointerEvent): void {
  event.preventDefault()

  const startHeight = renderHeight.value
  dragHeight.value = startHeight

  // 起手 / 跟手 / 收手 / Esc 取消都在 composable 里（含解绑 pointercancel 与 body 类）
  endResize = startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: 'is-resizing-terminal',
    // 指针往上走 = 面板变高，所以是减
    onMove: (moveEvent, start) => {
      dragHeight.value = clampHeight(startHeight + (start.y - moveEvent.clientY))
    },
    // Esc / 系统取消：这一手作废，高度回到拖动前，不落盘（last 为 null 只说明没移动过）
    onEnd: (last, cancelled) => {
      const next = dragHeight.value
      dragHeight.value = null
      if (!cancelled && last && next !== null)
        void terminal.setTerminalHeight(next)
    },
  })
}

/** 把手可聚焦：上下方向键微调，不必非得拖 */
function nudgeHeight(delta: number): void {
  void terminal.setTerminalHeight(clampHeight(renderHeight.value + delta))
}

/** 窗口尺寸变了：上下限跟着走，渲染高度由 renderHeight 自动收敛 */
function onWindowResize(): void {
  heightLimit.value = maxTerminalHeightFor(window.innerHeight)
  viewportHeight.value = window.innerHeight
}

window.addEventListener('resize', onWindowResize)

const tabs = computed(() => terminal.terminalList)
const active = computed(() => terminal.activeTerminalState)
const currentCommand = computed(() => active.value?.currentCommand)

/**
 * 选中一个终端。
 * 只切 active：面板条本身只在展开时才在，切换时不必顺带展开。
 */
function selectTab(key: string): void {
  terminal.setActiveTerminal(key)
}

const toneOf = (s: ProjectStatus): string => statusTone(s)

/** 参数名一律避开 `terminal`：那是 store 的名字，遮住了就读不到 store 的成员 */
function isRunning(item: TerminalState): boolean {
  return item.status === 'running' || item.status === 'installing' || item.status === 'building'
}

/** 这个终端属于谁：项目名 / 命令名 / 本机环境 */
function projectName(item: TerminalState): string {
  // 系统终端不属于任何项目，别把它显示成「已移除的项目」
  if (item.kind === 'system')
    return '本机环境'
  // 命令卡片的终端同理：它归属的是一条命令，不是项目
  if (item.kind === 'command') {
    return catalog.findCommand(item.projectId)?.name ?? '已删除的命令'
  }
  return store.findProject(item.projectId)?.name ?? '已移除的项目'
}

function closeTerminal(item: TerminalState): void {
  terminal.closeTerminal(item.key)
}

// ---------- 收起后的悬浮按钮 ----------

/** 面板自己的下外边距（tokens 里的 --sp-2）：算「面板纵向中线」时要用 */
const PANEL_MARGIN = 8

/**
 * 没拖动过时的落点：面板纵向中线换算成百分比。
 * 面板贴底铺开（renderHeight 是它当前的高度），所以中线在窗口偏下的位置，
 * 收起与展开来回切时按钮始终在面板原来那一带。
 */
const autoDockTop = computed(() => {
  const height = Math.max(1, viewportHeight.value)
  const center = height - PANEL_MARGIN - renderHeight.value / 2
  return (center / height) * 100
})

/**
 * 收起后 Tab 上那些状态点就看不见了，往按钮上补一个：
 * 还有命令在跑（黄点，呼吸）或上一次跑失败了（红点）都得看得出来。
 */
const dockTone = computed<'run' | 'fail' | ''>(() => {
  if (tabs.value.some(isRunning))
    return 'run'
  if (tabs.value.some(item => item.status === 'failed'))
    return 'fail'
  return ''
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  // 拖到一半被切走：window 上的监听要收干净（composable 返回的就是收尾函数）
  endResize?.()
})

function clearLogs(): void {
  const target = active.value
  if (target)
    terminal.clearTerminalLogs(target.key)
}
</script>

<template>
  <!-- 收起后整块面板收成窗口右缘那一颗按钮（它自己的组件与拖动状态，见 TerminalDockButton） -->
  <TerminalDockButton
    :shown="tabs.length > 0 && collapsed"
    :tone="dockTone"
    :auto-top="autoDockTop"
    :viewport-height="viewportHeight"
    @expand="collapsed = false"
  />

  <!-- 面板整块向右侧滑出去（滑进窗口右缘那颗按钮里），按钮同时从右缘滑出来 -->
  <Transition name="term-fold">
    <footer
      v-if="tabs.length && !collapsed"
      class="term"
      :class="{ 'is-resizing': resizing }"
      :style="{ '--term-h': `${renderHeight}px` }"
    >
      <!-- 上沿的拖拽把手 -->
      <div
        class="term__resizer"
        :class="{ 'is-active': resizing }"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整终端高度"
        :aria-valuenow="ariaHeight"
        :aria-valuemin="TERMINAL_HEIGHT_MIN"
        :aria-valuemax="heightLimit"
        tabindex="0"
        @pointerdown="startResize"
        @keydown.up.prevent="nudgeHeight(16)"
        @keydown.down.prevent="nudgeHeight(-16)"
      />

      <div class="term__bar">
        <button
          class="term__toggle"
          type="button"
          title="收起终端"
          @click="collapsed = true"
        >
          <el-icon class="term__caret">
            <ArrowRight />
          </el-icon>
          <span class="term__title">终端</span>
        </button>

        <div class="term__tabs">
          <div
            v-for="t in tabs"
            :key="t.key"
            class="tab"
            :class="{ 'is-active': t.key === active?.key }"
            role="tab"
            :aria-selected="t.key === active?.key"
            tabindex="0"
            @click="selectTab(t.key)"
            @keydown.enter.prevent="selectTab(t.key)"
          >
            <i class="tab__dot" :class="`tone-${toneOf(t.status)}`" />
            <span class="tab__name truncate">{{ projectName(t) }} · {{ t.label }}</span>
            <button
              class="tab__close"
              type="button"
              :disabled="isRunning(t)"
              :title="isRunning(t) ? '正在运行，停止后才能关闭' : '关闭这个终端'"
              :aria-label="`关闭 ${projectName(t)} · ${t.label}`"
              @click.stop="closeTerminal(t)"
            >
              <el-icon><Close /></el-icon>
            </button>
          </div>
        </div>

        <div class="term__tools">
          <span v-if="currentCommand" class="term__cmd mono truncate" :title="currentCommand">
            $ {{ currentCommand }}
          </span>
          <el-tooltip content="清空日志" placement="top" :show-after="400">
            <button class="tool" type="button" aria-label="清空日志" @click="clearLogs">
              <el-icon><Delete /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="收起终端" placement="top" :show-after="400">
            <button class="tool" type="button" aria-label="收起终端" @click="collapsed = true">
              <el-icon><ArrowRight /></el-icon>
            </button>
          </el-tooltip>
        </div>
      </div>

      <TerminalLogView />
    </footer>
  </Transition>
</template>

<style scoped>
/* ---------- 收起 / 展开的动效 ---------- */

/*
 * 面板整块横着走：**向右侧滑出去**（滑进窗口右缘那颗按钮里），两拍接续 ——
 * 第一拍是看得见的那一下（向右滑 + 淡出），第二拍才收拢高度、把上面的内容放下来。
 *
 * 为什么高度不能和滑动同时收：面板贴底铺开，高度一收它的上沿就在往下走，
 * 混进来会变成「往下折」的观感（踩过一次）—— 所以让高度在面板已经透明之后才走那一拍。
 * 收缩期间要裁掉溢出的日志，否则日志会从正在变矮的盒子里探出来。
 */
.term.term-fold-leave-active {
  overflow: hidden;
  transform-origin: right center;
  transition: transform 0.18s var(--ease-out), opacity 0.16s var(--ease-out),
    height 0.16s var(--ease-out) 0.18s;
}

.term.term-fold-leave-to {
  transform: translateX(100%);
  opacity: 0;
  height: 0;
}

/* 展开是同一套倒着走：先让高度长出来（上面的内容让位），面板再从右缘滑回来 */
.term.term-fold-enter-active {
  overflow: hidden;
  transform-origin: right center;
  transition: height 0.16s var(--ease-out), transform 0.18s var(--ease-out) 0.16s,
    opacity 0.16s var(--ease-out) 0.16s;
}

.term.term-fold-enter-from {
  transform: translateX(100%);
  opacity: 0;
  height: 0;
}

@media (prefers-reduced-motion: reduce) {
  .term.term-fold-enter-active,
  .term.term-fold-leave-active {
    transition: none;
  }
}

/* ---------- 面板 ---------- */
.term {
  position: relative;
  display: flex;
  flex-direction: column;
  /* 展开高度由拖动决定（--term-h），没拖动过时退回设计令牌里的默认值 */
  height: var(--term-h, var(--h-terminal));
  background: var(--term-bg);
  border-top: 1px solid var(--term-border);
  transition: height 0.18s var(--ease-out);
  border-radius: var(--r-md);
  margin: var(--sp-2);
  margin-top: 0;
}

/* 拖动过程中关掉过渡，否则高度会慢半拍地追着指针跑 */
.term.is-resizing {
  transition: none;
}

/* ---------- 拖拽把手 ---------- */
.term__resizer {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 10px;
  z-index: 3;
  cursor: ns-resize;
  touch-action: none;
}

/* 平时不显形，鼠标贴上来 / 拖动中才画一条线指示边界（保持灰度，不占用状态色） */
.term__resizer::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--ink-3);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.term__resizer:hover::after,
.term__resizer.is-active::after,
.term__resizer:focus-visible::after {
  opacity: 1;
}

.term__resizer:focus-visible {
  outline: none;
}

/* ---------- 工具栏 ---------- */
.term__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--h-terminal-bar);
  flex-shrink: 0;
  padding: 0 var(--sp-3);
}

.term__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--term-dim);
  font-size: var(--fs-meta);
  cursor: pointer;
}

.term__toggle:hover {
  background: var(--term-surface);
  color: var(--term-ink);
}

.term__caret {
  font-size: 11px;
}

.term__title {
  font-weight: 500;
}

/* ---------- 标签页 ---------- */
.term__tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.term__tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  max-width: 230px;
  height: 26px;
  padding: 0 4px 0 8px;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--term-dim);
  font-size: var(--fs-meta);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.tab:hover {
  background: var(--term-surface);
  color: var(--term-ink);
}

.tab.is-active {
  background: var(--term-surface);
  color: #e8edf4;
}

.tab__name {
  min-width: 0;
}

/* 关闭键平时收起，鼠标停在标签上才展开 */
.tab__close {
  display: grid;
  place-items: center;
  width: 0;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 11px;
  overflow: hidden;
  opacity: 0;
  cursor: pointer;
  transition: width 0.14s ease, opacity 0.14s ease, background 0.14s ease;
}

.tab:hover .tab__close,
.tab.is-active .tab__close {
  width: 18px;
  opacity: 0.75;
}

.tab__close:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
  opacity: 1;
}

.tab__close:disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.tab__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #4a5462;
}

.tab__dot.tone-run {
  background: var(--st-run);
  box-shadow: 0 0 0 3px rgba(199, 127, 10, 0.18);
  /* 命令还在跑：点呼吸一下，比一个静止的点更能说明「正在进行」 */
  animation: dot-pulse 1.3s ease-in-out infinite;
}

@keyframes dot-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 3px rgba(199, 127, 10, 0.18);
  }

  50% {
    box-shadow: 0 0 0 6px rgba(199, 127, 10, 0.06);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tab__dot.tone-run {
    animation: none;
  }
}

.tab__dot.tone-ok {
  background: var(--st-ok);
}

.tab__dot.tone-fail {
  background: var(--st-fail);
}

/* ---------- 右侧工具 ---------- */
.term__tools {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-left: auto;
  flex-shrink: 0;
  min-width: 0;
}

.term__cmd {
  max-width: 320px;
  margin-right: var(--sp-2);
  font-size: var(--fs-micro);
  color: var(--term-dim);
  text-align: right;
}

.tool {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--term-dim);
  cursor: pointer;
  font-size: 13px;
}

.tool:hover {
  background: var(--term-surface);
  color: var(--term-ink);
}
</style>
