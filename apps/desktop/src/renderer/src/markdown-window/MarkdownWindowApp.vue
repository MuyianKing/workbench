<script setup lang="ts">
import type { NoteDocument } from '@workbench/notes'
import { DArrowLeft, Document } from '@element-plus/icons-vue'
import { clampWidth } from '@workbench/appearance'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { bootstrapSnapshot } from '@/bootstrap'
import EmptyState from '@/components/EmptyState.vue'
import NoteEditor from '@/components/NoteEditor.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import { toggleOutlineRow } from '@/composables/use-outline-row-toggle'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { formatTimestamp } from '@/format'
import { confirmAction, notifyError, notifyInfo } from '@/notify'

/**
 * 独立 Markdown 编辑窗口（`markdown.html`）。
 *
 * 资源管理器「打开方式」选 Workbench 时，Rust 建这扇窗并把「打开的是哪个文件」
 * 记在会话里；窗口启动后只问一次上下文（文件名 / 正文 / mtime），之后正文与保存
 * 状态都由这里持有。**窗口里没有主界面、导航栏、目录树**，只有一块工作台面板：
 * 标题栏（文件名 + 自绘窗口键）+ 左侧大纲 + 正文 + 底栏（字数 / 保存状态 / 大纲开关）。
 *
 * 这扇窗是**无边框**的（`md_window.rs` 里 `decorations(false)`）：系统标题栏不画，
 * 三颗窗口键自绘在标题栏右端（规格照 TitleBar.vue，但那份引着 store，这里照抄不引）；
 * 标题栏与底栏都标了 `data-tauri-drag-region` 兼做拖动带（双击最大化由 Tauri 接管）。
 *
 * 三件自己管的事：
 *   1. **写盘串行**：一次输入防抖后的保存进入队列，下一笔等上一笔回来才发 ——
 *      否则两笔并发写盘会拿同一个 mtime 当基准，后一笔被 Rust 当成「别处改过」拒掉；
 *   2. **关闭握手**：Rust 先拦住窗口关闭并发 `markdown-window:flush`，这里把防抖里
 *      那一份交出去、等保存落地，再调 `markdownWindowClose` 真正销毁窗口；
 *      保存失败时问一句「仍然关闭 / 留在窗口」；
 *   3. **失败不静默**：保存失败的原因挂在底栏右侧，带一颗「重试」（重试取编辑器当前正文，
 *      因为失败那一次已经把 `saved` 推进过了，`flushAll` 不会重复交同一段）。
 *
 * 这扇窗**不上传图片**（NoteEditor 的 allowImageUpload=false）：它没有「笔记本」这一层，
 * 粘贴图片会把图推到图片仓库里一个临时层级，不是这个窗口里期待的动作。
 *
 * 面板本身是按「工作台」那一版设计做的：大纲在左、正文在右，中间一条发丝线；
 * 标题栏与底栏各 52 / 34px。**主题跟随主应用快照**，窗口里没有明暗开关 ——
 * 一次编辑通常不会中途去改主题。
 */
const loading = ref(true)
const loadError = ref('')
const saveError = ref('')
const note = ref<NoteDocument | null>(null)

/** 编辑器交上来的最新正文（字数与「保存中」状态用；note.content 是打开时那一版，不再更新） */
const content = ref('')
/** 最近一次落盘的 mtime（状态栏显示用）；与写盘基准 `mtimeMs` 同步更新 */
const savedAt = ref(0)
/** 队列里还没落盘的笔数：> 0 时保存状态显示「保存中…」 */
const pendingSaves = ref(0)
/** 左侧大纲是否摊开：窄窗口打开时先收起来，由底栏那颗按钮开关 */
const railOpen = ref(window.innerWidth >= 820)

/**
 * 窗口键（无边框改版后自绘，画在标题栏右端）：**已最大化时第三颗要画成「还原」**。
 * 状态由 Rust 从窗口事件推（拖边缘、双击拖动带、系统快捷键都算），按钮自己不去猜。
 */
const api = window.workbench
const maximized = ref(false)
let offWindowState: (() => void) | null = null

/**
 * 大纲栏的默认宽度：按工作台设计稿里的那两栏宽度取 320px。
 *
 * 拖动只改这一份本地值 —— 这扇窗不装 store、也不写 theme.json（笔记页那条
 * `noteRailWidth` 归主窗口），所以关窗后回到 320。区间沿用 noteRailWidth 的
 * 160–420（`clampWidth('noteRailWidth', …)` 取的同一档），不另定一套。
 */
const RAIL_WIDTH_DEFAULT = 320
const railWidth = ref(RAIL_WIDTH_DEFAULT)
/** 正在拖栏宽（把手据此常亮） */
const railResizing = ref(false)

/**
 * 拖大纲栏右缘调宽：与笔记页那条缝同一套骨架（`startPointerDrag`）。
 *
 * 栏在左边，指针往右拖才是拉宽，所以差值是正号；松手前一直被 `clampWidth('noteRailWidth', …)`
 * 夹在 160–420 之间。拖动态挂 `body.is-resizing-md-rail`（markdown.html 里兜住光标
 * 与文本选择 —— 独立窗口没引 global.css）。
 */
function onRailResize(event: PointerEvent): void {
  if (event.button !== 0)
    return
  event.preventDefault()

  const startWidth = railWidth.value
  railResizing.value = true
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: 'is-resizing-md-rail',
    onMove: (moveEvent, start) => {
      railWidth.value = clampWidth('noteRailWidth', startWidth + (moveEvent.clientX - start.x))
    },
    onEnd: (_last, cancelled) => {
      railResizing.value = false
      if (cancelled)
        railWidth.value = startWidth
    },
  })
}

/**
 * 打开时取一次明暗。独立窗口不跟主窗口实时联动（应用没有跨窗口的主题广播）：
 * 一次编辑通常不会中途去改主题；取的是首屏快照，与窗口创建时的设置一致。
 */
const theme = computed<'light' | 'dark'>(() => bootstrapSnapshot()?.theme ?? 'light')

const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)
/**
 * 左侧大纲栏的落点。
 *
 * 大纲那枚元素是 Vditor 建的，NoteEditor 在初始化完成后把它搬进这里（`outlineHost`）；
 * 这扇窗传了 `outlinePinned`，所以搬完之后直接打开、菜单里也不再有「大纲」一项。
 * 收起 / 展开是宽度过渡（栏始终留在 DOM 里），Vditor 不用重开一次大纲。
 */
const outlineRail = ref<HTMLElement | null>(null)

/**
 * 大纲条目整行收展：capture 阶段先于 Vditor 绑在根 `ul` 上的冒泡监听跑到，
 * 点在有子级的条目行任意位置就由这里收展（见 use-outline-row-toggle）。
 * 只有箭头上的点击需要拦下 —— 不拦的话 Vditor 自己那份也跑，同一下收展两次。
 */
function onOutlineRowClick(event: MouseEvent): void {
  if (toggleOutlineRow(event.target))
    event.stopPropagation()
}
/** 磁盘上那一版的 mtime（读盘 / 每次落盘后更新），下一笔写盘拿它当基准 */
let mtimeMs = 0
/** 串行保存队列：只保证顺序，失败由 saveError 展示，不在这里 reject */
let queue: Promise<void> = Promise.resolve()
/** 正在处理一次关闭请求：第二次点关闭只把兜底计时撤掉，别开第二份确认框 */
let handlingClose = false

/** 字数：不计空白；markdown 记号照算（这是正文本身，不是渲染后的字数） */
const countText = computed(() => {
  const count = content.value.replace(/\s/g, '').length
  return `${count.toLocaleString('zh-CN')} 字`
})

/**
 * 底栏右侧那一枚保存状态：失败 > 保存中 > 已保存。
 * `tone` 只用来换那枚小点的颜色（状态色，见 tokens.css）。
 */
const status = computed(() => {
  if (saveError.value)
    return { tone: 'fail' as const, text: '保存失败' }
  if (pendingSaves.value > 0)
    return { tone: 'run' as const, text: '保存中…' }
  return {
    tone: 'ok' as const,
    text: savedAt.value ? `已保存 · ${formatTimestamp(savedAt.value)}` : '已保存',
  }
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 编辑器的自定义快捷键（设置里的 editorHotkeys）：开窗时取一次，窗口里不跟主窗口实时联动 */
const editorHotkeys = ref<Record<string, string>>({})

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''

  // 编辑器快捷键从首屏快照拿（与 theme 同一条）：独立窗口不 initState，
  // getSettings() 返回的是适配层内存里的默认数据 —— 设置里配的自定义键只有
  // Rust 注入的快照里才有。快照那侧已经 sanitize 过，缺项退回内置键位
  editorHotkeys.value = bootstrapSnapshot()?.settings.editorHotkeys ?? {}

  const result = await window.workbench.markdownWindowContext()
  if (!result.ok || !result.data) {
    loadError.value = result.error ?? '读取失败'
    loading.value = false
    return
  }

  const context = result.data
  mtimeMs = context.mtimeMs
  savedAt.value = context.mtimeMs
  content.value = context.text
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

function enqueueSave(text: string): Promise<void> {
  pendingSaves.value += 1
  queue = queue.then(async () => {
    try {
      const result = await window.workbench.markdownWindowSave(text, mtimeMs || undefined)
      if (result.ok && typeof result.data === 'number') {
        mtimeMs = result.data
        savedAt.value = result.data
        saveError.value = ''
        return
      }
      saveError.value = result.error ?? '保存失败'
    }
    catch (error) {
      saveError.value = messageOf(error)
    }
  }).finally(() => {
    pendingSaves.value -= 1
  })
  return queue
}

/** 编辑器防抖后交上来的正文：进队列，不打断输入 */
function onChange(payload: { content: string }): void {
  content.value = payload.content
  void enqueueSave(payload.content)
}

/** 重试：取编辑器当前正文再发一次（失败那一次已经把 saved 推进过了） */
function retry(): void {
  const text = editorRef.value?.currentContent()
  if (text === undefined)
    return
  void enqueueSave(text)
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

/** 窗口键的关闭：不冲刷（防抖里那一份由输入路径交出去），直接走真销毁；失败如实说一句 */
function onCloseButton(): void {
  void api.markdownWindowClose().then((closed) => {
    if (!closed.ok)
      notifyError(closed.error ?? '关闭编辑窗口失败')
  })
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

let offFlush: (() => void) | null = null

onMounted(() => {
  offFlush = window.workbench.onMarkdownWindowFlushRequest(() => {
    void onFlushRequest()
  })
  // 先订阅再问一次当前值：订阅在前，不会漏掉挂载瞬间发生的最大化（与 TitleBar 同一条）
  offWindowState = window.workbench.onMarkdownWindowState((state) => {
    maximized.value = state.maximized
  })
  void window.workbench.markdownWindowIsMaximized().then((value) => {
    maximized.value = value
  })
  window.addEventListener('keydown', onKeydown)
  void load()
})

onBeforeUnmount(() => {
  offFlush?.()
  offFlush = null
  offWindowState?.()
  offWindowState = null
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="md-window">
    <section class="md-panel">
      <div v-if="loading" class="md-state">
        <PanelLoading text="正在打开…" />
      </div>

      <div v-else-if="loadError" class="md-state">
        <EmptyState
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
      </div>

      <template v-else-if="note">
        <!--
          标题栏：无边框改版后兼做窗口拖动带（data-tauri-drag-region 按下开始拖、双击
          最大化 / 还原，由 Tauri 注入的脚本接管 —— 所以这里**不要**再写 @dblclick 自己
          toggle 一次）。右端是自绘的三颗窗口键：图标按 Windows 规格手画（10px 见方、
          1px 细线），与 TitleBar.vue 同一套 —— 那份引着 store，这扇窗不装 store，照抄。
        -->
        <header class="md-head" data-tauri-drag-region>
          <span class="md-head__glyph" aria-hidden="true" data-tauri-drag-region>
            <el-icon><Document /></el-icon>
          </span>
          <span class="md-head__title" data-tauri-drag-region>
            <span class="md-head__name" :title="note.name">{{ note.name }}</span>
          </span>
          <span class="md-head__spacer" />
          <div class="wctl" role="group" aria-label="窗口控制">
            <button
              class="wctl__btn"
              type="button"
              title="最小化"
              aria-label="最小化"
              @click="api.markdownWindowMinimize()"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 5.5h10" />
              </svg>
            </button>

            <button
              class="wctl__btn"
              type="button"
              :title="maximized ? '向下还原' : '最大化'"
              :aria-label="maximized ? '向下还原' : '最大化'"
              @click="api.markdownWindowToggleMaximize()"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <!-- 还原：后窗只画上边与右边，露出被前窗压住的部分 -->
                <template v-if="maximized">
                  <path d="M2.5 0.5h7v7" />
                  <path d="M0.5 2.5h7v7h-7z" />
                </template>
                <rect v-else x="0.5" y="0.5" width="9" height="9" />
              </svg>
            </button>

            <button
              class="wctl__btn"
              type="button"
              title="关闭"
              aria-label="关闭"
              @click="onCloseButton"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
              </svg>
            </button>
          </div>
        </header>

        <div
          class="md-body"
          :class="{ 'is-rail-closed': !railOpen }"
          :style="{ '--rail-w': `${railWidth}px` }"
        >
          <!--
            左侧大纲：与笔记页那条栏同一副底子，收展由底栏那颗按钮控制。
            **始终留在 DOM 里**（不用 v-if / v-show）：收起只是把宽度过渡到 0，
            Vditor 的大纲元素不必重开，展开时也从它停的地方接着长出来。
          -->
          <aside
            ref="outlineRail"
            class="md-rail"
            :class="{ 'is-resizing': railResizing }"
            @click.capture="onOutlineRowClick"
          >
            <!-- 栏右缘的拖动把手：通高热区，静止时只露正中间那枚小竖条；随栏一起被裁掉 -->
            <span
              class="md-rail-resizer"
              :class="{ 'is-dragging': railResizing }"
              aria-hidden="true"
              @pointerdown="onRailResize"
            />
          </aside>

          <div class="md-doc">
            <NoteEditor
              ref="editorRef"
              :note="note"
              root=""
              :theme="theme"
              :read-only="false"
              :allow-image-upload="false"
              placeholder="写点什么…"
              :editor-hotkeys="editorHotkeys"
              :outline-host="outlineRail"
              outline-pinned
              @change="onChange"
              @open="onOpen"
            />
          </div>
        </div>

        <!--
          底栏：最左是大纲开关，接着保存状态，右端是字数。
          整条也标了拖动区：拖动标记只在直接按住的元素上生效，按钮自己不拖。
        -->
        <footer class="md-foot" data-tauri-drag-region>
          <el-tooltip :content="railOpen ? '收起大纲' : '展开大纲'" placement="top">
            <el-button
              text
              size="small"
              class="md-foot__btn"
              :class="{ 'is-collapsed': !railOpen }"
              :aria-label="railOpen ? '收起大纲' : '展开大纲'"
              :aria-pressed="railOpen"
              @click="railOpen = !railOpen"
            >
              <!-- 只留一枚左向箭头：收起时整枚转 180°（动画在样式里），不换图标 -->
              <el-icon><DArrowLeft /></el-icon>
            </el-button>
          </el-tooltip>
          <template v-if="saveError">
            <span class="md-foot__error" role="alert" :title="saveError">
              保存失败：{{ saveError }}
            </span>
            <el-button link size="small" @click="retry">
              重试
            </el-button>
          </template>
          <span
            v-else
            class="md-foot__status"
            :class="`is-${status.tone}`"
            role="status"
            aria-live="polite"
            data-tauri-drag-region
          >
            <span class="md-foot__dot" aria-hidden="true" data-tauri-drag-region />
            {{ status.text }}
          </span>
          <span class="md-foot__spacer" />
          <span class="md-foot__count" data-tauri-drag-region>{{ countText }}</span>
          <span class="md-foot__sep" aria-hidden="true" data-tauri-drag-region />
          <span class="md-foot__kind" data-tauri-drag-region>Markdown</span>
        </footer>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* 铺满整扇窗：外圈不留画布底色，面板自己就是窗口 */
.md-window {
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--bg-surface);
}

/**
 * 工作台面板：标题栏 + 正文 + 底栏，**直接贴到窗口四边**。
 * 不画外边框、圆角与卡片阴影 —— 这扇窗只有这一块内容，留一圈画布会像浮着的一张纸；
 * 层次全靠标题栏与底栏那两条发丝线。
 */
.md-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-surface);
}

/* 加载 / 打不开：面板里居中，与打开成功时同一块底 */
.md-state {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--sp-6);
}

.md-state > * {
  flex: 1 1 auto;
  min-height: 0;
}

/**
 * 标题栏：无边框后这一条兼做窗口拖动带（拖动标记在模板的 data-tauri-drag-region 上，
 * 右端三颗窗口键在 .wctl 里 —— 拖动脚本不会给按钮起拖）。下缘的发丝线照旧。
 */
.md-head {
  display: flex;
  flex: 0 0 52px;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 0 0 var(--sp-4);
  border-bottom: 1px solid var(--border);
  user-select: none;
}

.md-head__glyph {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-2);
}

.md-head__glyph .el-icon {
  font-size: 15px;
}

.md-head__title {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.md-head__name {
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-title);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.md-head__spacer {
  flex: 1 1 auto;
}

/* ---------- 窗口键（与 TitleBar.vue 同一套规格） ---------- */

.wctl {
  display: flex;
  align-self: stretch;
}

.wctl__btn {
  display: grid;
  place-items: center;
  /* Windows 11 的窗口按钮就是 46 宽、与标题栏同高 */
  width: 46px;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-2);
  /* 标题栏按钮在系统里是默认箭头，不是手型 */
  cursor: default;
  transition: background 0.12s ease, color 0.12s ease;
}

.wctl__btn:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

.wctl__btn:active {
  background: var(--border-strong);
}

/* 关闭那颗与系统一致：悬停红底白字 */
.wctl__btn.is-close:hover {
  background: var(--st-fail);
  color: #fff;
}

/* 顶到窗口边，全局那圈 outline 会顶出去被裁掉，改成都往内缩 */
.wctl__btn:focus-visible {
  outline-offset: -2px;
}

.wctl__btn svg {
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
}

.md-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.md-doc {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/**
 * 大纲栏：与笔记页那条栏同一副底子（发丝线 + 缩进 + 悬停底 + 行高），条目收展
 * 共用 use-outline-row-toggle。差别只有一处 —— 这扇窗里栏是面板的一部分（没有外间距）。
 *
 * 宽度取 `--rail-w`（默认 320，可拖；见 onRailResize）。**收起 / 展开是宽度过渡**：
 * 栏始终留在 DOM 里，`md-body.is-rail-closed` 时宽度、左右内边距与不透明度一起归零；
 * `min-width: 0` 不能省 —— flex 项的 `min-width: auto` 会让它停在内容的 min-content 宽度上，
 * 收不到 0。拖动时挂 `.is-resizing` 把过渡关掉，否则跟手会被 0.2s 的缓动拖慢。
 */
.md-rail {
  position: relative;
  flex: 0 0 auto;
  width: var(--rail-w, 320px);
  min-width: 0;
  min-height: 0;
  padding: var(--sp-4);
  overflow: hidden;
  border-right: 1px solid var(--border);
  opacity: 1;
  transition:
    width 0.2s var(--ease-out),
    padding 0.2s var(--ease-out),
    opacity 0.16s var(--ease-out),
    border-color 0.2s var(--ease-out);
}

.md-body.is-rail-closed .md-rail {
  width: 0;
  padding-right: 0;
  padding-left: 0;
  border-right-color: transparent;
  opacity: 0;
}

.md-rail.is-resizing {
  transition: none;
}

/**
 * 栏右缘的拖动把手：一条通高的热区，落在栏的右内边距里（不压正文的悬浮滚动条）。
 * 静止时不画东西，指针落上去 / 拖动中才露正中间那枚小竖条 —— 与笔记页那条缝同款。
 * 它是栏的子元素，所以收起时跟着栏一起被 `overflow: hidden` 裁掉。
 */
.md-rail-resizer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  width: var(--sp-4);
  cursor: ew-resize;
}

.md-rail-resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 8px;
  height: 34px;
  border: 1px solid var(--ink);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  opacity: 0;
  transform: translate(-50%, -50%);
  transition: opacity 0.15s ease, background-color 0.15s ease;
}

.md-rail-resizer:hover::after,
.md-rail-resizer.is-dragging::after {
  background: var(--ink);
  opacity: 1;
}

/*
 * 大纲本体（Vditor 自带的那枚元素，被 NoteEditor 搬到了这条栏里）。
 * 搬出来之后这些变量不再继承自 `.vditor`，关键的几枚（边线 / 字色 / 悬停色）
 * 要在栏这一层补一份，否则字会掉回浏览器默认色（与 NotesView 同一条）。
 */
.md-rail :deep(.vditor-outline) {
  --border-color: var(--border);
  --panel-background-color: transparent;
  --textarea-text-color: var(--ink-2);
  --toolbar-icon-color: var(--ink-3);
  --toolbar-icon-hover-color: var(--ink);
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--fs-meta);
}

/* 栏首「大纲」：与笔记页同一个行高（28）与左缘（8 内边距 + 10 箭头 + 4 间距） */
.md-rail :deep(.vditor-outline__title) {
  padding: 0 0 var(--sp-2) 22px;
  border-bottom: 1px solid var(--border);
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 28px;
}

/* 条目区：从分隔线下面一点开始，别贴着 */
.md-rail :deep(.vditor-outline__content) {
  padding-top: var(--sp-2);
}

/* 缩进：顶层不缩，子级按 12px 退一格 */
.md-rail :deep(.vditor-outline__content > ul) {
  padding-left: 0;
}

.md-rail :deep(.vditor-outline ul ul) {
  padding-left: var(--sp-3);
}

/* 每一条：4px + 19px 行高 = 27px 的点击片，与笔记页那条栏同一个口径 */
.md-rail :deep(.vditor-outline li > span) {
  padding: 4px var(--sp-2);
  border-radius: var(--r-sm);
  color: var(--ink-2);
  line-height: 19px;
  transition: background-color 0.15s var(--ease-out), color 0.15s var(--ease-out);
}

.md-rail :deep(.vditor-outline li > span:hover) {
  background-color: var(--bg-subtle);
  color: var(--ink);
}

/* 层级：顶层用正墨色，子级弱一档 */
.md-rail :deep(.vditor-outline__content > ul > li > span) {
  color: var(--ink-2);
}

.md-rail :deep(.vditor-outline ul ul li > span) {
  color: var(--ink-3);
}

/* 折叠箭头：小一号、弱一档；收起时 Vditor 自己加 `--close` 转半圈 */
.md-rail :deep(.vditor-outline li > span > svg) {
  width: 10px;
  height: 10px;
  margin-right: var(--sp-1);
  color: var(--ink-3);
  opacity: 0.75;
  transition: transform 0.15s var(--ease-out);
}

.md-rail :deep(.vditor-outline li > span > span) {
  line-height: 19px;
}

/**
 * 底栏：最左是大纲开关，接着保存状态（或失败原因 + 重试），右端是字数。
 * 失败提示从原来的右下角浮层挪到这里 —— 面板已经有底栏，不必再压一块浮层。
 * 整条兼做窗口拖动带（拖动标记在模板上；按钮自己不拖）。
 */
.md-foot {
  display: flex;
  flex: 0 0 34px;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  border-top: 1px solid var(--border);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  user-select: none;
}

/* 保存状态：一枚状态色小点 + 一句事实；文字不换行，窄窗口里失败原因先截断 */
.md-foot__status {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  white-space: nowrap;
}

.md-foot__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--st-idle);
}

.md-foot__status.is-ok .md-foot__dot {
  background: var(--st-ok);
}

.md-foot__status.is-run .md-foot__dot {
  background: var(--st-run);
}

.md-foot__status.is-fail {
  color: var(--st-fail);
}

.md-foot__status.is-fail .md-foot__dot {
  background: var(--st-fail);
}

/**
 * 大纲开关那颗箭头：收起 / 展开时整枚转 180°。
 * 只换 class 不换图标 —— 换 `DArrowLeft` / `DArrowRight` 两枚组件的话，
 * Vue 会直接替换节点，转不起来。
 */
.md-foot__btn {
  flex: 0 0 auto;
}

.md-foot__btn :deep(.el-icon) {
  transition: transform 0.2s var(--ease-out);
}

.md-foot__btn.is-collapsed :deep(.el-icon) {
  transform: rotate(180deg);
}

.md-foot__count {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.md-foot__sep {
  flex: 0 0 auto;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--border-strong);
}

.md-foot__kind {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
}

.md-foot__spacer {
  flex: 1 1 auto;
}

.md-foot__error {
  min-width: 0;
  overflow: hidden;
  color: var(--st-fail);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/**
 * 窗口里的正文排版：比笔记页松一档（15.5px / 1.8），单行限到约 1200px
 * （工作台设计稿红框那一档；窗口更宽时居中留白，更窄时自然铺满）。
 *
 * 限宽用左右内边距而不是 `max-width`：`pre.vditor-reset` 自己就是滚动容器，
 * 把它收窄会让滚动条离开面板右缘；内边距把文字挤到中间，滚动条留在原处。
 *
 * 这几条必须带 `!important`：Vditor 的 `setPadding` 会在 resize / 切模式时把 padding
 * 写成**行内样式**，而 `NoteEditor` 自己那两条左右 50px 也是 `!important`
 * （笔记页的口径）。选择器从 `.md-panel` 起、比它多一层，才压得住。
 * 底部不靠 padding：`NoteEditor` 已经用 `pre::after` 留了 120px（`--editor-bottom`），
 * 最后一行下面留一段空白（Typora 那种手感）。
 */
.md-panel .md-doc :deep(.vditor-ir pre.vditor-reset),
.md-panel .md-doc :deep(.vditor-wysiwyg pre.vditor-reset) {
  box-sizing: border-box;
  padding-top: calc(var(--sp-6) + var(--sp-3)) !important;
  padding-right: max(var(--sp-6), calc((100% - 1200px) / 2)) !important;
  padding-bottom: 0 !important;
  padding-left: max(var(--sp-6), calc((100% - 1200px) / 2)) !important;
  font-family: var(--font-ui);
  font-size: 15.5px;
  line-height: 1.8;
}

/* 标题的节奏：比 Vditor 自带的那套更松一点，贴近工作台设计稿 */
.md-doc :deep(.vditor-reset h1) {
  margin: 0 0 var(--sp-4);
  font-size: 1.9em;
  line-height: 1.35;
  letter-spacing: -0.01em;
}

.md-doc :deep(.vditor-reset h2) {
  margin: var(--sp-6) 0 var(--sp-2);
  font-size: 1.32em;
  line-height: 1.45;
}

.md-doc :deep(.vditor-reset h3) {
  margin: var(--sp-5) 0 var(--sp-1);
  font-size: 1.14em;
  line-height: 1.5;
}

.md-doc :deep(.vditor-reset h4) {
  margin: var(--sp-4) 0 var(--sp-1);
  font-size: 1em;
}

/* 系统开了「减少动态效果」：栏宽直接跳、箭头直接转向，不做过渡 */
@media (prefers-reduced-motion: reduce) {
  .md-rail,
  .md-foot__btn :deep(.el-icon),
  .md-rail-resizer::after {
    transition: none;
  }
}
</style>
