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
import { nextTick, ref, watch } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import ProjectFilterBar from '@/components/ProjectFilterBar.vue'
import ProjectsPanel from '@/components/ProjectsPanel.vue'

const store = useProjectsStore()
const body = ref<HTMLElement | null>(null)

/**
 * 从搜索结果跳过来时，把点名的那张卡滚进视野。
 *
 * 这里是纯 DOM 操作（滚动位置不是业务数据），照 HomeBoard 拖拽那套的用法：
 * 卡片上带着 data-project-id，找到它交给 scrollIntoView。
 * block: 'nearest' 是为了「已经看得见就别乱动」，免得每次切页都把列表重新滚一遍。
 */
watch(
  () => store.focusProjectId,
  async (id) => {
    if (!id) return
    await nextTick()
    const card = body.value?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(id)}"]`)
    card?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true }
)
</script>

<template>
  <!-- --card-gap 由 .app 统一给（导航栏那张卡片也吃它），内边距由项目网格自己带 -->
  <main ref="body" class="projects-view">
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
