<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowDown, FolderOpened, Refresh, Select } from '@element-plus/icons-vue'
import { UNGROUPED, useProjectsStore, type SortBy } from '@/stores/projects'
import { moveToPosition } from '@shared/reorder'
import { DRAG_MIME } from '@/drag-mime'
import GroupManageDialog from '@/components/GroupManageDialog.vue'

const store = useProjectsStore()
const groupDialog = ref(false)
/** 正在被拖到哪个筛选标签上 */
const dragOverKey = ref<string | null>(null)
/** 正在拖动哪个分组标签（拖动分组 = 排序，和拖卡片 = 归类是两回事） */
const draggingGroup = ref<string | null>(null)

const sortLabels: Record<SortBy, string> = {
  recent: '最近使用',
  name: '项目名称',
  created: '添加时间'
}

const ungroupedCount = computed(() => store.projects.filter((p) => !p.groupId).length)

const chips = computed(() => {
  const list: Array<{ key: string; label: string; count: number; sortable: boolean }> = [
    { key: 'all', label: '全部', count: store.projects.length, sortable: false }
  ]

  // 没有项目在跑就不占一个位置；但正停在这个筛选上时得把标签留住，
  // 否则筛选还在生效、列表却是空的，界面上找不到「是谁在筛」
  if (store.runningCount > 0 || store.groupFilter === 'running') {
    list.push({ key: 'running', label: '运行中', count: store.runningCount, sortable: false })
  }

  // 没有未归类的项目就不占一个位置
  if (ungroupedCount.value > 0) {
    list.push({ key: UNGROUPED, label: '未分组', count: ungroupedCount.value, sortable: false })
  }

  for (const g of store.sortedGroups) {
    list.push({
      key: g.id,
      label: g.name,
      count: store.projects.filter((p) => p.groupId === g.id).length,
      sortable: true
    })
  }
  return list
})

/** 「全部」「运行中」「未分组」是筛选视图，不是分组，不能当拖拽落点 */
function canDrop(key: string): boolean {
  return key !== 'all' && key !== 'running'
}

function onDragOver(key: string, event: DragEvent): void {
  if (!canDrop(key)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverKey.value = key
}

function onDragLeave(key: string): void {
  if (dragOverKey.value === key) dragOverKey.value = null
}

function onGroupDragStart(key: string, event: DragEvent): void {
  if (!canDrop(key) || !event.dataTransfer) return
  draggingGroup.value = key
  event.dataTransfer.setData(DRAG_MIME.group, key)
  event.dataTransfer.effectAllowed = 'move'
}

function onGroupDragEnd(): void {
  draggingGroup.value = null
  dragOverKey.value = null
}

/** 把 fromId 插到 toId 的位置上，然后整份落盘 */
async function reorderGroup(fromId: string, toId: string): Promise<void> {
  const next = moveToPosition(
    store.sortedGroups.map((g) => g.id),
    fromId,
    toId
  )
  if (next) await store.reorderGroups(next)
}

function onDrop(key: string, event: DragEvent): void {
  dragOverKey.value = null
  if (!canDrop(key)) return

  // 拖的是分组标签 → 排序
  const groupId = event.dataTransfer?.getData(DRAG_MIME.group)
  if (groupId) {
    draggingGroup.value = null
    if (key !== UNGROUPED) void reorderGroup(groupId, key)
    return
  }

  // 拖的是项目卡片 → 归类（场景 S7）
  const id =
    event.dataTransfer?.getData(DRAG_MIME.project) ||
    event.dataTransfer?.getData('text/plain')
  if (!id) return

  store.assignGroup(id, key === UNGROUPED ? undefined : key)
}

function pickSort(key: string): void {
  // 走 store action 而不是直接赋值，非法值不会被写进 sortBy
  if (key === 'recent' || key === 'name' || key === 'created') store.setSortBy(key)
}
</script>

<template>
  <div class="filter" :class="{ 'is-editing': store.layoutEditing }">
    <!--
      布局编辑态：原地接管这一行，而不是在画布上方再插一条操作栏 ——
      行高固定（--h-filter），进出编辑态画布都不会上下跳。
    -->
    <template v-if="store.layoutEditing">
      <span class="filter__hint">
        拖动卡片可在三栏之间移动、调整栏内顺序；卡片右上角切换「固定高度 / 自适应」，
        固定高度可拖下沿改高；拖两栏之间的竖线改栏宽 · 步进
        <b class="mono">{{ store.gridStep }}px</b> · 卡片间距
        <b class="mono">{{ store.cardGap }}px</b>
      </span>
      <div class="filter__tools">
        <el-button size="small" :icon="Refresh" @click="store.resetLayout()">恢复默认</el-button>
        <el-button size="small" type="primary" :icon="Select" @click="store.setLayoutEditing(false)">
          完成
        </el-button>
      </div>
    </template>

    <template v-else>
      <div class="filter__chips">
        <button
          v-for="chip in chips"
          :key="chip.key"
          class="chip"
          :class="{
            'is-active': store.groupFilter === chip.key,
            'is-drop': dragOverKey === chip.key && draggingGroup !== chip.key,
            'is-dragging': draggingGroup === chip.key
          }"
          type="button"
          :draggable="chip.sortable"
          :title="chip.sortable ? '拖动可调整分组顺序' : undefined"
          @click="store.setGroupFilter(chip.key)"
          @dragover="onDragOver(chip.key, $event)"
          @dragleave="onDragLeave(chip.key)"
          @drop="onDrop(chip.key, $event)"
          @dragstart="onGroupDragStart(chip.key, $event)"
          @dragend="onGroupDragEnd"
        >
          <span
            v-if="chip.key === 'running'"
            class="chip__dot"
            :class="{ 'is-live': chip.count > 0 }"
          />
          {{ chip.label }}
          <span class="chip__count mono">{{ chip.count }}</span>
        </button>
      </div>

      <div class="filter__tools">
        <button class="sort" type="button" @click="groupDialog = true">
          <el-icon class="sort__caret"><FolderOpened /></el-icon>
          <span class="sort__value">分组管理</span>
        </button>

        <el-dropdown trigger="click" placement="bottom-end" @command="pickSort">
          <button class="sort" type="button">
            <span class="sort__label">排序</span>
            <span class="sort__value">{{ sortLabels[store.sortBy] }}</span>
            <el-icon class="sort__caret"><ArrowDown /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="(label, key) in sortLabels"
                :key="key"
                :command="key"
                :class="{ 'is-current': store.sortBy === key }"
              >
                {{ label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </template>

    <GroupManageDialog v-model="groupDialog" />
  </div>
</template>

<style scoped>
.filter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 0 var(--sp-5);
  min-height: var(--h-filter);
  border-bottom: 1px solid var(--border);
  background: var(--bg-canvas);
}

.filter__chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/**
 * 编辑态：这一行临时换成布局操作条，整条铺一层主题色的淡底，一眼看出现在不在普通筛选状态。
 *
 * 淡底是按主色调出来的：主色在亮色下近黑、暗色下近白，所以两个主题下都是「往背景的反方向」
 * 走一步 —— 没设主题色时是一条中性灰，设了主题色就是那支色的淡调。
 * 毛玻璃 / 透明两档的底由 global.css 换成半透明的那一层，好让壁纸照旧透上来。
 */
.filter.is-editing {
  background: color-mix(in srgb, var(--el-color-primary) 12%, var(--bg-canvas));
}

.filter__hint {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
  /* 一行放不下就省略，绝不换行把行撑高、把下面的画布顶下去 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.filter__hint b {
  color: var(--ink);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--ink-2);
  font-size: var(--fs-body);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.chip:hover {
  background: rgba(17, 21, 27, 0.05);
}

/* 选中态是一处「当前选择」的表达，跟主色走（见设置里的「主题色」）：
   默认的中性主色就是 --ink，所以不设主题色时与原来完全一样。 */
.chip.is-active {
  background: var(--el-color-primary);
  color: var(--el-color-white);
}

/* 拖拽落点：虚线描边 + 轻微底色，和选中态区分开。
   描边同样跟主色走（默认的中性主色就是 --ink），落点提示才和选中态是同一个颜色。 */
.chip.is-drop {
  border-color: var(--el-color-primary);
  border-style: dashed;
  background: rgba(17, 21, 27, 0.06);
}

/* 正在被拖动的分组标签：压暗一点，明确「我在移动它」 */
.chip.is-dragging {
  opacity: 0.45;
}

.chip[draggable='true'] {
  cursor: grab;
}

.chip.is-active.is-drop {
  background: var(--el-color-primary);
  color: var(--el-color-white);
}

:root[data-theme='dark'] .chip.is-drop {
  background: rgba(232, 237, 244, 0.08);
}

.chip__count {
  font-size: var(--fs-micro);
  opacity: 0.6;
}

.chip__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--st-idle);
}

.chip.is-active .chip__dot {
  background: rgba(255, 255, 255, 0.85);
}

.chip__dot.is-live {
  background: var(--st-run);
}

.chip:not(.is-active) .chip__dot.is-live {
  box-shadow: 0 0 0 3px rgba(199, 127, 10, 0.16);
}

/* ---------- 排序 ---------- */
.filter__tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-surface);
  color: var(--ink-2);
  font-size: var(--fs-meta);
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.sort:hover {
  border-color: var(--border-strong);
}

.sort__label {
  color: var(--ink-3);
}

.sort__value {
  color: var(--ink);
  font-weight: 500;
}

.sort__caret {
  font-size: 11px;
  color: var(--ink-3);
}

@media (max-width: 900px) {
  .sort__label {
    display: none;
  }
}
</style>
