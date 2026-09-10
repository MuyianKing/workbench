<script setup lang="ts">
/**
 * 首页主体。
 *
 * 桌面打开后第一眼看到的整块内容：卡片网格与旁边那条窄栏的四块工作台面板，
 * 侧栏在左还是在右由设置决定（默认右）。窗口窄到挤不下两栏时退化成单列，面板排到卡片下方。
 * 一个项目都没有时直接整屏 WelcomePanel，侧栏没什么好显示的。
 */
import { computed } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { backgroundVeilAlpha, veilRgbTriplet } from '@shared/workspace-background'
import { useProjectsStore } from '@/stores/projects'
import ProjectCard from '@/components/ProjectCard.vue'
import HomePanels from '@/components/HomePanels.vue'
import WelcomePanel from '@/components/WelcomePanel.vue'

const store = useProjectsStore()

/** 侧栏宽度来自设置，拖动滑块时 store 里先跟手，落盘稍后 */
const sideWidth = computed(() => `${store.sidePanelWidth}px`)

/** 侧栏在卡片网格的哪一侧（左 / 右），拼成 .home 上的布局类 */
const sideClass = computed(() => `pos-${store.settings.sidePanelPosition}`)

/**
 * 工作区背景交给 CSS 变量，最终画在 .home 自己的 background 上。
 *
 * 用容器的 background 而不是多铺一层元素：它天然画在所有子元素之下（层级最低），
 * 既不占布局、也不接鼠标事件，卡片与右栏面板的显示一个像素都不会被影响。
 * 图片是主进程压好的 data URL（见 main/background.ts），这里只负责贴上去。
 */
const canvasStyle = computed(() => {
  const style: Record<string, string> = {
    '--side-w': sideWidth.value,
    '--ws-image': store.backgroundImage ? `url("${store.backgroundImage}")` : 'none',
    // 图片越浓，蒙版越淡
    '--ws-veil-alpha': String(backgroundVeilAlpha(store.backgroundOpacity))
  }

  // 蒙版底色：用户在设置里指定了就用它（图片「渐淡」进这个颜色），没指定则留空，
  // 交给 tokens.css 里按主题定义的那一份
  const veil = veilRgbTriplet(store.settings.workspaceBackgroundVeil)
  if (veil) style['--ws-veil-rgb'] = veil

  return style
})

function clearFilter(): void {
  store.keyword = ''
  store.groupFilter = 'all'
}
</script>

<template>
  <main
    class="home"
    :class="[sideClass, { 'is-live': store.runningCount > 0, 'is-empty': !store.projects.length }]"
    :style="canvasStyle"
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
  /**
   * 布局按「侧栏在左还是在右」切换，用命名区域而不是 order：
   * 面板与卡片网格的 DOM 顺序始终是「先卡片、后侧栏」（Tab 顺序稳定），
   * 位置只由 grid-template-areas 决定。
   *
   * 这里写的是退化形态（单列、侧栏在下），也是窄窗口下的最终样子；
   * 真正的位置类由设置注入（.pos-* 见下）。
   */
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: 'main' 'side';
  gap: 14px;
  padding: var(--sp-5);
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;

  /**
   * 工作区背景：默认只有顶部一层很淡的光晕——
   * 网格那类纹理再轻也会跟卡片抢视线，卡片和面板才是主角。
   *
   * 四层从下往上：用户选的背景图 → 蒙版 → 状态光晕 → 顶部光晕。
   * 图片是纯绘制层：不占布局、不接事件、画在所有子元素之下，卡片和侧栏面板完全不受影响，
   * 所以「背景层级最低」在这里是由 background 本身保证的，不需要 z-index。
   *
   * 铺在滚动容器上：background-attachment 默认是 scroll，背景跟着视口不动，
   * 卡片从下面滑过去，像铺在桌面上，而不是跟着一起滚。
   */
  background-color: var(--bg-canvas);
  /**
   * 蒙版颜色在 .home 自己身上拼：--ws-veil-alpha 是行内覆盖的（浓淡滑块），
   * 写进 :root 的 var() 链会因为「自定义属性在计算值阶段就已替换」而拿不到这个覆盖。
   */
  --ws-veil: rgba(var(--ws-veil-rgb), var(--ws-veil-alpha));
  background-image:
    radial-gradient(140% 80% at 50% -25%, var(--wash), transparent 62%),
    radial-gradient(90% 45% at 50% -12%, var(--ambient), transparent 70%),
    linear-gradient(var(--ws-veil), var(--ws-veil)),
    var(--ws-image, none);
  background-size: auto, auto, auto, cover;
  background-position: center;
  background-repeat: no-repeat;
}

.home.is-live {
  --ambient: var(--ambient-live);
}

/* ---------- 侧栏在左 / 在右 ---------- */

.home.pos-left {
  grid-template-columns: var(--side-w, 340px) minmax(0, 1fr);
  grid-template-areas: 'side main';
}

.home.pos-right {
  grid-template-columns: minmax(0, 1fr) var(--side-w, 340px);
  grid-template-areas: 'main side';
}

/* 没有项目时退化成单列，让 WelcomePanel 独占整行 */
.home.is-empty {
  grid-template-columns: minmax(0, 1fr);
  /* 命名区域与位置类无关：没有项目时侧栏根本不渲染 */
  grid-template-areas: 'solo';
}

.home__main {
  grid-area: main;
}

.home__side {
  grid-area: side;
}

.home__main,
.home__side {
  min-width: 0;
  min-height: 0;
}

/* 欢迎页那张单独铺满整行 */
.home__solo {
  grid-area: solo;
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

/* ---------- 窄窗口退化：侧栏排到卡片下方 ---------- */
@media (max-width: 880px) {
  .home.pos-left,
  .home.pos-right {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'main' 'side';
  }
}
</style>
