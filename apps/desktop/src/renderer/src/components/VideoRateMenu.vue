<!--
  播放速率徽章 + 档位下拉：视频页头部与悬浮小窗手柄条共用的一枚。
  档位表是 @workbench/video 的 VIDEO_RATES(与快捷键 ↑↓ 同一份);
  值不在这里住 —— 调用方持有当前速率,change 把选中的档位交回去。
-->
<script setup lang="ts">
import { CaretBottom, Check } from '@element-plus/icons-vue'
import { VIDEO_RATES } from '@workbench/video'

defineProps<{
  /** 当前速率,只决定徽章文案与菜单里的对勾 */
  rate: number
  /** 徽章的悬浮说明;视频页要提一句快捷键,悬浮窗不需要 */
  title?: string
}>()

const emit = defineEmits<{ change: [value: number] }>()
</script>

<template>
  <el-dropdown
    trigger="click"
    placement="bottom-end"
    @command="(value: number) => emit('change', value)"
  >
    <button class="rate-badge" type="button" :title="title ?? '播放速率'">
      {{ rate }}x
      <el-icon class="rate-badge__caret">
        <CaretBottom />
      </el-icon>
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="value in VIDEO_RATES"
          :key="value"
          :command="value"
          :class="{ 'is-current': value === rate }"
        >
          <span class="rate-badge__item">
            <el-icon v-if="value === rate" class="rate-badge__check"><Check /></el-icon>
            {{ value }}x
          </span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
/* 徽章本体:一枚安静的小徽章,不与标题抢注意力。
   配色走钩子变量 —— 视频页是浅色族,悬浮窗手柄条是 --term-* 深色族,宿主各自覆盖。 */
.rate-badge {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px var(--sp-2);
  background: transparent;
  border: 1px solid var(--rate-badge-border, var(--border));
  border-radius: var(--r-pill);
  font: inherit;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  color: var(--rate-badge-ink, var(--ink-2));
  cursor: pointer;
}

.rate-badge:hover {
  color: var(--rate-badge-hover-ink, var(--ink));
  background: var(--rate-badge-hover-bg, var(--bg-subtle));
}

.rate-badge__caret {
  font-size: 10px;
}

.rate-badge__item {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-variant-numeric: tabular-nums;
}

.rate-badge__check {
  font-size: 12px;
  color: var(--st-ok);
}
</style>
