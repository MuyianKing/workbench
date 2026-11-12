<script setup lang="ts">
import type { GitTreeEntry } from '@workbench/git'
import type { LoadFunction } from 'element-plus'
import { Document, Folder, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { ref, watch } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import { useGitStore } from '@/stores/git'
/**
 * 左栏：HEAD 那一版的目录树。
 *
 * 树是**按目录懒加载**的：展开一层才问一次 git（`ls-tree`），大仓库不会一进来就把
 * 几万个文件名全塞进 IPC。目录在前、同层按名字排；点文件 = 中间那栏切到它的提交历史。
 *
 * 没有用 `highlight-current`：当前选中项属于「中间在看的文件历史」，与 el-tree 自己的
 * 「当前节点」不是一回事（笔记树同一条理由）。选中态画在节点内容上，行盒用 `:has()` 铺底色。
 *
 * 重命名跟踪这一版不做：文件历史是 `git log -- <当前路径>`，改名前的历史不显示。
 */
const store = useGitStore()

interface GitTreeNode extends GitTreeEntry {
  leaf: boolean
}

const TREE_PROPS = { label: 'name', isLeaf: 'leaf' } as const

const treeRef = ref<{ filter: (value: string) => void } | null>(null)
const keyword = ref('')

const loadNode: LoadFunction = async (node, resolve) => {
  const parent = node.level > 0 ? node.data as GitTreeNode | undefined : undefined
  // 第一层从用户选中的那个文件夹开始（scope）：`.git` 可能在外层，树不该把整个仓库都摊开；
  // 展开子目录时节点里带的已经是仓库相对路径，直接用
  const dir = parent?.path ?? store.scope
  const result = await store.loadTree(dir)
  if (!result.ok || !result.data) {
    ElMessage.error(result.error ?? '读取目录失败')
    resolve([])
    return
  }
  if (result.data.truncated)
    ElMessage.warning('这个目录太大，只列出前一部分')
  resolve(result.data.entries.map(entry => ({ ...entry, leaf: entry.type !== 'dir' })))
}

function filterNode(value: string, data: GitTreeNode): boolean {
  if (!value)
    return true
  const needle = value.toLowerCase()
  return data.name.toLowerCase().includes(needle) || data.path.toLowerCase().includes(needle)
}

watch(keyword, (value) => {
  treeRef.value?.filter(value)
})

function onNodeClick(data: GitTreeNode): void {
  if (data.type === 'dir')
    return
  void store.showFileHistory(data.path)
}
</script>

<template>
  <div class="tree-pane">
    <header class="tree-head">
      <span class="tree-head__title">文件</span>
      <el-input
        v-model="keyword"
        class="tree-head__filter"
        size="small"
        clearable
        placeholder="过滤"
        :prefix-icon="Search"
        aria-label="过滤文件"
      />
    </header>

    <EmptyState
      v-if="store.repo?.empty"
      compact
      :icon="Folder"
      text="仓库还没有提交"
      hint="第一次提交之后，这里会列出仓库里的文件"
    />

    <div v-else class="tree-body">
      <el-tree
        ref="treeRef"
        lazy
        node-key="path"
        :props="TREE_PROPS"
        :load="loadNode"
        :filter-node-method="filterNode"
        :expand-on-click-node="true"
        :highlight-current="false"
        empty-text="这个目录是空的"
        @node-click="onNodeClick"
      >
        <template #default="{ data }">
          <span
            class="node"
            :class="{ 'is-active': data.path === store.historyPath }"
            :title="data.path"
          >
            <el-icon class="node__icon">
              <Folder v-if="data.type === 'dir'" />
              <Document v-else />
            </el-icon>
            <span class="node__name">{{ data.name }}</span>
            <span v-if="data.type === 'submodule'" class="node__badge">子模块</span>
          </span>
        </template>
      </el-tree>
    </div>
  </div>
</template>

<style scoped>
.tree-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: var(--sp-3);
}

.tree-head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--sp-2);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
}

.tree-head__title {
  color: var(--ink);
  font-size: var(--fs-meta);
  font-weight: 600;
  white-space: nowrap;
}

.tree-head__filter {
  flex: 1;
  min-width: 0;
}

.tree-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-top: var(--sp-2);
}

.tree-body :deep(.el-tree) {
  background: transparent;
  --el-tree-node-hover-bg-color: transparent;
}

.tree-body :deep(.el-tree-node__content) {
  height: 28px;
  border-radius: var(--r-sm);
}

.tree-body :deep(.el-tree-node__content:hover) {
  background: var(--bg-inset);
}

/* 当前打开的文件历史整行铺底色（与笔记树同一条做法） */
.tree-body :deep(.el-tree-node__content:has(.node.is-active)) {
  background: var(--bg-selected);
}

.node {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  width: 100%;
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.node.is-active {
  color: var(--ink);
}

.node__icon {
  flex-shrink: 0;
  color: var(--ink-3);
}

.node__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node__badge {
  flex-shrink: 0;
  margin-left: auto;
  padding: 0 6px;
  border-radius: var(--r-pill);
  background: var(--bg-subtle);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}
</style>
