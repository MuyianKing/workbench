<script setup lang="ts">
import { FolderOpened } from '@element-plus/icons-vue'
import { relativeToProject, resolveWithinProject } from '@workbench/core'
import { computed } from 'vue'
import { useProjectsStore } from '@/stores/projects'

/**
 * 项目详情抽屉的「打包输出」：输出目录与打包完成后是否打开资源管理器。
 *
 * 从 `ProjectDrawer.vue` 拆出来的整块。
 */
const store = useProjectsStore()

const project = computed(() => store.drawerProject)
const pathValid = computed(() => (project.value ? store.isPathValid(project.value.id) : true))

/** 输出目录的完整路径，只用于显示与悬停提示（配置里存的可能是相对写法） */
const resolvedOutputDir = computed(() => {
  const current = project.value
  if (!current)
    return ''
  return resolveWithinProject(current.path, current.outputDir ?? '')
})

/**
 * 选一个目录当输出目录。
 *
 * 选中的目录在项目内就落成相对写法（与扫描出来的 dist / www 一致），项目换位置不失效；
 * 在项目外只能记绝对路径 —— 相对路径表达不了。清空仍然靠输入框自己删。
 */
async function pickOutputDir(): Promise<void> {
  const current = project.value
  if (!current)
    return

  const picked = await window.workbench.pickDirectory('选择打包输出目录')
  if (!picked)
    return

  current.outputDir = relativeToProject(current.path, picked)
}
</script>

<template>
  <section v-if="project" class="block">
    <h3 class="section-title">
      打包输出
    </h3>

    <div class="field">
      <label class="field__label">输出目录</label>
      <div class="field__row">
        <el-input
          v-model="project.outputDir"
          size="small"
          clearable
          placeholder="留空则自动探测（dist 等）"
        />
        <el-button
          size="small"
          :icon="FolderOpened"
          :disabled="!pathValid"
          @click="pickOutputDir"
        >
          选择
        </el-button>
      </div>
      <p v-if="resolvedOutputDir" class="field__hint mono truncate" :title="resolvedOutputDir">
        实际路径 → {{ resolvedOutputDir }}
      </p>
      <p class="field__hint">
        选项目内的目录会落成相对写法（如 dist），项目换位置也不会失效；选到项目外就记绝对路径。
      </p>
    </div>

    <div class="field field--row">
      <label class="field__label">打包完成后打开资源管理器</label>
      <el-switch v-model="project.autoOpenExplorer" size="small" />
    </div>
  </section>
</template>

<style scoped>
/* 输入框 + 旁边的按钮（与 AddProjectDialog 选目录那一行同一套）。
   注意别跟 .field--row 混：那个是「标签 + 开关」占一行，两条横线一个点。 */
.field__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.field__row :deep(.el-input) {
  flex: 1;
}
</style>
