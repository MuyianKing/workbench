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
 * 增删改的确认与提示。树在 NoteTree，正文编辑在 NoteEditor。
 */
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CaretBottom, Close, Document, EditPen, FolderOpened, Notebook, Picture, Refresh, RefreshRight } from '@element-plus/icons-vue'
import {
  countNodes,
  findNoteNode,
  noteRootName,
  type NoteKind,
  type NoteSyncSummary
} from '@shared/note'
import { formatTimestamp } from '@/format'
import { confirmAction } from '@/notify'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { useNotesStore } from '@/stores/notes'
import { useSettingsStore } from '@/stores/settings'
import NoteTree from '@/components/NoteTree.vue'
import NoteEditor from '@/components/NoteEditor.vue'
import NoteNameDialog from '@/components/NoteNameDialog.vue'
import NoteAssetsDialog from '@/components/NoteAssetsDialog.vue'

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

/** 「最近打开」那份浮层开着没有（挂在笔记本名那颗按钮上，见模板） */
const historyOpen = ref(false)

/**
 * 那份浮层的宽度：**与左栏的菜单区一样宽**（就是底部这一行的宽度）。
 *
 * 现量而不是按左栏宽度减内边距算：内边距是设计令牌（`--sp-4`），
 * 在 JS 里再抄一遍就等于多了一处会过期的事实。
 * 量的是这一行自己的 `clientWidth` —— 它铺满菜单区，且自己不带内边距。
 */
const metaRef = ref<HTMLElement | null>(null)
const historyWidth = ref(200)

function measureHistoryWidth(): void {
  const width = metaRef.value?.clientWidth ?? 0
  if (width > 0) historyWidth.value = Math.round(width)
}

onMounted(() => {
  void store.init()
  void nextTick(measureHistoryWidth)
})

// 左栏宽度可以拖、笔记本也可能刚选上（这一行这时才渲染出来）：宽度跟着重新量一次
watch(
  [() => store.root, () => settings.themeConfig.noteTreeWidth],
  () => void nextTick(measureHistoryWidth)
)

/** 第一次进来（或想换一个目录）时挑文件夹；取消就什么都不做 */
async function chooseFolder(): Promise<void> {
  const picked = await window.workbench.pickDirectory('选择笔记文件夹')
  if (!picked) return

  if (await store.setRoot(picked)) ElMessage.success('笔记本已切换')
}

/**
 * 从「最近打开」里换一个笔记本；点的是当前这个就什么都不做。
 *
 * 换完把浮层收起来：这一下的事已经做完了，留着它只会挡着下面的树
 * （删记录那颗叉不关 —— 那是可能连着点几次的动作）。
 */
function openRecent(dir: string): void {
  historyOpen.value = false
  if (dir === store.root) return
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

/** 编辑器实例：同步前后要借它一双手（先把攒着的那一份交出去 / 换掉远端改过的那一篇） */
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)

/** 没配仓库时那颗按钮的提示：点下去只会得到一句「去哪儿配」，那就先写在提示里 */
const syncTitle = computed(() =>
  settings.settings.noteSyncRepo
    ? '与远端同步（提交本机改动、拉回别处的改动）'
    : '同步笔记（先到设置 → 笔记里填仓库地址）'
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
 * 失败一律是「说清楚」而不是静默：没配地址、git 报的错、冲突的那几个文件名都在里面。
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

/** 拖左栏右沿改宽度：跟手与收手的解绑交给 composable，松手才落盘 */
function onResizeDown(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()

  const startWidth = settings.themeConfig.noteTreeWidth
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    // 拖过正文（Vditor 里是可选中文字）时别把正文选起来、光标也别变成文本光标
    bodyClass: 'is-resizing-notes-tree',
    onMove: (moveEvent, start) => {
      settings.setNoteTreeWidth(startWidth + (moveEvent.clientX - start.x))
    },
    onEnd: () => void settings.commitNoteTreeWidth()
  })
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
        <footer class="notes__foot">
          <!-- ref 只为一件事：量出这一行有多宽，好让「最近打开」那份浮层与它等宽、左缘对齐 -->
          <div ref="metaRef" class="notes__meta">
            <!--
              笔记本名是一颗按钮：点开「最近打开」那份浮层（往上弹 —— 它就在面板最底下）。
              旁边那颗小箭头是提示，展开时翻过来。没有历史记录时不摆浮层，名字就是一行字。
            -->
            <el-popover
              v-if="store.recentRoots.length"
              v-model:visible="historyOpen"
              trigger="click"
              placement="top-start"
              :width="historyWidth"
              :offset="8"
            >
              <template #reference>
                <button class="notes__root-btn" type="button" :title="store.root">
                  <span class="notes__root truncate">{{ store.rootName }}</span>
                  <el-icon class="notes__caret" :class="{ 'is-open': historyOpen }">
                    <CaretBottom />
                  </el-icon>
                </button>
              </template>

              <div class="notes__history">
                <p class="notes__history-title">最近打开</p>
                <ul class="notes__history-list scrollbar">
                  <li
                    v-for="dir in store.recentRoots"
                    :key="dir"
                    class="notes__history-item"
                    :class="{ 'is-current': dir === store.root }"
                  >
                    <button
                      class="notes__history-open"
                      type="button"
                      :title="dir"
                      :disabled="dir === store.root"
                      @click="openRecent(dir)"
                    >
                      <span class="truncate">{{ noteRootName(dir) }}</span>
                    </button>
                    <el-tooltip content="从历史记录里删掉" placement="top">
                      <button
                        class="notes__history-remove"
                        type="button"
                        aria-label="从历史记录里删掉"
                        @click="store.forgetRoot(dir)"
                      >
                        <el-icon><Close /></el-icon>
                      </button>
                    </el-tooltip>
                  </li>
                </ul>
              </div>
            </el-popover>

            <!-- 一个历史记录都没有：名字只是一行字，点了也没东西可弹 -->
            <span v-else class="notes__root is-plain truncate" :title="store.root">
              {{ store.rootName }}
            </span>

            <span class="notes__count" :title="`${store.noteCount} 篇笔记`">
              {{ store.noteCount }} 篇笔记
            </span>
            <span class="notes__tools">
              <el-tooltip :content="syncTitle" placement="top">
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
            </span>
          </div>

        </footer>
      </aside>

      <!-- 两栏之间的分隔条：热区是一条通高的窄条，看得见的只有正中间那个小竖条 -->
      <span
        class="notes__resizer"
        title="拖动调整目录树宽度"
        @pointerdown="onResizeDown"
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
        />

        <div v-else class="empty notes__hint">
          <template v-if="store.loadError">
            <p>读不出这个文件夹。</p>
            <p class="empty__hint">{{ store.loadError }}</p>
          </template>
          <template v-else-if="scanning">
            <p>正在读取笔记…</p>
          </template>
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

.notes__intro {
  min-height: 0;
}

/**
 * 左树右编辑器。
 *
 * 两栏各是一张卡片（.panel 那副外壳，写在 global.css），间距与别处同源 ——
 * 左栏宽度跟着 theme.json 里的 noteTreeWidth 走（拖动分隔条改它）、右栏吃掉剩余宽度；
 * 两栏各自滚，谁也不把谁撑高。
 */
.notes__body {
  position: relative;
  display: grid;
  gap: var(--card-gap, 10px);
  min-width: 0;
  min-height: 0;
  padding: var(--card-gap, 10px);
}

.notes__side {
  min-height: 0;
}

/* 两栏之间的分隔条：热区通高，看得见的只有正中间那个小竖条（与首页栏宽把手同款） */
.notes__resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 10;
  width: 10px;
  cursor: ew-resize;
  /* 落点：外框内边距 + 左栏宽度 + 缝线正中，再往回让半个热区（本容器的定位原点是内边距外沿） */
  left: calc(var(--card-gap, 10px) + var(--tree-w, 232px) + var(--card-gap, 10px) / 2 - 5px);
}

/**
 * 把手**平时不显示**，指针落到缝线上才露出来：它是一条 10px 热区上的装饰，
 * 常显就是给每一屏都添一道竖线（这一页左栏本来就是一条窄栏，多一个竖条更挤）。
 * 拖动期间（body 上挂着 is-resizing-notes-tree）指针可能已经离开缝线，那时也得亮着 ——
 * 否则拖到一半把手自己没了，看着像拖动断了。
 */
.notes__resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 8px;
  height: 34px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--ink);
  border-radius: var(--r-pill);
  background: var(--bg-surface);
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}

/* 指针落到缝线上就把小竖条填实，提示这条缝可以拖 */
.notes__resizer:hover::after {
  background: var(--ink);
}

.notes__resizer:hover::after,
body.is-resizing-notes-tree .notes__resizer::after {
  opacity: 1;
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

/* ---------- 左栏底部：笔记本 + 最近打开 ---------- */

/**
 * 钉在卡片底部：树上边吃掉剩余高度，这一段多长都不会被挤走。
 * 上面那道分隔线把它与树分开 —— 两者说的是不同的事（这一页的内容 / 这是哪个笔记本）。
 */
.notes__foot {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}

.notes__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

/* 笔记本名：点开「最近打开」那颗按钮（没有历史记录时是一行字，不带按钮外观） */
.notes__root-btn {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  /* 不带横向内边距：按钮的左缘就是菜单区的左缘 —— 名字与树的缩进对齐，
     浮层（挂在它上面、placement=top-start）的左缘也因此与菜单对齐 */
  padding: 2px 0;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.notes__root-btn:hover,
.notes__root-btn[aria-expanded='true'] {
  background: var(--bg-subtle);
}

.notes__root {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--ink-2);
}

/* 「点这儿还有一份清单」的提示：展开时翻过来 */
.notes__caret {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
  transition: color 0.15s ease, transform 0.15s ease;
}

.notes__root-btn:hover .notes__caret {
  color: var(--ink-2);
}

.notes__caret.is-open {
  color: var(--ink-2);
  transform: rotate(180deg);
}

/**
 * 这一行的宽度是抢出来的：笔记本名最要紧，篇数其次，三颗按钮各自有固定宽度。
 * 所以篇数允许被挤掉（截断 + 悬停看全），名字不跟着一起缩 ——
 * 两边都按默认的 flex-shrink: 1 分，名字会被挤成「N…」，那这一行就白留了。
 */
.notes__count {
  flex: 0 100 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.notes__tools {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

/* 三颗图标按钮：挨在一起（EP 的 text 按钮自带左外边距），内边距也收窄 ——
   这一行本来就窄，按钮占的每一像素都是从笔记本名那里拿走的 */
.notes__tools :deep(.el-button + .el-button) {
  margin-left: 0;
}

.notes__tools :deep(.el-button) {
  height: 22px;
  padding: 0 4px;
}

/**
 * 「最近打开」是一份**往上弹的浮层**（挂在笔记本名那颗按钮上，见模板）。
 *
 * 不做成常显的一行：左栏本来就窄，这几个目录几天也不换一次，常显要吃掉大半屏的高度 ——
 * 收进浮层里，那段高度就还给树了。浮层内容被 Teleport 到 body，不受卡片裁剪的影响。
 */
.notes__history {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-height: 0;
}

.notes__history-title {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 历史记录最多 6 条，正常不会滚；给个上限免得这里把树挤没 */
.notes__history-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 132px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.notes__history-item {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  border-radius: var(--r-sm);
}

.notes__history-item:hover {
  background: var(--bg-inset);
}

.notes__history-open {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px var(--sp-2);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font: inherit;
  font-size: var(--fs-meta);
  color: var(--ink-2);
  text-align: left;
  cursor: pointer;
}

.notes__history-open:hover {
  color: var(--ink);
}

/* 当前打开的那个不给点（点它等于什么都不做），但要看得见是哪一条 */
.notes__history-item.is-current .notes__history-open {
  color: var(--ink);
  font-weight: 600;
  cursor: default;
}

.notes__history-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 2px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  color: var(--ink-3);
  cursor: pointer;
  /* 平时不显眼，指到这一行才露出来：它是次要动作，不该与「打开」抢注意力 */
  opacity: 0;
}

.notes__history-item:hover .notes__history-remove {
  opacity: 1;
}

.notes__history-remove:hover {
  color: var(--ink);
  background: var(--bg-subtle);
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
