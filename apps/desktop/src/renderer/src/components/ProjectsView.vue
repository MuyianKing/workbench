<script setup lang="ts">
/**
 * 项目页：分组筛选工具条 + 项目卡网格。
 *
 * 这一页原来散在首页的顶部带与中栏卡片里（筛选行 + 「项目列表」卡）。独立成页之后网格
 * 能铺满整窗，不再受首页三栏的栏宽限制 —— 1440 宽下一行放得下四张卡。
 *
 * 与首页共用同一套间距：--card-gap 由 .app 统一给（导航栏那张卡片也吃它），
 * 网格周围的内边距由 ProjectsPanel 自己带（它是这一页的滚动体）。
 */
import { ref } from 'vue'
import ProjectFilterBar from '@/components/ProjectFilterBar.vue'
import ProjectsPanel from '@/components/ProjectsPanel.vue'
</script>

<template>
  <!-- --card-gap 由 .app 统一给（导航栏那张卡片也吃它），内边距由项目网格自己带 -->
  <main class="projects-view">
    <ProjectFilterBar />
    <ProjectsPanel />
  </main>
</template>

<style scoped>
.projects-view {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
</style>
