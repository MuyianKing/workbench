<script setup lang="ts">
/**
 * 首页「快捷操作」卡片：一份随设置变化的快捷键提示。
 * 说明行用实线划到列表外面（行间是虚线），读起来是「列表到此为止」。
 */
import { computed } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { buildHints } from '@/hints'

const store = useProjectsStore()
const hints = computed(() => buildHints(store.settings))
</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <span class="eyebrow">快捷操作</span>
    </header>

    <ul class="tips">
      <li v-for="item in hints" :key="item.text" class="tip">
        <span class="tip__text truncate" :title="item.text">{{ item.text }}</span>
        <kbd class="tip__key mono">{{ item.hint }}</kbd>
      </li>
    </ul>

    <p class="tips__note">主题、托盘、开机自启在右上角的设置里。</p>
  </article>
</template>

<style scoped>
/**
 * 卡片高度由布局给定：提示多了在列表里滚，底部说明行留在原地。
 * 全局 .tips 是 flex-shrink: 0，这里按本卡片的需要改掉。
 */
.tips {
  flex: 1 1 auto;
  flex-shrink: 1;
  min-height: 0;
  overflow-y: auto;
}

.tips__note {
  /**
   * 说明是列表的补充，但它的字号只比行文字小 1.5px，光靠字号差和 12px 的
   * 面板 gap 分不出层次：最后一条提示会跟它黏成一坨。
   * 用一条实线把它划到列表外面——行间是虚线，说明用实线。
   */
  margin-top: calc(var(--sp-3) * -1 + 4px);
  padding: calc(var(--sp-2) + 2px) 0 0;
  border-top: 1px solid var(--border);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}
</style>
