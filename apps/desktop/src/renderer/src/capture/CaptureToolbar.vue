<script setup lang="ts">
/**
 * 截图工具条：上面一排工具与动作，下面一排当前工具的参数。
 *
 * 只管摆和收（点哪一项就往上报），不碰任何截图状态 —— 选区 / 标注 / 撤销栈都在 CaptureApp 里。
 * 位置由父组件算好（贴着选区，摆不下就翻到上面），这里只负责长什么样。
 */
import type { AnnotationTool } from '@/types'
import { Check, Close, CopyDocument, Download, RefreshLeft, RefreshRight } from '@element-plus/icons-vue'
import { ANNOTATION_COLORS, ANNOTATION_TOOLS, MOSAIC_BLOCKS, STROKE_WIDTHS, TEXT_SIZES } from '@workbench/capture'
import { computed } from 'vue'
import { PIN_ICON, TOOL_ICONS } from './tool-icons'

const props = defineProps<{
  canUndo: boolean
  canRedo: boolean
  /** 正在存 / 正在复制：这一刻按钮点不动，免得同一个动作发两次 */
  busy: boolean
}>()
const emit = defineEmits<{
  undo: []
  redo: []
  cancel: []
  copy: []
  save: []
  pin: []
  done: []
}>()
const tool = defineModel<AnnotationTool | null>('tool', { required: true })
const color = defineModel<string>('color', { required: true })
const strokeWidth = defineModel<number>('strokeWidth', { required: true })
const block = defineModel<number>('block', { required: true })
const textSize = defineModel<number>('textSize', { required: true })

/** 当前工具的相关参数：颜色 / 线宽 / 档位各按工具露哪一排 */
const usesColor = computed(() => tool.value !== null && tool.value !== 'mosaic')
const usesStroke = computed(() => tool.value === 'rect' || tool.value === 'ellipse' || tool.value === 'arrow' || tool.value === 'pen' || tool.value === 'highlight')
const usesBlock = computed(() => tool.value === 'mosaic')
const usesTextSize = computed(() => tool.value === 'text')
const hasOptions = computed(() => usesColor.value || usesStroke.value || usesBlock.value || usesTextSize.value)

/** 再点一次同一个工具 = 取消它（回到「不是画，是挪选区」的那个状态） */
function pick(next: AnnotationTool): void {
  tool.value = tool.value === next ? null : next
}
</script>

<template>
  <div class="capture-toolbar">
    <div class="overlay-bar">
      <el-tooltip v-for="item in ANNOTATION_TOOLS" :key="item.tool" :content="item.name" placement="top">
        <button
          type="button"
          class="overlay-tool"
          :class="{ 'is-active': tool === item.tool }"
          @click="pick(item.tool)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6">
            <path :d="TOOL_ICONS[item.tool]" />
          </svg>
        </button>
      </el-tooltip>

      <span class="overlay-bar__sep" />

      <el-tooltip content="撤销（Ctrl+Z）" placement="top">
        <button type="button" class="overlay-tool" :disabled="!canUndo" @click="emit('undo')">
          <el-icon><RefreshLeft /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip content="重做（Ctrl+Shift+Z）" placement="top">
        <button type="button" class="overlay-tool" :disabled="!canRedo" @click="emit('redo')">
          <el-icon><RefreshRight /></el-icon>
        </button>
      </el-tooltip>

      <span class="overlay-bar__sep" />

      <el-tooltip content="取消（Esc）" placement="top">
        <button type="button" class="overlay-tool" @click="emit('cancel')">
          <el-icon><Close /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip content="复制到剪贴板（Enter）" placement="top">
        <button type="button" class="overlay-tool" :disabled="props.busy" @click="emit('copy')">
          <el-icon><CopyDocument /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip content="保存文件（Ctrl+S）" placement="top">
        <button type="button" class="overlay-tool" :disabled="props.busy" @click="emit('save')">
          <el-icon><Download /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip content="钉到屏幕（Ctrl+D）" placement="top">
        <button type="button" class="overlay-tool" :disabled="props.busy" @click="emit('pin')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6">
            <path :d="PIN_ICON" />
          </svg>
        </button>
      </el-tooltip>

      <span class="overlay-bar__sep" />

      <el-tooltip content="完成（Enter，与复制同一个动作）" placement="top">
        <button type="button" class="overlay-tool is-primary" :disabled="props.busy" @click="emit('done')">
          <el-icon><Check /></el-icon>
        </button>
      </el-tooltip>
    </div>

    <!--
      第二排：当前工具的参数。没有参数的工具（没有）就不画这一排 ——
      工具条因此始终贴着选区，不会白占一行高度。
    -->
    <div v-if="hasOptions" class="overlay-bar capture-toolbar__options">
      <template v-if="usesColor">
        <button
          v-for="item in ANNOTATION_COLORS"
          :key="item.value"
          type="button"
          class="overlay-swatch"
          :class="{ 'is-active': color === item.value }"
          :style="{ background: item.value }"
          :title="item.name"
          @click="color = item.value"
        />

        <span v-if="usesStroke || usesBlock || usesTextSize" class="overlay-bar__sep" />
      </template>

      <template v-if="usesStroke">
        <button
          v-for="item in STROKE_WIDTHS"
          :key="item.value"
          type="button"
          class="overlay-step"
          :class="{ 'is-active': strokeWidth === item.value }"
          @click="strokeWidth = item.value"
        >
          {{ item.name }}
        </button>
      </template>

      <template v-if="usesBlock">
        <button
          v-for="item in MOSAIC_BLOCKS"
          :key="item.value"
          type="button"
          class="overlay-step"
          :class="{ 'is-active': block === item.value }"
          @click="block = item.value"
        >
          {{ item.name }}
        </button>
      </template>

      <template v-if="usesTextSize">
        <button
          v-for="item in TEXT_SIZES"
          :key="item.value"
          type="button"
          class="overlay-step"
          :class="{ 'is-active': textSize === item.value }"
          @click="textSize = item.value"
        >
          {{ item.name }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.capture-toolbar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 工具条本身不接鼠标事件中的滚动 / 选中，按钮自己接 */
  font-size: 13px;
}

.capture-toolbar__options {
  /* 参数那一排比工具排矮一点，视觉上从属 */
  padding: 4px 6px;
}

/* 「完成」是主操作：给一层底色，一眼找得到 */
.overlay-tool.is-primary {
  background: var(--accent, #409eff);
  color: #fff;
}

.overlay-tool.is-primary:hover {
  background: var(--accent, #409eff);
  filter: brightness(1.1);
}

/* EP 的图标默认按自己那套字号，对齐到与自绘 SVG 一样大 */
.overlay-tool .el-icon {
  font-size: 17px;
}
</style>
