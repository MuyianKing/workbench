<script setup lang="ts">
/**
 * 布局编辑态的操作条。
 *
 * 原先它是筛选行的一部分（旧的 FilterBar 在编辑态「原地接管」那一行）。项目卡与筛选标签
 * 搬去项目页之后首页就没有这一行了，于是它改去接管顶栏的欢迎语位 —— 同样是固定高度的一行，
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
    <!-- 整句就是一行（nowrap）：源码里别在句子中间换行，中文之间会多出一个空格 -->
    <span class="layoutbar__hint">
      拖卡片换栏换行换序（落在卡片中间＝并进这一行、左右换位，落在上 / 下缘＝另起一行）；行右上角切高度固定 / 自适应、下缘那颗拉行高；栏头 ＋ 拆栏、✕ 收栏、那颗切栏宽的自适应与固定；拖两栏之间的竖线改栏宽（两栏都固定就一起变）· 间距
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
