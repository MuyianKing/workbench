<script setup lang="ts">
import { Document } from '@element-plus/icons-vue'
import { shortHash } from '@workbench/git'
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import GitChangedFiles from '@/components/git/GitChangedFiles.vue'
import GitPatchView from '@/components/git/GitPatchView.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { formatTimestamp } from '@/format'
import { useGitStore } from '@/stores/git'
import { useSettingsStore } from '@/stores/settings'
/** 全屏期间把态报给宿主（GitView）：分隔条（PanelResizer，z 10）比全屏卡片（z 9）高，
 * 不藏的话会从卡片上戳出来 —— 它的 tooltip 更是 2000 起。 */
const emit = defineEmits<{ fullscreen: [value: boolean] }>()
/**
 * 右侧：一次提交（相对第一父提交）或两个提交之间的差异。
 *
 * 上半截是「谁跟谁比、改了什么」——单个提交写标题 / 作者 / 时间 / 根提交 / 合并提交，
 * 对比写两头的短号与各自的标题；下半截分成两列：左侧是改动文件清单（竖排、可滚动），
 * 右侧是选中文件的补丁，中间那条缝可以左右拖（宽度住在 theme.json 的 `gitFilesWidth`）。
 * 两者不会同时出现：store 在选中提交或开始对比时会把另一边清掉。
 */
const store = useGitStore()
const settings = useSettingsStore()

/** 改动文件清单的宽度来自 theme.json，补丁区吃掉剩余宽度 */
const bodyStyle = computed(() => ({
  gridTemplateColumns: `${settings.themeConfig.gitFilesWidth}px minmax(0, 1fr)`,
}))

const hasSelection = computed(() => Boolean(store.detail || store.compare))

/** 当前选中文件的改动信息：补丁栏首行显示路径与增删数用 */
const activeFile = computed(() =>
  store.activeFiles.find(file => file.path === store.selectedFile) ?? null,
)

/** 提交说明的正文部分（去掉第一行标题）：标题已经单独显示了，正文块里不重复 */
const bodyRest = computed(() => {
  const detail = store.detail
  if (!detail)
    return ''
  return detail.body.split('\n').slice(1).join('\n').trim()
})

// ---------- 代码区（补丁）全屏 ----------

/** 全屏的是补丁区本身：提交说明与文件清单留在原地（被盖住），代码铺满内容区。
 * 页面内的布局态，不进 store；换页即收（onDeactivated）。 */
const patchFull = ref(false)
const patchWrap = ref<HTMLElement | null>(null)

/**
 * `.git-view` 的盒子：全屏后槽被 Teleport 到 body，`closest` 就找不到了 ——
 * 进全屏时（此刻还在原地）先取一次存下来，之后缩放窗口 / 收展导航才钉得动。
 */
let viewEl: HTMLElement | null = null

/**
 * 全屏落点 = `.git-view` 的盒子（顶栏以下、导航栏右侧的内容区）。导航栏是 int32 上限
 * 的层级（弹层开着它也在最上），压不过 —— 铺到它右侧为止。量出来钉 inline inset，
 * 不照 `--w-nav` 摆：导航收起时那个变量不跟着变（收起动画动的是导航自己的 width）。
 */
function pinPatchRect(): void {
  const el = patchWrap.value
  if (!el)
    return
  viewEl = el.closest('.git-view') ?? viewEl
  if (!viewEl)
    return
  const rect = viewEl.getBoundingClientRect()
  el.style.top = `${rect.top}px`
  el.style.right = `${window.innerWidth - rect.right}px`
  el.style.bottom = `${window.innerHeight - rect.bottom}px`
  el.style.left = `${rect.left}px`
}

function clearPatchRect(): void {
  const el = patchWrap.value
  if (!el)
    return
  el.style.top = ''
  el.style.right = ''
  el.style.bottom = ''
  el.style.left = ''
}

/**
 * FLIP：先量起点（栏内那格），换完布局（Teleport 挪到 body + fixed）再量终点，
 * 用 `transform-origin: top left` 把代码区平移 + 缩放回起点再放它归位 —— 看上去就是
 * 代码区朝着左上角长满过去，收起时对称缩回右栏。文本在 0.22s 里会被带着缩放，
 * FLIP 固有形态；缓动取 --ease-out（起步快收尾缓）。
 */
function flipPatch(apply: () => void): void {
  const el = patchWrap.value
  if (!el) {
    apply()
    return
  }
  const first = el.getBoundingClientRect()
  apply()
  void nextTick(() => {
    const last = el.getBoundingClientRect()
    if (!last.width || !last.height)
      return
    const dx = first.left - last.left
    const dy = first.top - last.top
    const sx = first.width / last.width
    const sy = first.height / last.height
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
    // 强制回流：让「起点那一帧」先落住，清掉 transform 时才有东西可过渡
    void el.getBoundingClientRect()
    el.style.transition = ''
    el.style.transform = ''
  })
}

/** 全屏态的惟一写入口：状态与「告诉宿主」绑在一起 */
function setPatchFull(value: boolean): void {
  patchFull.value = value
  emit('fullscreen', value)
}

function togglePatchFull(): void {
  // 没选文件时补丁栏（连同它的全屏开关）根本不渲染，这里兜一道
  if (!activeFile.value)
    return
  flipPatch(() => {
    setPatchFull(!patchFull.value)
    if (patchFull.value)
      pinPatchRect()
    else
      clearPatchRect()
  })
}

/** 全屏期间按 Esc 收 */
function onEscKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && patchFull.value)
    togglePatchFull()
}

function onWindowResize(): void {
  if (patchFull.value)
    pinPatchRect()
}

/** 导航栏收起 / 展开是 0.2s 的过渡：结束时再钉一次，全屏的代码区跟着让位 / 收回来 */
function onNavToggle(): void {
  if (!patchFull.value)
    return
  pinPatchRect()
  window.setTimeout(pinPatchRect, 240)
}

watch(() => settings.settings.navHidden, onNavToggle)

onMounted(() => {
  window.addEventListener('keydown', onEscKey)
  window.addEventListener('resize', onWindowResize)
})

onBeforeUnmount(() => {
  viewEl = null
  window.removeEventListener('keydown', onEscKey)
  window.removeEventListener('resize', onWindowResize)
})

/** 换页（KeepAlive 挂起）必须收掉全屏：fixed 面板会盖在别的页上面 */
onDeactivated(() => {
  if (!patchFull.value)
    return
  setPatchFull(false)
  clearPatchRect()
})
</script>

<template>
  <section class="diff-pane page">
    <PanelLoading v-if="store.activeLoading && !hasSelection" text="正在读取提交…" />

    <EmptyState
      v-else-if="!hasSelection"
      compact
      :icon="Document"
      text="还没有选中提交"
      hint="在中间选一个提交；点「对比」可以选两个提交互相比较"
    />

    <template v-else>
      <header class="diff-head">
        <template v-if="store.compare">
          <div class="diff-head__row">
            <span class="diff-head__tag">对比</span>
            <span class="mono">{{ shortHash(store.compare.base) }}</span>
            <span class="diff-head__arrow">→</span>
            <span class="mono">{{ shortHash(store.compare.target) }}</span>
          </div>
          <div class="diff-head__subjects">
            <span v-if="store.compareBase" class="diff-head__subject truncate" :title="store.compareBase.subject">
              {{ store.compareBase.subject || '（无提交说明）' }}
            </span>
            <span v-if="store.compareTarget" class="diff-head__subject truncate" :title="store.compareTarget.subject">
              {{ store.compareTarget.subject || '（无提交说明）' }}
            </span>
          </div>
        </template>

        <template v-else-if="store.detail">
          <!-- 提交说明按 Markdown 渲染（作者常写列表 / 行内代码 / 链接）：
               标题仍是第一行，正文在下面那个定高滚动的盒子里，安全口径见 MarkdownView -->
          <MarkdownView
            class="diff-head__subject diff-head__subject--title truncate"
            :source="store.detail.subject || '（无提交说明）'"
            style="font-size: var(--fs-title); line-height: 1.45"
          />
          <div class="diff-head__meta">
            <span class="mono">{{ shortHash(store.detail.hash) }}</span>
            <span>{{ store.detail.author || '未知作者' }}</span>
            <span>{{ formatTimestamp(store.detail.time) }}</span>
            <span v-if="store.detail.isRoot" class="diff-head__badge">根提交</span>
            <span v-if="store.detail.isMerge" class="diff-head__badge">合并提交 · 对比第一父提交</span>
          </div>
          <MarkdownView
            v-if="bodyRest"
            class="diff-head__body"
            :source="bodyRest"
          />
        </template>
      </header>

      <p v-if="store.activeError" class="diff-error">
        {{ store.activeError }}
      </p>

      <div v-if="store.activeFiles.length" class="diff-body" :style="bodyStyle">
        <aside class="diff-files">
          <GitChangedFiles
            :files="store.activeFiles"
            :active-path="store.selectedFile"
            :truncated="store.activeTruncated"
            @select="store.selectFile"
          />
        </aside>

        <!--
          代码区（补丁）全屏：Teleport 到 body 才逃得开 .panel 那层毛玻璃 —— backdrop-filter 会把
          后代的 fixed 劫持成自己的 containing block。平时 disabled 原地渲染，全屏时挪到 body、钉到
          `.git-view` 的盒子上（提交说明与文件清单留在原地，被盖住）；Esc 收、换页自动收（见 script）。
        -->
        <Teleport to="body" :disabled="!patchFull">
          <!-- 卡片间距在这里显式带一份：全屏后槽挪到了 body 上，`.app` 上那个 --card-gap 继承不过来 -->
          <div
            ref="patchWrap"
            class="diff-patch-slot"
            :class="{ 'diff-patch-slot--full': patchFull }"
            :style="{ '--card-gap': `${settings.cardGap}px` }"
          >
            <GitPatchView
              v-model:view="store.patchView"
              :file="activeFile"
              :files="store.activeFiles"
              :patch="store.patch"
              :loading="store.patchLoading"
              :error="store.patchError"
              :full="patchFull"
              @toggle-full="togglePatchFull"
              @select="store.selectFile"
            />
          </div>
        </Teleport>

        <!-- 文件清单与补丁之间那条缝：宽度住 theme.json 的 gitFilesWidth。全屏期间要藏
             （PanelResizer 比全屏卡片高，会戳出来） -->
        <PanelResizer
          v-show="!patchFull"
          :width="settings.themeConfig.gitFilesWidth"
          body-class="is-resizing-git-pane"
          title="拖动调整改动文件清单宽度"
          :style="{
            '--resizer-inset': 'calc((var(--sp-2) - var(--card-gap, 10px)) / 2)',
            '--tree-w': `${settings.themeConfig.gitFilesWidth}px`,
          }"
          @move="width => settings.setThemeWidth('gitFilesWidth', width)"
          @end="() => void settings.commitThemeWidth('gitFilesWidth')"
        />
      </div>
      <p v-else-if="!store.activeLoading" class="diff-empty">
        没有改动文件
      </p>
    </template>
  </section>
</template>

<style scoped>
.diff-pane {
  gap: var(--sp-2);
  min-width: 0;
  padding: var(--sp-3);
  overflow: hidden;
}

.diff-head {
  flex-shrink: 0;
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.diff-head__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.diff-head__tag {
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--ink-2);
  font-size: var(--fs-micro);
}

.diff-head__arrow {
  color: var(--ink-3);
}

.diff-head__subjects {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  margin-top: var(--sp-1);
}

.diff-head__subject {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.diff-head__subject--title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
  font-weight: 600;
  overflow-wrap: anywhere;
  white-space: normal;
}

/* 标题是一行 Markdown：里面那个段落不要带正文的段间距 */
.diff-head__subject--title :deep(p) {
  margin: 0;
}

.diff-head__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.diff-head__badge {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--bg-subtle);
  color: var(--ink-3);
}

/* 完整提交说明（标题之外还有正文时才出）：定高滚动，不把差异挤下去 */
/* 完整提交说明（标题之外还有正文时才出）：定高滚动，不把差异挤下去。
   字号 / 行高 / 换行由 MarkdownView 的 .md 管，这里只管这只盒子。 */
.diff-head__body {
  max-height: 16em;
  overflow: auto;
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
}

.diff-error {
  flex-shrink: 0;
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-micro);
}

.diff-empty {
  flex-shrink: 0;
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 下半截两列：左竖排文件清单、右补丁；两侧各自滚动，互不挤占 */
.diff-body {
  position: relative;
  display: grid;
  flex: 1;
  /* 列宽由 bodyStyle 给（theme.json 里的 gitFilesWidth，拖动分隔条改） */
  gap: var(--sp-2);
  min-height: 0;
}

.diff-files {
  min-width: 0;
  min-height: 0;
  padding-right: var(--sp-2);
  border-right: 1px solid var(--border);
}

.diff-pane__patch {
  min-width: 0;
  min-height: 0;
}

/* 补丁区的槽：平时是 .diff-body 网格里普通的一格，全屏时被 Teleport 挪到 body */
.diff-patch-slot {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* 全屏 FLIP 只动 transform（落点钉在 inline inset 上）；双向都得有过渡可放 */
  transition: transform 0.22s var(--ease-out);
}

/**
 * 全屏态：fixed 钉到 `.git-view` 的盒子（inline inset，见 pinPatchRect）。层级取 9 ——
 * 顶栏是 10（毛玻璃要压住内容），导航栏是 int32 上限（弹层开着它也在最上），全屏铺不到
 * 它，铺到它右侧为止。**这层自己不上底色**：外层再垫一块画布就是多余的又一层。
 *
 * 落点是「导航栏那张卡片的外壳」：**顶边与它齐平（不留缝）**，**左 / 右 / 底各留一道
 * --card-gap**（左那条就是与导航栏卡片之间的间距，右 / 底与页面四周同一档，取设置里
 * 的「卡片间距」）；露出来的是底下的页面与壁纸；FLIP 过渡中缩放露出的同样是页面，
 * 不会闪白（.app 整块在底下垫着）。
 */
.diff-patch-slot--full {
  position: fixed;
  z-index: 9;
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
  transform-origin: top left;
}
</style>
