<script setup lang="ts">
/**
 * 预览栏的 DOCX 画法：docx-preview 在浏览器里把文件解出来画（样式、图片、表格都出自
 * 文件本身，不出网 —— 图片编成 blob URL、字体用文件里内嵌的那份）。库是动态引的：
 * 不用这个画法就不进包。base64 → 二进制的解码见 decodeBase64ToBuffer。
 */
import { onMounted, ref, watch } from 'vue'
import { decodeBase64ToBuffer } from '@workbench/ai'

const props = defineProps<{ binary: string }>()

const host = ref<HTMLElement | null>(null)
const error = ref('')
/** 连点几个文件时只有最后一份有资格写回 */
let runId = 0

async function load(): Promise<void> {
  const id = ++runId
  const box = host.value
  if (!box || !props.binary) return // 还没挂上 / 还没取回来：等下一次触发
  const buffer = decodeBase64ToBuffer(props.binary)
  if (!buffer) {
    error.value = '文件内容解不出来'
    return
  }
  error.value = ''
  box.innerHTML = ''
  try {
    const { renderAsync } = await import('docx-preview')
    if (id !== runId) return
    await renderAsync(buffer, box, box, {
      // 分页与页宽按文件里的版式出，超出的部分由预览栏的滚动容器兜
      inWrapper: true,
      breakPages: true
    })
  } catch (err) {
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
</script>

<template>
  <div class="doc">
    <p v-if="error" class="doc__note is-fail">{{ error }}</p>
    <div v-show="!error" ref="host" class="doc__host" />
  </div>
</template>

<style scoped>
.doc {
  min-height: 100%;
}

.doc__host {
  min-width: 0;
}

/* docx-preview 画的页是白底的（它带自己的 .docx-wrapper 外壳），这里给容器补个白底，
   暗色主题下页外的留白不至于黑成一片 */
.doc__host :deep(.docx-wrapper) {
  background: #fff;
  padding: 8px;
}

.doc__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.doc__note.is-fail {
  color: var(--st-fail);
}
</style>
