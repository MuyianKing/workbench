<script setup lang="ts">
import type { GitPatch, ParsedPatch, PatchRow } from '@workbench/git'
import { Document, Warning } from '@element-plus/icons-vue'
import { parsePatch } from '@workbench/git'
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
/**
 * 单文件补丁：把 `git diff -U3` 的原文拆成「行号 + 增删标记 + 内容」的表格。
 *
 * 行模型在 `@workbench/git` 的 `parsePatch`（有单测）；这里只管渲染与几种取不到的情况：
 *  - 二进制 → 明说「二进制文件」，不假装能逐行看；
 *  - 单侧超过 1 MB → 宿主没有取补丁，明说「文件太大」；
 *  - 只有模式 / 重命名的元信息 → 没有 hunk，明说没有行级差异；
 *  - 非 UTF-8 → 宿主按替换字符解了，补一条提示，别让人以为文件真的长这样。
 *
 * 滚动容器只有一个：横向与纵向都由它管，行号列不跟着横向滚（`position: sticky`）。
 */
const props = defineProps<{
  patch: GitPatch | null
  loading: boolean
  error: string
}>()

const parsed = computed<ParsedPatch>(() => {
  const patch = props.patch
  if (!patch || patch.binary || patch.tooLarge || !patch.patch)
    return { rows: [] as PatchRow[], truncated: false }
  return parsePatch(patch.patch)
})

/** meta 行（diff --git / index / --- / +++）对单文件补丁没有信息量，不铺到表里 */
const rows = computed(() => parsed.value.rows.filter(row => row.type !== 'meta'))
const hasHunk = computed(() => rows.value.some(row => row.type === 'hunk'))

function rowClass(row: PatchRow): string {
  if (row.type === 'add')
    return 'is-add'
  if (row.type === 'del')
    return 'is-del'
  if (row.type === 'note')
    return 'is-note'
  return ''
}

function markOf(row: PatchRow): string {
  if (row.type === 'add')
    return '+'
  if (row.type === 'del')
    return '-'
  return ''
}
</script>

<template>
  <div class="patch">
    <div v-if="props.loading" class="state">
      正在读取差异…
    </div>
    <div v-else-if="props.error" class="state state--error">
      {{ props.error }}
    </div>
    <EmptyState
      v-else-if="!props.patch"
      compact
      :icon="Document"
      text="还没有选中文件"
      hint="在上面的文件条里点一个文件看差异"
    />
    <EmptyState
      v-else-if="props.patch.tooLarge"
      compact
      :icon="Warning"
      text="文件太大，没有取差异"
      hint="单侧超过 1 MB"
    />
    <EmptyState
      v-else-if="props.patch.binary"
      compact
      :icon="Document"
      text="二进制文件"
      hint="不显示行级差异"
    />
    <template v-else>
      <p v-if="props.patch.lossy" class="patch__note">
        文件内容不是 UTF-8，非 UTF-8 字节显示为 �
      </p>
      <p v-if="props.patch.truncated || parsed.truncated" class="patch__note">
        补丁过长，只显示前一部分
      </p>
      <div v-if="!hasHunk" class="state">
        {{ props.patch.patch ? '只有文件模式 / 重命名等元信息，没有行级差异' : '没有可显示的差异' }}
      </div>
      <div v-else class="patch__scroll">
        <table class="patch__table">
          <tbody>
            <template v-for="(row, index) in rows" :key="index">
              <tr v-if="row.type === 'hunk'" class="is-hunk">
                <td colspan="4">
                  {{ row.text }}
                </td>
              </tr>
              <tr v-else-if="row.type === 'note'" class="is-note">
                <td colspan="4">
                  {{ row.text }}
                </td>
              </tr>
              <tr v-else :class="rowClass(row)">
                <td class="patch__no">
                  {{ row.oldNo ?? '' }}
                </td>
                <td class="patch__no">
                  {{ row.newNo ?? '' }}
                </td>
                <td class="patch__mark">
                  {{ markOf(row) }}
                </td>
                <td class="patch__code">
                  {{ row.text }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.patch {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  height: 100%;
}

.state {
  padding: var(--sp-5) var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-meta);
  text-align: center;
}

.state--error {
  color: var(--st-fail);
}

.patch__note {
  flex-shrink: 0;
  margin: 0;
  padding: 4px var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.patch__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.patch__table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  line-height: 1.6;
}

.patch__table td {
  padding: 0 var(--sp-2);
  vertical-align: top;
}

/* 两列行号：定宽、右对齐。代码列会换行，不需要横向滚动，所以不做粘性列 */
.patch__no {
  width: 3.2em;
  background: var(--bg-inset);
  color: var(--ink-3);
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--border);
}

/* 增删标记：与行底色同一语义，窄窄一列 */
.patch__mark {
  width: 1.6em;
  color: var(--ink-3);
  text-align: center;
  user-select: none;
}

.patch__code {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--ink);
}

tr.is-add .patch__code,
tr.is-add .patch__mark {
  background: color-mix(in srgb, var(--st-ok) 13%, transparent);
}

tr.is-add .patch__no {
  background: color-mix(in srgb, var(--st-ok) 13%, var(--bg-inset));
}

tr.is-del .patch__code,
tr.is-del .patch__mark {
  background: color-mix(in srgb, var(--st-fail) 13%, transparent);
}

tr.is-del .patch__no {
  background: color-mix(in srgb, var(--st-fail) 13%, var(--bg-inset));
}

/* hunk 头与「没有换行」说明：整行一条，浅底、等宽 */
tr.is-hunk td,
tr.is-note td {
  padding: 2px var(--sp-2);
  background: var(--bg-subtle);
  color: var(--ink-3);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

tr.is-note td {
  font-style: italic;
}
</style>
