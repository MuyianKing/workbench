<script setup lang="ts">
/**
 * 面板 / 页面共用的加载态：一枚转圈加一句说明，告诉用户「数据正在来」。
 *
 * 各模块首次取数（读盘、扫目录、探测子进程）都不快，没有这一层时界面就是一片空白，
 * 分不清「在加载」还是「真的没有」。文字与排版对齐 global.css 的空态那两套
 * （`.empty` / `.panel__empty`），区别只在于它是一枚转圈 —— 加载与空着是两种状态，
 * 得让人一眼分清。转圈用 Element Plus 图标自带的 `.is-loading`，不必自己写 keyframes。
 *
 * 盒子跟 `.empty` 同款（flex:1 居中、可带一行更淡的补充）：
 * 在 `.panel` 这类纵向 flex 容器里自动撑满；在普通滚动容器里就是内容自身的高度。
 */
import { Loading } from '@element-plus/icons-vue'

withDefaults(defineProps<{
  /** 一句说明：正在读什么 */
  text?: string
  /** 可选的第二行：为什么慢、要等多久 */
  hint?: string
}>(), {
  text: '正在加载…',
  hint: ''
})
</script>

<template>
  <div class="loading" role="status">
    <el-icon class="loading__icon is-loading"><Loading /></el-icon>
    <span class="loading__text">{{ text }}</span>
    <span v-if="hint" class="loading__hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.loading {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 0;
  min-width: 0;
  text-align: center;
}

/* 转圈与文字都用最浅一档：它在说「还没就绪」，不该抢内容的视线 */
.loading__icon {
  font-size: 22px;
  color: var(--ink-3);
  opacity: 0.7;
  margin-bottom: 2px;
}

.loading__text {
  font-size: var(--fs-meta);
  line-height: 1.7;
  color: var(--ink-3);
}

.loading__hint {
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--ink-3);
  opacity: 0.85;
}
</style>
