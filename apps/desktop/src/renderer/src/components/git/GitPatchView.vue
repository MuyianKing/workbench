<script setup lang="ts">
import type { GitChangedFile, GitPatch, ParsedPatch, PatchRow, SplitRow } from '@workbench/git'
import { Document, Warning } from '@element-plus/icons-vue'
import { buildSplitRows, parsePatch } from '@workbench/git'
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
/**
 * 单文件补丁：把 `git diff -U3` 的原文拆成可读的差异表。
 *
 * 两种视图（右上角分段切换，默认统一）：
 *  - **并排**（split）：左旧右新，连续的删除块与新增块按顺序一一配对成「修改行」，
 *    多余的单边显示；口径在 `@workbench/git` 的 `buildSplitRows`（有单测）。
 *  - **统一**（unified）：Git 原生的一列排布，顺着看大段上下文更省横向空间。
 *
 * 这里只管渲染与几种取不到的情况：
 *  - 二进制 → 明说「二进制文件」，不假装能逐行看；
 *  - 单侧超过 1 MB → 宿主没有取补丁，明说「文件太大」；
 *  - 只有模式 / 重命名的元信息 → 没有 hunk，明说没有行级差异；
 *  - 非 UTF-8 → 宿主按替换字符解了，补一条提示，别让人以为文件真的长这样。
 *
 * 滚动容器只有一个：横向与纵向都由它管，行号列不跟着横向滚（`position: sticky`）。
 */
type ViewMode = 'split' | 'unified'

const props = defineProps<{
  /** 当前视图：由页面状态持有，切提交 / 换文件 / 换页都不重置 */
  view: ViewMode
  patch: GitPatch | null
  loading: boolean
  error: string
  /** 当前文件：补丁栏首行显示路径与增删数；没有选中文件时为 null */
  file?: GitChangedFile | null
}>()

const emit = defineEmits<{ 'update:view': [value: ViewMode] }>()

const VIEW_OPTIONS: { label: string, value: ViewMode }[] = [
  { label: '并排', value: 'split' },
  { label: '统一', value: 'unified' },
]

/** 分段控件直接读写父组件那份状态（v-model:view），组件自己不另存一份 */
const view = computed<ViewMode>({
  get: () => props.view,
  set: value => emit('update:view', value),
})

const parsed = computed<ParsedPatch>(() => {
  const patch = props.patch
  if (!patch || patch.binary || patch.tooLarge || !patch.patch)
    return { rows: [] as PatchRow[], truncated: false }
  return parsePatch(patch.patch)
})

/** meta 行（diff --git / index / --- / +++）对单文件补丁没有信息量，不铺到表里 */
const rows = computed(() => parsed.value.rows.filter(row => row.type !== 'meta'))
const splitRows = computed<SplitRow[]>(() => buildSplitRows(rows.value))
const hasHunk = computed(() => rows.value.some(row => row.type === 'hunk'))

function splitClass(row: SplitRow): string {
  if (row.type === 'change')
    return 'is-change'
  if (row.type === 'del')
    return 'is-del'
  if (row.type === 'add')
    return 'is-add'
  return ''
}

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
    <!-- 文件名与视图切换常驻：切文件、读取中都不整条闪掉，只换下面的内容 -->
    <div v-if="props.file" class="patch__bar">
      <span class="patch__file mono" :title="props.file.path">
        {{ props.file.path }}
      </span>
      <span v-if="props.file.binary" class="patch__stat">二进制</span>
      <span v-else class="patch__stat">
        <span class="is-add">+{{ props.file.added }}</span>
        <span class="is-del">-{{ props.file.deleted }}</span>
      </span>
      <el-segmented
        v-if="hasHunk"
        v-model="view"
        class="patch__toggle"
        :options="VIEW_OPTIONS"
        size="small"
        aria-label="差异视图"
      />
    </div>

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
      hint="在左侧文件清单里点一个文件看差异"
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
        <table v-if="view === 'split'" class="patch__table patch__table--split">
          <colgroup>
            <col class="split__col-no">
            <col>
            <col class="split__col-no">
            <col>
          </colgroup>
          <tbody>
            <template v-for="(row, index) in splitRows" :key="index">
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
              <tr v-else :class="splitClass(row)">
                <td class="split__no split__no--old" :class="{ split__void: !row.left }">
                  {{ row.left?.no ?? '' }}
                </td>
                <td class="split__text split__text--old" :class="{ split__void: !row.left }">
                  {{ row.left?.text ?? '' }}
                </td>
                <td class="split__no split__no--new" :class="{ split__void: !row.right }">
                  {{ row.right?.no ?? '' }}
                </td>
                <td class="split__text split__text--new" :class="{ split__void: !row.right }">
                  {{ row.right?.text ?? '' }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>

        <table v-else class="patch__table">
          <colgroup>
            <col class="patch__col-no">
            <col class="patch__col-no">
            <col class="patch__col-mark">
            <col>
          </colgroup>
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

/* 补丁栏首行：左边是被查看的文件与增删数，右边是视图切换 */
.patch__bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--sp-2);
  min-height: 28px;
}

.patch__file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
  font-size: var(--fs-micro);
}

.patch__stat {
  display: inline-flex;
  flex-shrink: 0;
  gap: 4px;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}

.patch__toggle {
  flex-shrink: 0;
  margin-left: auto;
}

.is-add {
  color: var(--st-ok);
}

.is-del {
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

/* ---------- 统一视图：旧行号 / 新行号 / 标记 / 内容 ---------- */

/* 列宽写在 colgroup 上：表首行是 colspan=4 的 hunk 头，靠 td 定宽会被均分 */
.patch__col-no {
  width: 3.2em;
}

.patch__col-mark {
  width: 1.6em;
}

/* 两列行号：定宽、右对齐。代码列会换行，不需要横向滚动，所以不做粘性列 */
.patch__no {
  background: var(--bg-inset);
  color: var(--ink-3);
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--border);
}

/* 增删标记：与行底色同一语义，窄窄一列 */
.patch__mark {
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

/* ---------- 并排视图：左旧右新，空着的一侧用浅底 ---------- */

.split__col-no {
  width: 3.2em;
}

.split__no {
  background: var(--bg-inset);
  color: var(--ink-3);
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--border);
}

.split__text {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--ink);
}

/* 两半之间的分隔线：画在左侧内容列的右沿，右边内容列不再重复 */
.split__text--old {
  border-right: 1px solid var(--border);
}

.split__void {
  background: var(--bg-subtle);
}

tr.is-change .split__no--old,
tr.is-del .split__no--old {
  background: color-mix(in srgb, var(--st-fail) 13%, var(--bg-inset));
}

tr.is-change .split__no--new,
tr.is-add .split__no--new {
  background: color-mix(in srgb, var(--st-ok) 13%, var(--bg-inset));
}

tr.is-change .split__text--old,
tr.is-del .split__text--old {
  background: color-mix(in srgb, var(--st-fail) 13%, transparent);
}

tr.is-change .split__text--new,
tr.is-add .split__text--new {
  background: color-mix(in srgb, var(--st-ok) 13%, transparent);
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
