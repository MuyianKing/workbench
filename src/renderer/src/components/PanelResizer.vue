<script setup lang="ts">
/**
 * 两栏之间的分隔条把手：一条通高的 10px 热区，看得见的只有正中间那个小竖条。
 * 笔记页与视频页的左右分栏是同一副（原先两页各抄一份 handler 与样式），收在这里；
 * 首页画布的栏宽把手是常显变体、还带「两栏一起改」的耦合逻辑，不在这份里。
 *
 * 定位要求：外层容器 `position: relative`，且要提供 `--tree-w`（当前左栏宽度）——
 * 落点是「外框内边距 + 左栏宽度 + 缝线正中」。四页的外框内边距都是 `--card-gap`
 * （知识库页的把手挂在两栏那层、那层没有内边距，用 `--resizer-inset: 0px` 覆盖）；
 * 宽度跟手只改本地，**落盘归调用方**（`@end`，与首页栏宽把手同一套做法）。
 *
 * 拖动经 use-pointer-drag：光标与文本选择由它挂到 body 上的类全局兜住
 * （global.css 的 `body.is-resizing-*`）。emit 的宽度以**按下那一刻**的 props.width
 * 为基准 —— 不能每帧拿 props.width 现算：调用方若做了收敛（钳位 / 回退），
 * 逐帧累加会让手感发飘。
 */
import { ref } from 'vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'

const props = defineProps<{
  /** 拖动开始时的当前宽度（emit 的绝对宽度以它为起点） */
  width: number
  /** 拖动期间挂到 body 上的类（global.css 靠它兜光标与文本选择） */
  bodyClass: string
}>()

const emit = defineEmits<{
  /** 拖动中：width 是以按下那一刻为基准的绝对宽度 */
  move: [width: number]
  /** 松手：该落盘了 */
  end: []
}>()

/** 拖动期间把手要一直亮着：指针可能已经离开缝线，不亮就像拖动断了 */
const dragging = ref(false)

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()

  const startWidth = props.width
  dragging.value = true
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: props.bodyClass,
    onMove: (moveEvent, start) => emit('move', startWidth + (moveEvent.clientX - start.x)),
    onEnd: () => {
      dragging.value = false
      emit('end')
    }
  })
}
</script>

<template>
  <span
    class="panel-resizer"
    :class="{ 'is-dragging': dragging }"
    title="拖动调整目录树宽度"
    @pointerdown="onPointerDown"
  />
</template>

<style scoped>
/* 热区通高，看得见的只有正中间那个小竖条；落点：外框内边距 + 左栏宽度 + 缝线正中 */
.panel-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 10;
  width: 10px;
  cursor: ew-resize;
  left: calc(
    var(--resizer-inset, var(--card-gap, 10px)) + var(--tree-w, 232px) + var(--card-gap, 10px) / 2 -
      5px
  );
}

/**
 * 把手**平时不显示**，指针落到缝线上才露出来：它是一条 10px 热区上的装饰，
 * 常显就是给每一屏都添一道竖线。拖动期间指针可能已经离开缝线，那时也得亮着 ——
 * 否则拖到一半把手自己没了，看着像拖动断了（用组件自己的拖动态驱动，不依赖 body 类）。
 */
.panel-resizer::after {
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

/* 指针落到缝线上就把小竖条填实，提示这条缝可以拖 */
.panel-resizer:hover::after,
.panel-resizer.is-dragging::after {
  background: var(--ink);
  opacity: 1;
}
</style>
