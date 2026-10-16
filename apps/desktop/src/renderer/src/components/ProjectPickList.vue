<script setup lang="ts">
import type { Project } from '@/types'
import { Check } from '@element-plus/icons-vue'
import { projectColorVar, sanitizeProjectColor } from '@workbench/core'
/** 项目列表由调用方取数，选中项可逐行切换。 */
const props = defineProps<{
  projects: Project[]
  emptyText: string
  disabled?: boolean
}>()

const selectedIds = defineModel<string[]>({ required: true })

function toggle(id: string): void {
  if (props.disabled)
    return
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter(item => item !== id)
    : [...selectedIds.value, id]
}

/** 标识色的取用口径在 packages/core/src/project-color.ts，这里只管画出来 */
function colorVarOf(project: Project): string {
  const color = sanitizeProjectColor(project.color)
  return color ? projectColorVar(color) : 'var(--border-strong)'
}
</script>

<template>
  <p v-if="!projects.length" class="pick__empty">
    {{ emptyText }}
  </p>
  <div v-else class="pick" role="group" aria-label="选择项目">
    <button
      v-for="project in projects"
      :key="project.id"
      class="pick__row"
      type="button"
      :aria-pressed="selectedIds.includes(project.id)"
      :disabled="disabled"
      :class="{ 'is-active': selectedIds.includes(project.id) }"
      @click="toggle(project.id)"
    >
      <i class="pick__dot" :style="{ background: colorVarOf(project) }" aria-hidden="true" />
      <span class="pick__name" :title="project.name">{{ project.name }}</span>
      <span class="pick__path mono" :title="project.path">{{ project.path }}</span>
      <el-icon class="pick__check">
        <Check />
      </el-icon>
    </button>
  </div>
</template>

<style scoped>
/* 一个项目都没有：只留一句话，不画一个空框 */
.pick__empty {
  margin: 0;
  padding: var(--sp-4) 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.pick {
  display: flex;
  flex-direction: column;
  max-height: 300px;
  overflow-y: auto;
  /* 滚到头别把滚动传给弹窗背后那一页 */
  overscroll-behavior: contain;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-surface);
}

.pick__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  padding: var(--sp-2) var(--sp-3);
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

/* 分隔线画在行的上边：第一行不画，最后一行不留一条悬空的线 */
.pick__row + .pick__row {
  border-top: 1px solid var(--border);
}

.pick__row:hover:not(:disabled) {
  background: var(--bg-subtle);
}

.pick__row:disabled {
  cursor: default;
}

.pick__row.is-active {
  background: var(--bg-selected);
}

/* 标识色点：与项目卡、工作日志里选项目那处的圆点同一个尺寸与口径 */
.pick__dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

/* 名字与路径各占一头：名字先让位（最多吃掉一半），路径跟着缩，两边都省略号收尾 */
.pick__name {
  flex: 0 1 auto;
  max-width: 50%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.pick__path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-align: right;
  text-overflow: ellipsis;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 对勾只在选中那一行显形，但位置一直占着 —— 否则选一行、别的行会跟着左右挪 */
.pick__check {
  flex-shrink: 0;
  visibility: hidden;
  color: var(--ink);
  font-size: var(--fs-meta);
}

.pick__row.is-active .pick__check {
  visibility: visible;
}
</style>
