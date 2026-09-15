<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowLeft, ArrowRight, Close, Delete } from '@element-plus/icons-vue'
import {
  TERMINAL_HEIGHT_MIN,
  clampTerminalHeight,
  maxTerminalHeightFor
} from '@shared/terminal-height'
import { isPinnedToBottom } from '@shared/log-scroll'
import { splitLinks, type LinkSegment } from '@shared/linkify'
import { statusTone } from '@/status'
import { useProjectsStore, type TerminalState } from '@/stores/projects'
import type { LogLine, ProjectStatus } from '@/types'

const store = useProjectsStore()
const bodyRef = ref<HTMLElement | null>(null)

const collapsed = computed({
  get: () => store.terminalCollapsed,
  set: (value: boolean) => store.setTerminalCollapsed(value)
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
 * 视口高度。
 * 收起后那颗悬浮按钮的上下限按它现算（见下面的 dockRange），窗口一变就跟着收敛。
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
  viewportHeight.value = window.innerHeight
}

window.addEventListener('resize', onWindowResize)

const tabs = computed(() => store.terminalList)
const active = computed(() => store.activeTerminalState)

/**
 * 选中一个终端。
 * 只切 active：面板条本身只在展开时才在，切换时不必顺带展开。
 */
function selectTab(key: string): void {
  store.setActiveTerminal(key)
}

/**
 * 单次渲染的行数上限（F-6.11）。
 * 缓冲区仍保留 5000 行（F-6.6），但超过这个数就只把尾部挂到 DOM 上。
 * 规格允许「虚拟滚动或阈值截断」，这里取截断 —— 但只截断还不够，
 * 见下面 CHUNK_SIZE 的分块说明。
 */
const RENDER_LIMIT = 1000

/**
 * 渲染分块大小。
 *
 * 1000 行一次性 patch 依然会让滚动掉帧，所以在截断之上再分块：
 * 每块套一个 `content-visibility: auto` 的容器，屏幕外的块浏览器直接跳过
 * 布局与绘制。这样既不用自己实现虚拟滚动的定位与高度测量，
 * 又能把一帧的渲染量压到「可见的那几块」。
 */
const CHUNK_SIZE = 100

const toneOf = (s: ProjectStatus): string => statusTone(s)

const isRunning = (terminal: TerminalState): boolean =>
  terminal.status === 'running' || terminal.status === 'installing' || terminal.status === 'building'

function projectName(terminal: TerminalState): string {
  // 系统终端不属于任何项目，别把它显示成「已移除的项目」
  if (terminal.kind === 'system') return '本机环境'
  // 命令卡片的终端同理：它归属的是一条命令，不是项目
  if (terminal.kind === 'command') {
    return store.findCommand(terminal.projectId)?.name ?? '已删除的命令'
  }
  return store.findProject(terminal.projectId)?.name ?? '已移除的项目'
}

function closeTerminal(terminal: TerminalState): void {
  store.closeTerminal(terminal.key)
}

// ---------- 收起后的悬浮按钮 ----------

/**
 * 收起不是把面板压矮，而是整块收成窗口最右侧这一颗按钮（Teleport 到 body，
 * 与页面布局无关；面板则折回它原来的位置，见模板上的两个 Transition）。
 *
 * 位置：没拖动过时落在**终端面板自己的纵向中线**上 —— 收起看着才像面板收进了这颗按钮，
 * 而不是凭空飘到屏幕中间去；拖动过就以存下来的百分比为准（shared/terminal-dock.ts）。
 */
const DOCK_SIZE = 34

/** 下边留白：按钮贴到底时与窗口下沿的距离 */
const DOCK_MARGIN = 10

/** 面板自己的下外边距（tokens 里的 --sp-2）：算「面板纵向中线」时要用 */
const PANEL_MARGIN = 8

/** 顶栏（标题栏 + 搜索栏）占掉的高度：按钮最多贴到它下面 */
const DOCK_TOP_LIMIT = 100

/** 拖动中的临时位置：只影响渲染，松手才写进设置（与面板高度同一套做法） */
const dragDockTop = ref<number | null>(null)
const dockDragging = computed(() => dragDockTop.value !== null)

/**
 * 当前视口下的上下限（百分比）。
 * 窗口特别矮时两条线可能交叉，此时 clampDockTop 取中间那点，仍保证按钮是够得着的。
 */
const dockRange = computed(() => {
  const height = Math.max(1, viewportHeight.value)
  const half = DOCK_SIZE / 2
  return {
    min: ((DOCK_TOP_LIMIT + half) / height) * 100,
    max: ((height - half - DOCK_MARGIN) / height) * 100
  }
})

function clampDockTop(percent: number): number {
  const { min, max } = dockRange.value
  return Math.min(Math.max(min, max), Math.max(Math.min(min, max), percent))
}

/**
 * 没拖动过时的落点：面板纵向中线换算成百分比。
 * 面板贴底铺开（renderHeight 是它当前的高度），所以中线在窗口偏下的位置，
 * 收起与展开来回切时按钮始终在面板原来那一带。
 */
const autoDockTop = computed(() => {
  const height = Math.max(1, viewportHeight.value)
  const center = height - PANEL_MARGIN - renderHeight.value / 2
  return clampDockTop((center / height) * 100)
})

/** 真正渲染的位置：拖动 > 用户存下来的 > 面板中线，再按当前窗口收一次 */
const renderDockTop = computed(() =>
  clampDockTop(dragDockTop.value ?? store.terminalButtonTop ?? autoDockTop.value)
)

/**
 * 收起后 Tab 上那些状态点就看不见了，往按钮上补一个：
 * 还有命令在跑（黄点，呼吸）或上一次跑失败了（红点）都得看得出来。
 */
const dockTone = computed(() => {
  if (tabs.value.some(isRunning)) return 'run'
  if (tabs.value.some((terminal) => terminal.status === 'failed')) return 'fail'
  return ''
})

/** 按住时指针相对按钮中心的偏移：拖动中保持它，按钮才不会在指针底下跳一下 */
let dockGrabOffset = 0
let dockStartY = 0
/** 这一次拖动把位置改掉了：松手要落盘 */
let dockMoved = false
/**
 * 刚结束的这一按不算「点击」（拖动过，或按 Esc 取消了）。
 * 浏览器在 pointerup 之后还会补一个 click，靠它区分「拖」与「点」。
 */
let dockSuppressClick = false

function onDockMove(event: PointerEvent): void {
  if (Math.abs(event.clientY - dockStartY) > 3) {
    dockMoved = true
    dockSuppressClick = true
  }
  const center = event.clientY - dockGrabOffset
  dragDockTop.value = clampDockTop((center / Math.max(1, viewportHeight.value)) * 100)
}

function detachDockDrag(): void {
  window.removeEventListener('pointermove', onDockMove)
  window.removeEventListener('pointerup', onDockEnd)
  window.removeEventListener('pointercancel', onDockEnd)
  window.removeEventListener('keydown', onDockKeydown)
  document.body.classList.remove('is-dragging-terminal-dock')
}

function onDockEnd(): void {
  const next = dragDockTop.value
  const moved = dockMoved
  detachDockDrag()
  dragDockTop.value = null
  dockMoved = false
  if (moved && next !== null) void store.setTerminalButtonTop(next)
}

/** 拖动中按 Esc：放弃这次调整，按钮回到拖动前的位置，也不算点击 */
function onDockKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  dockSuppressClick = true
  dockMoved = false
  detachDockDrag()
  dragDockTop.value = null
}

function startDockDrag(event: PointerEvent): void {
  if (event.button !== 0) return

  const height = Math.max(1, viewportHeight.value)
  dockStartY = event.clientY
  dockGrabOffset = event.clientY - (renderDockTop.value / 100) * height
  dockMoved = false
  dockSuppressClick = false
  dragDockTop.value = renderDockTop.value

  // 监听挂在 window 上：指针挪出这颗 34px 的按钮也还能继续拖（与面板上沿的把手同一套）
  window.addEventListener('pointermove', onDockMove)
  window.addEventListener('pointerup', onDockEnd)
  window.addEventListener('pointercancel', onDockEnd)
  window.addEventListener('keydown', onDockKeydown)
  document.body.classList.add('is-dragging-terminal-dock')
}

/** 按钮可聚焦：上下方向键微调位置，不必非得拖 */
function nudgeDock(delta: number): void {
  void store.setTerminalButtonTop(clampDockTop(renderDockTop.value + delta))
}

/** 点开面板；刚拖完 / 刚按 Esc 的那一下不算点 */
function expandFromDock(): void {
  if (dockSuppressClick) {
    dockSuppressClick = false
    return
  }
  collapsed.value = false
}

/**
 * 日志快照。用 store.activeLogs 而不是 active.logs：
 * 缓冲是环形且 markRaw 的，store 那个 computed 会跟着 logVersion 更新，
 * 这里只负责截断到渲染上限。
 */
const allLines = computed<LogLine[]>(() => store.activeLogs)

const omitted = computed(() => Math.max(0, allLines.value.length - RENDER_LIMIT))

const lines = computed(() =>
  omitted.value ? allLines.value.slice(-RENDER_LIMIT) : allLines.value
)

const chunks = computed(() => {
  const list = lines.value
  const out: LogLine[][] = []
  for (let i = 0; i < list.length; i += CHUNK_SIZE) {
    out.push(list.slice(i, i + CHUNK_SIZE))
  }
  return out
})

const currentCommand = computed(() => active.value?.currentCommand)

// ---------- 日志里的地址 ----------

/**
 * 行文本 -> 切分结果。
 *
 * 日志只追加不改写，同一行不会变，所以按文本缓存：刷屏时只有新行需要重新扫描。
 * 缓冲区上限 5000 行，缓存跟着这个量级封顶，超了整体丢掉重新攒。
 */
const linkCache = new Map<string, LinkSegment[]>()

function segmentsOf(text: string): LinkSegment[] {
  const cached = linkCache.get(text)
  if (cached) return cached

  const segments = splitLinks(text)
  if (linkCache.size >= 4096) linkCache.clear()
  linkCache.set(text, segments)
  return segments
}

/**
 * 是否按住了 Ctrl。
 *
 * 只用来画「可点」的样式（下划线 + 手型）——按住才显形，和 Ctrl + 单击对得上；
 * 真正能不能开还是看点击事件里的 ctrlKey，不依赖这个状态。
 */
const ctrlHeld = ref(false)

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Control') ctrlHeld.value = true
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key === 'Control') ctrlHeld.value = false
}

/** 切走窗口时收不到 keyup，回来别停在「按住」的样子 */
function onWindowBlur(): void {
  ctrlHeld.value = false
}

window.addEventListener('keydown', onKeyDown)
window.addEventListener('keyup', onKeyUp)
window.addEventListener('blur', onWindowBlur)

/** Ctrl + 单击：把地址交给系统默认浏览器 */
async function openLink(event: MouseEvent, url: string): Promise<void> {
  if (!event.ctrlKey) return
  const result = await window.workbench.openExternal(url)
  if (!result.ok) ElMessage.warning(result.error)
}

// ---------- 自动滚动：只在用户贴底时跟随 ----------

/**
 * 用户是否停在底部。
 *
 * 原实现每帧无条件 `scrollTop = scrollHeight`，有两个毛病：
 * 一是每帧读 scrollHeight 就是一次强制同步布局；二是用户往上翻着看编译报错时，
 * 会被下一帧硬拽回底部。改成贴底才跟随，判定本身抽在 shared/log-scroll.ts 里。
 */
const pinned = ref(true)

function onBodyScroll(): void {
  const el = bodyRef.value
  if (!el) return
  pinned.value = isPinnedToBottom(el)
}

function scrollToBottom(): void {
  const el = bodyRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  // 程序化滚动同样会触发 scroll 事件，这里直接把状态定下来，省一次回调
  pinned.value = true
}

/**
 * 有新日志就跟随。
 *
 * `flush: 'post'` 是关键，也是这里唯一「时序敏感」的一行：回调要跑在本次
 * DOM patch **之后**、浏览器绘制**之前**。这样读到的 scrollHeight 已经算上新插入的行，
 * 滚动与绘制落在同一帧。原来的写法要 `await nextTick()`，白等一帧 ——
 * 刷屏时那种「慢半拍」的感觉主要来自这里。
 */
watch(
  () => store.logVersion,
  () => {
    if (pinned.value) scrollToBottom()
  },
  { flush: 'post' }
)

// 切终端时回到该终端的底部（每个终端都是「最新在下面」）
watch(
  () => store.activeTerminal,
  () => {
    pinned.value = true
    scrollToBottom()
  },
  { flush: 'post' }
)

// 面板被拖高、窗口变大或 Tab 条换行都会改变可视高度，贴底时跟着走
const bodyObserver = new ResizeObserver(() => {
  if (pinned.value) scrollToBottom()
})

/**
 * 一行实测高度。
 *
 * 用来喂给分块的 `contain-intrinsic-size`：`content-visibility: auto` 让屏外的块
 * 按「估算高度」计入 scrollHeight，估算值与真实值不一致时，跳到底部会停在离底部
 * 一截的地方。行高由字体与缩放决定，实测一次就基本稳定，之后再变也只是微调。
 */
const lineHeight = ref(0)
const chunkEstimatePx = computed(() => Math.round((lineHeight.value || 22) * CHUNK_SIZE))

const lineObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
    if (height > 0 && Math.abs(height - lineHeight.value) > 0.5) lineHeight.value = height
  }
})

function measureLine(el: Element | null): void {
  if (!el) return
  const height = (el as HTMLElement).getBoundingClientRect().height
  if (height > 0) lineHeight.value = height
}

/**
 * 量第一行的高度。
 * bodyRef 赋值时子节点已经渲染好了，直接同步查；查不到（比如面板空着）
 * 就断开观察，等下一次 watch 再试。
 */
function measureFirstLine(el: HTMLElement | null): void {
  const firstLine = el?.querySelector('.line:not(.term__omitted)') ?? null
  if (!firstLine) {
    lineObserver.disconnect()
    return
  }
  measureLine(firstLine)
  lineObserver.observe(firstLine)
}

watch(bodyRef, (el, prev) => {
  if (prev) bodyObserver.unobserve(prev)
  if (el) bodyObserver.observe(el)
  measureFirstLine(el)
})

// 第一行渲染出来之后量一次；此后行高若因缩放 / 设置变化，由 observer 接住
watch(
  () => chunks.value.length > 0,
  async (hasLines) => {
    if (!hasLines) return
    await nextTick()
    measureFirstLine(bodyRef.value)
  },
  { immediate: true }
)

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onWindowBlur)
  bodyObserver.disconnect()
  lineObserver.disconnect()
  detachResize()
  detachDockDrag()
})

function clearLogs(): void {
  const target = active.value
  if (target) store.clearTerminalLogs(target.key)
}
</script>

<template>
  <!--
    收起后整块面板收成这一颗按钮。
    Teleport 到 body：它要贴在**窗口**最右侧，不参与页面（内容列 / 首页那几个面板）的布局，
    也就不会被任何一层的定位或裁剪带偏；按住可上下拖，位置落盘（见 shared/terminal-dock.ts）。
    收起后 Tab 上的状态点就看不见了，所以按钮带上一个（见 dockTone）。
  -->
  <Teleport to="body">
    <Transition name="dock">
      <button
        v-if="tabs.length && collapsed"
        class="dock"
        :class="{ 'is-dragging': dockDragging }"
        type="button"
        :style="{ top: `${renderDockTop}%` }"
        title="展开终端（按住可上下拖动）"
        aria-label="展开终端"
        @pointerdown="startDockDrag"
        @keydown.up.prevent="nudgeDock(-2)"
        @keydown.down.prevent="nudgeDock(2)"
        @click="expandFromDock"
      >
        <el-icon><ArrowLeft /></el-icon>
        <i v-if="dockTone" class="dock__dot" :class="`tone-${dockTone}`" />
      </button>
    </Transition>
  </Teleport>

  <!-- 面板整块向右侧滑出去（滑进窗口右缘那颗按钮里），按钮同时从右缘滑出来 -->
  <Transition name="term-fold">
    <footer
      v-if="tabs.length && !collapsed"
      class="term"
      :class="{ 'is-resizing': resizing, 'is-linkable': ctrlHeld }"
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
        <el-icon class="term__caret"><ArrowRight /></el-icon>
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

      <div
        ref="bodyRef"
        class="term__body scroll-dark"
        role="log"
        aria-live="polite"
        @scroll.passive="onBodyScroll"
      >
        <template v-if="lines.length">
          <p v-if="omitted" class="line line--sys term__omitted">
            已省略较早的 {{ omitted }} 行（缓冲区保留最近 5000 行，此处只渲染最近 {{ RENDER_LIMIT }} 行）
          </p>
          <!-- 分块渲染：屏幕外的块由 content-visibility 跳过布局与绘制 -->
          <div
            v-for="(chunk, index) in chunks"
            :key="chunk[0]?.id ?? index"
            class="chunk"
            :style="{ containIntrinsicSize: `auto ${chunkEstimatePx}px` }"
          >
            <div v-for="line in chunk" :key="line.id" class="line" :class="`line--${line.stream}`">
              <span class="line__time mono">{{ line.time }}</span>
              <!-- 先按地址切段：链接单独成段上绿色，空行仍拿空格占住行高 -->
              <span class="line__text mono"><template
                v-for="(seg, index) in segmentsOf(line.text || ' ')"
                :key="index"
              ><span
                v-if="seg.url"
                class="line__link"
                role="link"
                :title="`Ctrl + 单击用默认浏览器打开：${seg.url}`"
                @click="openLink($event, seg.url)"
              >{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template></span>
            </div>
          </div>
        </template>
        <p v-else class="term__blank mono">
          {{ active ? '这个终端还没有输出。' : '点击上方标签切换终端。' }}
        </p>
      </div>
    </footer>
  </Transition>
</template>

<style scoped>
/* ---------- 收起后的悬浮按钮 ---------- */

/**
 * 收起后整块面板就剩这一颗按钮：贴在**窗口**最右侧（Teleport 到 body，见模板），
 * 纵向位置来自设置（百分比，见 shared/terminal-dock.ts）。
 * 用终端自己的深色底：它是终端面板的一部分，明暗主题下都不跟着变。
 */
.dock {
  position: fixed;
  /* 贴死窗口右缘，只留左边两个圆角：看着像挂在窗口边上的一道把手，而不是页面里的一个浮块 */
  right: 0;
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
  /* top 取的是「按钮中心落在窗口高度的百分之几」，所以自身上移一半 */
  transform: translateY(-50%);
  transition: top 0.16s ease, background 0.15s ease, color 0.15s ease;
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
  transition: transform 0.18s ease, opacity 0.16s ease, height 0.16s ease 0.18s;
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
  transition: height 0.16s ease, transform 0.18s ease 0.16s, opacity 0.16s ease 0.16s;
}

.term.term-fold-enter-from {
  transform: translateX(100%);
  opacity: 0;
  height: 0;
}

/* 按钮从窗口右缘滑出来 / 缩回右缘：与面板那一拍错开，看着像面板收进去之后它才冒头 */
.dock.dock-enter-active {
  transition: transform 0.18s ease 0.14s, opacity 0.16s ease 0.14s;
}

.dock.dock-leave-active {
  transition: transform 0.14s ease, opacity 0.12s ease;
}

.dock.dock-enter-from,
.dock.dock-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .term.term-fold-enter-active,
  .term.term-fold-leave-active,
  .dock.dock-enter-active,
  .dock.dock-leave-active {
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
  transition: height 0.18s ease;
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

/* ---------- 日志正文 ---------- */
.term__body {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) var(--sp-3) var(--sp-3);
  line-height: 1.65;
  /*
   * 把这块子树从页面其余部分的布局与绘制里隔离出来：
   * 面板底部的日志再多，也不会牵动上面的项目列表。
   */
  contain: content;
}

/*
 * 渲染分块：屏幕外的块不必布局，也不必绘制。
 * contain-intrinsic-size 给出「没渲染时按多高估算」，滚动条长度才不会
 * 随着内容进出视口来回跳；这里的值按 100 行 × 1.65 行高估一个中间数。
 */
.chunk {
  content-visibility: auto;
  contain-intrinsic-size: auto 1800px;
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

/* 日志里的地址：用终端专属的链接绿，不占状态色 */
.line__link {
  color: var(--term-link);
}

/* 按住 Ctrl 才显出可点：下划线 + 手型，跟「Ctrl + 单击」的操作对上 */
.term.is-linkable .line__link {
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
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
