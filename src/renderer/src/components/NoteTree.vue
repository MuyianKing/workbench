<script setup lang="ts">
/**
 * 笔记目录树（左栏）。
 *
 * 外观与交互交给 `el-tree`：展开 / 收起、缩进、键盘可达性都是它现成的东西，
 * 这里只补三件它没有的：
 *   1. **右键菜单**（新建笔记 / 新建文件夹 / 重命名 / 删除）—— 用 `el-dropdown` 的
 *      `contextmenu` 触发方式挂在每个节点的标签上，位置由它自己按指针算。
 *   2. **节点样式**：文件夹与笔记两副图标、选中态（`el-tree` 的 `highlight-current` 只认
 *      它自己的"当前节点"概念，而我们另有一份"编辑器里打开的是哪一篇"，两套状态容易打架）。
 *   3. **展开态跟着选中项走**：每次数据换成新对象时 `el-tree` 会重建节点、丢掉展开态，
 *      所以展开的 id 存在这里，以 `default-expanded-keys` 的形式交给它重建时恢复。
 *
 * 增删改本身由上层执行（那是跨组件的联动：新建完要选中、删掉的正是当前这篇要切走编辑器），
 * 这一层只把「想做什么」报上去。
 */
import { ref, watch } from 'vue'
import { Document, Folder, FolderAdd, Plus } from '@element-plus/icons-vue'
import { notePath, type NoteKind, type NoteNode } from '@shared/note'

const props = defineProps<{
  nodes: NoteNode[]
  /** 当前选中的节点 id（可能是文件夹，也可能是笔记） */
  activeId: string | null
  /** 树是空的（一篇都还没建）：空态里给一句引导 */
  loaded: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  create: [payload: { parentId: string | null; kind: NoteKind }]
  rename: [id: string]
  remove: [id: string]
}>()

/** el-tree 认的字段名：数据里叫 name / children */
const TREE_PROPS = { label: 'name', children: 'children' } as const

/**
 * 展开着的文件夹 id。
 *
 * 数组而不是 Set：`default-expanded-keys` 要的是数组，而每次都得换一个新数组才触发更新
 * （往里 push 也是换引用，这里图省事直接赋值）。
 */
const expandedKeys = ref<string[]>([])

function expand(ids: string[]): void {
  const next = new Set([...expandedKeys.value, ...ids])
  expandedKeys.value = [...next]
}

function collapse(id: string): void {
  expandedKeys.value = expandedKeys.value.filter((item) => item !== id)
}

/**
 * 折叠状态跟着选中项走：选中一篇笔记（不管是自己点的还是刚新建出来的）就把它所在的
 * 几层文件夹展开 —— 否则会出现「编辑器里打开了某一篇，左栏里却找不到它」。
 */
watch(
  () => props.activeId,
  (id) => {
    if (!id) return
    expand(notePath(props.nodes, id).slice(0, -1).map((node) => node.id))
  },
  { immediate: true }
)

/** 右键新建时的落点：文件夹就是它自己，笔记则落在它所在的文件夹里 */
function folderOf(data: NoteNode): string | null {
  if (data.kind === 'folder') return data.id
  const path = notePath(props.nodes, data.id)
  return path.length > 1 ? path[path.length - 2].id : null
}

function onCommand(command: string, data: NoteNode): void {
  if (command === 'rename') {
    emit('rename', data.id)
    return
  }
  if (command === 'remove') {
    emit('remove', data.id)
    return
  }
  emit('create', {
    parentId: folderOf(data),
    kind: command === 'new-folder' ? 'folder' : 'note'
  })
}
</script>

<template>
  <div class="tree">
    <el-tree
      v-if="nodes.length"
      class="tree__body scrollbar"
      :data="nodes"
      :props="TREE_PROPS"
      node-key="id"
      :indent="14"
      :default-expanded-keys="expandedKeys"
      :expand-on-click-node="true"
      :highlight-current="false"
      @node-click="(data: NoteNode) => emit('select', data.id)"
      @node-expand="(data: NoteNode) => expand([data.id])"
      @node-collapse="(data: NoteNode) => collapse(data.id)"
    >
      <template #default="{ data }">
        <!-- 右键菜单挂在标签上：位置由 el-dropdown 按指针算，不用自己摆一副浮动层 -->
        <el-dropdown
          trigger="contextmenu"
          placement="bottom-start"
          @command="(command: string) => onCommand(command, data)"
        >
          <span class="node" :class="{ 'is-active': data.id === activeId }" :title="data.name">
            <el-icon class="node__icon">
              <Folder v-if="data.kind === 'folder'" />
              <Document v-else />
            </el-icon>
            <span class="node__name">{{ data.name }}</span>
          </span>

          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="new-note">
                <el-icon><Plus /></el-icon>新建笔记
              </el-dropdown-item>
              <el-dropdown-item command="new-folder" divided>
                <el-icon><FolderAdd /></el-icon>新建文件夹
              </el-dropdown-item>
              <el-dropdown-item command="rename" divided>重命名</el-dropdown-item>
              <el-dropdown-item command="remove">删除</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </el-tree>

    <div v-else-if="loaded" class="tree__empty">
      <p>还没有笔记。</p>
      <p class="tree__empty-hint">在上面「新建笔记」或「新建文件夹」开始；右击条目还能改名和删除。</p>
    </div>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.tree__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  /* 树的容器自带内边距，这里去掉一层，让它与外层卡片对齐 */
  padding: 0;
  background: transparent;
}

/* el-tree 的节点行默认吃满整宽，悬停与选中才有整行感 */
.tree__body :deep(.el-tree-node__content) {
  height: 28px;
  border-radius: var(--r-sm);
}

.tree__body :deep(.el-tree-node__content:hover) {
  background: var(--bg-inset);
}

/**
 * 选中的那一行整行铺底色。
 *
 * 用 `:has()` 挑出「装着选中节点的那个行盒」，而不是打开 el-tree 的 `highlight-current`：
 * 它那套「当前节点」是它自己的概念（键盘导航也会改它），与「编辑器里打开的是哪一篇」是两回事，
 * 两套状态叠在一起时会出现「高亮在一处、编辑器在另一处」。
 */
.tree__body :deep(.el-tree-node__content:has(.node.is-active)) {
  background: var(--bg-selected);
}

/* 图标不参与收缩：名字很长时该被挤掉的是字，不是图标 */
.node {
  display: flex;
  align-items: center;
  gap: 6px;
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
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 选中态自己画（不用 el-tree 的 highlight-current）：它比悬停明确高一档，
   而且得与「编辑器里打开的是哪一篇」严格对应 */
.node.is-active {
  color: var(--ink);
  font-weight: 600;
}

.node.is-active .node__icon {
  color: var(--ink);
}

.tree__empty {
  padding: var(--sp-4) var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

.tree__empty p {
  margin: 0;
}

.tree__empty-hint {
  color: var(--ink-3);
  opacity: 0.85;
}
</style>
