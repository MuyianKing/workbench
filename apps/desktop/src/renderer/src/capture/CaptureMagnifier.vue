<script setup lang="ts">
/**
 * 放大镜：光标周围那一小块按 zoom 倍放大 + 当前像素的坐标与颜色读数。
 *
 * 只管画：取样几何来自 `@workbench/capture` 的 `magnifierView`（那份有单测），
 * 颜色读数由父组件采好递进来（父组件手里才有原图的画布）。
 */
import type { Point } from '@/types'
import { magnifierView } from '@workbench/capture'
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  /** 冻结的那一帧（按物理像素） */
  bitmap: ImageBitmap | null
  /** 光标在画布像素坐标里的位置 */
  cursor: Point
  /** 放大倍数（一格源像素占几个物理像素） */
  zoom: number
  /** 放大镜的边长（CSS 像素） */
  side: number
  /** 光标处像素的颜色：#rrggbb */
  pixel: string
  /** 压在这个颜色上的读数该用深色还是浅色字 */
  ink: string
  /** 光标处的坐标文本，如 `(1024, 768)` */
  position: string
  /** 复制读数后的反馈（有它就顶替掉坐标那一格） */
  note?: string
}>()

const canvas = ref<HTMLCanvasElement | null>(null)

/** backing store 也按物理像素：HiDPI 屏上放大镜里的格子才是真的一格一个像素 */
const density = computed(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
const backing = computed(() => Math.round(props.side * density.value))

function draw(): void {
  const element = canvas.value
  const bitmap = props.bitmap
  if (!element || !bitmap)
    return

  const size = backing.value
  const context = element.getContext('2d')
  if (!context)
    return

  // 放大后的一格就是一块纯色方块：关掉插值，格子边界才利落
  context.imageSmoothingEnabled = false
  context.clearRect(0, 0, size, size)

  const view = magnifierView(props.cursor, props.zoom, size)
  context.drawImage(
    bitmap,
    view.source.x,
    view.source.y,
    view.source.width,
    view.source.height,
    0,
    0,
    size,
    size,
  )

  // 网格：与源像素的边一一对应
  context.strokeStyle = 'rgba(255, 255, 255, 0.16)'
  context.lineWidth = 1
  for (let index = 1; index < view.cells; index += 1) {
    const at = Math.round(index * view.cell) + 0.5
    context.beginPath()
    context.moveTo(at, 0)
    context.lineTo(at, size)
    context.moveTo(0, at)
    context.lineTo(size, at)
    context.stroke()
  }

  // 光标所在那一格：描一圈主题色，浅色与深色内容上都看得见
  context.strokeStyle = '#409eff'
  context.lineWidth = 2
  context.strokeRect(
    view.cursorCell.x + 1,
    view.cursorCell.y + 1,
    Math.max(1, view.cursorCell.width - 2),
    Math.max(1, view.cursorCell.height - 2),
  )
}

onMounted(draw)
watch(() => [props.cursor.x, props.cursor.y, props.bitmap, props.zoom, props.side], draw)
</script>

<template>
  <div class="magnifier" :style="{ width: `${side}px` }">
    <canvas ref="canvas" :width="backing" :height="backing" :style="{ width: `${side}px`, height: `${side}px` }" />
    <div class="magnifier__readout" :style="{ background: pixel, color: ink }">
      <span class="magnifier__hex">{{ pixel }}</span>
      <span class="magnifier__pos">{{ note || position }}</span>
    </div>
  </div>
</template>

<style scoped>
.magnifier {
  /* 数字用等宽字体，光标挪动时读数不会左右跳 */
  font-variant-numeric: tabular-nums;
}

.magnifier canvas {
  display: block;
  border: 1px solid rgb(255 255 255 / 30%);
  border-radius: 4px;
  /* 放大镜压在截图上，边框外再压一圈深色才好认出边界 */
  box-shadow: 0 2px 12px rgb(0 0 0 / 55%);
}

.magnifier__readout {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  padding: 3px 6px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 0 2px 12px rgb(0 0 0 / 45%);
}

.magnifier__hex {
  font-family: 'Cascadia Mono', Consolas, monospace;
  text-transform: uppercase;
}

.magnifier__pos {
  opacity: 0.75;
}
</style>
