<script setup lang="ts">
/**
 * 知识库条目树（左栏「条目」签）：搜索 + 按目录结构收成的树，点开一条进右栏阅读。
 *
 * 条目在仓库里本来就按目录分类（`kb/NN-主题名/…`），树就是它自己的样子：
 * 目录由 shared/kb.ts 的 kbEntryTree 从清单现算出来（props 只读，这里不留第二份），
 * 只负责展示与「点开它」。与笔记树（NoteTree）同一副 el-tree 用法，少了很多 ——
 * 条目在应用里只读不编辑，没有右键菜单、没有拖拽、没有增删。
 *
 * 展开态是这里唯一的界面状态，但也只活在本组件里（与笔记树落盘到设置不同，
 * 知识库的目录浅、重建索引又会整树重算，记一份反而容易与盘上对不上）：
 * 首次出数据时把顶层目录摊开，之后用户收展自己管。
 * 搜索时另算一份「全部摊开」的展开清单交给 el-tree 重建节点时恢复 ——
 * 搜索命中是逐字变化的，重建出的树只含匹配项，摊开才看得见都搜到了哪儿。
 */
import { computed, ref, watch } from 'vue'
import { Document, Folder, Search } from '@element-plus/icons-vue'
import { kbEntryTree, kbFolderChain, kbTreeFolderIds, type KbEntryMeta, type KbTreeNode } from '@workbench/kb'

const props = defineProps<{
  entries: KbEntryMeta[]
  /** 当前打开的条目（kb 相对路径）；空串 = 还没打开（右栏是概览） */
  activeRel: string
}>()

const emit = defineEmits<{ select: [rel: string] }>()

/** el-tree 认的字段名：数据里叫 name / children */
const TREE_PROPS = { label: 'name', children: 'children' } as const

const searchText = ref('')

/** 标题 / 标签 / 摘要 / 路径，哪儿沾边算哪儿（大小写不敏感） */
const filtered = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()
  if (!keyword) return props.entries
  return props.entries.filter((entry) =>
    [entry.title, entry.summary, entry.rel, entry.tags.join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(keyword)
  )
})

const tree = computed(() => kbEntryTree(filtered.value))
const searching = computed(() => searchText.value.trim() !== '')

/** 用户自己收展的那份（搜索期间不记，见 expand / collapse） */
const expanded = ref<string[]>([])

/** 搜索时整棵摊开：重建出的树只含匹配项，收着的目录会让「搜到了」看不出来 */
const expandedKeys = computed(() =>
  searching.value ? kbTreeFolderIds(tree.value) : expanded.value
)

// 首次出数据（换文件夹后重新扫到也一样）把顶层目录摊开：树默认全收着的话，
// 一进来只剩两个目录名，与「全库目录」的用途不符
watch(tree, (nodes) => {
  if (!searching.value && !expanded.value.length && nodes.length) {
    expanded.value = nodes.filter((node) => node.kind === 'folder').map((node) => node.id)
  }
})

/**
 * 选中项所在的那几层跟着摊开：换文件夹 / 清洗后重扫时打开着的那篇不能在树里找不到
 * （重扫后 el-tree 重建节点，展开态靠 default-expanded-keys 恢复，那份清单在这里补齐）。
 */
watch(
  () => props.activeRel,
  (rel) => {
    if (!rel) return
    expanded.value = [...new Set([...expanded.value, ...kbFolderChain(rel)])]
  },
  { immediate: true }
)

function expand(id: string): void {
  if (searching.value) return
  expanded.value = [...new Set([...expanded.value, id])]
}

function collapse(id: string): void {
  if (searching.value) return
  expanded.value = expanded.value.filter((item) => item !== id)
}

/** 点目录行只是收展（el-tree 自己处理），点条目才算「打开它」 */
function onNodeClick(data: KbTreeNode): void {
  if (data.kind === 'entry') emit('select', data.id)
}

/** 仓库自己的口径：draft / reviewed 有中文名，别的值照原样显示 */
function statusText(status: string): string {
  if (status === 'draft') return '草稿'
  if (status === 'reviewed') return '已核对'
  return status
}
</script>

<template>
  <div class="kb-tree">
    <el-input
      v-model="searchText"
      :prefix-icon="Search"
      placeholder="搜标题、标签、摘要"
      clearable
      size="small"
    />

    <!-- 两种空态分开说：库里还没有条目，和搜出来的没有 -->
    <div v-if="!entries.length" class="kb-tree__empty">
      <p>kb 里还没有条目。把原始资料整理进 kb 后，这里就是全库目录。</p>
    </div>
    <div v-else-if="!filtered.length" class="kb-tree__empty">
      <p>没有匹配「{{ searchText }}」的条目。</p>
    </div>

    <el-tree
      v-else
      class="kb-tree__body scrollbar"
      :data="tree"
      :props="TREE_PROPS"
      node-key="id"
      :indent="14"
      :default-expanded-keys="expandedKeys"
      :auto-expand-parent="false"
      :expand-on-click-node="true"
      :highlight-current="false"
      @node-click="onNodeClick"
      @node-expand="(data: KbTreeNode) => expand(data.id)"
      @node-collapse="(data: KbTreeNode) => collapse(data.id)"
    >
      <template #default="{ data }">
        <span
          class="node"
          :class="{ 'is-active': data.kind === 'entry' && data.id === activeRel }"
          :title="data.kind === 'entry' ? data.id : data.name"
        >
          <el-icon class="node__icon">
            <Folder v-if="data.kind === 'folder'" />
            <Document v-else />
          </el-icon>
          <span class="node__name">{{ data.name }}</span>
          <span v-if="data.kind === 'entry' && data.status" class="node__status">
            {{ statusText(data.status) }}
          </span>
        </span>
      </template>
    </el-tree>
  </div>
</template>

<style scoped>
.kb-tree {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  flex: 1;
}

.kb-tree__empty {
  padding: var(--sp-4) var(--sp-2);
  text-align: center;
}

.kb-tree__empty p {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

/**
 * 滚动条贴到卡片右缘（与笔记树 .tree__body 同一条口径）：负右 margin 把滚动容器
 * 出血到卡片边缘，等宽的右 padding 把树的位置兜回来。
 */
.kb-tree__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin-right: calc(-1 * var(--sp-4));
  padding: 0 var(--sp-4) 0 0;
  background: transparent;
}

.kb-tree__body :deep(.el-tree-node__content) {
  height: 28px;
  border-radius: var(--r-sm);
}

.kb-tree__body :deep(.el-tree-node__content:hover) {
  background: var(--bg-inset);
}

/* 选中（正在阅读）的那一行整行铺底色，与笔记树同一副选中态 */
.kb-tree__body :deep(.el-tree-node__content:has(.node.is-active)) {
  background: var(--bg-selected);
}

.node {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding-right: 6px;
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

.node__status {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.node.is-active {
  color: var(--ink);
  font-weight: 600;
}

.node.is-active .node__icon {
  color: var(--ink);
}
</style>
