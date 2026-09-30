<script setup lang="ts">
/**
 * 原始数据树（左栏「原始数据」签）：data/raw 下的文件按目录结构收成的树与各自的入库状态。
 *
 * 状态的口径在 shared/kb.ts（source 配对 + mtime 比较），这里只把结果摆出来：
 * 按状态筛（带计数）、一眼看出哪些等着清洗；树由 kbRawTree 从筛过的清单现算
 * （props 只读，这里不留第二份），文件行还是原来那副两行块 —— 名字 + 后缀一行，
 * 状态、指向它的条目数与修改时间一行。清洗由工具条的「开始清洗」发起（应用全程编排，
 * 见 stores/kb.ts），这里只管把状态摆清楚。
 */
import { computed, ref, watch } from 'vue'
import { Document, Folder } from '@element-plus/icons-vue'
import { formatTimestamp } from '@/format'
import {
  kbRawStatusText,
  kbRawTree,
  kbTreeFolderIds,
  type KbRawItem,
  type KbRawStatus,
  type KbRawTreeNode
} from '@workbench/kb'

const props = defineProps<{
  items: KbRawItem[]
}>()

const emit = defineEmits<{ open: [rel: string] }>()

type Filter = 'all' | KbRawStatus

const FILTER_LABELS: Record<Filter, string> = {
  all: '全部',
  pending: '未入库',
  stale: '有更新',
  synced: '已入库'
}

/** el-tree 认的字段名：数据里叫 name / children */
const TREE_PROPS = { label: 'name', children: 'children' } as const

const filter = ref<Filter>('all')

const counts = computed<Record<Filter, number>>(() => ({
  all: props.items.length,
  pending: props.items.filter((item) => item.status === 'pending').length,
  stale: props.items.filter((item) => item.status === 'stale').length,
  synced: props.items.filter((item) => item.status === 'synced').length
}))

const filtered = computed(() =>
  filter.value === 'all' ? props.items : props.items.filter((item) => item.status === filter.value)
)

const tree = computed(() => kbRawTree(filtered.value))
/** 筛过（非「全部」）就算在过滤中：那份清单只是全库的一角，整树摊开才看得见都剩了谁 */
const filtering = computed(() => filter.value !== 'all')

/** 用户自己收展的那份（筛选期间不记，见 expand / collapse） */
const expanded = ref<string[]>([])

/** 筛选时整棵摊开：重建出的树只含筛出项，收着的目录会让「筛到了」看不出来 */
const expandedKeys = computed(() =>
  filtering.value ? kbTreeFolderIds(tree.value) : expanded.value
)

// 首次出数据（重扫后也一样）把顶层目录摊开：树默认全收着的话，
// 一进来只剩目录名，「哪些等着清洗」就看不出来了
watch(tree, (nodes) => {
  if (!filtering.value && !expanded.value.length && nodes.length) {
    expanded.value = nodes.filter((node) => node.kind === 'folder').map((node) => node.id)
  }
})

function expand(id: string): void {
  if (filtering.value) return
  expanded.value = [...new Set([...expanded.value, id])]
}

function collapse(id: string): void {
  if (filtering.value) return
  expanded.value = expanded.value.filter((item) => item !== id)
}

/** 点目录行只是收展（el-tree 自己处理），点文件才算「查看它」（右栏就地预览或给出去） */
function onNodeClick(data: KbRawTreeNode): void {
  if (data.kind === 'file') emit('open', data.id)
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

    <!-- 两种空态分开说：data/raw 里还没有原始资料，和筛出来的没有 -->
    <div v-if="!items.length" class="kb-raw__empty">
      <p>data/raw 里还没有原始资料。把要整理的文件放进去，点一次刷新就能看到。</p>
    </div>
    <div v-else-if="!filtered.length" class="kb-raw__empty">
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
        <!-- 目录行：与条目树同一副（图标 + 名字，一行） -->
        <span v-if="data.kind === 'folder'" class="node" :title="data.name">
          <el-icon class="node__icon"><Folder /></el-icon>
          <span class="node__name">{{ data.name }}</span>
        </span>

        <!-- 文件行：保留原来那副两行块（名字 + 后缀 / 状态 + 条目数 + 时间），点开进右栏查看 -->
        <span v-else class="raw-item" :title="data.id">
          <span class="raw-item__head">
            <el-icon class="raw-item__icon"><Document /></el-icon>
            <span class="raw-item__name">{{ data.name }}</span>
            <span v-if="data.item?.ext" class="raw-item__ext">{{ data.item.ext }}</span>
          </span>
          <span class="raw-item__meta">
            <span v-if="data.item" class="raw-item__status" :class="`is-${data.item.status}`">
              {{ kbRawStatusText(data.item.status) }}
            </span>
            <span
              v-if="data.item?.entryRels.length"
              class="raw-item__entries"
              :title="data.item.entryRels.join('\n')"
            >
              {{ data.item.entryRels.length }} 个条目
            </span>
            <span v-if="data.item" class="raw-item__time">{{ formatTimestamp(data.item.mtimeMs) }}</span>
          </span>
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

/* 文件行是两行块：行盒不再定死 26px，让内容自己撑（目录行自己的 .node 定了 28px） */
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

.raw-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 0;
  cursor: pointer;
}

.raw-item__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.raw-item__icon {
  flex-shrink: 0;
  align-self: center;
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

.raw-item__ext {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-family: var(--font-mono);
}

.raw-item__meta {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  padding-left: 20px;
}

/* 彩色在这个界面只表达运行状态，所以入库状态用灰度说话：要催的浓、已完成的淡 */
.raw-item__status {
  flex-shrink: 0;
  color: var(--ink);
  font-size: var(--fs-micro);
}

.raw-item__status.is-synced {
  color: var(--ink-3);
}

.raw-item__entries {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.raw-item__time {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-family: var(--font-mono);
}
</style>
