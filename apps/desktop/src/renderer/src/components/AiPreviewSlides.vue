<script setup lang="ts">
/**
 * 预览栏的 PPTX 画法：@aiden0z/pptx-renderer 在浏览器里解析并渲染，列表模式
 * （幻灯片从上到下排、带页码标）。**pdfjs 兜底必须显式关** —— EMF 媒体的降级渲染
 * 默认会去拿 pdf.js，那是不在任何已登记出口里的出网（见 AGENTS.md 第 1 节的联网边界）。
 * 库（连带它依赖的 echarts）是动态引的：不用这个画法就不进包。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PptxViewer } from '@aiden0z/pptx-renderer'
import { decodeBase64ToBuffer } from '@workbench/ai'

const props = defineProps<{ binary: string }>()

const host = ref<HTMLElement | null>(null)
const error = ref('')
/** 连点几个文件时只有最后一份有资格写回；旧的 viewer 先收干净（图表实例、监听都在它身上） */
let runId = 0
let viewer: PptxViewer | null = null

function dispose(): void {
  viewer?.destroy()
  viewer = null
}

async function load(): Promise<void> {
  const id = ++runId
  const box = host.value
  if (!box || !props.binary) return // 还没挂上 / 还没取回来：等下一次触发
  const buffer = decodeBase64ToBuffer(props.binary)
  if (!buffer) {
    error.value = '文件内容解不出来'
    return
  }
  dispose()
  error.value = ''
  try {
    const { PptxViewer } = await import('@aiden0z/pptx-renderer')
    if (id !== runId) return
    viewer = new PptxViewer(box, {
      fitMode: 'contain',
      pdfjs: false
    })
    await viewer.open(buffer, { renderMode: 'list', listOptions: { showSlideLabels: true } })
  } catch (err) {
    dispose()
    if (id === runId) error.value = err instanceof Error ? err.message : '这个文件画不出来'
  }
}

/**
 * **挂载后先画一次**（打开时内容往往在挂载前就取回来了，binary 之后不再变），
 * binary 再变（连点别的文件）跟着重画 —— 不能只靠 immediate 的 watch：它跑在
 * 挂载之前，容器还是 null，会静默地什么都没画。
 */
onMounted(() => {
  void load()
})

watch(
  () => props.binary,
  () => {
    void load()
  }
)

onBeforeUnmount(dispose)
</script>

<template>
  <div class="slides">
    <p v-if="error" class="slides__note is-fail">{{ error }}</p>
    <div v-show="!error" ref="host" class="slides__host" />
  </div>
</template>

<style scoped>
.slides {
  min-height: 100%;
}

/* 幻灯片是白底画面，容器在暗色下补白（viewer 只往容器里铺内容，外壳样式归我们） */
.slides__host {
  background: #fff;
}

.slides__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.slides__note.is-fail {
  color: var(--st-fail);
}
</style>
