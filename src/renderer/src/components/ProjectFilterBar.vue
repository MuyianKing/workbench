<script setup lang="ts">
/**
 * 项目页的工具条：左边是分组筛选标签，右边是分组管理与排序。
 *
 * 这一条原先在首页的顶部带里（FilterBar），项目卡网格搬出来单独成页之后跟着一起搬过来 ——
 * 它们本来就是一回事：分组标签是项目卡的拖拽落点（场景 S7），两者必须同页面才拖得动。
 *
 * 底色仍由 global.css 按「顶部样式」三档给（band 取画布色、glass / clear 全透），
 * 所以它看起来还是原来那条工具带，只是从顶部带挪到了页面里。
 */
import { computed, ref } from 'vue'
import { ArrowDown, FolderOpened } from '@element-plus/icons-vue'
import { UNGROUPED, useProjectsStore } from '@/stores/projects'
import { isProjectSort, type ProjectSort } from '@shared/project-sort'
import { moveToPosition } from '@shared/reorder'
import { DRAG_MIME } from '@/drag-mime'
import GroupManageDialog from '@/components/GroupManageDialog.vue'

const store = useProjectsStore()
const groupDialog = ref(false)
/** 正在被拖到哪个筛选标签上 */
const dragOverKey = ref<string | null>(null)
/** 正在拖动哪个分组标签（拖动分组 = 排序，和拖卡片 = 归类是两回事） */
const draggingGroup = ref<string | null>(null)

const sortLabels: Record<ProjectSort, string> = {
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
  // 走 store action 而不是直接赋值，非法值不会被写进 sortBy；取值表在 shared/project-sort.ts
  if (isProjectSort(key)) store.setSortBy(key)
}
</script>

<template>
  <div class="filter">
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

    <GroupManageDialog v-model="groupDialog" />
  </div>
</template>

<style scoped>
/**
 * 工具带本身的外壳（flex 排布、高度、边框、底色与三档顶部样式）在 global.css 的
 * 「工作区背景 / 顶部样式」一节里 —— 项目页与工作页共用同一条带子，
 * 写法留在任一组件里都会让另一个只剩颜色、丢掉排版。
 */
.filter__chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/*
 * 筛选标签（.chip）的基础形态在 global.css —— 项目页与工作页都在用它，
 * 这里只留项目页特有的那几档：拖拽落点、拖动中的样子、以及标签里那个运行状态点。
 */
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

/* 排序控件（.sort / .sort__label / .sort__value / .sort__caret）与工具带的排版（.filter__tools）
   一样在 global.css：工作页也用同一套，写法留在某个组件里另一个就只剩一半。 */

/* 这一页的筛选标签比工作页密一档，所以只收紧间距。
   多带一层 .filter 是为了压过全局那条规则，而不是跟它打平手后赌样式注入顺序 */
.filter .filter__tools {
  gap: 6px;
}
</style>
