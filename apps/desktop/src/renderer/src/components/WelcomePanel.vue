<script setup lang="ts">
import { FolderOpened, Plus } from '@element-plus/icons-vue'
/**
 * 一个项目都还没有时的项目页：一枚空态 + 添加项目按钮，别无他物。
 * 2026-11 用户定：上手三步 / 说明 / 眉题 / 水印全部去掉，「不关心这些东西」——
 * 缺省样式走 EmptyState（裸压画布、居中、白字），与技能 / Git 的整页空态同一待遇。
 */
import EmptyState from '@/components/EmptyState.vue'
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()
</script>

<template>
  <EmptyState :icon="FolderOpened" text="还没有项目">
    <template #actions>
      <el-button type="primary" :icon="Plus" @click="store.openAddDialog()">
        添加项目
      </el-button>
    </template>
  </EmptyState>
</template>
