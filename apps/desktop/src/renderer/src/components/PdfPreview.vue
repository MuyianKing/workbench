<script setup lang="ts">
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import { decodeBase64ToBuffer } from '@workbench/ai'
/**
 * PDF 画法：pdf.js（pdfjs-dist）在浏览器里解析、一页一页画到画布上（邮件附件里的
 * 「在应用里看」用它，见 MailAttachmentDialog）。**不换成 iframe / embed** ——
 * webview 里内嵌系统 PDF 查看器靠不住，而 pdf.js 画出来的东西在哪都一样。
 *
 * 三件东西都随包带、不出网（见 scripts/sync-pdfjs-assets.mjs）：解析本体是动态引的
 * （不用这个画法就不进包），cmaps / 标准字体 / wasm 是 pdf.js 运行时按下面几个基址
 * 去取的静态资源 —— 基址走 `import.meta.env.BASE_URL`（相对基址，打包后也从产物根取），
 * 少了它们中文正文与扫描件会画不出来。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ binary: string }>()

/** 画面与分页条上面的那一条：滚动与宽度都归它（弹窗那块地方多高，它就多高） */
const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const error = ref('')
const page = ref(1)
const total = ref(0)
/** 连点几个文件时只有最后一份有资格写回 */
let runId = 0
let doc: PDFDocumentProxy | null = null
/** 收工要连 worker 一起放掉 —— v6 里 destroy 长在 loading task 上（文档对象上只有 cleanup） */
let loading: PDFDocumentLoadingTask | null = null
let task: RenderTask | null = null

const BASE = `${import.meta.env.BASE_URL}pdfjs/`

function dispose(): void {
  task?.cancel()
  task = null
  void loading?.destroy()
  loading = null
  doc = null
}

/** 一页画满整宽（比容器宽就缩、窄的不放大到两倍以上），按设备像素比出图 */
async function draw(): Promise<void> {
  const box = host.value
  const target = canvas.value
  if (!doc || !box || !target)
    return
  const id = runId
  const proxy = await doc.getPage(page.value)
  if (id !== runId)
    return
  const base = proxy.getViewport({ scale: 1 })
  const ratio = window.devicePixelRatio || 1
  const viewport = proxy.getViewport({ scale: Math.min(box.clientWidth / base.width, 2) * ratio })
  task?.cancel()
  target.width = Math.floor(viewport.width)
  target.height = Math.floor(viewport.height)
  target.style.width = `${Math.floor(viewport.width / ratio)}px`
  target.style.height = `${Math.floor(viewport.height / ratio)}px`
  const current = proxy.render({ canvas: target, viewport })
  task = current
  try {
    await current.promise
  }
  finally {
    if (task === current)
      task = null
  }
}

async function load(): Promise<void> {
  const id = ++runId
  const box = host.value
  if (!box || !props.binary)
    return // 还没挂上 / 还没取回来：等下一次触发
  const buffer = decodeBase64ToBuffer(props.binary)
  if (!buffer) {
    error.value = '文件内容解不出来'
    return
  }
  dispose()
  error.value = ''
  total.value = 0
  page.value = 1
  try {
    const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
    if (id !== runId)
      return
    // worker 与那几样静态资源同一条口径：都从产物里取，不去外面拿
    const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    if (id !== runId)
      return
    GlobalWorkerOptions.workerSrc = worker
    loading = getDocument({
      data: new Uint8Array(buffer),
      cMapUrl: `${BASE}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${BASE}standard_fonts/`,
      wasmUrl: `${BASE}wasm/`,
      iccUrl: `${BASE}iccs/`,
    })
    doc = await loading.promise
    if (id !== runId)
      return
    total.value = doc.numPages
    box.scrollTop = 0
    await draw()
  }
  catch (err) {
    if (id !== runId)
      return
    dispose()
    const name = (err as { name?: string } | null)?.name
    error.value = name === 'PasswordException' ? '这份 PDF 有密码，打不开' : '这个文件画不出来'
  }
}

function step(delta: number): void {
  const next = page.value + delta
  if (next < 1 || next > total.value)
    return
  page.value = next
  const box = host.value
  if (box)
    box.scrollTop = 0
  void draw()
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
  },
)

onBeforeUnmount(dispose)
</script>

<template>
  <div class="pdf">
    <p v-if="error" class="pdf__note is-fail">
      {{ error }}
    </p>
    <template v-else>
      <!-- 分页条只在多页时出现；单页的 PDF 是绝大多数，那一栏是纯噪音 -->
      <div v-if="total > 1" class="pdf__bar">
        <el-tooltip content="上一页" placement="top">
          <el-button size="small" text :icon="ArrowLeft" :disabled="page <= 1" @click="step(-1)" />
        </el-tooltip>
        <span class="pdf__count">{{ page }} / {{ total }}</span>
        <el-tooltip content="下一页" placement="top">
          <el-button size="small" text :icon="ArrowRight" :disabled="page >= total" @click="step(1)" />
        </el-tooltip>
      </div>
      <div ref="host" class="pdf__host">
        <canvas ref="canvas" class="pdf__page" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 弹窗给多高就多高：滚动收在画面那一块里，翻页时页首能自己回到顶（见 step） */
.pdf {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.pdf__bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding-bottom: var(--sp-1);
}

.pdf__count {
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}

/* 页是白底画面（pdf.js 自己铺白），页外留一截底色，免得白页贴着弹窗边 */
.pdf__host {
  flex: 1;
  min-height: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  overflow: auto;
  padding-bottom: var(--sp-2);
}

.pdf__page {
  display: block;
  border-radius: var(--r-xs);
  box-shadow: 0 1px 6px rgb(0 0 0 / 18%);
}

.pdf__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.pdf__note.is-fail {
  color: var(--st-fail);
}
</style>
