<script setup lang="ts">
/**
 * 钉图窗口：一张图钉在屏幕上（置顶、拖得动、滚轮缩放、Ctrl+滚轮调透明度、右键出菜单）。
 *
 * ## 拖动交给系统，位置由 Rust 记账
 *
 * 整张图标了 `data-tauri-drag-region`：按下拖动是**系统在搬这扇窗口**（不是我们在 JS 里
 * 一帧一帧地 set_position），所以拖起来跟原生窗口一样跟手。位置不用前端回传 ——
 * Rust 在窗口的 `Moved` 事件里把几何写回记账（见 pin.rs 的 sync_geometry）。
 *
 * ## 缩放与透明度
 *
 * 窗口本身就是图片的尺寸，所以「缩放图片」= 改窗口的尺寸与位置，由 `pinState` 落到系统上。
 * 算式在 `@workbench/capture` 的纯函数里（以光标为不动点、保持长宽比、夹上下限），这里只管接事件。
 */
import type { PinRecord, Point } from '@/types'
import { clampPinOpacity, clampPinSize, defaultCaptureName, initialPinSize, splitPath, zoomAround } from '@workbench/capture'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { assetUrl } from '@/workbench/bridge'
import PinMenu from './PinMenu.vue'

const record = ref<PinRecord | null>(null)
const imageUrl = ref('')
const failure = ref('')
const hovering = ref(false)
const menu = ref<{ x: number, y: number } | null>(null)

/** 缩放档：一次滚轮走 10% */
const ZOOM_STEP = 1.1
/** 透明度档：一次滚轮走 5 个点 */
const OPACITY_STEP = 5

const opacity = computed(() => (record.value ? record.value.opacity / 100 : 1))

onMounted(async () => {
  const result = await window.workbench.pinContext()
  const info = result.ok ? result.data : undefined
  if (!info) {
    failure.value = result.error ?? '这张钉图已经不在了'
    return
  }
  record.value = info
  // 图片由 Rust 按文件授权给 asset 协议（见 pin.rs），这里拿到的是能直接加载的 URL
  imageUrl.value = assetUrl(info.file)
  window.addEventListener('keydown', onKeyDown)
  // 全局快捷键翻了穿透时，这份状态也要跟着变（菜单里那一项才显示得对）
  window.workbench.onPinState((next) => {
    record.value = next
  })
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape')
    return
  // 菜单开着时 Esc 只收菜单（收起骨架已经处理了），别顺手把钉图也关了
  if (menu.value)
    return
  void close()
}

/** 滚轮：缩放（不动点取光标）；按住 Ctrl 是调透明度 */
async function onWheel(event: WheelEvent): Promise<void> {
  const current = record.value
  if (!current)
    return
  event.preventDefault()

  const up = event.deltaY < 0

  if (event.ctrlKey) {
    await apply({ opacity: clampPinOpacity(current.opacity + (up ? OPACITY_STEP : -OPACITY_STEP)) })
    return
  }

  const factor = up ? ZOOM_STEP : 1 / ZOOM_STEP
  const size = clampPinSize(
    { width: current.width * factor, height: current.height * factor },
    current.ratio,
  )
  // 光标底下那块内容缩放前后停在原位：先把光标位置换算成虚拟桌面的物理坐标
  const scale = window.devicePixelRatio || 1
  const anchor: Point = {
    x: current.x + event.clientX * scale,
    y: current.y + event.clientY * scale,
  }
  const position = zoomAround(anchor, { x: current.x, y: current.y }, { width: current.width, height: current.height }, size)
  await apply({ x: position.x, y: position.y, width: size.width, height: size.height })
}

async function apply(patch: Parameters<typeof window.workbench.pinState>[0]): Promise<void> {
  const result = await window.workbench.pinState(patch)
  if (result.ok && result.data)
    record.value = result.data
  else if (!result.ok)
    failure.value = result.error ?? '改钉图状态失败'
}

function onContextMenu(event: MouseEvent): void {
  menu.value = { x: event.clientX, y: event.clientY }
}

async function close(): Promise<void> {
  await window.workbench.pinClose()
}

async function copy(): Promise<void> {
  const result = await window.workbench.pinCopy()
  if (!result.ok)
    failure.value = result.error ?? '复制到剪贴板失败'
}

async function saveAs(): Promise<void> {
  const picked = await window.workbench.pickSavePath({
    title: '钉图另存为',
    defaultPath: defaultCaptureName(new Date()),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  })
  if (!picked)
    return

  const parts = splitPath(picked)
  const result = await window.workbench.pinSave(parts.dir, parts.name, false)
  if (!result.ok)
    failure.value = result.error ?? '保存失败'
}

/** 穿透开着的时候这扇窗口收不到鼠标事件，只能靠全局快捷键收回来（见设置里的说明） */
async function toggleThrough(): Promise<void> {
  const current = record.value
  if (!current)
    return
  await apply({ clickThrough: !current.clickThrough })
}

/**
 * 适应屏幕：把窗口收回「最长边占这块屏七成」的尺寸（与刚钉出来时同一把尺子）。
 *
 * 不是「恢复成原始像素」—— 记账里存的是长宽比与窗口尺寸，没有图片的原始像素尺寸；
 * 一张 4K 截图按原尺寸铺在屏幕上本来也超出屏幕。
 */
async function fitToScreen(): Promise<void> {
  const current = record.value
  if (!current)
    return
  // screen 给的是 CSS 像素，乘上缩放才是与图片同一把尺子的物理像素
  const viewport = {
    width: window.screen.width * (window.devicePixelRatio || 1),
    height: window.screen.height * (window.devicePixelRatio || 1),
  }
  // 拿一个「比屏幕大得多、但比例正确」的假图去量，量出来就是能放下的最大尺寸
  const size = initialPinSize({ width: current.ratio * 10000, height: 10000 }, viewport)
  await apply({ width: size.width, height: size.height })
}
</script>

<template>
  <div
    class="pin"
    :class="{ 'is-hover': hovering, 'is-through': record?.clickThrough }"
    @pointerenter="hovering = true"
    @pointerleave="hovering = false"
    @wheel="onWheel"
    @contextmenu.prevent="onContextMenu"
    @dblclick="close"
  >
    <img
      v-if="imageUrl"
      class="pin__image"
      :src="imageUrl"
      :style="{ opacity }"
      alt=""
      data-tauri-drag-region
      draggable="false"
    >

    <div v-if="failure" class="pin__failure">
      {{ failure }}
    </div>

    <PinMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :click-through="record?.clickThrough === true"
      @act="(name) => {
        if (name === 'copy') void copy()
        else if (name === 'save') void saveAs()
        else if (name === 'through') void toggleThrough()
        else if (name === 'fit') void fitToScreen()
        else void close()
      }"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.pin {
  position: relative;
  width: 100%;
  height: 100%;
  /* 底必须透明：窗口是 transparent 的，CSS 这一层再压一层底色就等于把桌面挡掉了 */
  background: transparent;
}

.pin__image {
  display: block;
  width: 100%;
  height: 100%;
  /* 窗口尺寸就是按图片比例算出来的，fill 与 contain 等价，用 fill 免得多一次重采样 */
  object-fit: fill;
  /* 拖动时不要选中 / 拖成幽灵图 */
  user-select: none;
  -webkit-user-drag: none;
}

/*
 * 悬停时描一圈边：钉图没有窗口框架，不描边就分不清边界在哪（也提示「这块可以拖」）。
 * 只描边，不影响内容。
 */
.pin.is-hover {
  outline: 1px solid rgb(64 158 255 / 90%);
  outline-offset: -1px;
}

.pin.is-through {
  outline-color: rgb(250 173 20 / 90%);
}

.pin__failure {
  position: absolute;
  top: 6px;
  left: 6px;
  max-width: calc(100% - 12px);
  padding: 4px 8px;
  border-radius: 4px;
  background: rgb(160 40 40 / 94%);
  color: #fff;
  font-size: 12px;
}
</style>
