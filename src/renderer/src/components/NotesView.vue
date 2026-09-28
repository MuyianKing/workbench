<script setup lang="ts">
/**
 * 笔记页：左边目录树，右边正文。
 *
 * 它就是一个**本地 markdown 编辑器**，笔记本是用户自己挑的一个文件夹
 * （设置里的 `noteDir`，见 shared/note.ts 的文件头）。所以这一页有两种样子：
 *   - **还没选文件夹**：整页只有一句引导与那颗「选择文件夹」按钮。
 *     在那之前不给任何操作入口 —— 没有文件夹就没有地方放笔记，先摆一排按钮只是挡路；
 *   - **选好了**：左树右正文，新建都从树的右键菜单走（顶部那条工具条已经去掉），
 *     左栏底部是笔记本本身与「最近打开」那一份历史记录。
 *
 * 两栏的分隔线可以左右拖（宽度住在 theme.json 里，见 shared/theme.ts 的 `noteTreeWidth`），
 * 与首页那两条栏宽把手同一套做法：拖动时只改本地让界面跟手，松手才落盘。
 *
 * 与其它页面一样，它是导航栏上的一项（见 shared/views.ts），换页由 App.vue 的
 * `<KeepAlive><component :is>` 负责 —— 切走再回来时编辑器还是刚才那一篇、光标位置也还在。
 * 数据与动作都在 store 里，这一层负责编排：谁被选中、什么时候弹起名字的弹窗、
 * 增删改的确认与提示。树在 NoteTree，正文编辑在 NoteEditor，
 * 左栏底部那一行与分隔条是 RecentRoots / PanelResizer（与视频页共用）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, EditPen, FolderOpened, Notebook, Picture, Refresh, RefreshRight } from '@element-plus/icons-vue'
import {
  countNodes,
  findNoteNode,
  noteRootName,
  type NoteKind,
  type NoteSyncSummary
} from '@shared/note'
import { formatTimestamp } from '@/format'
import { confirmAction } from '@/notify'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'
import NoteTree from '@/components/NoteTree.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import NoteEditor from '@/components/NoteEditor.vue'
import NoteNameDialog from '@/components/NoteNameDialog.vue'
import NoteAssetsDialog from '@/components/NoteAssetsDialog.vue'
import RecentRoots from '@/components/RecentRoots.vue'
import PanelResizer from '@/components/PanelResizer.vue'

const store = useNotesStore()
const settings = useSettingsStore()

/**
 * 目录树的展开态（行为记忆）：状态住在设置里，这一层只做「读出来 / 写回去」。
 *
 * 树自己不留第二份（见 NoteTree 的文件头）：上次摊开的那几层下次进来还是摊开的。
 * 只对当前这个笔记本成立 —— 换笔记本时由 notes store 的 setRoot 清空，
 * 因为相对路径在另一个笔记本里指的是完全不同的东西。
 */
const expandedKeys = computed<string[]>({
  get: () => settings.settings.noteTreeExpanded,
  set: (value) => {
    void settings.updateSettings({ noteTreeExpanded: value })
  }
})

/**
 * 起名字的那个弹窗：新建与重命名共用。
 *
 * `mode` 决定提交后走哪条路 —— 两者的差别只有「落在哪个文件夹」和「报什么错」，
 * 让两个入口各写一个弹窗只会让校验那一段抄两遍。
 */
const dialog = reactive({
  open: false,
  mode: 'create' as 'create' | 'rename',
  kind: 'note' as NoteKind,
  /** 新建时落在哪个文件夹（相对路径）；空串表示最外层 */
  parentRel: '',
  /** 重命名时的目标路径 */
  targetRel: ''
})

const dialogTitle = computed(() => {
  if (dialog.mode === 'rename') return dialog.kind === 'folder' ? '重命名文件夹' : '重命名笔记'
  return dialog.kind === 'folder' ? '新建文件夹' : '新建笔记'
})

const dialogDefaultName = computed(() => {
  if (dialog.mode === 'rename') return findNoteNode(store.nodes, dialog.targetRel)?.name ?? ''
  return dialog.kind === 'folder' ? '新建文件夹' : '新建笔记'
})

/** 正在扫盘：右栏据此说一句「正在读取」，而不是显示成「这个文件夹里什么都没有」 */
const scanning = computed(() => store.loading && !store.loaded)
/**
 * 「它在哪一层」：选中项**所在的那几层文件夹**，从最外层排下来。
 *
 * 末尾那个（选中项自己）要摘掉 —— 它已经写在标题上了，留着就是「README README」
 * 这种并排重复（选中的是文件夹时同样如此）。最外层的东西没有上一级，这时它是空串，
 * 标题行只剩名字与保存状态。
 */
const locationText = computed(() =>
  store.activeChain
    .slice(0, -1)
    .map((node) => node.name)
    .join(' / ')
)

/** 保存状态：失败时给原因，正常时给最后一次落盘的时间 */
const savedText = computed(() => {
  if (!store.active) return ''
  const at = store.savedAt || store.active.mtimeMs
  return at ? `已保存 · ${formatTimestamp(at)}` : '已保存'
})

/** 两栏的宽度：左栏是主题里存的那个值，分隔条按它定位 */
const bodyStyle = computed(() => ({
  gridTemplateColumns: `${settings.themeConfig.noteTreeWidth}px minmax(0, 1fr)`,
  '--tree-w': `${settings.themeConfig.noteTreeWidth}px`
}))

/** 素材管理那个面板：当前笔记本在这台机器上传过哪些图、谁还在用（见 NoteAssetsDialog） */
const assetsOpen = ref(false)

onMounted(() => {
  void store.init()
})

/** 第一次进来（或想换一个目录）时挑文件夹；取消就什么都不做 */
async function chooseFolder(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择笔记文件夹')
  if (!picked) return

  if (await store.setRoot(picked)) ElMessage.success('笔记本已切换')
}

/** 从「最近打开」里换一个笔记本（当前的那条 RecentRoots 自己拦下了） */
function openRecentRoot(dir: string): void {
  void store.setRoot(dir)
}

/** 在指定的文件夹里新建；`parentRel` 为空串表示最外层 */
function openCreateIn(parentRel: string, kind: NoteKind): void {
  dialog.mode = 'create'
  dialog.kind = kind
  dialog.parentRel = parentRel
  dialog.targetRel = ''
  dialog.open = true
}

function openRename(rel: string): void {
  const node = findNoteNode(store.nodes, rel)
  if (!node) return
  dialog.mode = 'rename'
  dialog.kind = node.kind
  dialog.parentRel = ''
  dialog.targetRel = rel
  dialog.open = true
}

async function submitName(name: string): Promise<void> {
  if (dialog.mode === 'rename') {
    if (await store.rename(dialog.targetRel, name)) ElMessage.success('已重命名')
    return
  }

  const created = await store.create({ parentRel: dialog.parentRel, kind: dialog.kind, name })
  if (created) ElMessage.success(dialog.kind === 'folder' ? '已新建文件夹' : '已新建笔记')
}

/**
 * 删除。
 *
 * 文件夹会带走整棵子树，所以确认框里先把「要删掉几个」说清楚 ——
 * 只说一句「删除文件夹？」的话，用户按下去才知道里面还有东西。
 */
async function remove(rel: string): Promise<void> {
  const node = findNoteNode(store.nodes, rel)
  if (!node) return

  const detail =
    node.kind === 'note'
      ? `删除笔记「${node.name}」？`
      : `删除文件夹「${node.name}」及里面的 ${countNodes(node.children ?? [])} 项？`
  if (!(await confirmAction(`${detail}删除后不可恢复。`, '删除', { confirmButtonText: '删除' }))) {
    return
  }

  if (await store.remove(rel)) ElMessage.success('已删除')
}

/**
 * 拖动落下：报给 store 去挪文件。
 *
 * 失败时要**重新扫一遍**：`el-tree` 在松手那一刻已经把它自己那份数据挪过了，
 * 不重新读一次，左栏显示的会是一个磁盘上并不存在的位置。
 */
async function onMove(payload: { rel: string; targetDir: string }): Promise<void> {
  if (await store.move(payload.rel, payload.targetDir)) return
  await store.reload()
}

/**
 * 编辑器把防抖后的正文交回来。
 *
 * 用编辑器给的路径而不是 `store.active.rel`：换一篇时它会先把上一篇没写完的那段冲出来，
 * 那一下发生在选中项已经切走之后，按当前选中项去取就会写错篇（见 NoteEditor 里的说明）。
 */
function onContentChange(payload: { rel: string; content: string }): void {
  void store.saveContent(payload.rel, payload.content)
}

/**
 * 正文里点了一个指向别的笔记的链接：跳到那一篇。
 *
 * 路径已经在编辑器里解析好了（见 shared/note.ts 的 `resolveNoteLink`），这里只管打开：
 * 树上没有就先**重扫一遍**再看 —— 目标可能是刚在应用外面写下的（别的编辑器、同步拉回来的），
 * 而树只信磁盘。还没有就如实说找不到，**不把选中项切到一个不存在的路径上**：
 * 那样右栏会显示成「『』是文件夹」这种看不出所以然的话。
 *
 * 跳过去之后的展开与高亮交给 store 的 select（与在左栏点一下是同一条路）。
 */
async function openNoteLink(rel: string): Promise<void> {
  if (!findNoteNode(store.nodes, rel)) await store.reload()
  if (!findNoteNode(store.nodes, rel)) {
    ElMessage.warning(`找不到这篇笔记：${rel}`)
    return
  }

  store.select(rel)
}

/** 编辑器实例：同步前后要借它一双手（先把攒着的那一份交出去 / 换掉远端改过的那一篇） */
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)

/**
 * 同步按钮的提示：**同步到哪儿先说清楚**。
 *
 * 地址不是用户在这里填的，而是这个文件夹自己连着的远端 —— 文件夹里任何一个 origin 都会被
 * 当成笔记仓库（用户可能早先为别的用途连过一个），所以这一句不能省。
 * 有仓库但还没连远端时也照实说：那颗按钮仍然点得动，点下去 Rust 会报一句带解决办法的话，
 * 这样用户在终端里补上 origin 之后不必重启 —— 这也是它不禁用的原因。
 */
const syncTitle = computed(() =>
  store.remoteUrl
    ? `同步到 ${store.remoteUrl}（提交本机改动、拉回别处的改动）`
    : '这个文件夹是 git 仓库，但还没连远端仓库'
)

/**
 * 同步一次。
 *
 * 次序是有讲究的，三步都不能换：
 *  1. **先让编辑器把防抖里那一份交出去、并等它落盘**：不然这次提交的是按下按钮
 *     之前的那一版（`flushAll` 是现取，`waitForWrites` 等的是 store 那一侧的写盘）；
 *  2. 再走同步（提交 → 拉 → 推，git 全在 Rust 那边跑）；
 *  3. 回来若远端改过打开着的那一篇，**把新正文塞回编辑器** —— 否则编辑器手上是旧的，
 *     下一次输入就会以旧内容为准把远端那份盖回去。
 *
 * 失败一律是「说清楚」而不是静默：不是仓库、没连远端、git 报的错、冲突的那几个文件名都在里面。
 */
async function syncNow(): Promise<void> {
  editorRef.value?.flushAll()
  await store.waitForWrites()

  const outcome = await store.syncNotes()
  if (!outcome) {
    ElMessage.error(store.syncError || '同步笔记失败')
    return
  }
  if (outcome.activeChanged) editorRef.value?.reloadFromProps()

  ElMessage.success(syncDoneText(outcome.summary))
}

/** 同步成功那句提示：把「提交了什么、拉回了什么」说清楚，两边都没动就直说 */
function syncDoneText(summary: NoteSyncSummary): string {
  const parts: string[] = []
  if (summary.files) parts.push(`提交 ${summary.files} 个文件`)
  if (summary.received) parts.push('拉回了远端的改动')
  return parts.length ? `已同步（${parts.join('、')}）` : '已同步，两边都没有新改动'
}
</script>

<template>
  <main class="notes" :class="{ 'is-intro': !store.root }">
    <!-- 还没选文件夹：整页只说一件事 —— 先挑一个文件夹当笔记本 -->
    <div v-if="!store.root" class="notes__intro panel">
      <div class="empty">
        <el-icon class="empty__icon"><Notebook /></el-icon>
        <p>笔记就是这个文件夹里的 markdown 文件。</p>
        <p class="empty__hint">
          选一个文件夹当笔记本：里面的目录结构会直接变成左边的目录树，
          用别的编辑器写下的 .md 也会显示出来。
        </p>
        <el-button type="primary" @click="chooseFolder">
          <el-icon><FolderOpened /></el-icon>
          选择文件夹
        </el-button>
      </div>
    </div>

    <div v-else class="notes__body" :style="bodyStyle">
      <aside class="notes__side panel">
        <!-- 读不出来：把原因说出来并给一次重试，不能显示成「这个文件夹里什么都没有」 -->
        <template v-if="store.loadError">
          <p class="notes__error">{{ store.loadError }}</p>
          <div class="notes__error-actions">
            <el-button size="small" @click="store.reload()">重试</el-button>
            <el-button size="small" @click="chooseFolder">换一个文件夹</el-button>
          </div>
        </template>

        <NoteTree
          v-else
          v-model:expanded="expandedKeys"
          :nodes="store.nodes"
          :active-rel="store.activeRel"
          :loaded="store.loaded && !store.loading"
          @select="store.select"
          @create="({ parentRel, kind }) => openCreateIn(parentRel, kind)"
          @rename="openRename"
          @remove="remove"
          @move="onMove"
        />

        <!--
          底部：笔记本是哪个目录 + 最近打开的那几个（原顶部工具条右侧那一组搬到这里）。
          放在树的下面而不是顶上：进这一页要做的第一件事是找文件，不是找设置。
        -->
        <RecentRoots
          :root="store.root"
          :root-name="store.rootName"
          :count-text="`${store.noteCount} 篇笔记`"
          :roots="store.recentRoots"
          :tree-width="settings.themeConfig.noteTreeWidth"
          :name-of="noteRootName"
          @open="openRecentRoot"
          @forget="(dir: string) => store.forgetRoot(dir)"
        >
          <template #tools>
            <!-- 没仓库的文件夹就是本机的笔记：这颗按钮连同它的提示一起不出现 -->
            <el-tooltip v-if="store.canSync" :content="syncTitle" placement="top">
              <el-button size="small" text :disabled="store.syncing" @click="syncNow">
                <el-icon :class="{ 'is-loading': store.syncing }"><RefreshRight /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="重新读取文件夹" placement="top">
              <el-button size="small" text :disabled="store.loading" @click="store.reload()">
                <el-icon><Refresh /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="换一个文件夹" placement="top">
              <el-button size="small" text @click="chooseFolder">
                <el-icon><FolderOpened /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="素材管理（这个笔记本传的图片）" placement="top">
              <el-button size="small" text @click="assetsOpen = true">
                <el-icon><Picture /></el-icon>
              </el-button>
            </el-tooltip>
          </template>
        </RecentRoots>
      </aside>

      <!-- 两栏之间的分隔条：热区是一条通高的窄条，看得见的只有正中间那个小竖条 -->
      <PanelResizer
        :width="settings.themeConfig.noteTreeWidth"
        body-class="is-resizing-notes-tree"
        @move="settings.setNoteTreeWidth"
        @end="() => void settings.commitNoteTreeWidth()"
      />

      <section class="notes__editor panel">
        <header class="notes__head">
          <template v-if="store.active">
            <span class="notes__title" :title="store.active.name">{{ store.active.name }}</span>
            <!-- 在最外层时它是空的：没有「哪一层」可说，就不摆一个空盒子占位 -->
            <span v-if="locationText" class="notes__location truncate">{{ locationText }}</span>
          </template>
          <template v-else-if="store.activeRel">
            <span class="notes__title">
              {{ findNoteNode(store.nodes, store.activeRel)?.name ?? '' }}
            </span>
            <!-- 在最外层时它是空的：没有「哪一层」可说，就不摆一个空盒子占位 -->
            <span v-if="locationText" class="notes__location truncate">{{ locationText }}</span>
          </template>
          <span v-else class="notes__location">未选中</span>

          <span class="notes__spacer" />

          <!-- 保存状态就写在标题这一行：写东西的人需要知道「刚才那段到底存下去了没有」 -->
          <span v-if="store.saveError" class="notes__saved is-error">{{ store.saveError }}</span>
          <span v-else-if="store.active" class="notes__saved">{{ savedText }}</span>
        </header>

        <!-- 编辑器只在「打开的是一篇笔记」时出现；其余情况各说一句 -->
        <NoteEditor
          v-if="store.active"
          ref="editorRef"
          :note="store.active"
          :root="store.root"
          :theme="settings.effectiveTheme"
          @change="onContentChange"
          @open="openNoteLink"
        />

        <div v-else class="empty notes__hint">
          <template v-if="store.loadError">
            <p>读不出这个文件夹。</p>
            <p class="empty__hint">{{ store.loadError }}</p>
          </template>
          <PanelLoading v-else-if="scanning" text="正在读取笔记…" />
          <template v-else-if="store.openError">
            <p>这一篇打不开。</p>
            <p class="empty__hint">{{ store.openError }}</p>
            <el-button size="small" @click="store.select(store.activeRel)">重试</el-button>
          </template>
          <template v-else-if="store.activeRel">
            <p>「{{ findNoteNode(store.nodes, store.activeRel)?.name }}」是文件夹。</p>
            <p class="empty__hint">在左栏里选中一篇笔记打开，或者右击它往里面新建。</p>
          </template>
          <template v-else-if="!store.noteCount">
            <el-icon class="empty__icon"><EditPen /></el-icon>
            <p>这个文件夹里还没有笔记。</p>
            <p class="empty__hint">在左栏里右击新建一篇，写下第一行。</p>
          </template>
          <template v-else>
            <el-icon class="empty__icon"><Document /></el-icon>
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

    <!-- 素材管理：当前笔记本（这台机器）传过哪些图、谁还在用 -->
    <NoteAssetsDialog v-model="assetsOpen" :root="store.root" />
  </main>
</template>

<style scoped>
.notes {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

/**
 * 还没选文件夹时的整页引导：与视频页同一副样子，四周留白也同源 —— 左右与下边距取
 * `--card-gap`（设置里的「卡片间距」）；**上边距 0**，顶栏下面那条缝归 .shell 管（见 global.css）。
 */
.notes__intro {
  min-height: 0;
  margin: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

/**
 * 左树右编辑器。
 *
 * 两栏各是一张卡片（.panel 那副外壳，写在 global.css），间距与别处同源 ——
 * 左栏宽度跟着 theme.json 里的 noteTreeWidth 走（拖动分隔条改它）、右栏吃掉剩余宽度；
 * 两栏各自滚，谁也不把谁撑高。
 *
 * **顶边一份不给自己加**：顶栏下面那条缝归 .shell 管（见 global.css「顶栏与内容之间那条缝」），
 * 与首页同款 —— 这里再补一份，正常 / 毛玻璃两档就成了两倍。
 */
.notes__body {
  position: relative;
  display: grid;
  gap: var(--card-gap, 10px);
  min-width: 0;
  min-height: 0;
  padding: 0 var(--card-gap, 10px) var(--card-gap, 10px);
}

.notes__side {
  min-height: 0;
}

.notes__error {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.notes__error-actions {
  display: flex;
  gap: var(--sp-2);
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
