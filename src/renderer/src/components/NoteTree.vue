<script setup lang="ts">
/**
 * 笔记目录树（左栏）。
 *
 * 树就是笔记本里的东西本身：顶层条目直接铺开，**没有「根行」那一层** ——
 * 笔记本是哪个目录写在左栏底部（见 NotesView），在树里再多占一行只是挡地方。
 * 点开头的目录、非 markdown 的文件由后端扫的时候就滤掉了（见 src-tauri/src/notes.rs）。
 *
 * 外观与交互交给 `el-tree`：展开 / 收起、缩进、键盘可达性都是它现成的，
 * 这里只补它没有的四件：
 *   1. **拖动**：文件拖进文件夹，或拖到树下面的**空白区**（= 移回最外层）。
 *      能不能落由 shared/note.ts 的 `noteDropAllowed` 说了算，这里只把它接到 el-tree 的回调上；
 *   2. **右键菜单**：节点上是新建笔记 / 新建文件夹 / 重命名 / 删除；
 *      落在空白区时只有前两项，且一律落在笔记本根目录 —— 顶部那条工具条去掉之后，
 *      新建就只剩右键与空态里那两颗按钮这两条路；
 *   3. **节点样式**：文件夹与笔记两副图标、选中态（自己画，不用 `highlight-current`：
 *      它那套「当前节点」是它自己的概念，与「编辑器里打开的是哪一篇」是两回事，
 *      两套状态叠在一起会出现「高亮在一处、编辑器在另一处」）；
 *   4. **展开态跟着选中项走**：每次数据换成新对象时 `el-tree` 会重建节点、丢掉展开态，
 *      所以展开的 id 以 `default-expanded-keys` 的形式交给它重建时恢复。
 *
 * 增删改本身由上层执行（那是跨组件的联动：改完要重新扫、要接着认当前打开的那一篇），
 * 这一层只把「想做什么」报上去。**展开态也一样**：这里是 `expanded` 进、`update:expanded` 出，
 * 自己不留一份副本 —— 上层要拿它落盘（见 NotesView 的 expandedKeys），
 * 组件里再存一份就变成「两份状态谁说了算」。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { Document, Folder, FolderAdd, Plus } from '@element-plus/icons-vue'
import {
  noteChain,
  noteDropAllowed,
  parentRel,
  type NoteKind,
  type NoteNode
} from '@shared/note'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'

const props = defineProps<{
  /** 笔记本里的顶层条目（文件夹在前、同层按名字，顺序由后端 + shared 定下） */
  nodes: NoteNode[]
  /** 当前选中项的路径（可能是文件夹，也可能是笔记） */
  activeRel: string
  /** 至少成功扫过一次：空态提示据此决定要不要说「这里还没有笔记」 */
  loaded: boolean
  /**
   * 展开着的节点 id（就是各自的 `rel`）。
   *
   * 由上层持有并落盘（设置里的 `noteTreeExpanded`，见 shared/types.ts）：
   * 上次摊开的那几层，下次进来还是摊开的。数组而不是 Set ——
   * `default-expanded-keys` 要的就是数组。
   */
  expanded: string[]
}>()

const emit = defineEmits<{
  select: [rel: string]
  create: [payload: { parentRel: string; kind: NoteKind }]
  rename: [rel: string]
  remove: [rel: string]
  move: [payload: { rel: string; targetDir: string }]
  'update:expanded': [value: string[]]
}>()

/** el-tree 认的字段名：数据里叫 name / children */
const TREE_PROPS = { label: 'name', children: 'children' } as const

/**
 * 展开 / 收起都只是把下一份清单报上去，状态本身在上层。
 *
 * 顶层文件夹**默认收起**：笔记本里通常就那么几个目录，一进来全展开反而把树拉得很长，
 * 所以落盘的清单一开始是空的。选中项所在的几层会在下面那条 watch 里被展开。
 *
 * `:auto-expand-parent="false"` 是这个清单能当真的前提：`el-tree` 的
 * `setDefaultExpandedKeys` 对清单里的每个 id 都调 `node.expand(null, autoExpandParent)`，
 * 而这个选项**默认为 true** —— 于是「展开一个子孙」会顺手把它的祖先也展开。
 * 我们这份清单里存着选中项一路下来的所有节点（含子孙），用户一旦收起其中某一层，
 * 下一次清单变化（收起本身就改它）就会由**子孙**把它重新顶开：选中项所在的那一支
 * 怎么点都收不起来，别处却正常（踩过）。祖先本来就是我们显式放进清单的，用不着它代劳。
 */
function expand(ids: string[]): void {
  const next = new Set([...props.expanded, ...ids])
  emit('update:expanded', [...next])
}

function collapse(id: string): void {
  emit(
    'update:expanded',
    props.expanded.filter((item) => item !== id)
  )
}

/**
 * 折叠状态跟着选中项走：选中一篇笔记（不管是自己点的还是刚新建出来的）就把
 * **它所在的那几层**文件夹展开 —— 否则会出现「编辑器里打开了某一篇，左栏里却找不到它」。
 *
 * 末尾那个（选中项自己）要摘掉：选中一个文件夹时用不着把它自己撑开，反过来，
 * 点一行同时会切换展开态（`expand-on-click-node`）—— 选中的正是这一行时，
 * 把「它自己」也塞回展开清单就等于**刚收起又被自己顶开**，
 * 表现成「选中项所在的那一支怎么点都收不起来」（踩过）。祖先照旧展开，笔记就露得出来。
 */
watch(
  () => props.activeRel,
  (rel) => {
    if (!rel) return
    expand(
      noteChain(props.nodes, rel)
        .slice(0, -1)
        .map((node) => node.id)
    )
  },
  { immediate: true }
)

// ---------- 节点上的右键菜单 ----------

/** 右键新建时的落点：文件夹就是它自己，文件则落在它所在的文件夹里 */
function folderOf(data: NoteNode): string {
  return data.kind === 'folder' ? data.rel : parentRel(data.rel)
}

function onCommand(command: string, data: NoteNode): void {
  if (command === 'rename') {
    emit('rename', data.rel)
    return
  }
  if (command === 'remove') {
    emit('remove', data.rel)
    return
  }
  emit('create', {
    parentRel: folderOf(data),
    kind: command === 'new-folder' ? 'folder' : 'note'
  })
}

// ---------- 空白区的右键菜单 ----------

/** 空白区菜单的两项：都落在笔记本根目录 */
const ROOT_ITEMS: { command: string; label: string; icon: Component }[] = [
  { command: 'new-note', label: '新建笔记', icon: Plus },
  { command: 'new-folder', label: '新建文件夹', icon: FolderAdd }
]

/** 离窗口边缘留出的空当：贴着边看着像被裁掉了一角 */
const EDGE = 6

const rootMenuOpen = ref(false)
const rootPanel = ref<HTMLDivElement | null>(null)
/** 夹回窗口之后的落点 */
const rootPos = ref({ left: 0, top: 0 })

/**
 * 空白区（树下面那片没有节点的地方）右键：菜单里的新建落在根目录。
 *
 * 落在节点行上时让路 —— 那个事件是给节点自己的菜单的（它挂在更里面，先收到）。
 */
async function openRootMenu(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement | null
  if (target?.closest('.el-tree-node__content')) return

  const point = { x: event.clientX, y: event.clientY }
  rootMenuOpen.value = true
  rootPos.value = { left: point.x, top: point.y }

  // 面板是刚渲染出来的，量完尺寸再夹回窗口内
  await nextTick()
  const element = rootPanel.value
  if (!element) return

  const { width, height } = element.getBoundingClientRect()
  rootPos.value = {
    left: Math.max(EDGE, Math.min(point.x, window.innerWidth - width - EDGE)),
    top: Math.max(EDGE, Math.min(point.y, window.innerHeight - height - EDGE))
  }
}

function runRootCommand(command: string): void {
  rootMenuOpen.value = false
  emit('create', { parentRel: '', kind: command === 'new-folder' ? 'folder' : 'note' })
}

// 点别处 / 右键别处 / Esc / 滚轮 / 窗口变化都收起（与正文那份菜单共用同一副骨架）
useFloatingDismiss({ panel: () => rootPanel.value, onDismiss: () => (rootMenuOpen.value = false) })

// ---------- 拖动 ----------

/** el-tree 传进来的是它自己的节点对象，数据挂在 `data` 上 */
interface TreeNodeLike {
  data: NoteNode
}

/** 正在被拖的笔记（相对路径）；空串表示没在拖 */
let draggingRel = ''
/** 指针正落在空白区且这里能放（松手就是移到最外层）：容器据此亮一圈 */
const rootDrop = ref(false)
/**
 * 指针这一刻停在空白区上。
 *
 * `el-tree` 记的落点是**上一次悬停过的那个节点** —— 指针离开节点行时它不会清掉，
 * 所以「先划过某个文件夹、再落到空白区」时，它那边照样会走一次 `node-drop`
 * （松手那一刻按的是那个文件夹，不是空白区）。指针一进空白区就把这个标记立起来，
 * el-tree 的 `node-drop` 见状让路：真正落在哪儿只由空白区的 drop 或这次让路决定。
 *
 * 立/清都只看指针位置，且**不在 `node-drop` 里清**（指针还在空白区上，
 * 清掉就没法拦住同一抬手里的第二次；收尾统一在 window 的 dragend 上）。
 */
let blankHover = false

/**
 * 拖动：只有文件能拖（`allow-drag`），只能落进文件夹（`allow-drop` 的 inner）。
 *
 * `allow-drop` 会按 prev / next / inner 三种落法各问一次，这里只放行 inner ——
 * 顺序是按名字算出来的（见 shared/note.ts 的排序），插一个「前后」下一秒就没了。
 */
function allowDrag(node: TreeNodeLike): boolean {
  return node.data.kind === 'note'
}

function allowDrop(dragging: TreeNodeLike, drop: TreeNodeLike, type: string): boolean {
  if (type !== 'inner') return false
  return noteDropAllowed(dragging.data, drop.data)
}

/**
 * 松手：报给上层去真正挪文件。
 *
 * 注意 `el-tree` 在这之前已经把它自己那份数据挪过了 —— 磁盘上真挪没挪、挪成没成
 * 由上层执行；失败时上层会重新扫一遍把这棵树的显示拉回真实状态（见 NotesView）。
 */
function onDrop(dragging: TreeNodeLike, drop: TreeNodeLike): void {
  if (blankHover) return
  emit('move', { rel: dragging.data.rel, targetDir: drop.data.rel })
}

function onDragStart(node: TreeNodeLike): void {
  draggingRel = node.data.rel
  blankHover = false
}

/** 指针是不是落在空白区（不在任何节点行上） */
function isBlankArea(target: EventTarget | null): boolean {
  return !(target instanceof HTMLElement && target.closest('.el-tree-node__content'))
}

/** 拖回最外层：已经在最外层了就不提示（后端也会返回一次空操作） */
function rootDropAllowed(): boolean {
  return Boolean(draggingRel) && noteDropAllowed(
    { rel: draggingRel, kind: 'note' },
    { rel: '', kind: 'folder' }
  )
}

/**
 * 空白区不归 `el-tree` 管（它的落点只认节点行），得自己声明「这里可以放」——
 * `dragover` 里不 preventDefault 的话，浏览器根本不会派发 drop。
 *
 * 顺带定下 `blankHover`：指针在空白区上时，el-tree 记的那个落点已经不算数了，
 * 不论这里能不能放都要拦下它那一次 `node-drop`（「已经在最外层」时如果放它过去，
 * 停在空白区松手反而会被挪进刚才划过的那个文件夹里）。
 */
function onDragOver(event: DragEvent): void {
  blankHover = isBlankArea(event.target)
  if (!blankHover || !rootDropAllowed()) {
    rootDrop.value = false
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  rootDrop.value = true
}

function onDropOnRoot(event: DragEvent): void {
  if (!blankHover || !rootDropAllowed()) return
  event.preventDefault()
  rootDrop.value = false
  emit('move', { rel: draggingRel, targetDir: '' })
}

/**
 * 拖动结束：把这次拖动的痕迹清掉。
 *
 * 两个「不能」：**不能挂在 `el-tree` 的 `node-drag-end` 上**（它在源码里先于 `node-drop`
 * 发出来，在那儿清 `blankHover` 等于没记）；**也不能只挂在容器上**（松手落在树外面时
 * dragend 一般还是能冒泡上来，但万一哪次没冒上来，`draggingRel` 会一直留着，
 * 下一次从资源管理器拖文件划过这里就会被当成「正拖着某一篇笔记」）。挂在 window 上最省心。
 */
function onDragEnd(): void {
  draggingRel = ''
  rootDrop.value = false
  blankHover = false
}

onMounted(() => window.addEventListener('dragend', onDragEnd))
onBeforeUnmount(() => window.removeEventListener('dragend', onDragEnd))

</script>

<template>
  <div
    class="tree"
    :class="{ 'is-root-drop': rootDrop }"
    @contextmenu="openRootMenu"
    @dragover="onDragOver"
    @drop="onDropOnRoot"
  >
    <el-tree
      v-show="nodes.length"
      class="tree__body scrollbar"
      :data="nodes"
      :props="TREE_PROPS"
      node-key="id"
      :indent="14"
      :default-expanded-keys="expanded"
      :auto-expand-parent="false"
      :expand-on-click-node="true"
      :highlight-current="false"
      draggable
      :allow-drag="allowDrag"
      :allow-drop="allowDrop"
      @node-click="(data: NoteNode) => emit('select', data.rel)"
      @node-expand="(data: NoteNode) => expand([data.id])"
      @node-collapse="(data: NoteNode) => collapse(data.id)"
      @node-drag-start="onDragStart"
      @node-drop="(dragging: TreeNodeLike, drop: TreeNodeLike) => onDrop(dragging, drop)"
    >
      <template #default="{ data }">
        <!-- 右键菜单挂在标签上：位置由 el-dropdown 按指针算，不用自己摆一副浮动层 -->
        <el-dropdown
          trigger="contextmenu"
          placement="bottom-start"
          @command="(command: string) => onCommand(command, data)"
        >
          <span class="node" :class="{ 'is-active': data.rel === activeRel }" :title="data.name">
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

    <!-- 一篇都没有：直接给两颗按钮，别让人对着空白猜「怎么开始」 -->
    <div v-if="loaded && !nodes.length" class="tree__empty">
      <p class="tree__empty-title">这个文件夹里还没有笔记</p>
      <div class="tree__empty-actions">
        <el-button
          type="primary"
          size="small"
          @click="emit('create', { parentRel: '', kind: 'note' })"
        >
          <el-icon><Plus /></el-icon>
          新建笔记
        </el-button>
        <el-button size="small" @click="emit('create', { parentRel: '', kind: 'folder' })">
          <el-icon><FolderAdd /></el-icon>
          新建文件夹
        </el-button>
      </div>
      <p class="tree__empty-hint">
        也可以在这里右击新建。把现成的 markdown 文件放进这个文件夹，点一下底部那颗刷新也能看到。
      </p>
    </div>
  </div>

  <!-- 空白区的右键菜单：浮层挂在 body 上（定位与层叠都不必看这张卡片的脸色） -->
  <Teleport to="body">
    <div
      v-if="rootMenuOpen"
      ref="rootPanel"
      class="root-menu"
      :style="{ left: `${rootPos.left}px`, top: `${rootPos.top}px` }"
      role="menu"
      @mousedown.prevent
      @contextmenu.prevent
    >
      <button
        v-for="item in ROOT_ITEMS"
        :key="item.command"
        class="root-menu__item"
        type="button"
        role="menuitem"
        @click="runRootCommand(item.command)"
      >
        <el-icon><component :is="item.icon" /></el-icon>
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  border-radius: var(--r-md);
}

/* 拖动中的落点提示：整片空白区都是「移到最外层」的落点 */
.tree.is-root-drop {
  background: var(--bg-inset);
  box-shadow: inset 0 0 0 1px var(--border-strong);
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
 * 用 `:has()` 挑出「装着选中节点的那个行盒」，而不是打开 el-tree 的 `highlight-current`
 * （理由见组件开头那段）。
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
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-1);
}

.tree__empty-title {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.tree__empty-actions {
  display: flex;
  gap: var(--sp-2);
}

.tree__empty-hint {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--ink-3);
}

/* ---------- 空白区的右键菜单 ---------- */

/**
 * 与正文那份右键菜单（NoteContextMenu）同一副外壳：面底色而不是毛玻璃 ——
 * 它压在树的字上，透出底下的字就没法看了。
 */
.root-menu {
  position: fixed;
  /* 挂在 body 上（见模板里的 Teleport），比卡片与终端面板高，但仍在弹窗（EP 的 2000+）下面 */
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 150px;
  padding: var(--sp-1);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
}

.root-menu__item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-1) var(--sp-2);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font: inherit;
  font-size: var(--fs-body);
  color: var(--ink-2);
  text-align: left;
  cursor: pointer;
}

.root-menu__item:hover {
  color: var(--ink);
  background: var(--bg-subtle);
}
</style>
