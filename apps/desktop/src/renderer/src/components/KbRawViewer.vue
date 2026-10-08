<script setup lang="ts">
import type { KbRawItem, KbRawViewKind } from '@workbench/kb'
import { ArrowLeft, FolderOpened } from '@element-plus/icons-vue'
import { kbRawStatusText } from '@workbench/kb'
/**
 * 原始数据查看（右栏点开一个原始文件之后）：文本类就地预览，其余说明去向。
 *
 * 看法由 shared/kb.ts 的 kbRawViewKind 按后缀分好（父层算好传进来）：markdown 用
 * MarkdownView 渲染（与条目阅读同一副 `html: false` 的安全口径），认得出的文本后缀
 * 按纯文本摆出来（等宽、原样，不做任何解析），预览不了的（pdf / docx / 图片…）就地
 * 说明并给「用系统默认程序打开」—— 应用对原始数据只读，看与不看都不改它。
 * 读失败（权限 / 编码）不算致命：原因摆进来，外部打开那条路还在。
 */
import { computed } from 'vue'
import MarkdownView from '@/components/MarkdownView.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import { formatTimestamp } from '@/format'

const props = defineProps<{
  item: KbRawItem
  kind: KbRawViewKind
  content: string
  loading: boolean
  error: string
}>()

const emit = defineEmits<{ back: [], open: [] }>()

/**
 * 资料的真实位置：库里那份就是「知识库文件夹 + 逻辑路径」，不必多摆一行；
 * 在来源文件夹里时它是用户自己的目录，摆出来才找得到。
 */
const realPath = computed(() => {
  const trimmed = props.item.abs.replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed && !trimmed.endsWith(props.item.rel) ? props.item.abs : ''
})
</script>

<template>
  <div class="kb-raw-viewer">
    <header class="kb-raw-viewer__head">
      <div class="kb-raw-viewer__bar">
        <el-button size="small" :icon="ArrowLeft" @click="emit('back')">
          概览
        </el-button>
        <el-tooltip content="用系统默认程序打开" placement="bottom">
          <el-button size="small" :icon="FolderOpened" @click="emit('open')" />
        </el-tooltip>
      </div>
      <h2 class="kb-raw-viewer__title">
        {{ item.name }}
      </h2>
      <p class="kb-raw-viewer__meta">
        <span class="mono" :title="item.rel">{{ item.rel }}</span>
      </p>
      <!-- 资料在来源文件夹里时把真实位置也摆出来：它是用户自己的目录，找得到才放心改 -->
      <p v-if="realPath" class="kb-raw-viewer__meta">
        <span class="mono" :title="realPath">{{ realPath }}</span>
      </p>
      <p class="kb-raw-viewer__meta">
        <span>{{ kbRawStatusText(item.status) }}</span>
        <span>更新于 {{ formatTimestamp(item.mtimeMs) }}</span>
        <span v-if="item.entryRels.length" :title="item.entryRels.join('\n')">
          {{ item.entryRels.length }} 个条目整理自它
        </span>
      </p>
    </header>

    <div class="kb-raw-viewer__body">
      <PanelLoading v-if="loading" text="正在读取原始数据…" />

      <div v-else-if="error" class="kb-raw-viewer__fallback">
        <p>{{ error }}</p>
        <el-button :icon="FolderOpened" @click="emit('open')">
          用系统默认程序打开
        </el-button>
      </div>

      <MarkdownView v-else-if="kind === 'markdown'" :source="content" class="kb-raw-viewer__md" />

      <pre v-else-if="kind === 'text'" class="kb-raw-viewer__text mono">{{ content }}</pre>

      <div v-else class="kb-raw-viewer__fallback">
        <p>这个格式在应用里预览不了。</p>
        <el-button type="primary" :icon="FolderOpened" @click="emit('open')">
          用系统默认程序打开
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kb-raw-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.kb-raw-viewer__head {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  /* 与条目阅读同一副壳子：左与顶都不留（右栏 .kb-view__right 已经给过内边距），右边留给滚动条 */
  padding: 0 var(--sp-3) var(--sp-2) 0;
  border-bottom: 1px solid var(--border);
}

.kb-raw-viewer__bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.kb-raw-viewer__title {
  margin: 0;
  color: var(--ink);
  font-size: var(--fs-title);
  line-height: 1.4;
}

.kb-raw-viewer__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin: 0;
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.kb-raw-viewer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 左不留：与上面那行标题同一条竖线（与条目阅读同一个口径） */
  padding: var(--sp-3) var(--sp-3) var(--sp-3) 0;
}

.kb-raw-viewer__md {
  max-width: 860px;
}

.kb-raw-viewer__text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--fs-meta);
  line-height: 1.7;
  color: var(--ink-2);
}

/* 预览不了 / 读失败：同一副居中说明 + 一条去路 */
.kb-raw-viewer__fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  height: 100%;
  text-align: center;
}

.kb-raw-viewer__fallback p {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-body);
  line-height: 1.7;
}
</style>
