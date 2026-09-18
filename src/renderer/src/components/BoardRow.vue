<script setup lang="ts">
/**
 * 布局里的一行：栏内横向的一条槽，槽里的卡片平分这一栏的宽度、高度跟着这一行走。
 *
 * 行负责自己的高度与下边缘缩放（只有固定高度才有那颗把手），编辑态的两颗控件都贴在行上：
 * 右上角的「固定 / 自适应」、下缘中间那颗高度把手 —— 与原先挂在卡片上的那两颗同一副长相，
 * 只是现在一行一颗（一行三张卡片时，高度是它们共享的）。
 *
 * 高度写成 flex-basis（固定）或 flex:1（自适应），下限用 min-height 兜着：卡片被挪进
 * 一条比它下限还矮的行时，行会被它撑起来，而不是把卡片压成一条细边。
 * 卡片由 HomeBoard 从插槽排进来（它才认得落点空隙该插在哪两张之间）。
 */
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { resizeRowHeight, type HomeRow, type RowId } from '@shared/theme'

const props = defineProps<{
  row: HomeRow
  /** 它在所在栏 `rows` 里的下标：落点判定按它算（见 HomeBoard 的 targetAt） */
  index: number
  /** 这一行的高度下限（行里最高的那条卡片下限，见 shared/theme.ts 的 rowHeightMin） */
  min: number
  editing: boolean
}>()

const emit = defineEmits<{
  resize: [id: RowId, height: number]
  toggleMode: [id: RowId]
  commit: []
}>()

const style = computed<CSSProperties>(() => ({
  flex: props.row.mode === 'flex' ? '1 1 0' : `0 0 ${props.row.height}px`,
  minHeight: `${props.min}px`
}))

/** 拖动下边缘改高度：过程中只往上冒，落盘由 HomeBoard 在松手时做 */
function onResizeDown(event: PointerEvent): void {
  if (!props.editing || props.row.mode === 'flex' || event.button !== 0) return
  event.preventDefault()

  const startHeight = props.row.height

  // 跟手与收手（含系统取消指针）交给 composable：这里只换算高度
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    onMove: (moveEvent, start) => {
      emit(
        'resize',
        props.row.id,
        resizeRowHeight(startHeight, moveEvent.clientY - start.y, props.min)
      )
    },
    onEnd: () => emit('commit')
  })
}
</script>

<template>
  <div
    class="board-row"
    :class="{ 'is-editing': editing, 'is-flex': row.mode === 'flex' }"
    :style="style"
    :data-row="row.id"
    :data-row-index="index"
  >
    <slot />

    <template v-if="editing">
      <!-- 右上角：这一行的高度模式（固定 / 自适应） -->
      <button
        class="board-row__mode"
        type="button"
        :title="
          row.mode === 'flex'
            ? '这一行是自适应高度，点一下改为固定高度'
            : '这一行是固定高度，点一下改为自适应'
        "
        @click.stop="emit('toggleMode', row.id)"
      >
        <template v-if="row.mode === 'flex'">自适应</template>
        <template v-else>{{ row.height }}px</template>
      </button>

      <!-- 只有固定高度才需要手动拉高度 -->
      <span
        v-if="row.mode === 'fixed'"
        class="board-row__resize"
        title="拖动调整这一行的高度"
        @pointerdown="onResizeDown"
      />
    </template>
  </div>
</template>

<style scoped>
.board-row {
  position: relative;
  display: flex;
  align-items: stretch;
  /* 行内卡片之间的留白：与栏间、行间同一个「卡片间距」 */
  gap: var(--card-gap, 14px);
  min-width: 0;
  min-height: 0;
}

/* ---------- 高度模式药丸 ---------- */

/* 与卡片名那颗同一副小药丸，只是挂在行的右上角（一行一颗，管的是这一行的高度） */
.board-row__mode {
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

.board-row__mode:hover {
  border-color: var(--ink);
  color: var(--ink);
}

/* 自适应时按钮实心，一眼看出这一行在吃剩余高度 */
.board-row.is-flex .board-row__mode {
  border-color: transparent;
  background: var(--ink);
  color: var(--ink-inverse);
}

/* ---------- 下边缘的高度把手 ---------- */

.board-row__resize {
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

.board-row__resize:hover {
  background: var(--ink);
}
</style>
