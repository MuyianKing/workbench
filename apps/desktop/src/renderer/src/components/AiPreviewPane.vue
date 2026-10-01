<script setup lang="ts">
/**
 * AI 对话右侧的**预览栏**：回答里的文件链接（`[测试](../test.md)`）与轮尾「写下 N 个文件」
 * 点开就摊在这里。
 *
 * 它是**页内的一个分栏面板，不是弹层**（AppDialog 那套规矩不适用）—— 读文件与继续看对话
 * 要同时进行，弹层只会把对话挡住。取数与授权都在 AiView（路径解析见 resolveAiPreview，
 * 图片的 asset 授权与背景图同一条边界），这里只管三件事：
 *
 *  - **Tab 头**：一个文件一个 Tab，点着切换；行上的 × 关掉那一个（最后一个关掉整栏就没
 *    了，对话占满整行）。Tab 多了横向滚。
 *  - **正文区**：每个文件一个自滚动的页面（`v-show` 保活）—— 切 Tab 不重解析，PPTX 那种
 *    重活在打开那一次干完；每页自己记加载中 / 错因 / 内容。
 *  - **左缘那条缝**：拖着改宽度（宽度住在 AiView，emit 过去钳位后回传）。
 *
 * 宽度定在卡片自己身上（`:style`），比写在列模板里直 —— 反正拖动时每帧都要改它。
 */
import { Close } from '@element-plus/icons-vue'
import type { AiPreviewState } from '@workbench/ai'
import AiPreviewDoc from '@/components/AiPreviewDoc.vue'
import AiPreviewHtml from '@/components/AiPreviewHtml.vue'
import AiPreviewSlides from '@/components/AiPreviewSlides.vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import MarkdownView from '@/components/MarkdownView.vue'

const props = defineProps<{
  previews: AiPreviewState[]
  /** 当前显示的那张 Tab（previews 里某个的 key） */
  activeKey: string
  /** 预览栏宽度（px，AiView 里钳位） */
  width: number
}>()

const emit = defineEmits<{
  activate: [key: string]
  close: [key: string]
  resize: [width: number]
}>()

/**
 * 左缘那条缝：以按下那一刻的宽度为基准，往左拖 = 变宽（与 PanelResizer 同一套做法 ——
 * 不能每帧拿 props.width 现算，钳位会让手感发飘）；拖动期间的光标与文本选择由
 * global.css 的 body.is-resizing-ai-preview 兜住。
 */
function onResizeDown(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()

  const startWidth = props.width
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: 'is-resizing-ai-preview',
    onMove: (moveEvent, start) => emit('resize', startWidth + (start.x - moveEvent.clientX))
  })
}
</script>

<template>
  <aside class="pane panel" :style="{ width: `${width}px` }">
    <span class="pane__resizer" title="拖动调整预览栏宽度" @pointerdown="onResizeDown" />

    <header class="pane__tabs">
      <div class="pane__tablist" role="tablist">
        <button
          v-for="state in previews"
          :key="state.key"
          type="button"
          role="tab"
          class="pane__tab"
          :class="{ 'is-active': state.key === activeKey }"
          :aria-selected="state.key === activeKey"
          :title="state.name"
          @click="emit('activate', state.key)"
        >
          <span class="pane__tab-name">{{ state.name }}</span>
          <span
            class="pane__tab-close"
            aria-label="关闭这个预览"
            @click.stop="emit('close', state.key)"
          >
            <el-icon><Close /></el-icon>
          </span>
        </button>
      </div>
    </header>

    <div class="pane__body">
      <section
        v-for="state in previews"
        :key="state.key"
        v-show="state.key === activeKey"
        class="pane__page"
        :class="`is-${state.kind}`"
      >
        <p v-if="state.error" class="pane__note is-fail">{{ state.error }}</p>
        <p v-else-if="state.loading" class="pane__note">正在打开…</p>
        <template v-else>
          <MarkdownView
            v-if="state.kind === 'markdown'"
            :source="state.text"
            :resolve-image-src="(src: string) => state.imageSrcs[src] ?? null"
          />
          <AiPreviewDoc v-else-if="state.kind === 'docx'" :binary="state.binary" />
          <AiPreviewSlides v-else-if="state.kind === 'pptx'" :binary="state.binary" />
          <AiPreviewHtml
            v-else-if="state.kind === 'html'"
            :source="state.text"
            :image-srcs="state.imageSrcs"
          />
          <img
            v-else-if="state.kind === 'image' && state.imageUrl"
            class="pane__img"
            :src="state.imageUrl"
            :alt="state.name"
          />
          <pre v-else class="pane__text">{{ state.text }}</pre>
        </template>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.pane {
  position: relative; /* 左缘那条拖拽缝以它定位 */
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  padding: var(--sp-3);
}

/**
 * 左缘的拖拽缝：通高 10px 热区，跨在缝线上（左缘外探一半），看得见的只有
 * 正中间那个小竖条 —— 与笔记 / 视频页那条分隔条同一副样子。
 */
.pane__resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -5px;
  width: 10px;
  cursor: ew-resize;
  z-index: 10;
}

.pane__resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 8px;
  height: 34px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--ink);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}

.pane__resizer:hover::after {
  background: var(--ink);
  opacity: 1;
}

/* Tab 头：一行可横滚的标签；底部一条细线把它与正文分开 */
.pane__tabs {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}

.pane__tablist {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.pane__tab {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  max-width: 160px;
  padding: 2px 4px 2px 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-3);
  font: inherit;
  font-size: var(--fs-meta);
  cursor: pointer;
}

.pane__tab:hover {
  color: var(--ink-2);
  background: var(--bg-inset);
}

/* 摊开的那张：字最重、底最实 */
.pane__tab.is-active {
  color: var(--ink);
  background: var(--bg-inset);
}

.pane__tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行内那颗 ×：平时淡着，悬停抬头 */
.pane__tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: var(--r-sm);
  font-size: 10px;
  opacity: 0.55;
}

.pane__tab-close:hover {
  opacity: 1;
  background: var(--border);
}

/**
 * 正文区：一个文件一层页面，每层自己滚（切 Tab 用 v-show，滚动位置与渲染结果都留在原地，
 * PPTX 不重解析）。html 那层不滚 —— 沙箱 iframe 撑满，滚在它自己里面。
 */
.pane__body {
  position: relative;
  flex: 1;
  min-height: 0;
  margin-top: var(--sp-2);
}

.pane__page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
}

.pane__page.is-html {
  overflow: hidden;
}

.pane__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.pane__note.is-fail {
  color: var(--st-fail);
}

.pane__text {
  margin: 0;
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 图片按它自己的比例缩到栏宽为止，不放大 */
.pane__img {
  display: block;
  max-width: 100%;
  margin: 0 auto;
}
</style>
