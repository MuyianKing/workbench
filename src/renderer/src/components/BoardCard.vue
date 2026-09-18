<script setup lang="ts">
/**
 * 布局里的一块卡片：本体 + 编辑态的卡片名，整块区域都是拖动手柄。
 *
 * 宽度与高度都不归它管：宽度由所在的那一行平分（一行几张就一人一份），高度跟着那一行走
 * （见 BoardRow）—— 所以它比过去薄了一层，只剩下「画内容」与「按下即拖动」两件事。
 * 平时它就是一块普通容器，内容该怎么点还怎么点；编辑态下内容整体 pointer-events: none，
 * 所以从卡片任意位置按下都能开始拖动。
 *
 * 拖动过程中这张卡片自己就是预览：HomeBoard 把 floatingStyle（position: fixed 跟着指针）
 * 传下来，它就脱离文档流跟手移动 —— 原位置不留任何东西，也不会出现第二份副本。
 */
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import type { CardGrab, HomeCardId } from '@shared/theme'

const props = defineProps<{
  id: HomeCardId
  title: string
  editing: boolean
  floatingStyle: CSSProperties | null
}>()

const emit = defineEmits<{
  grab: [id: HomeCardId, grab: CardGrab]
}>()

/** 浮层样式由 HomeBoard 给；还没真正拖起来（没超过阈值）时按普通卡片排布 */
const style = computed<CSSProperties>(() => props.floatingStyle ?? {})

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
</script>

<template>
  <div
    class="board-card"
    :class="{ 'is-editing': editing, 'is-floating': !!floatingStyle }"
    :style="style"
    :data-card-id="id"
    @pointerdown="onCardPointerDown"
  >
    <div class="board-card__body">
      <slot />
    </div>

    <!-- 编辑态：卡片名。整块区域按下即可拖动，所以它只是个标记，不吃指针 -->
    <span v-if="editing" class="board-card__label">{{ title }}</span>
  </div>
</template>

<style scoped>
.board-card {
  position: relative;
  display: flex;
  flex-direction: column;
  /* 一行里的卡片平分宽度：几张卡片就是几个等份（只有一张时它独占整行） */
  flex: 1 1 0;
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
 * 落点判断会一直停在原来那一行。
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
</style>
