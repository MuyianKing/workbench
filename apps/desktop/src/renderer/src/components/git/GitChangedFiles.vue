<script setup lang="ts">
import type { GitChangedFile } from '@workbench/git'
import { statusLabel } from '@workbench/git'
/**
 * 一次提交 / 一次对比里改动了哪些文件：横向滚动的一排文件条。
 *
 * 每一格是「状态字母 + 路径 + 增删行数」；二进制文件没有行数，写「二进制」。
 * 点一格就是看那个文件的补丁（父组件负责取）。文件很多时横向滚动，不撑破右侧那栏。
 *
 * 状态色只借 `--st-ok`（新增）/ `--st-fail`（删除）表达增删语义，其余照旧灰度 ——
 * 与差异表的红绿是同一套读法（见 SkillCompareDialog 的行底色）。
 */
const props = defineProps<{
  files: GitChangedFile[]
  /** 当前打开的那个文件 */
  activePath: string
  /** 文件太多，宿主只回了一部分 */
  truncated: boolean
}>()

const emit = defineEmits<{ select: [path: string] }>()

function toneOf(file: GitChangedFile): string {
  if (file.status === 'A')
    return 'is-add'
  if (file.status === 'D')
    return 'is-del'
  return 'is-mod'
}
</script>

<template>
  <div class="changed-files" role="tablist" aria-label="改动的文件">
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
    <span v-if="props.truncated" class="changed-files__more">
      只列出前 {{ props.files.length }} 个文件
    </span>
  </div>
</template>

<style scoped>
.changed-files {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
}

.changed-file {
  display: inline-flex;
  flex-shrink: 0;
  align-items: baseline;
  gap: var(--sp-2);
  max-width: 280px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--r-md);
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
  flex-shrink: 0;
  padding: 0 var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  white-space: nowrap;
}
</style>
