<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowUp, Close, Delete, Download } from '@element-plus/icons-vue'
import {
  TERMINAL_HEIGHT_MIN,
  clampTerminalHeight,
  maxTerminalHeightFor
} from '@shared/terminal-height'
import { useProjectsStore, type TerminalState } from '@/stores/projects'
import type { ProjectStatus } from '@/types'

const store = useProjectsStore()
const bodyRef = ref<HTMLElement | null>(null)

const collapsed = computed({
  get: () => store.terminalCollapsed,
  set: (value: boolean) => (store.terminalCollapsed = value)
})

// ---------- 拖动调整高度 ----------

/** 拖动中的临时高度：只影响渲染，松手才写进设置 */
const dragHeight = ref<number | null>(null)
const resizing = computed(() => dragHeight.value !== null)

/** 展开时的高度：拖动中跟手，其余时间取设置里存的值 */
const panelHeight = computed(() => dragHeight.value ?? store.terminalHeight)

/**
 * 高度上下限：先按硬边界收敛（顺带挡住 NaN 与小数），
 * 再压到当前窗口允许的最大值，保证上面始终留得住项目列表。
 */
const heightLimit = ref(maxTerminalHeightFor(window.innerHeight))

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

let startY = 0
let startHeight = 0

function onPointerMove(event: PointerEvent): void {
  // 指针往上走 = 面板变高，所以是减
  dragHeight.value = clampHeight(startHeight + (startY - event.clientY))
}

function detachResize(): void {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerEnd)
  window.removeEventListener('pointercancel', onPointerEnd)
  window.removeEventListener('keydown', onResizeKeydown)
  document.body.classList.remove('is-resizing-terminal')
}

function onPointerEnd(): void {
  const next = dragHeight.value
  detachResize()
  dragHeight.value = null
  if (next !== null) void store.setTerminalHeight(next)
}

/** 拖动中按 Esc：放弃这次调整，高度回到拖动前 */
function onResizeKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  detachResize()
  dragHeight.value = null
}

function startResize(event: PointerEvent): void {
  if (collapsed.value) return
  event.preventDefault()

  startY = event.clientY
  startHeight = renderHeight.value
  dragHeight.value = startHeight

  // 监听挂在 window 上：指针跑出这条 10px 的把手也还能继续拖
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerEnd)
  window.addEventListener('pointercancel', onPointerEnd)
  window.addEventListener('keydown', onResizeKeydown)
  document.body.classList.add('is-resizing-terminal')
}

/** 把手可聚焦：上下方向键微调，不必非得拖 */
function nudgeHeight(delta: number): void {
  void store.setTerminalHeight(clampHeight(renderHeight.value + delta))
}

/** 窗口尺寸变了：上下限跟着走，渲染高度由 renderHeight 自动收敛 */
function onWindowResize(): void {
  heightLimit.value = maxTerminalHeightFor(window.innerHeight)
}

window.addEventListener('resize', onWindowResize)
onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  detachResize()
})

const tabs = computed(() => store.terminalList)
const active = computed(() => store.activeTerminalState)

/**
 * 单次渲染的行数上限（F-6.11）。
 * 缓冲区仍保留 5000 行（F-6.6），但超过这个数就只把尾部挂到 DOM 上，
 * 否则几千个节点会让滚动明显掉帧——规格允许「虚拟滚动或阈值截断」，这里取截断。
 */
const RENDER_LIMIT = 1000

const toneOf = (s: ProjectStatus): string =>
  s === 'failed' ? 'fail' : s === 'success' ? 'ok' : s === 'idle' ? 'idle' : 'run'

const isRunning = (terminal: TerminalState): boolean =>
  terminal.status === 'running' || terminal.status === 'installing' || terminal.status === 'building'

function projectName(terminal: TerminalState): string {
  return store.findProject(terminal.projectId)?.name ?? '已移除的项目'
}

function closeTerminal(terminal: TerminalState): void {
  store.closeTerminal(terminal.key)
}

const allLines = computed(() => active.value?.logs ?? [])

const omitted = computed(() => Math.max(0, allLines.value.length - RENDER_LIMIT))

const lines = computed(() =>
  omitted.value ? allLines.value.slice(-RENDER_LIMIT) : allLines.value
)

const currentCommand = computed(() => active.value?.currentCommand)

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = bodyRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch([lines, () => store.activeTerminal], scrollToBottom, { deep: true, flush: 'post' })

function clearLogs(): void {
  const target = active.value
  if (target) store.clearTerminalLogs(target.key)
}

function exportLogs(): void {
  const target = active.value
  if (!target) return

  if (!target.logs.length) {
    ElMessage.info('当前没有可导出的日志')
    return
  }

  const text = target.logs.map((line) => `[${line.time}] ${line.text}`).join('\r\n')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${projectName(target)}-${target.label}-${stamp}.log`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <footer
    v-if="tabs.length"
    class="term"
    :class="{ 'is-collapsed': collapsed, 'is-resizing': resizing }"
    :style="{ '--term-h': `${renderHeight}px` }"
  >
    <!-- 上沿的拖拽把手：收起时藏起来（收起高度是固定的） -->
    <div
      v-show="!collapsed"
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
        :title="collapsed ? '展开终端' : '收起终端'"
        @click="collapsed = !collapsed"
      >
        <el-icon class="term__caret">
          <ArrowUp v-if="collapsed" />
          <ArrowDown v-else />
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
          @click="store.activeTerminal = t.key"
          @keydown.enter.prevent="store.activeTerminal = t.key"
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
        <el-tooltip content="导出日志" placement="top" :show-after="400">
          <button class="tool" type="button" aria-label="导出日志" @click="exportLogs">
            <el-icon><Download /></el-icon>
          </button>
        </el-tooltip>
      </div>
    </div>

    <div v-show="!collapsed" ref="bodyRef" class="term__body scroll-dark">
      <template v-if="lines.length">
        <p v-if="omitted" class="line line--sys term__omitted">
          已省略较早的 {{ omitted }} 行（缓冲区保留最近 5000 行，此处只渲染最近 {{ RENDER_LIMIT }} 行）
        </p>
        <div v-for="line in lines" :key="line.id" class="line" :class="`line--${line.stream}`">
          <span class="line__time mono">{{ line.time }}</span>
          <span class="line__text mono">{{ line.text || ' ' }}</span>
        </div>
      </template>
      <p v-else class="term__blank mono">
        {{ active ? '这个终端还没有输出。' : '点击上方标签切换终端。' }}
      </p>
    </div>
  </footer>
</template>

<style scoped>
.term {
  position: relative;
  display: flex;
  flex-direction: column;
  /* 展开高度由拖动决定（--term-h），没拖动过时退回设计令牌里的默认值 */
  height: var(--term-h, var(--h-terminal));
  background: var(--term-bg);
  border-top: 1px solid var(--term-border);
  transition: height 0.18s ease;
}

/* 收起时只留一条面板条：标签与状态点还在，正文藏起来 */
.term.is-collapsed {
  height: var(--h-terminal-collapsed);
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
  height: var(--h-terminal-collapsed);
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--term-border);
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

/* ---------- 日志正文 ---------- */
.term__body {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) var(--sp-3) var(--sp-3);
  line-height: 1.65;
}

.line {
  display: flex;
  gap: var(--sp-3);
  font-size: var(--fs-meta);
}

.line__time {
  flex-shrink: 0;
  color: #4f5a68;
  user-select: none;
}

.line__text {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--term-ink);
}

.line--cmd .line__text {
  color: #ffffff;
  font-weight: 600;
}

.line--cmd .line__text::before {
  content: '› ';
  color: var(--st-run);
}

.line--err .line__text {
  color: #ef7373;
}

.line--sys .line__text {
  color: #7f8c9d;
  font-style: italic;
}

/* 截断提示：横跨整行，不参与「时间 + 正文」的列布局 */
.term__omitted {
  display: block;
  padding-bottom: var(--sp-1);
  font-size: var(--fs-micro);
  color: var(--term-dim);
}

.term__blank {
  font-size: var(--fs-meta);
  color: var(--term-dim);
  padding: var(--sp-2) 0;
}
</style>
