<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { Component } from 'vue'
import { backgroundVeilAlpha, veilRgbTriplet } from '@shared/workspace-background'
import { cardSurfaceAlpha } from '@shared/card-opacity'
import type { ViewId } from '@shared/views'
import NavRail from '@/components/NavRail.vue'
import TitleBar from '@/components/TitleBar.vue'
import AppHeader from '@/components/AppHeader.vue'
import ProjectGrid from '@/components/ProjectGrid.vue'
import ProjectsView from '@/components/ProjectsView.vue'
import WorkView from '@/components/WorkView.vue'
import NotesView from '@/components/NotesView.vue'
import SkillsView from '@/components/SkillsView.vue'
import TerminalPanel from '@/components/TerminalPanel.vue'
import ProjectDrawer from '@/components/ProjectDrawer.vue'
import AddProjectDialog from '@/components/AddProjectDialog.vue'
import QuickAppDialog from '@/components/QuickAppDialog.vue'
import CommandDialog from '@/components/CommandDialog.vue'
import QuitConfirmDialog from '@/components/QuitConfirmDialog.vue'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'

const store = useProjectsStore()
const settings = useSettingsStore()

/**
 * 页面清单：id 在 shared/views.ts 里登记，这里给出对应的组件。
 *
 * 换页不用路由 —— KeepAlive 包住 <component :is>，切走的页面留在内存里，
 * 各页的滚动位置（首页三栏、项目页的网格）因此不会在来回切时丢掉。
 */
const VIEWS: Record<ViewId, Component> = {
  home: ProjectGrid,
  projects: ProjectsView,
  work: WorkView,
  notes: NotesView,
  skills: SkillsView
}

const currentView = computed(() => VIEWS[store.activeView])

/**
 * 工作区背景铺在整个窗口上，而不是只在某一页上。
 *
 * 左侧导航栏与顶部两条栏（标题栏 / 欢迎语）浮在它上面，具体怎么处理由「顶部样式」决定
 * （见 global.css 的 .top-* 与设置里的 topBarStyle）：壁纸因此能从窗口顶边一路铺下来，
 * 而不是在工具栏下沿突然开始。
 *
 * 背景交给 CSS 变量、最终画在 .app 自己的 background 上：
 * 它天然画在所有子元素之下（层级最低），既不占布局、也不接鼠标事件。
 * 图片是后端授权、由 webview 按 asset 协议自己读的 URL（见适配层的 assetUrl），不是解码后的 data URL。
 */
const appStyle = computed(() => {
  const style: Record<string, string> = {
    '--ws-image': settings.backgroundImage ? `url("${settings.backgroundImage}")` : 'none',
    // 图片越浓，蒙版越淡
    '--ws-veil-alpha': String(backgroundVeilAlpha(settings.backgroundOpacity)),
    // 卡片底色浓度：面板（.panel）与项目卡拼 rgba 用，跟手渲染靠 store 里的 cardOpacity
    '--card-alpha': String(cardSurfaceAlpha(settings.cardOpacity)),
    /**
     * 卡片间距（px）：栏间、栏内卡片之间、项目页网格之间共用这一个值，
     * 导航栏这张卡片的四周留白也取它 —— 所以定义在 .app 上，全窗口一处来源。
     */
    '--card-gap': `${settings.cardGap}px`
  }

  // 蒙版底色：用户在设置里指定了就用它（图片「渐淡」进这个颜色），没指定则留空，
  // 交给 tokens.css 里按主题定义的那一份
  const veil = veilRgbTriplet(settings.settings.workspaceBackgroundVeil)
  if (veil) style['--ws-veil-rgb'] = veil

  return style
})

onMounted(() => {
  void store.init()
})
</script>

<template>
  <div class="app" :class="`top-${settings.settings.topBarStyle}`" :style="appStyle">
    <!--
      顶部两条栏包成一块、通宽：毛玻璃要整块画一次，逐行各画一遍会在行与行之间露出接缝。
      导航栏在它下面才开始，所以也进不了这条带子（进去就把玻璃块切成两块了）。
    -->
    <div class="topbar">
      <TitleBar />
      <AppHeader />
    </div>

    <!-- 导航栏从顶栏下沿起、一直到底；终端留在内容列里，不横跨导航栏 -->
    <div class="shell">
      <NavRail />

      <div class="content">
        <KeepAlive>
          <component :is="currentView" />
        </KeepAlive>

        <!-- 终端按项目组织，从哪一页启动都能看日志，所以不随页面切换 -->
        <TerminalPanel />
      </div>
    </div>

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
  /**
   * 一列 `minmax(0, 1fr)`：**不许里面的内容把这一列顶宽**。
   * 顶栏里有不换行的长内容（布局编辑那行提示语），列宽交给内容决定的话，窗口一窄整条顶栏
   * 就横着溢出窗外，右侧那几颗按钮一起被推出去、点都点不着。下面 `.shell` 同理。
   */
  grid-template-columns: minmax(0, 1fr);
  /* 顶部整条栏（标题栏 + 欢迎语通宽）/ 下面「导航栏 + 内容列」*/
  grid-template-rows: auto minmax(0, 1fr);
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

/** 顶栏以下：左边导航栏（宽度由它自己撑）、右边内容列 */
.shell {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  min-height: 0;
}

/**
 * 内容列：当前页面（吃掉剩余高度）+ 终端面板。
 * 多出来的子元素会凭空多出一行，所以弹窗一律留在 .app 上（它们是 fixed 定位，不进网格流）。
 */
.content {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
}

/**
 * 顶部两条栏各自的固定高度还在这里给：两个组件都没有自己写高度，
 * 原来靠 .app 的网格行撑着，包进容器后由容器接管。
 */
.topbar {
  display: grid;
  /* 同上：里面的东西再长也不许把这一列顶宽（否则顶栏会溢出窗外） */
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: var(--h-titlebar) var(--h-header);
  min-width: 0;
  /* 通宽：导航栏是从它下沿才开始的一列，不在这一层 */
  /**
   * 抬到页面内容之上。必须显式抬这一手：
   * 「毛玻璃」那档的 backdrop-filter 会给 .topbar 造一个层叠上下文，而画布上的卡片是
   * 定位元素（position: relative、z-index: auto，见 BoardCard / ProjectCard），按树序
   * 排在 .topbar 之后 —— 不抬的话，卡片整块会盖在顶栏上面；卡片本身还是半透明的
   * （卡片不透明度），两层就叠成「顶栏透底」的样子。
   */
  position: relative;
  z-index: 10;
}
</style>
