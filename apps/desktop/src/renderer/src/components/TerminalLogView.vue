<script setup lang="ts">
import type { LinkSegment } from '@workbench/core'
import type { LogLine } from '@/types'
import { splitLinks } from '@workbench/core'
import { isPinnedToBottom } from '@workbench/terminal'
import { ElMessage } from 'element-plus'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useTerminalStore } from '@/stores/terminal'

/**
 * 终端日志正文：分块渲染、贴底跟随、Ctrl + 单击开链接。
 *
 * 从 `TerminalPanel.vue` 拆出来的整块 —— 它自己管滚动、行高测量与三个 ResizeObserver，
 * 面板那一层只管高度与标签；两块的生命周期互不牵扯（都各自在 onUnmounted 里收监听）。
 *
 * 下面是原注释里两条不能破的口径：
 * - 渲染上限 1000 行、每块 100 行，超过就只挂尾部（缓冲区仍保留 5000 行）。
 * - 分块只许给 `contain-intrinsic-height`，不能用 `contain-intrinsic-size`（会连宽度一起算）。
 */
const terminal = useTerminalStore()
const bodyRef = ref<HTMLElement | null>(null)

const active = computed(() => terminal.activeTerminalState)

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

/**
 * 日志快照。用 terminal.activeLogs 而不是 active.logs：
 * 缓冲是环形且 markRaw 的，store 那个 computed 会跟着 logVersion 更新，
 * 这里只负责截断到渲染上限。
 */
const allLines = computed<LogLine[]>(() => terminal.activeLogs)

/**
 * 渲染起点，**刻意对齐到 CHUNK_SIZE 的整数倍**（所以 RENDER_LIMIT 也取它的整数倍）。
 *
 * 分块的 key 取 `chunk[0].id`，起点只要动一行，所有分块的 key 就同时落空 ——
 * Vue 找不到可复用的节点，只能把整屏卸了重建，正好抵消掉下面分块想省下的那部分。
 * 对齐之后只有整个分块滚出窗口时起点才跳一次，稳态下每帧只增删一个分块。
 */
const start = computed(() => {
  const total = allLines.value.length
  if (total <= RENDER_LIMIT)
    return 0
  return Math.floor((total - RENDER_LIMIT) / CHUNK_SIZE) * CHUNK_SIZE
})

/** 省略了几行（截断的起点就是省略的行数） */
const omitted = computed(() => start.value)

const lines = computed(() => (start.value ? allLines.value.slice(start.value) : allLines.value))

const chunks = computed(() => {
  const list = lines.value
  const out: LogLine[][] = []
  for (let i = 0; i < list.length; i += CHUNK_SIZE) {
    out.push(list.slice(i, i + CHUNK_SIZE))
  }
  return out
})

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
  if (cached)
    return cached

  const segments = splitLinks(text)
  if (linkCache.size >= 4096)
    linkCache.clear()
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
  if (event.key === 'Control')
    ctrlHeld.value = true
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key === 'Control')
    ctrlHeld.value = false
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
  if (!event.ctrlKey)
    return
  const result = await window.workbench.openExternal(url)
  if (!result.ok)
    ElMessage.warning(result.error)
}

// ---------- 自动滚动：只在用户贴底时跟随 ----------

/**
 * 用户是否停在底部。
 *
 * 原实现每帧无条件 `scrollTop = scrollHeight`，有两个毛病：
 * 一是每帧读 scrollHeight 就是一次强制同步布局；二是用户往上翻着看编译报错时，
 * 会被下一帧硬拽回底部。改成贴底才跟随，判定本身抽在 packages/terminal/src/log-scroll.ts 里。
 */
const pinned = ref(true)

function onBodyScroll(): void {
  const el = bodyRef.value
  if (!el)
    return
  pinned.value = isPinnedToBottom(el)
}

function scrollToBottom(): void {
  const el = bodyRef.value
  if (!el)
    return
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
  () => terminal.logVersion,
  () => {
    if (pinned.value)
      scrollToBottom()
  },
  { flush: 'post' },
)

// 切终端时回到该终端的底部（每个终端都是「最新在下面」）
watch(
  () => terminal.activeTerminal,
  () => {
    pinned.value = true
    scrollToBottom()
  },
  { flush: 'post' },
)

// 面板被拖高、窗口变大或 Tab 条换行都会改变可视高度，贴底时跟着走
const bodyObserver = new ResizeObserver(() => {
  if (pinned.value)
    scrollToBottom()
})

/**
 * 一行实测高度。
 *
 * 用来喂给分块的 `contain-intrinsic-height`：`content-visibility: auto` 让屏外的块
 * 按「估算高度」计入 scrollHeight，估算值与真实值不一致时，跳到底部会停在离底部
 * 一截的地方。行高由字体与缩放决定，实测一次就基本稳定，之后再变也只是微调。
 *
 * 只喂高度、不喂 `contain-intrinsic-size`（单值会连**宽度**一起算），原因见样式里 .chunk 的说明。
 */
const lineHeight = ref(0)
const chunkEstimatePx = computed(() => Math.round((lineHeight.value || 22) * CHUNK_SIZE))

const lineObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
    if (height > 0 && Math.abs(height - lineHeight.value) > 0.5)
      lineHeight.value = height
  }
})

function measureLine(el: Element | null): void {
  if (!el)
    return
  const height = (el as HTMLElement).getBoundingClientRect().height
  if (height > 0)
    lineHeight.value = height
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
  if (prev)
    bodyObserver.unobserve(prev)
  if (el)
    bodyObserver.observe(el)
  measureFirstLine(el)
})

// 第一行渲染出来之后量一次；此后行高若因缩放 / 设置变化，由 observer 接住
watch(
  () => chunks.value.length > 0,
  async (hasLines) => {
    if (!hasLines)
      return
    await nextTick()
    measureFirstLine(bodyRef.value)
  },
  { immediate: true },
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onWindowBlur)
  bodyObserver.disconnect()
  lineObserver.disconnect()
})
</script>

<template>
  <div
    ref="bodyRef"
    class="term__body scroll-dark"
    :class="{ 'is-linkable': ctrlHeld }"
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
        :style="{ containIntrinsicHeight: `auto ${chunkEstimatePx}px` }"
      >
        <div v-for="line in chunk" :key="line.id" class="line" :class="`line--${line.stream}`">
          <span class="line__time mono">{{ line.time }}</span>
          <!-- 先按地址切段：链接单独成段上绿色，空行仍拿空格占住行高 -->
          <span class="line__text mono"><template
            v-for="(seg, segIndex) in segmentsOf(line.text || ' ')"
            :key="segIndex"
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
</template>

<style scoped>
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
 * 高度估算（contain-intrinsic-height）给出「没渲染时按多高算」，滚动条长度才不会
 * 随着内容进出视口来回跳；这里的值按 100 行 × 1.65 行高估一个中间数。
 *
 * **只许用高度那一条长属性**：`contain-intrinsic-size` 给一个值等于宽、高各一份，
 * 而 `content-visibility: auto` 在块被跳过时会把这份「内在宽度」（1800px / 行高 × 100）
 * 算进分块的尺寸里 —— 整块终端的最小宽度随之变成两千多像素，把 `.content` 那一列
 * 顶得比窗口还宽，页面右侧（网关那排统计卡的最后一张）被裁掉一截。
 */
.chunk {
  content-visibility: auto;
  contain-intrinsic-height: auto 1800px;
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
.term__body.is-linkable .line__link {
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
