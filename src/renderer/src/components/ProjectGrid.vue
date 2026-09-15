<script setup lang="ts">
/**
 * 首页主体：一层工作区画布 + 七块可自由布局的卡片。
 *
 * 卡片的位置与尺寸由 HomeBoard 按 theme.json 摆放；这里只管画布本身 —— 内边距与滚动。
 * 工作区背景图归 App.vue 的 .app 管（要铺满整窗、从标题栏后面透出来），这里保持透明。
 */
import HomeBoard from '@/components/HomeBoard.vue'
</script>

<template>
  <!-- --card-gap 由 .app 统一给（导航栏那张卡片也吃它），这里只管画布自己的内边距 -->
  <main class="home">
    <HomeBoard />
  </main>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  /* 四周留白与卡片间距同源：设置里改「卡片间距」，页面外圈的空隙跟着变 */
  padding: var(--card-gap, 14px);
  min-height: 0;
  /*
   * 页面本身不滚：三栏各自撑满可用高度、需要时自己滚，
   * 这样「自适应」卡片才有剩余高度可分（见 HomeBoard 的栏样式）。
   */
  overflow: hidden;
  /* 背景由 .app 统一铺（壁纸 + 蒙版），这里不再自己画一层，否则会叠出两道不同的裁切 */
  background: transparent;
}
</style>
