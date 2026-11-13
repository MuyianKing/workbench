<script setup lang="ts">
import { Document } from '@element-plus/icons-vue'
import { shortHash } from '@workbench/git'
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import GitChangedFiles from '@/components/git/GitChangedFiles.vue'
import GitPatchView from '@/components/git/GitPatchView.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import PanelResizer from '@/components/PanelResizer.vue'
import { formatTimestamp } from '@/format'
import { useGitStore } from '@/stores/git'
import { useSettingsStore } from '@/stores/settings'
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
</script>

<template>
  <section class="diff-pane">
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
            <span v-if="store.compareBase" class="diff-head__subject" :title="store.compareBase.subject">
              {{ store.compareBase.subject || '（无提交说明）' }}
            </span>
            <span v-if="store.compareTarget" class="diff-head__subject" :title="store.compareTarget.subject">
              {{ store.compareTarget.subject || '（无提交说明）' }}
            </span>
          </div>
        </template>

        <template v-else-if="store.detail">
          <!-- 提交说明按 Markdown 渲染（作者常写列表 / 行内代码 / 链接）：
               标题仍是第一行，正文在下面那个定高滚动的盒子里，安全口径见 MarkdownView -->
          <MarkdownView
            class="diff-head__subject diff-head__subject--title"
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

        <GitPatchView
          v-model:view="store.patchView"
          class="diff-pane__patch"
          :file="activeFile"
          :patch="store.patch"
          :loading="store.patchLoading"
          :error="store.patchError"
        />

        <!-- 文件清单与补丁之间那条缝：宽度住 theme.json 的 gitFilesWidth -->
        <PanelResizer
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
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  height: 100%;
  min-width: 0;
  min-height: 0;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>
