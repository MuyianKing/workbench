<script setup lang="ts">
/**
 * 自定义标题栏。
 * 窗口用 titleBarStyle: 'hidden'，最小化 / 最大化 / 关闭由系统以叠加层绘制在右上角，
 * 所以这条只负责左侧品牌 + 提供整条拖动区域。
 */
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()
</script>

<template>
  <header class="titlebar">
    <span class="titlebar__mark mono" aria-hidden="true">&rsaquo;_</span>
    <span class="titlebar__name mono">{{ store.settings.appName }}</span>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--h-titlebar);
  padding: 0 var(--sp-5);
  background: var(--bg-canvas);
  /* 整条都能拖动窗口；右上角那块由系统窗口按钮接管 */
  -webkit-app-region: drag;
  user-select: none;
}

.titlebar__mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: var(--ink);
  color: var(--ink-inverse);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: -0.06em;
  padding-bottom: 1px;
}

.titlebar__name {
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--ink-2);
}
</style>
