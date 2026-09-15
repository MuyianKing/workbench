<script setup lang="ts">
/**
 * 布局编辑态的操作条。
 *
 * 原先它是筛选行的一部分（旧的 FilterBar 在编辑态「原地接管」那一行）。项目卡与筛选标签
 * 搬去项目页之后首页就没有这一行了，于是它改去接管顶栏的搜索位 —— 同样是固定高度的一行，
 * 进出编辑态不会让下面的画布上下跳；而那颗「编辑布局」按钮本来就在这一行的右端，
 * 进入 / 退出因此都发生在同一处。
 */
import { Refresh, Select } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'

const store = useProjectsStore()
const settings = useSettingsStore()
</script>

<template>
  <div class="layoutbar">
    <span class="layoutbar__tag">布局编辑</span>
    <span class="layoutbar__hint">
      拖动卡片可在三栏之间移动、调整栏内顺序；卡片右上角切换「固定高度 / 自适应」，
      固定高度可拖下沿改高；拖两栏之间的竖线改栏宽 · 步进
      <b class="mono">{{ settings.gridStep }}px</b> · 卡片间距
      <b class="mono">{{ settings.cardGap }}px</b>
    </span>
    <div class="layoutbar__tools">
      <el-button size="small" :icon="Refresh" @click="settings.resetLayout()">恢复默认</el-button>
      <el-button
        size="small"
        type="primary"
        :icon="Select"
        @click="store.setLayoutEditing(false)"
      >
        完成
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.layoutbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex: 1;
  min-width: 0;
}

/* 一眼看出「现在不是平时的顶栏」：这一小块取主题色的淡底 */
.layoutbar__tag {
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: var(--r-pill);
  background: var(--el-color-primary-light-9);
  color: var(--ink);
  font-size: var(--fs-micro);
  font-weight: 600;
}

.layoutbar__hint {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--ink-2);
  /* 一行放不下就省略，绝不换行把这一行撑高、把下面的画布顶下去 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.layoutbar__hint b {
  color: var(--ink);
}

.layoutbar__tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
</style>
