<script setup lang="ts">
import { ref } from 'vue'
import { useOverlayScrollbar } from '@/composables/use-overlay-scrollbar'

/**
 * 自绘的悬浮滚动条。
 *
 * 用法：把它放进一个 `position: relative` 的外壳（滚动容器旁边），`target` 给真正的
 * 滚动元素。它只画一条 5px 的胶囊滑块 —— 不占正文宽度、没有轨道与箭头；鼠标落在
 * 这条热区（或按着滑块拖）时才加粗变深。
 *
 * 几何与监听都在 `useOverlayScrollbar` 里，这里只负责摆。
 */
const props = defineProps<{
  /** 真正滚动的元素（Vditor 是 `pre.vditor-reset`）；还没初始化完时为 null */
  target: HTMLElement | null
}>()

const track = ref<HTMLElement | null>(null)
const { metrics, dragging, onThumbPointerDown, onTrackPointerDown } = useOverlayScrollbar(
  () => props.target,
  () => track.value,
)
</script>

<template>
  <div
    ref="track"
    class="osb"
    :class="{ 'is-visible': !!metrics, 'is-drag': dragging }"
    role="presentation"
    aria-hidden="true"
    @pointerdown="onTrackPointerDown"
  >
    <div
      v-if="metrics"
      class="osb__thumb"
      :style="{ height: `${metrics.height}px`, transform: `translateY(${metrics.top}px)` }"
      @pointerdown="onThumbPointerDown"
    />
  </div>
</template>

<style scoped>
.osb {
  position: absolute;
  top: 6px;
  right: 3px;
  bottom: 6px;
  z-index: 4;
  width: 12px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s var(--ease-out);
}

.osb.is-visible {
  opacity: 1;
  pointer-events: auto;
}

.osb__thumb {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  border-radius: var(--r-pill);
  background: var(--ink);
  opacity: 0.16;
  cursor: pointer;
  transition: width 0.16s var(--ease-out), opacity 0.16s var(--ease-out);
}

.osb:hover .osb__thumb,
.osb.is-drag .osb__thumb {
  width: 7px;
  opacity: 0.34;
}
</style>
