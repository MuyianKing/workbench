<script setup lang="ts">
/**
 * 布局里的一块卡片：负责自己的高度与下边缘缩放，整个卡片区域都是拖动手柄。
 *
 * 宽度不用管 —— 它永远铺满所在栏。高度有两种模式：fixed 用像素值，flex 相当于 flex:1，
 * 吃掉所在栏剩下的高度（自适应）。平时它就是一块普通容器，内容该怎么点还怎么点；
 * 编辑态下内容整体 pointer-events: none，所以从卡片任意位置按下都能开始拖动。
 *
 * 拖动过程中这张卡片自己就是预览：HomeBoard 把 floatingStyle（position: fixed 跟着指针）
 * 传下来，它就脱离文档流跟手移动 —— 原位置不留任何东西，也不会出现第二份副本。
 */
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import {
  CARD_HEIGHT_MIN,
  resizeCardHeight,
  type CardGrab,
  type CardMode,
  type HomeCardId
} from '@shared/theme'

const props = defineProps<{
  id: HomeCardId
  title: string
  mode: CardMode
  height: number
  step: number
  editing: boolean
  floatingStyle: CSSProperties | null
}>()

const emit = defineEmits<{
  grab: [id: HomeCardId, grab: CardGrab]
  toggleMode: [id: HomeCardId]
  resize: [id: HomeCardId, height: number]
  commit: []
}>()

/**
 * 固定高度写成 flex-basis，自适应写成 flex:1。
 * 用 flex 而不是 height，是为了让固定高度在空间不够时不参与压缩、由栏自己滚。
 */
const frameStyle = computed<CSSProperties>(() =>
  props.mode === 'flex'
    ? { flex: '1 1 0', minHeight: `${CARD_HEIGHT_MIN[props.id]}px` }
    : { flex: `0 0 ${props.height}px` }
)

/** 浮层样式由 HomeBoard 给；还没真正拖起来（没超过阈值）时按普通卡片排布 */
const style = computed<CSSProperties>(() => props.floatingStyle ?? frameStyle.value)

// ---------- 抓起来（整个卡片区域） ----------

function onCardPointerDown(event: PointerEvent): void {
  if (!props.editing || event.button !== 0) return
  event.preventDefault()

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  emit('grab', props.id, {
    x: event.clientX,
    y: event.clientY,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  })
}

// ---------- 高度缩放 ----------

let resizing = false
let startY = 0
let startHeight = 0

function onResizeDown(event: PointerEvent): void {
  if (!props.editing || props.mode === 'flex' || event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()

  resizing = true
  startY = event.clientY
  startHeight = props.height

  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeUp)
  window.addEventListener('pointercancel', onResizeUp)
}

function onResizeMove(event: PointerEvent): void {
  if (!resizing) return
  const next = resizeCardHeight(
    startHeight,
    event.clientY - startY,
    props.step,
    CARD_HEIGHT_MIN[props.id]
  )
  emit('resize', props.id, next)
}

function onResizeUp(): void {
  if (!resizing) return
  resizing = false
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeUp)
  window.removeEventListener('pointercancel', onResizeUp)
  emit('commit')
}
</script>

<template>
  <div
    class="board-card"
    :class="{ 'is-editing': editing, 'is-floating': !!floatingStyle, 'is-flex': mode === 'flex' }"
    :style="style"
    :data-card-id="id"
    @pointerdown="onCardPointerDown"
  >
    <div class="board-card__body">
      <slot />
    </div>

    <template v-if="editing">
      <!-- 左上角：卡片名，整块区域按下即可拖动 -->
      <span class="board-card__label">{{ title }}</span>

      <!-- 右上角：固定高度 / 自适应切换 -->
      <button
        class="board-card__mode"
        type="button"
        :title="mode === 'flex' ? '当前自适应高度，点一下改为固定高度' : '当前固定高度，点一下改为自适应'"
        @pointerdown.stop
        @click.stop="emit('toggleMode', id)"
      >
        <template v-if="mode === 'flex'">自适应</template>
        <template v-else>{{ height }}px</template>
      </button>

      <!-- 只有固定高度才需要手动拉高度 -->
      <span
        v-if="mode === 'fixed'"
        class="board-card__resize"
        :title="`拖动调整${title}的高度`"
        @pointerdown="onResizeDown"
      />
    </template>
  </div>
</template>

<style scoped>
.board-card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* 编辑态整块都是拖动热区 */
  cursor: default;
}

.board-card.is-editing {
  cursor: grab;
}

/* 内容撑满卡片（内部各面板自己决定怎么分配） */
.board-card__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* 编辑态下内容不吃指针：从卡片任意位置按下都能拖动，也不会误点里面的按钮 */
.board-card.is-editing .board-card__body {
  pointer-events: none;
}

.board-card.is-editing {
  outline: 1px dashed var(--border-strong);
  outline-offset: -1px;
  border-radius: var(--r-lg);
}

/**
 * 拖起来的那一张：脱离文档流跟着指针走，所以原位置不留东西。
 * pointer-events: none 是必须的 —— 否则 elementFromPoint 只会照到它自己，
 * 落点判断会一直停在原来那一栏。
 */
.board-card.is-floating {
  z-index: 200;
  pointer-events: none;
  cursor: grabbing;
  opacity: 0.92;
  box-shadow: 0 14px 34px rgba(17, 21, 27, 0.22);
}

:root[data-theme='dark'] .board-card.is-floating {
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.55);
}

/* ---------- 标签与模式按钮 ---------- */
.board-card__label {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  padding: 2px 8px;
  border-radius: var(--r-pill);
  background: var(--ink);
  color: var(--ink-inverse);
  font-size: var(--fs-micro);
  line-height: 16px;
  white-space: nowrap;
  pointer-events: none;
}

.board-card__mode {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 3;
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 16px;
  cursor: pointer;
}

.board-card__mode:hover {
  border-color: var(--ink);
  color: var(--ink);
}

/* 自适应时按钮实心，一眼看出这块在吃剩余高度 */
.board-card.is-flex .board-card__mode {
  border-color: transparent;
  background: var(--ink);
  color: var(--ink-inverse);
}

/* ---------- 下边缘的高度把手 ---------- */
.board-card__resize {
  position: absolute;
  left: 50%;
  bottom: -4px;
  z-index: 2;
  width: 34px;
  height: 8px;
  transform: translateX(-50%);
  border: 1px solid var(--ink);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  cursor: ns-resize;
}

.board-card__resize:hover {
  background: var(--ink);
}
</style>
