<script setup lang="ts">
import type { GitChangedFile } from '@workbench/git'
import { statusLabel } from '@workbench/git'
import { nextTick, ref, watch } from 'vue'
/**
 * 一次提交 / 一次对比里改动了哪些文件：差异区左侧的竖排清单。
 *
 * 每一行是「状态字母 + 路径 + 增删行数」；二进制文件没有行数，写「二进制」。
 * 点一行就是看那个文件的补丁（父组件负责取）。文件多时纵向滚动 —— 横排文件条
 * 在十几个文件时就要来回拖，竖向清单与提交列表同一套读法，也放得下完整路径。
 *
 * 状态色只借 `--st-ok`（新增）/ `--st-fail`（删除）表达增删语义，其余照旧灰度 ——
 * 与差异表的红绿是同一套读法。
 */
const props = defineProps<{
  files: GitChangedFile[]
  /** 当前打开的那个文件 */
  activePath: string
  /** 文件太多，宿主只回了一部分 */
  truncated: boolean
}>()

const emit = defineEmits<{ select: [path: string] }>()

const scrollRef = ref<HTMLElement | null>(null)

/**
 * 选中的那一行滚进可视区：文件多时默认打开的文件可能排在几十行之后
 * （左栏点开的文件在清单里不一定是第一个），只高亮不滚过去等于没选中。
 */
watch(
  [() => props.activePath, () => props.files],
  async () => {
    await nextTick()
    scrollRef.value
      ?.querySelector<HTMLElement>('.changed-file.is-active')
      ?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true },
)

function toneOf(file: GitChangedFile): string {
  if (file.status === 'A')
    return 'is-add'
  if (file.status === 'D')
    return 'is-del'
  return 'is-mod'
}
</script>

<template>
  <div class="changed-files">
    <header class="changed-files__head">
      <span class="changed-files__title">改动文件</span>
      <span class="changed-files__count">{{ props.files.length }} 个</span>
    </header>

    <div ref="scrollRef" class="changed-files__scroll" role="tablist" aria-label="改动的文件">
      <button
        v-for="file in props.files"
        :key="file.path"
        class="changed-file"
        :class="{ 'is-active': props.activePath === file.path }"
        type="button"
        role="tab"
        :aria-selected="props.activePath === file.path"
        :title="`${statusLabel(file.status)} · ${file.path}`"
        @click="emit('select', file.path)"
      >
        <span class="changed-file__status" :class="toneOf(file)">{{ file.status }}</span>
        <span class="changed-file__path mono">{{ file.path }}</span>
        <span v-if="file.binary" class="changed-file__stat">二进制</span>
        <span v-else class="changed-file__stat">
          <span class="is-add">+{{ file.added }}</span>
          <span class="is-del">-{{ file.deleted }}</span>
        </span>
      </button>

      <p v-if="props.truncated" class="changed-files__more">
        只列出前 {{ props.files.length }} 个文件
      </p>
    </div>
  </div>
</template>

<style scoped>
.changed-files {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.changed-files__head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  min-height: 28px;
  padding: 0 var(--sp-2) var(--sp-1);
}

.changed-files__title {
  color: var(--ink);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.changed-files__count {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.changed-files__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.changed-file {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}

.changed-file:hover {
  background: var(--bg-inset);
  color: var(--ink-2);
}

.changed-file.is-active {
  background: var(--bg-selected);
  border-color: var(--border);
  color: var(--ink);
}

.changed-file__status {
  flex-shrink: 0;
  width: 1.2em;
  font-weight: 600;
  text-align: center;
}

.changed-file__path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.changed-file__stat {
  display: inline-flex;
  flex-shrink: 0;
  gap: 4px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}

.is-add {
  color: var(--st-ok);
}

.is-del {
  color: var(--st-fail);
}

.changed-files__more {
  margin: 0;
  padding: var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}
</style>
