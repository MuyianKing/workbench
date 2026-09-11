<script setup lang="ts">
import { onMounted } from 'vue'
import TitleBar from '@/components/TitleBar.vue'
import AppHeader from '@/components/AppHeader.vue'
import FilterBar from '@/components/FilterBar.vue'
import ProjectGrid from '@/components/ProjectGrid.vue'
import TerminalPanel from '@/components/TerminalPanel.vue'
import ProjectDrawer from '@/components/ProjectDrawer.vue'
import AddProjectDialog from '@/components/AddProjectDialog.vue'
import QuickAppDialog from '@/components/QuickAppDialog.vue'
import QuitConfirmDialog from '@/components/QuitConfirmDialog.vue'
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()

onMounted(() => {
  void store.init()
})
</script>

<template>
  <div class="app">
    <TitleBar />
    <AppHeader />
    <FilterBar />
    <ProjectGrid />
    <TerminalPanel />
    <ProjectDrawer />
    <AddProjectDialog />
    <QuickAppDialog />
    <QuitConfirmDialog />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: grid;
  grid-template-rows: var(--h-titlebar) var(--h-header) auto 1fr auto;
  background: var(--bg-canvas);
  overflow: hidden;
}
</style>
