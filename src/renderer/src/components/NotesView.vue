<script setup lang="ts">
/**
 * 笔记页：左边目录树，右边正文。
 *
 * 与其它页面一样，它是导航栏上的一项（见 shared/views.ts），换页由 App.vue 的
 * `<KeepAlive><component :is>` 负责 —— 所以切走再回来时编辑器还是刚才那一篇、光标位置也还在，
 * 数据也不会重读。
 *
 * 数据住在本机的 `note-data.json`（**不进同步仓库**，见 shared/note.ts）。
 * 这一层负责编排：谁被选中、什么时候弹起名字的弹窗、增删改的确认与提示；
 * 树的具体渲染在 NoteTree，正文编辑在 NoteEditor，两边都只看 store 里那一份状态。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderAdd, Plus } from '@element-plus/icons-vue'
import { countNodes, findNote, notePath, type NoteKind } from '@shared/note'
import { formatTimestamp } from '@/format'
import { confirmAction } from '@/notify'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'
import NoteTree from '@/components/NoteTree.vue'
import NoteEditor from '@/components/NoteEditor.vue'
import NoteNameDialog from '@/components/NoteNameDialog.vue'

const store = useNotesStore()
const settings = useSettingsStore()

/**
 * 起名字的那个弹窗：新建与重命名共用。
 *
 * `mode` 决定提交后走哪条路 —— 两者的差别只有「要不要回来选中」和「报什么错」，
 * 让两个入口各写一个弹窗只会让校验那一段抄两遍。
 */
const dialog = reactive({
  open: false,
  mode: 'create' as 'create' | 'rename',
  kind: 'note' as NoteKind,
  /** 新建时落在哪个文件夹；null 表示根目录 */
  parentId: null as string | null,
  /** 重命名时的目标 */
  targetId: ''
})

const dialogTitle = computed(() => {
  if (dialog.mode === 'rename') return dialog.kind === 'folder' ? '重命名文件夹' : '重命名笔记'
  return dialog.kind === 'folder' ? '新建文件夹' : '新建笔记'
})

const dialogDefaultName = computed(() => {
  if (dialog.mode === 'rename') return findNote(store.nodes, dialog.targetId)?.name ?? ''
  return dialog.kind === 'folder' ? '新建文件夹' : '新建笔记'
})

/** 面包屑：从根到当前选中项，让「这篇在哪一层」一眼看得出来 */
const crumbs = computed(() => store.activePath.map((node) => node.name))

/** 整棵树里的节点数：空态与工具栏上的计数都用它 */
const total = computed(() => countNodes(store.nodes))

onMounted(() => {
  void store.init()
})

/** 在指定的文件夹里新建；`parentId` 为 null 表示根目录 */
function openCreateIn(parentId: string | null, kind: NoteKind): void {
  dialog.mode = 'create'
  dialog.kind = kind
  dialog.parentId = parentId
  dialog.targetId = ''
  dialog.open = true
}

/** 工具栏上的两个按钮：落点跟随当前选中项（文件夹就是它自己，笔记则放在同级，没选则是根目录） */
function openCreate(kind: NoteKind): void {
  openCreateIn(store.currentFolderId(), kind)
}

function openRename(id: string): void {
  const node = findNote(store.nodes, id)
  if (!node) return
  dialog.mode = 'rename'
  dialog.kind = node.kind
  dialog.parentId = null
  dialog.targetId = id
  dialog.open = true
}

async function submitName(name: string): Promise<void> {
  if (dialog.mode === 'rename') {
    const node = findNote(store.nodes, dialog.targetId)
    if (!node || node.name === name) return
    if (await store.rename(dialog.targetId, name)) ElMessage.success('已重命名')
    return
  }

  const created = await store.create({ parentId: dialog.parentId, kind: dialog.kind, name })
  if (!created) return
  ElMessage.success(dialog.kind === 'folder' ? '已新建文件夹' : '已新建笔记')
}

/**
 * 删除。
 *
 * 文件夹会带走整棵子树，所以确认框里先把「要删掉几个」说清楚 ——
 * 只说一句「删除文件夹？」的话，用户按下去才知道里面还有东西。
 */
async function remove(id: string): Promise<void> {
  const node = findNote(store.nodes, id)
  if (!node) return

  const detail =
    node.kind === 'note'
      ? `删除笔记「${node.name}」？`
      : `删除文件夹「${node.name}」及里面的 ${countNodes(node.children ?? [])} 项？`
  if (!(await confirmAction(`${detail}删除后不可恢复。`, '删除', { confirmButtonText: '删除' }))) {
    return
  }

  if (await store.remove(id)) ElMessage.success('已删除')
}

/**
 * 编辑器把防抖后的正文交回来。
 *
 * 用编辑器给的 id 而不是 `store.activeId`：换篇时它会先把上一篇没写完的那段冲出来，
 * 那一下发生在选中项已经切走之后，按当前选中项去取就会写错篇（见 NoteEditor 里的说明）。
 */
function onContentChange(payload: { id: string; content: string }): void {
  void store.saveContent(payload.id, payload.content)
}

/** 右栏那句「它在哪一层」：根下的项就只有它自己 */
const locationText = computed(() => (crumbs.value.length ? crumbs.value.join(' / ') : ''))
</script>

<template>
  <main class="notes">
    <!-- 工具条与项目页那条同款（底色由 global.css 按顶部样式给），搜索栏以下的第一条 -->
    <div class="filter">
      <div class="filter__head">
        <!-- 新建的落点跟随当前选中项：选着文件夹就放进它里面，选着笔记就放在同级 -->
        <el-button type="primary" size="small" :disabled="!store.loaded" @click="openCreate('note')">
          <el-icon><Plus /></el-icon>
          新建笔记
        </el-button>
        <el-button size="small" :disabled="!store.loaded" @click="openCreate('folder')">
          <el-icon><FolderAdd /></el-icon>
          新建文件夹
        </el-button>
      </div>

      <div class="filter__tools">
        <span class="notes__count">{{ store.noteCount }} 篇笔记 · {{ total }} 项</span>
      </div>
    </div>

    <div class="notes__body">
      <!-- 读盘失败：把原因说出来并给一次重试，不能显示成「还没有笔记」 -->
      <div v-if="store.loadError" class="notes__tree panel">
        <p class="notes__error">{{ store.loadError }}</p>
        <el-button size="small" @click="store.init()">重试</el-button>
      </div>

      <aside v-else class="notes__tree panel">
        <NoteTree
          :nodes="store.nodes"
          :active-id="store.activeId"
          :loaded="store.loaded && !store.loading"
          @select="store.select"
          @create="({ parentId, kind }) => openCreateIn(parentId, kind)"
          @rename="openRename"
          @remove="remove"
        />
      </aside>

      <section class="notes__editor panel">
        <header class="notes__head">
          <template v-if="store.activeNode">
            <span class="notes__title" :title="locationText">{{ store.activeNode.name }}</span>
            <span class="notes__location truncate">{{ locationText }}</span>
          </template>
          <span v-else class="notes__location">未选中</span>

          <span class="notes__spacer" />

          <!-- 保存状态就写在标题这一行：写东西的人需要知道「刚才那段到底存下去了没有」 -->
          <span v-if="store.saveError" class="notes__saved is-error">{{ store.saveError }}</span>
          <span v-else-if="store.activeNote" class="notes__saved">
            已保存 · {{ formatTimestamp(store.activeNote.updatedAt) }}
          </span>
        </header>

        <!-- 编辑器只在「打开的是一篇笔记」时出现；文件夹与空选择各说一句 -->
        <NoteEditor
          v-if="store.activeNote"
          :note="store.activeNote"
          :theme="settings.effectiveTheme"
          @change="onContentChange"
        />

        <div v-else class="empty notes__hint">
          <template v-if="store.loading">
            <p>正在读取笔记…</p>
          </template>
          <template v-else-if="!total">
            <p>还没有笔记。</p>
            <p class="empty__hint">
              点左上角「新建笔记」写下第一篇；右击左栏里的条目可以新建、改名与删除。
            </p>
          </template>
          <template v-else-if="store.activeNode">
            <p>「{{ store.activeNode.name }}」是文件夹。</p>
            <p class="empty__hint">在左栏里选中一篇笔记，或右击这个文件夹往里面新建。</p>
          </template>
          <template v-else>
            <p>从左边选一篇笔记打开。</p>
            <p class="empty__hint">标题栏右侧那句会显示它最后一次改动的时间。</p>
          </template>
        </div>
      </section>
    </div>

    <NoteNameDialog
      v-model="dialog.open"
      :title="dialogTitle"
      :kind="dialog.kind"
      :default-name="dialogDefaultName"
      @submit="submitName"
    />
  </main>
</template>

<style scoped>
.notes {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

/* 工具带右侧的计数：与别处的计数同一档字号 */
.notes__count {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/**
 * 左树右编辑器。
 *
 * 两栏各是一张卡片（.panel 那副外壳，写在 global.css），间距与别处同源 ——
 * 左栏定宽、右栏吃掉剩余宽度；两栏各自滚，谁也不把谁撑高。
 */
.notes__body {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  gap: var(--card-gap, 10px);
  min-width: 0;
  min-height: 0;
  padding: var(--card-gap, 10px);
}

.notes__tree {
  min-height: 0;
}

.notes__error {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.notes__editor {
  min-width: 0;
  min-height: 0;
}

/* 标题行：名字 + 位置 + 保存状态，右栏的「页头」 */
.notes__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  flex-shrink: 0;
  min-width: 0;
}

.notes__title {
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--ink);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.notes__location {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  min-width: 0;
}

.notes__spacer {
  flex: 1 1 auto;
}

.notes__saved {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.notes__saved.is-error {
  color: var(--st-fail);
}

/* 空态与文件夹提示：居中占满右栏，与别处的 .empty 同一副样子 */
.notes__hint {
  flex: 1 1 auto;
}
</style>
