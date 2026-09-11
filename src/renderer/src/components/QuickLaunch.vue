<script setup lang="ts">
/**
 * 首页的「快捷启动」：常用软件挂在一块工作台面板里，点一下就启动。
 *
 * 与项目卡片是两种东西：Workbench 不接管这些进程 —— 没有日志、没有停止按钮，
 * 关掉 Workbench 也不会连带结束它们。所以一块卡上只有小图标和几个维护动作，
 * 名字收进悬停提示，格子才能排得密、一屏放得下更多常用软件。
 *
 * 面板外壳与侧栏那几块（快捷操作 / 系统状态）一致，但内容自己滚：
 * 标题固定不动，程序多了只在中间那块滚动区里滚动，面板不会跟着程序数量长高。
 */
import { computed, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { MoreFilled, Plus } from '@element-plus/icons-vue'
import { moveToPosition } from '@shared/reorder'
import { useProjectsStore } from '@/stores/projects'
import type { QuickApp } from '@/types'

const store = useProjectsStore()

/** 拖到哪张卡上了（落点高亮） */
const dragOverId = ref<string | null>(null)
/** 正在拖哪张卡（拖动排序用，与「拖项目卡到分组」是两回事） */
const draggingId = ref<string | null>(null)

const apps = computed(() => store.quickApps)

function initialOf(app: QuickApp): string {
  return (app.name.trim() || '?').slice(0, 1).toUpperCase()
}

/** 悬停提示：平时只露图标，名字在这里；失效的顺便说清怎么补救 */
function tipOf(app: QuickApp): string {
  return store.isQuickAppMissing(app.id)
    ? `${app.name}（失效 · 用「⋯ → 编辑」重新选择）`
    : app.name
}

function iconOf(app: QuickApp): string {
  return store.quickIconOf(app.target)
}

function launch(app: QuickApp): void {
  void store.launchQuickApp(app.id)
}

function onMore(app: QuickApp, command: string): void {
  if (command === 'edit') store.openQuickDialog(app.id)
  else if (command === 'reveal') void store.reveal(app.target)
  else if (command === 'remove') void remove(app)
}

async function remove(app: QuickApp): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定把「${app.name}」从快捷启动里移除？程序本身不会被卸载或删除。`,
      '移除常用软件',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  await store.removeQuickApp(app.id)
}

function onDragStart(app: QuickApp, event: DragEvent): void {
  if (!event.dataTransfer) return
  draggingId.value = app.id
  event.dataTransfer.setData('application/x-workbench-quick-app', app.id)
  event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(app: QuickApp, event: DragEvent): void {
  if (!draggingId.value || draggingId.value === app.id) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverId.value = app.id
}

function onDragEnd(): void {
  draggingId.value = null
  dragOverId.value = null
}

/** 松手即重排：把正在拖的那张放到当前这张的位置上 */
function onDrop(app: QuickApp): void {
  const from = draggingId.value
  onDragEnd()
  if (!from || from === app.id) return

  const next = moveToPosition(
    apps.value.map((item) => item.id),
    from,
    app.id
  )
  if (next) void store.reorderQuickApps(next)
}
</script>

<template>
  <section class="panel launch">
    <!-- 标题固定：它不在下面那块滚动区里，程序再多也不会被滚走 -->
    <header class="panel__head">
      <span class="eyebrow">快捷启动</span>
    </header>

    <!--
      添加入口挂在卡片右上角，绝对定位：放进标题栏的话，按钮比文字行高，
      标题栏会被撑高几像素，固定高度的卡片就会把下面那排图标挤下去。
    -->
    <el-tooltip content="添加软件 · .exe / .lnk / .bat" placement="bottom-end" :show-after="250">
      <button
        class="launch__add"
        type="button"
        aria-label="添加软件"
        @click="store.openQuickDialog()"
      >
        <el-icon><Plus /></el-icon>
      </button>
    </el-tooltip>

    <div class="launch__body">
      <p v-if="!apps.length" class="launch__empty">还没有常用软件，点右上角的 + 添加</p>

      <ul v-else class="launch__list">
        <li
          v-for="app in apps"
          :key="app.id"
          class="launch__item"
          :class="{
            'is-missing': store.isQuickAppMissing(app.id),
            'is-dragover': dragOverId === app.id
          }"
          role="button"
          tabindex="0"
          :aria-label="app.name"
          draggable="true"
          @click="launch(app)"
          @keydown.enter.prevent="launch(app)"
          @keydown.space.prevent="launch(app)"
          @dragstart="onDragStart(app, $event)"
          @dragover="onDragOver(app, $event)"
          @dragleave="dragOverId === app.id && (dragOverId = null)"
          @drop.prevent="onDrop(app)"
          @dragend="onDragEnd"
        >
          <!-- 只留图标，名字收进悬停提示：格子才能压到 44px 上下、排得密 -->
          <el-tooltip :content="tipOf(app)" placement="top" :show-after="250">
            <span class="launch__hit">
              <span class="launch__icon">
                <img v-if="iconOf(app)" class="launch__img" :src="iconOf(app)" alt="" />
                <template v-else>{{ initialOf(app) }}</template>
              </span>
              <span
                v-if="store.isQuickAppMissing(app.id)"
                class="launch__flag mono"
                aria-hidden="true"
              >
                !
              </span>
            </span>
          </el-tooltip>

          <!-- 更多操作收在右上角，鼠标移上来才出现，不跟图标抢位置 -->
          <el-dropdown
            class="launch__more"
            trigger="click"
            placement="bottom-end"
            @command="onMore(app, $event)"
          >
            <button
              class="launch__more-btn"
              type="button"
              :aria-label="`${app.name} 的更多操作`"
              @click.stop
            >
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="edit">编辑…</el-dropdown-item>
                <el-dropdown-item command="reveal">打开所在位置</el-dropdown-item>
                <el-dropdown-item command="remove" divided>从快捷启动移除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* 下沿不留白：卡片高度本来就紧，底部再垫一层内边距会多出一截空 */
.panel {
  padding-bottom: 0;
}

/**
 * 滚动区：标题在它外面所以固定不动，这里只放图标网格。
 * 高度跟着卡片走（卡片是用户拖出来的固定尺寸），程序多到放不下就自己滚。
 */
.launch__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/**
 * 图标网格：格子做成正方形，列数按可用宽度自适应 —— 窗口越宽一排放得越多。
 * 只保留图标、不排名字，才能把格子压到 44px 上下，一屏看到更多常用软件。
 */
.launch__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: 6px;
  align-content: start;
}

.launch__item {
  position: relative;
  aspect-ratio: 1 / 1;
  min-height: 44px;
  /* 面板本身是白的，卡片用一层浅底而不是白底：靠底色而不是边框分层 */
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  cursor: pointer;
  overflow: hidden;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.launch__item:hover {
  background: var(--bg-inset);
}

.launch__item:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
}

/* 落点高亮：虚线框就是「松手会插到这里」 */
.launch__item.is-dragover {
  border-color: var(--ink);
  border-style: dashed;
}

/**
 * 热区：盖满整块格子，名字的悬停提示挂在这上面。
 * 更多操作按钮是它的兄弟节点、层级更高，所以悬停按钮时不会弹出名字。
 */
.launch__hit {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
}

/**
 * 图标本身不带底：图标文件多半是透明底的，给它垫一块浅色方块就会在图标四周
 * 露出一圈白边（尤其暗色下很脏）。没有图标时退回首字母，直接写在卡片底色上。
 */
.launch__icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  color: var(--ink-2);
  font-size: 16px;
  font-weight: 600;
}

.launch__img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}

/* 程序被移走：图标褪成灰的，左上角挂一枚叹号（名字与补救方式都在悬停提示里） */
.launch__item.is-missing .launch__icon {
  filter: grayscale(1);
  opacity: 0.5;
}

.launch__flag {
  position: absolute;
  top: 2px;
  left: 2px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--st-fail-soft);
  color: var(--st-fail);
  font-size: 9px;
  line-height: 1;
}

/* ---------- 更多操作 ---------- */
.launch__more {
  position: absolute;
  top: 1px;
  right: 1px;
  z-index: 2;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.launch__item:hover .launch__more,
.launch__item:focus-within .launch__more {
  opacity: 1;
}

.launch__more-btn {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ink-3);
  font-size: 11px;
  cursor: pointer;
}

.launch__more-btn:hover {
  background: var(--bg-surface);
  color: var(--ink);
}

/* ---------- 卡片右上角的添加入口 ---------- */
.launch__add {
  position: absolute;
  /* 与标题那行文字（eyebrow）大致对齐，具体像素不重要，反正不占流 */
  top: 12px;
  right: 12px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  /* 只要一个 +：这块是标题栏上的外挂入口，画成描边小方块会跟下面的软件图标抢视线 */
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.launch__add:hover {
  color: var(--ink);
}

/* 一个软件都没加时的落点提示（添加入口在标题栏上） */
.launch__empty {
  padding: var(--sp-3) 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}
</style>
