<script setup lang="ts">
import type { KbEntryMeta } from '@workbench/kb'
/**
 * 条目阅读（右栏点开一个条目之后）：只读渲染 Markdown 正文。
 *
 * 解析交给 MarkdownView（工作日志同款：`html: false` 的安全口径），这里补的是条目自己的
 * 元数据 —— 出处（source 指回的那份原始资料）、状态与更新日期。应用对条目是只读的：
 * 改内容去原始资料源头，再清洗一轮就会覆盖出来。
 *
 * 正文里的**站内链接**（条目之间用相对路径互链，见 shared/kb-lint.ts）往上交给父层去跳：
 * 这里只管把 MarkdownView 那个口子打开，解析成哪一条是父层的事。
 */
import { ArrowLeft } from '@element-plus/icons-vue'
import MarkdownView from '@/components/MarkdownView.vue'
import PanelLoading from '@/components/PanelLoading.vue'

defineProps<{
  entry: KbEntryMeta
  content: string
  loading: boolean
}>()

const emit = defineEmits<{ back: [], internal: [href: string] }>()

/** 出处那行的前缀：指回原始资料的与外部出处的说法不一样 */
function sourceLabel(entry: KbEntryMeta): string {
  return entry.source.startsWith('data/raw/') ? '原始资料' : '出处'
}
</script>

<template>
  <div class="kb-viewer">
    <header class="kb-viewer__head">
      <div class="kb-viewer__bar">
        <el-button size="small" :icon="ArrowLeft" @click="emit('back')">
          概览
        </el-button>
      </div>
      <h2 class="kb-viewer__title">
        {{ entry.title }}
      </h2>
      <p class="kb-viewer__meta">
        <template v-if="entry.status">
          （{{ entry.status === 'draft' ? '草稿' : entry.status === 'reviewed' ? '已核对' : entry.status }}）
        </template>
        <template v-if="entry.updated">
          更新于 {{ entry.updated }}
        </template>
      </p>
      <p v-if="entry.source" class="kb-viewer__source" :title="entry.source">
        {{ sourceLabel(entry) }}：<span class="mono">{{ entry.source }}</span>
      </p>
      <p v-if="entry.tags.length" class="kb-viewer__tags">
        <span v-for="tag in entry.tags" :key="tag" class="kb-viewer__tag">{{ tag }}</span>
      </p>
    </header>

    <div class="kb-viewer__body">
      <PanelLoading v-if="loading" text="正在读取条目…" />
      <MarkdownView
        v-else
        :source="content"
        internal-links
        class="kb-viewer__md"
        @internal="emit('internal', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.kb-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.kb-viewer__head {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.kb-viewer__bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.kb-viewer__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
  line-height: 1.4;
}

.kb-viewer__meta {
  display: flex;
  gap: var(--sp-3);
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.kb-viewer__source {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
  font-size: var(--fs-micro);
}

.kb-viewer__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
}

.kb-viewer__tag {
  padding: 0 6px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 18px;
}

.kb-viewer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
}

.kb-viewer__md {
  max-width: 860px;
}
</style>
