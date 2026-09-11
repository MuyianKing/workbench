<script setup lang="ts">
/**
 * 首页主体：一层工作区画布 + 六块可自由布局的卡片。
 *
 * 卡片的位置与尺寸由 HomeBoard 按 theme.json 摆放；这里只管画布本身 ——
 * 内边距、滚动，以及贴在最底层的工作区背景图。
 */
import { computed } from 'vue'
import { backgroundVeilAlpha, veilRgbTriplet } from '@shared/workspace-background'
import { useProjectsStore } from '@/stores/projects'
import HomeBoard from '@/components/HomeBoard.vue'

const store = useProjectsStore()

/**
 * 工作区背景交给 CSS 变量，最终画在 .home 自己的 background 上。
 *
 * 用容器的 background 而不是多铺一层元素：它天然画在所有子元素之下（层级最低），
 * 既不占布局、也不接鼠标事件。图片是主进程压好的 data URL（见 main/background.ts）。
 */
const canvasStyle = computed(() => {
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
</script>

<template>
  <main class="home" :style="canvasStyle">
    <HomeBoard />
  </main>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  padding: var(--sp-5);
  min-height: 0;
  /*
   * 页面本身不滚：三栏各自撑满可用高度、需要时自己滚，
   * 这样「自适应」卡片才有剩余高度可分（见 HomeBoard 的栏样式）。
   */
  overflow: hidden;

  /**
   * 两层：用户选的背景图 → 蒙版。画布本身保持平铺，不再叠加任何顶部光晕。
   * 图片是纯绘制层：不占布局、不接事件、画在所有子元素之下，所以不需要 z-index。
   */
  background-color: var(--bg-canvas);
  /**
   * 蒙版颜色在 .home 自己身上拼：--ws-veil-alpha 是行内覆盖的（浓淡滑块），
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
</style>
