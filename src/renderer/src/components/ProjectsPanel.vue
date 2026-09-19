<script setup lang="ts">
/**
 * 项目页的主体：项目卡网格 + 末尾的「添加项目」幽灵卡。
 *
 * 故意不套 .panel 外壳 —— 这块是页面的主体，直接铺在画布上（无白底、无边框、无标题）。
 * 它自己就是滚动体：占据工具条以下的全部高度，四周的内边距取卡片间距，
 * 项目再多也在这一层滚，不把页面撑高。
 */
import { Plus, Search } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import ProjectCard from '@/components/ProjectCard.vue'
import WelcomePanel from '@/components/WelcomePanel.vue'

const store = useProjectsStore()

function clearFilter(): void {
  store.setGroupFilter('all')
}
</script>

<template>
  <div class="projects">
    <template v-if="store.projects.length">
      <div v-if="store.filteredProjects.length" class="grid">
        <ProjectCard v-for="p in store.filteredProjects" :key="p.id" :project="p" />

        <button class="add-tile" type="button" @click="store.openAddDialog()">
          <el-icon class="add-tile__icon"><Plus /></el-icon>
          <span class="add-tile__text">添加项目</span>
          <span class="add-tile__hint mono">选择项目目录</span>
        </button>
      </div>

      <div v-else class="nomatch">
        <el-icon class="empty__icon"><Search /></el-icon>
        <p class="nomatch__title">这个分组下没有项目</p>
        <p class="nomatch__desc">切回「全部」分组，或先给项目归类。</p>
        <el-button size="small" @click="clearFilter">清除筛选条件</el-button>
      </div>
    </template>

    <WelcomePanel v-else />
  </div>
</template>

<style scoped>
/* 项目再多也不撑高页面：这一层自己滚，高度由剩下的空间给定 */
.projects {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  /* 四周留白与卡片间距同源（--card-gap 由 .app 统一给），设置里改「卡片间距」，外圈跟着变 */
  padding: var(--card-gap, 10px);
}

/* ---------- 卡片网格 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(302px, 1fr));
  /* 与首页卡片共用同一个间距配置（--card-gap 由 .app 统一给） */
  gap: var(--card-gap, 14px);
  align-content: start;
}

/* ---------- 添加项目幽灵卡片 ---------- */
.add-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  /* 与项目卡同高（--h-project-card）：单独占一行时也和上面的卡片一样高 */
  min-height: var(--h-project-card);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-lg);
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  transition: border-color 0.18s ease, color 0.18s ease, background 0.18s ease;
}

.add-tile:hover {
  border-color: var(--ink);
  color: var(--ink);
  background: rgba(255, 255, 255, 0.6);
}

:root[data-theme='dark'] .add-tile:hover {
  background: rgba(232, 237, 244, 0.06);
}

.add-tile__icon {
  font-size: 18px;
}

.add-tile__text {
  font-size: var(--fs-body);
  font-weight: 500;
}

.add-tile__hint {
  font-size: var(--fs-micro);
  opacity: 0.7;
}

/* ---------- 筛没了的时候 ---------- */
.nomatch {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  min-height: 156px;
  padding: var(--sp-6);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-lg);
  text-align: center;
}

.nomatch__title {
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--ink);
}

.nomatch__desc {
  margin-bottom: var(--sp-1);
  font-size: var(--fs-body);
  color: var(--ink-3);
}
</style>
