<script setup lang="ts">
import type { KbLibraryRow, KbRawItem, KbRawStatus, KbRawTreeNode } from '@workbench/kb'
import type { Component } from 'vue'
import type { FloatingMenuItem } from '@/components/FloatingMenu.vue'
import { Delete, Document, Folder, MagicStick } from '@element-plus/icons-vue'
import { kbRawSourceNameOf, kbRawTree, kbTreeFolderIds } from '@workbench/kb'
/**
 * 知识库列表（左栏）：最外层是**知识库**（仓库清单 `raw/kb.json` 里的一条，见
 * packages/kb/src/kb.ts 的 KbLibraryRow），下面是按目录结构收成的树与各自的入库状态。
 *
 * 状态的口径在 packages/kb/src/kb.ts（source 配对 + 内容指纹比较），这里只把结果摆出来：
 * 按状态筛（带计数）、一眼看出哪些等着清洗；树由 kbRawTree 从筛过的清单现算
 * （props 只读，这里不留第二份）。文件行只挂「有更新」一个 tag。
 *
 * 右键菜单：**三种行都有「在资源管理器中打开」**（文件落在磁盘上真实的那一份 ——
 * 有关联是本机源头、没关联是仓库副本；目录按关联落到对应文件夹）；在此之上，
 * 知识库行有清洗 / 删除，子文件行只在**这台机器关联了源头文件夹**时才有清洗 / 删除
 * —— 没关联的知识库（别的设备添加的）只读仓库里的副本。「已删除 N」点开按 raw 文件
 * 分组清理。所有动作都只是把意图交给父层（弹层、删除与落盘在父层 / store 里）——
 * 组件不碰设置、也不碰文件。
 */
import { computed, ref, watch } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import FloatingMenu from '@/components/FloatingMenu.vue'

const props = defineProps<{
  items: KbRawItem[]
  /** 列表行（最外层）：清单一条一行，没关联的本机副本也占一行 */
  libraries: KbLibraryRow[]
}>()

const emit = defineEmits<{
  'open': [rel: string]
  /** 右键菜单：清洗这个知识库（源头同步 → 上传 → 清单交给清洗） */
  'clean-kb': [row: KbLibraryRow]
  /** 右键菜单：删除这个知识库（两层目录 + 关联条目；确认框在父层） */
  'delete-kb': [row: KbLibraryRow]
  /** 右键菜单：清洗这个文件（有关联的才有这一项） */
  'clean-file': [item: KbRawItem]
  /** 右键菜单：删除这个文件（仓库与源头一起删；确认框在父层） */
  'delete-file': [item: KbRawItem]
  /** 「已删除 N」点开：这个知识库的失联条目清理 */
  'purge-kb': [row: KbLibraryRow]
  /** 右键菜单：在资源管理器中打开 —— id 是相对 raw 的路径（知识库名开头），文件带 item
   * （abs 已经落在磁盘上真实的那一份：有关联是本机源头，没关联是仓库副本） */
  'reveal': [target: { id: string, item?: KbRawItem }]
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
 * 筛到某一档时只留「这一档里真有东西」的知识库行：还没放过文件的知识库在任何一档下
 * 都没有文件，顶在树上只会让人以为筛坏了（切回「全部」它照样在）。
 */
const rows = computed(() => {
  if (filter.value === 'all')
    return props.libraries
  const names = new Set(filtered.value.map(item => kbRawSourceNameOf(item.rel).toLowerCase()))
  return props.libraries.filter(row => names.has(row.name.toLowerCase()))
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

// 首次出数据（重扫后也一样）把顶层知识库行摊开：树默认全收着的话，
// 一进来只剩知识库名，「哪些等着清洗」就看不出来了
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

/** 点知识库行 / 目录行只是收展（el-tree 自己处理），点文件才算「查看它」（右栏就地预览或给出去） */
function onNodeClick(data: KbRawTreeNode): void {
  if (data.kind === 'file')
    emit('open', data.id)
}

/** 一个 raw 文件属于哪个知识库（列表里那一行）；清单里没有的回 null（不摆出来） */
function libraryOf(item: KbRawItem): KbLibraryRow | null {
  const name = kbRawSourceNameOf(item.rel).toLowerCase()
  return props.libraries.find(row => row.name.toLowerCase() === name) ?? null
}

// ---------- 右键菜单（知识库行 / 目录行 / 文件行都有；清洗与删除只给有关联的） ----------

/** 「在资源管理器中打开」：目录与只读文件（没关联的副本）唯一可做的事 */
const REVEAL_MENU_ITEMS: FloatingMenuItem[] = [
  { name: 'reveal', label: '在资源管理器中打开', icon: Folder as Component },
]

const KB_MENU_ITEMS: FloatingMenuItem[] = [
  { name: 'reveal', label: '在资源管理器中打开', icon: Folder as Component },
  { name: 'clean', label: '清洗知识库', icon: MagicStick as Component },
  { name: 'delete', label: '删除知识库', icon: Delete as Component, danger: true, sep: true },
]

const FILE_MENU_ITEMS: FloatingMenuItem[] = [
  { name: 'reveal', label: '在资源管理器中打开', icon: Folder as Component },
  { name: 'clean', label: '清洗文件', icon: MagicStick as Component },
  { name: 'delete', label: '删除文件', icon: Delete as Component, danger: true, sep: true },
]

type MenuState
  = | { kind: 'kb', x: number, y: number, row: KbLibraryRow }
    | { kind: 'file', x: number, y: number, item: KbRawItem, linked: boolean }
    | { kind: 'folder', x: number, y: number, id: string }
    | null

/** 右键菜单：开着时记下对哪一行、落在哪（视口坐标）；null 表示没开 */
const menu = ref<MenuState>(null)

/** 当前该出哪一份菜单（kb / 有关联的文件 / 只读副本与目录） */
const menuItems = computed<FloatingMenuItem[]>(() => {
  if (!menu.value)
    return []
  if (menu.value.kind === 'kb')
    return KB_MENU_ITEMS
  if (menu.value.kind === 'file')
    return menu.value.linked ? FILE_MENU_ITEMS : REVEAL_MENU_ITEMS
  return REVEAL_MENU_ITEMS
})

function openMenu(event: MouseEvent, data: KbRawTreeNode): void {
  if (data.library) {
    event.preventDefault()
    menu.value = { kind: 'kb', x: event.clientX, y: event.clientY, row: data.library }
    return
  }
  if (data.item) {
    event.preventDefault()
    // 有关联才有清洗 / 删除；没关联的副本是只读的，但「在资源管理器中打开」照样给
    menu.value = {
      kind: 'file',
      x: event.clientX,
      y: event.clientY,
      item: data.item,
      linked: !!libraryOf(data.item)?.dir,
    }
    return
  }
  // 目录行：进到磁盘上对应的文件夹（有关联落本机源头，没关联落仓库副本）
  if (data.kind === 'folder') {
    event.preventDefault()
    menu.value = { kind: 'folder', x: event.clientX, y: event.clientY, id: data.id }
  }
}

/** 点了菜单里的哪一项：只把意图交上去（落盘、弹确认框都在父层） */
function onMenuAct(name: string): void {
  const state = menu.value
  if (!state)
    return
  if (name === 'reveal') {
    if (state.kind === 'file')
      emit('reveal', { id: state.item.rel, item: state.item })
    else if (state.kind === 'folder')
      emit('reveal', { id: state.id })
    else
      emit('reveal', { id: state.row.name })
    return
  }
  if (state.kind === 'kb') {
    if (name === 'clean')
      emit('clean-kb', state.row)
    else if (name === 'delete')
      emit('delete-kb', state.row)
  }
  else if (state.kind === 'file' && name === 'clean') {
    emit('clean-file', state.item)
  }
  else if (state.kind === 'file' && name === 'delete') {
    emit('delete-file', state.item)
  }
}
</script>

<template>
  <div class="kb-list">
    <div class="kb-list__filters">
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
    <!-- 两种空态分开说：一个知识库都没有、这一档筛不出东西（都配一张小图，见 EmptyState） -->
    <EmptyState
      v-if="!items.length && !libraries.length"
      compact
      :icon="Document"
      text="还没有知识库"
      hint="点工具条上的「添加知识库」：选一个本机文件夹作为源头，复制上传后立即清洗。"
    />
    <EmptyState
      v-else-if="filtering && !filtered.length"
      compact
      :icon="Document"
      :text="`没有「${FILTER_LABELS[filter]}」的原始数据`"
    />

    <el-tree
      v-else
      class="kb-list__body scrollbar"
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
      @node-contextmenu="openMenu"
    >
      <template #default="{ data }">
        <!-- 知识库行：与目录行一样高的一行 —— 名字、这一库的几个数、失联那颗按钮；
             关联到哪儿这些说明收在悬停里（两行块在这一层只是噪音） -->
        <span v-if="data.library" class="library" :title="data.library.dir || '这台机器没有关联源头文件夹（只读仓库里的副本）'">
          <el-icon class="node__icon"><Folder /></el-icon>
          <span class="library__name">{{ data.name }}</span>
          <!-- 失联：原始文件被删（多半是别的设备删的），但还有条目指着它。点开按 raw 文件分组清理 -->
          <button
            v-if="data.library.deleted"
            type="button"
            class="library__deleted"
            title="原始文件不在了：点开清理指向它的条目"
            @click.stop="emit('purge-kb', data.library)"
          >
            已删除 {{ data.library.deleted }}
          </button>
          <span v-if="data.library.pending" class="library__count">
            未入库 {{ data.library.pending }}
          </span>
          <span v-if="data.library.stale" class="library__count">
            有更新 {{ data.library.stale }}
          </span>
          <span
            v-if="!data.library.pending && !data.library.stale && data.library.files"
            class="library__count"
          >
            {{ data.library.files }} 个文件
          </span>
        </span>

        <!-- 目录行（知识库下面那一层起）：图标 + 名字，一行 -->
        <span v-else-if="data.kind === 'folder'" class="node" :title="data.name">
          <el-icon class="node__icon"><Folder /></el-icon>
          <span class="node__name">{{ data.name }}</span>
        </span>

        <!-- 文件行：与目录行同一副（图标 + 名字，一行），只有「有更新」才在行尾挂一个 tag -->
        <span v-else class="raw-item">
          <el-icon class="raw-item__icon"><Document /></el-icon>
          <span class="raw-item__name">{{ data.name }}</span>
          <span v-if="data.item?.status === 'stale'" class="raw-item__tag">有更新</span>
        </span>
      </template>
    </el-tree>

    <!-- 右键菜单：贴指针出现（与笔记树同一副 FloatingMenu 外壳） -->
    <FloatingMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @act="onMenuAct"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.kb-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
  flex: 1;
}

.kb-list__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}

/**
 * 滚动条贴到卡片右缘（与笔记树同一条口径）：负右 margin 把滚动容器出血到卡片边缘，
 * 等宽的右 padding 把树的位置兜回来。
 */
.kb-list__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin-right: calc(-1 * var(--sp-4));
  padding: 0 var(--sp-4) 0 0;
  background: transparent;
}

/* 树的行盒：行高由三种行自己写（知识库 / 目录 / 文件都是一行 28px），悬停给一块浅底 */
.kb-list__body :deep(.el-tree-node__content) {
  height: auto;
  min-height: 28px;
  padding-top: 2px;
  padding-bottom: 2px;
  border-radius: var(--r-sm);
}

.kb-list__body :deep(.el-tree-node__content:hover) {
  background: var(--bg-inset);
}

/* ---------- 知识库行（最外层那一格） ---------- */

/**
 * 与目录行（.node）同高的一行：名字占满中间，计数贴右缘。
 * 关联到哪儿这些说明收在悬停里 —— 两行块在这一层只是噪音，
 * 而且长的绝对路径在窄栏里也只会被截成半截。
 */
.library {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
}

.library__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink);
  font-size: var(--fs-body);
}

.library__count {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 「已删除 N」：要动手的信号，与文件行的「有更新」同一档（--st-fail），但做成可点的按钮 */
.library__deleted {
  flex-shrink: 0;
  padding: 0 6px;
  border: none;
  border-radius: var(--r-sm);
  background: var(--st-fail-soft);
  color: var(--st-fail);
  font-size: var(--fs-micro);
  line-height: 18px;
  cursor: pointer;
}

.library__deleted:hover {
  filter: brightness(0.96);
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

/* 与目录行 / 知识库行同高的一行：名字占满中间，只有「有更新」在行尾挂一个 tag */
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
