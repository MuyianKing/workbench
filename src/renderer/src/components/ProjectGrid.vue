<script setup lang="ts">
/**
 * 首页主体。
 *
 * 从上到下：卡片网格 → 工作台面板。
 * 没有项目时整块换成 WelcomePanel；有项目但被筛没了时，网格位置放一条窄提示，
 * 面板照旧——不然筛一次条件，半屏就空了。
 */
import { Plus } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import ProjectCard from '@/components/ProjectCard.vue'
import HomePanels from '@/components/HomePanels.vue'
import WelcomePanel from '@/components/WelcomePanel.vue'

const store = useProjectsStore()

function clearFilter(): void {
  store.keyword = ''
  store.groupFilter = 'all'
}
</script>

<template>
  <main class="home" :class="{ 'is-live': store.runningCount > 0 }">
    <WelcomePanel v-if="!store.projects.length" />

    <template v-else>
      <div v-if="store.filteredProjects.length" class="grid">
        <ProjectCard v-for="p in store.filteredProjects" :key="p.id" :project="p" />

        <button class="add-tile" type="button" @click="store.addDialogVisible = true">
          <el-icon class="add-tile__icon"><Plus /></el-icon>
          <span class="add-tile__text">添加项目</span>
          <span class="add-tile__hint mono">选择项目目录</span>
        </button>
      </div>

      <div v-else class="nomatch">
        <p class="nomatch__title">没有匹配的项目</p>
        <p class="nomatch__desc">换个关键词，或切换到其他分组看看。</p>
        <el-button size="small" @click="clearFilter">清除筛选条件</el-button>
      </div>

      <HomePanels />
    </template>
  </main>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: var(--sp-5);
  overflow-y: auto;

  /**
   * 工作区背景：不上任何图案，只有顶部一层很淡的光晕——
   * 网格那类纹理再轻也会跟卡片抢视线，卡片和面板才是主角。
   *
   * 铺在滚动容器上：background-attachment 默认是 scroll，光晕跟着视口不动，
   * 卡片从下面滑过去，像铺在桌面上，而不是跟着一起滚。
   */
  background-color: var(--bg-canvas);
  background-image:
    radial-gradient(140% 80% at 50% -25%, var(--wash), transparent 62%),
    radial-gradient(90% 45% at 50% -12%, var(--ambient), transparent 70%);
}

.home.is-live {
  --ambient: var(--ambient-live);
}

/* ---------- 卡片网格 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(302px, 1fr));
  gap: 14px;
  align-content: start;
  /* 网格按内容定高，剩下的高度留给下面的面板 */
  flex: none;
}

/* ---------- 添加项目幽灵卡片 ---------- */
.add-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 132px;
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
  flex: none;
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
