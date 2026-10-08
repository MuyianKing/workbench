<script setup lang="ts">
import type { KbRawItem, KbRawSourceRow, KbRawStatus, KbRawTreeNode } from '@workbench/kb'
import { Document, Folder, Setting } from '@element-plus/icons-vue'
import { kbRawSourceNameOf, kbRawTree, kbTreeFolderIds } from '@workbench/kb'
/**
 * 原始数据树（左栏「原始数据」签）：最外层是**来源**（`data/raw/<名字>` 那一格，见
 * shared/kb.ts 的 KbRawSourceRow —— 它可能对到本机一个外部文件夹），来源下面是按目录
 * 结构收成的树与各自的入库状态。
 *
 * 状态的口径在 shared/kb.ts（source 配对 + mtime 比较），这里只把结果摆出来：
 * 按状态筛（带计数）、一眼看出哪些等着清洗；树由 kbRawTree 从筛过的清单现算
 * （props 只读，这里不留第二份）。文件行只挂「有更新」一个 tag —— 已入库 / 条目数 /
 * 后缀 / 时间都不上行（右栏一看就有，分档交给顶上那排 chips）。来源行的「配置路径」与
 * 顶部那颗「添加原始数据」都只是把意图交给父层（弹层与落盘在 store 里）—— 组件不碰设置、
 * 也不碰文件。
 */
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  items: KbRawItem[]
  /** 来源行（最外层那一格）：没配路径、路径打不开的也在里面 */
  sources: KbRawSourceRow[]
}>()

const emit = defineEmits<{
  'open': [rel: string]
  /** 给一个来源指定 / 更换文件夹 */
  'edit-source': [row: KbRawSourceRow]
}>()

type Filter = 'all' | KbRawStatus

const FILTER_LABELS: Record<Filter, string> = {
  all: '全部',
  pending: '未入库',
  stale: '有更新',
  synced: '已入库',
}

/** el-tree 认的字段名：数据里叫 name / children */
const TREE_PROPS = { label: 'name', children: 'children' } as const

const filter = ref<Filter>('all')

const counts = computed<Record<Filter, number>>(() => ({
  all: props.items.length,
  pending: props.items.filter(item => item.status === 'pending').length,
  stale: props.items.filter(item => item.status === 'stale').length,
  synced: props.items.filter(item => item.status === 'synced').length,
}))

const filtered = computed(() =>
  filter.value === 'all' ? props.items : props.items.filter(item => item.status === filter.value),
)

/**
 * 筛到某一档时只留「这一档里真有东西」的来源行：没配路径的来源在任何一档下都没有文件，
 * 顶在树上只会让人以为筛坏了（切回「全部」它照样在）。
 */
const rows = computed(() => {
  if (filter.value === 'all')
    return props.sources
  const names = new Set(filtered.value.map(item => kbRawSourceNameOf(item.rel).toLowerCase()))
  return props.sources.filter(row => names.has(row.name.toLowerCase()))
})

const tree = computed(() => kbRawTree(filtered.value, rows.value))
/** 筛过（非「全部」）就算在过滤中：那份清单只是全库的一角，整树摊开才看得见都剩了谁 */
const filtering = computed(() => filter.value !== 'all')

/** 用户自己收展的那份（筛选期间不记，见 expand / collapse） */
const expanded = ref<string[]>([])

/** 筛选时整棵摊开：重建出的树只含筛出项，收着的目录会让「筛到了」看不出来 */
const expandedKeys = computed(() =>
  filtering.value ? kbTreeFolderIds(tree.value) : expanded.value,
)

// 首次出数据（重扫后也一样）把顶层目录摊开：树默认全收着的话，
// 一进来只剩目录名，「哪些等着清洗」就看不出来了
watch(tree, (nodes) => {
  if (!filtering.value && !expanded.value.length && nodes.length) {
    expanded.value = nodes.filter(node => node.kind === 'folder').map(node => node.id)
  }
})

function expand(id: string): void {
  if (filtering.value)
    return
  expanded.value = [...new Set([...expanded.value, id])]
}

function collapse(id: string): void {
  if (filtering.value)
    return
  expanded.value = expanded.value.filter(item => item !== id)
}

/** 点目录行只是收展（el-tree 自己处理），点文件才算「查看它」（右栏就地预览或给出去） */
function onNodeClick(data: KbRawTreeNode): void {
  if (data.kind === 'file')
    emit('open', data.id)
}

/**
 * 来源行上那句要催的话：**只说需要动手的两种**（打不开 / 还没指定路径）。
 * 「库里 data/raw」「以映射为准」这类说明性的话不上行（行要跟目录行一样是一行），
 * 全部收在悬停里 —— 见 sourceHint。
 */
function sourceState(row: KbRawSourceRow): string {
  if (row.kind === 'unconfigured')
    return '还没指定路径'
  if (row.error)
    return '打不开'
  return ''
}

/** 来源行的悬停说明：读的是哪儿、为什么读不到、库里那份还在不在，都在这儿说清楚 */
function sourceHint(row: KbRawSourceRow): string {
  const lines: string[] = []
  if (row.kind === 'inRepo')
    lines.push('资料就在知识库里（没配外部来源）')
  else if (row.kind === 'unconfigured')
    lines.push('这个来源还没指定文件夹（点行尾那颗齿轮选一个）')
  else
    lines.push(`来源文件夹：${row.dir}`)
  if (row.shadowed)
    lines.push(`库里还留着一份 data/raw/${row.name}，这里按来源文件夹读，那份不再列出`)
  if (row.error)
    lines.push(row.error)
  lines.push(`${row.files} 个文件`)
  return lines.join('\n')
}
</script>

<template>
  <div class="kb-raw">
    <div class="kb-raw__filters">
      <button
        v-for="(label, key) in FILTER_LABELS"
        :key="key"
        type="button"
        class="chip"
        :class="{ 'is-active': filter === key }"
        @click="filter = key"
      >
        {{ label }}
        <span class="chip__count">{{ counts[key] }}</span>
      </button>
    </div>
    <!-- 三种空态分开说：一个来源都没有、这一档筛不出东西 -->
    <div v-if="!items.length && !sources.length" class="kb-raw__empty">
      <p>还没有原始数据：添加一个来源文件夹，或者把要整理的文件放进库里的 data/raw。</p>
    </div>
    <div v-else-if="filtering && !filtered.length" class="kb-raw__empty">
      <p>没有「{{ FILTER_LABELS[filter] }}」的原始数据。</p>
    </div>

    <el-tree
      v-else
      class="kb-raw__body scrollbar"
      :data="tree"
      :props="TREE_PROPS"
      node-key="id"
      :indent="14"
      :default-expanded-keys="expandedKeys"
      :auto-expand-parent="false"
      :expand-on-click-node="true"
      :highlight-current="false"
      @node-click="onNodeClick"
      @node-expand="(data: KbRawTreeNode) => expand(data.id)"
      @node-collapse="(data: KbRawTreeNode) => collapse(data.id)"
    >
      <template #default="{ data }">
        <!-- 来源行：与目录行一样高的一行 —— 名字、要催的状态、这一来源的几个数，行尾那颗齿轮；
             路径与「库里那份还在不在」这些说明收在悬停里（两行块在这一层只是噪音） -->
        <span v-if="data.source" class="source" :title="sourceHint(data.source)">
          <el-icon class="node__icon"><Folder /></el-icon>
          <span class="source__name">{{ data.name }}</span>
          <span v-if="sourceState(data.source)" class="source__state">
            {{ sourceState(data.source) }}
          </span>
          <span v-if="data.source.pending" class="source__count">
            未入库 {{ data.source.pending }}
          </span>
          <span v-if="data.source.stale" class="source__count">
            有更新 {{ data.source.stale }}
          </span>
          <span
            v-if="!data.source.pending && !data.source.stale && data.source.files"
            class="source__count"
          >
            {{ data.source.files }} 个文件
          </span>
          <el-tooltip content="指定 / 更换这个来源的文件夹" placement="left">
            <el-button
              class="source__edit"
              size="small"
              text
              :icon="Setting"
              @click.stop="emit('edit-source', data.source)"
            />
          </el-tooltip>
        </span>

        <!-- 目录行（来源下面那一层起）：与条目树同一副（图标 + 名字，一行） -->
        <span v-else-if="data.kind === 'folder'" class="node" :title="data.name">
          <el-icon class="node__icon"><Folder /></el-icon>
          <span class="node__name">{{ data.name }}</span>
        </span>

        <!-- 文件行：与目录行同一副（图标 + 名字，一行），只有「有更新」才在行尾挂一个 tag -->
        <span v-else class="raw-item" :title="data.id">
          <el-icon class="raw-item__icon"><Document /></el-icon>
          <span class="raw-item__name">{{ data.name }}</span>
          <span v-if="data.item?.status === 'stale'" class="raw-item__tag">有更新</span>
        </span>
      </template>
    </el-tree>
  </div>
</template>

<style scoped>
.kb-raw {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  flex: 1;
}

.kb-raw__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}

.kb-raw__empty {
  padding: var(--sp-4) var(--sp-2);
  text-align: center;
}

.kb-raw__empty p {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

/**
 * 滚动条贴到卡片右缘（与条目树同一条口径）：负右 margin 把滚动容器出血到卡片边缘，
 * 等宽的右 padding 把树的位置兜回来。
 */
.kb-raw__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin-right: calc(-1 * var(--sp-4));
  padding: 0 var(--sp-4) 0 0;
  background: transparent;
}

/* 树的行盒：行高由三种行自己写（来源 / 目录 / 文件都是一行 28px），悬停给一块浅底 */
.kb-raw__body :deep(.el-tree-node__content) {
  height: auto;
  min-height: 28px;
  padding-top: 2px;
  padding-bottom: 2px;
  border-radius: var(--r-sm);
}

.kb-raw__body :deep(.el-tree-node__content:hover) {
  background: var(--bg-inset);
}

/* ---------- 来源行（最外层那一格） ---------- */

/**
 * 与目录行（.node）同高的一行：名字占满中间，要催的状态与计数贴右缘。
 * 路径与「库里那份还在不在」这些说明收在悬停里（见 sourceHint）—— 两行块在这一层
 * 只是噪音，而且长的绝对路径在窄栏里也只会被截成半截。
 */
.source {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
}

.source__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink);
  font-size: var(--fs-body);
}

/* 要催的两句话（打不开 / 还没指定路径）用浓一点的灰，说明性的那两类不上行 */
.source__state,
.source__count {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.source__state {
  color: var(--ink);
}

/* 那颗「配置路径」：平时收着，指到这一行才露出来（不抢状态的视线） */
.source__edit {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--ease-out);
}

.kb-raw__body :deep(.el-tree-node__content:hover) .source__edit,
.source__edit:focus-visible {
  opacity: 1;
}

/* ---------- 目录行 ---------- */

.node {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  font-size: var(--fs-body);
  color: var(--ink-2);
}

.node__icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--ink-3);
}

.node__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* ---------- 文件行 ---------- */

/* 与目录行 / 来源行同高的一行：名字占满中间，只有「有更新」在行尾挂一个 tag */
.raw-item {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  cursor: pointer;
}

.raw-item__icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--ink-3);
}

.raw-item__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-body);
}

/*
 * 要催的那一档：红底小 tag。整栏灰着，只有它上色 —— 一屏里要动的东西就是这几个
 * （与项目卡 / 保险库那些「要催」的 pill 同一副 `--st-fail` 口径）。
 */
.raw-item__tag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--r-sm);
  background: var(--st-fail-soft);
  color: var(--st-fail);
  font-size: var(--fs-micro);
  line-height: 18px;
}
</style>
