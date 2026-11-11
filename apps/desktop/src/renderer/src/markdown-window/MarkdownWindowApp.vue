<script setup lang="ts">
import type { NoteDocument } from '@workbench/notes'
import { Document } from '@element-plus/icons-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { bootstrapSnapshot } from '@/bootstrap'
import EmptyState from '@/components/EmptyState.vue'
import NoteEditor from '@/components/NoteEditor.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import { confirmAction, notifyError, notifyInfo } from '@/notify'

/**
 * 独立 Markdown 编辑窗口（`markdown.html`）。
 *
 * 资源管理器「打开方式」选 Workbench 时，Rust 建这扇窗并把「打开的是哪个文件」
 * 记在会话里；窗口启动后只问一次上下文（文件名 / 正文 / mtime），之后正文与保存
 * 状态都由这里持有。**窗口里没有主界面、导航栏、目录树**，只有正文编辑器。
 *
 * 三件自己管的事：
 *   1. **写盘串行**：一次输入防抖后的保存进入队列，下一笔等上一笔回来才发 ——
 *      否则两笔并发写盘会拿同一个 mtime 当基准，后一笔被 Rust 当成「别处改过」拒掉；
 *   2. **关闭握手**：Rust 先拦住窗口关闭并发 `markdown-window:flush`，这里把防抖里
 *      那一份交出去、等保存落地，再调 `markdownWindowClose` 真正销毁窗口；
 *      保存失败时问一句「仍然关闭 / 留在窗口」；
 *   3. **失败不静默**：保存失败的原因挂在右下角，带一颗「重试」（重试取编辑器当前正文，
 *      因为失败那一次已经把 `saved` 推进过了，`flushAll` 不会重复交同一段）。
 *
 * 这扇窗**不上传图片**（NoteEditor 的 allowImageUpload=false）：它没有「笔记本」这一层，
 * 粘贴图片会把图推到图片仓库里一个临时层级，不是这个窗口里期待的动作。
 */
const loading = ref(true)
const loadError = ref('')
const saveError = ref('')
const note = ref<NoteDocument | null>(null)

/**
 * 打开时取一次明暗。独立窗口不跟主窗口实时联动（应用没有跨窗口的主题广播）：
 * 一次编辑通常不会中途去改主题；取的是首屏快照，与窗口创建时的设置一致。
 */
const theme = computed<'light' | 'dark'>(() => bootstrapSnapshot()?.theme ?? 'light')

const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)
/** 磁盘上那一版的 mtime（读盘 / 每次落盘后更新），下一笔写盘拿它当基准 */
let mtimeMs = 0
/** 串行保存队列：只保证顺序，失败由 saveError 展示，不在这里 reject */
let queue: Promise<void> = Promise.resolve()
let offFlush: (() => void) | null = null
/** 正在处理一次关闭请求：第二次点关闭只把兜底计时撤掉，别开第二份确认框 */
let handlingClose = false

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''

  const result = await window.workbench.markdownWindowContext()
  if (!result.ok || !result.data) {
    loadError.value = result.error ?? '读取失败'
    loading.value = false
    return
  }

  const context = result.data
  mtimeMs = context.mtimeMs
  note.value = {
    // 独立窗口没有「相对笔记根」这一层，rel 用文件名占位：NoteEditor 只用它判断换篇，
    // 而这里永远只编辑一个文件
    rel: context.name,
    name: context.name,
    content: context.text,
    mtimeMs: context.mtimeMs,
  }
  loading.value = false
}

function enqueueSave(content: string): Promise<void> {
  queue = queue.then(async () => {
    try {
      const result = await window.workbench.markdownWindowSave(content, mtimeMs || undefined)
      if (result.ok && typeof result.data === 'number') {
        mtimeMs = result.data
        saveError.value = ''
        return
      }
      saveError.value = result.error ?? '保存失败'
    }
    catch (error) {
      saveError.value = messageOf(error)
    }
  })
  return queue
}

/** 编辑器防抖后交上来的正文：进队列，不打断输入 */
function onChange(payload: { content: string }): void {
  void enqueueSave(payload.content)
}

/** 重试：取编辑器当前正文再发一次（失败那一次已经把 saved 推进过了） */
function retry(): void {
  const content = editorRef.value?.currentContent()
  if (content === undefined)
    return
  void enqueueSave(content)
}

/**
 * Rust 发来的「窗口要关了」：先冲刷、等保存落地，再放行。
 *
 * 第一件事是告诉 Rust「收到了」（`markdownWindowCancelClose` 会撤掉它那条 10 秒兜底计时）——
 * 后面的保存与确认可能要等用户慢慢决定，不能让兜底线程在确认框还开着的时候把窗口销毁掉。
 * 真的被关了 / 用户选了留下，都由这里再走 `markdownWindowClose` 或直接返回。
 * 保存失败时问一句 —— 这一次关闭会丢掉编辑器里的修改；用户选「留在窗口」就什么都不做，
 * 窗口原地留着，下次点关闭再走一遍。
 *
 * `flushAll` 是同步的，它触发的 change 会立刻把队列接长，所以下面 `await queue` 拿到的
 * 是包含这一笔的那条链。
 */
async function onFlushRequest(): Promise<void> {
  // 第二次点关闭（确认框还开着）：只把新一次请求的兜底计时撤掉，关闭仍由第一份流程收尾
  if (handlingClose) {
    await window.workbench.markdownWindowCancelClose()
    return
  }

  handlingClose = true
  try {
    // 撤掉 Rust 的兜底计时：回执之后，关闭的节奏归这里
    await window.workbench.markdownWindowCancelClose()

    editorRef.value?.flushAll()
    await queue

    if (saveError.value) {
      const close = await confirmAction(
        `保存失败：${saveError.value}。仍然关闭会丢掉编辑器里的修改。`,
        '仍然关闭？',
        { confirmButtonText: '仍然关闭', cancelButtonText: '留在窗口' },
      )
      if (!close)
        return
    }

    const closed = await window.workbench.markdownWindowClose()
    if (!closed.ok)
      notifyError(closed.error ?? '关闭编辑窗口失败')
  }
  finally {
    handlingClose = false
  }
}

/** Ctrl+S：立刻把攒着的那一份交出去（不等 600ms 防抖） */
function onKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
    return
  event.preventDefault()
  editorRef.value?.flushAll()
}

/** 正文里的相对链接：这扇窗只编辑当前文件，跳不过去就如实说一句 */
function onOpen(): void {
  notifyInfo('这个窗口只编辑一个文件；链接指向的笔记请回笔记页打开')
}

onMounted(() => {
  offFlush = window.workbench.onMarkdownWindowFlushRequest(() => {
    void onFlushRequest()
  })
  window.addEventListener('keydown', onKeydown)
  void load()
})

onBeforeUnmount(() => {
  offFlush?.()
  offFlush = null
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="md-window">
    <PanelLoading v-if="loading" text="正在打开…" />

    <EmptyState
      v-else-if="loadError"
      :icon="Document"
      tone="error"
      text="打不开这个 Markdown 文件"
      :hint="loadError"
    >
      <template #actions>
        <el-button size="small" @click="load">
          重试
        </el-button>
      </template>
    </EmptyState>

    <NoteEditor
      v-else-if="note"
      ref="editorRef"
      :note="note"
      root=""
      :theme="theme"
      :read-only="false"
      :allow-image-upload="false"
      placeholder="写点什么…"
      @change="onChange"
      @open="onOpen"
    />

    <!-- 保存失败只挂一条浮层：成功时窗口里什么都不多出来（这一页只有正文） -->
    <div v-if="saveError" class="save-error" role="alert">
      <span class="save-error__text" :title="saveError">保存失败：{{ saveError }}</span>
      <el-button link size="small" @click="retry">
        重试
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.md-window {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: var(--sp-4) var(--sp-5);
  /* 底色归窗口：编辑器自己透明（与笔记页同一条，见 NoteEditor 样式） */
  background: var(--bg-canvas);
}

/*
 * 保存失败：贴在右下角，压着正文但不挡路（与 NoteEditor 的上传角标同一套做法）。
 * 颜色只借用失败状态色，不把整页染红。
 */
.save-error {
  position: absolute;
  right: var(--sp-4);
  bottom: var(--sp-4);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: min(560px, calc(100% - var(--sp-4) * 2));
  padding: var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-3);
  background: var(--bg-surface);
  border: 1px solid var(--st-fail);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  color: var(--st-fail);
  font-size: var(--fs-meta);
}

.save-error__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
