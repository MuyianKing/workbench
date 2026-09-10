<script setup lang="ts">
/**
 * 首页主体。
 *
 * 桌面打开后第一眼看到的整块内容：左边是项目卡片网格，右边是窄栏的四块工作台面板。
 * 窗口窄到挤不下两栏时退化成单列，面板排到卡片下方。
 * 一个项目都没有时直接整屏 WelcomePanel，侧栏没什么好显示的。
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
  <main
    class="home"
    :class="{ 'is-live': store.runningCount > 0, 'is-empty': !store.projects.length }"
  >
    <WelcomePanel v-if="store.projects.length === 0" class="home__solo" />

    <template v-else>
      <section class="home__main">
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
      </section>

      <aside class="home__side">
        <HomePanels />
      </aside>
    </template>
  </main>
</template>

<style scoped>
.home {
  display: grid;
  /* 默认两栏：左卡片网格占满剩余，右栏固定 340px 放四块面板 */
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 14px;
  padding: var(--sp-5);
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;

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

/* 没有项目时退化成单列，让 WelcomePanel 独占整行 */
.home.is-empty {
  grid-template-columns: minmax(0, 1fr);
}

.home__main,
.home__side {
  min-width: 0;
  min-height: 0;
}

/* 欢迎页那张单独铺满整行 */
.home__solo {
  grid-column: 1 / -1;
}

/* ---------- 卡片网格 ---------- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(302px, 1fr));
  gap: 14px;
  align-content: start;
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

/* ---------- 窄窗口退化：右栏排到下方 ---------- */
@media (max-width: 880px) {
  .home {
    grid-template-columns: minmax(0, 1fr);
  }

  .home__side {
    order: 1;
  }

  .home__main {
    order: 0;
  }
}
</style>
