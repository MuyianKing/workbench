<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { backgroundVeilAlpha, veilRgbTriplet } from '@shared/workspace-background'
import TitleBar from '@/components/TitleBar.vue'
import AppHeader from '@/components/AppHeader.vue'
import FilterBar from '@/components/FilterBar.vue'
import ProjectGrid from '@/components/ProjectGrid.vue'
import TerminalPanel from '@/components/TerminalPanel.vue'
import ProjectDrawer from '@/components/ProjectDrawer.vue'
import AddProjectDialog from '@/components/AddProjectDialog.vue'
import QuickAppDialog from '@/components/QuickAppDialog.vue'
import CommandDialog from '@/components/CommandDialog.vue'
import QuitConfirmDialog from '@/components/QuitConfirmDialog.vue'
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()

/**
 * 工作区背景铺在整个窗口上，而不是只在首页画布上。
 *
 * 三级栏（标题栏 / 搜索栏 / 筛选栏）浮在它上面，具体怎么处理由「顶部样式」决定
 * （见 global.css 的 .top-* 与设置里的 topBarStyle）：壁纸因此能从窗口顶边一路铺下来，
 * 而不是在筛选栏下沿突然开始。
 *
 * 背景交给 CSS 变量、最终画在 .app 自己的 background 上：
 * 它天然画在所有子元素之下（层级最低），既不占布局、也不接鼠标事件。
 * 图片是主进程压好的 data URL（见 main/background.ts）。
 */
const appStyle = computed(() => {
  const style: Record<string, string> = {
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

onMounted(() => {
  void store.init()
})
</script>

<template>
  <div class="app" :class="`top-${store.settings.topBarStyle}`" :style="appStyle">
    <!-- 顶部三条栏包成一块：毛玻璃要整块画一次，逐行各画一遍会在行与行之间露出接缝 -->
    <div class="topbar">
      <TitleBar />
      <AppHeader />
      <FilterBar />
    </div>
    <ProjectGrid />
    <TerminalPanel />
    <ProjectDrawer />
    <AddProjectDialog />
    <QuickAppDialog />
    <CommandDialog />
    <QuitConfirmDialog />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: grid;
  /* 顶部整块、首页画布（吃掉剩余高度）、底部终端 */
  grid-template-rows: auto 1fr auto;
  overflow: hidden;

  /**
   * 两层：用户选的背景图 → 蒙版。画布本身保持平铺，不再叠加任何顶部光晕。
   * 图片是纯绘制层：不占布局、不接事件、画在所有子元素之下，所以不需要 z-index。
   */
  background-color: var(--bg-canvas);
  /**
   * 蒙版颜色在 .app 自己身上拼：--ws-veil-alpha 是行内覆盖的（浓淡滑块），
   * 写进 :root 的 var() 链会因为「自定义属性在计算值阶段就已替换」而拿不到这个覆盖。
   */
  --ws-veil: rgba(var(--ws-veil-rgb), var(--ws-veil-alpha));
  background-image:
    linear-gradient(var(--ws-veil), var(--ws-veil)),
    var(--ws-image, none);
  background-size: auto, cover;
  background-position: center;
  background-repeat: no-repeat;
}

/**
 * 顶部三条栏各自的固定高度还在这里给：三个组件都没有自己写高度，
 * 原来靠 .app 的网格行撑着，包进容器后由容器接管。
 */
.topbar {
  display: grid;
  grid-template-rows: var(--h-titlebar) var(--h-header) auto;
  min-width: 0;
}
</style>
