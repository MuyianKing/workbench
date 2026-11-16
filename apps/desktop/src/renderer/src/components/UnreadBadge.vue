<script setup lang="ts">
/**
 * 未读数角标：为 0 时不画，>99 收成 99+。
 *
 * 位置交给宿主：外面那层容器自己 `position: relative`，这颗用绝对定位贴在图标右上角。
 * 它只表达「有多少没看」，所以走灰度（`--ink` 底 + `--bg-surface` 字），不引红色 ——
 * 与邮件清单那颗未读点同一档；彩色只表达运行状态与项目标识色。
 */
import { computed } from 'vue'

const props = defineProps<{ count: number }>()

const text = computed(() => (props.count > 99 ? '99+' : String(props.count)))
</script>

<template>
  <span v-if="count > 0" class="unread-badge" aria-hidden="true">{{ text }}</span>
</template>

<style scoped>
.unread-badge {
  position: absolute;
  top: -5px;
  right: -9px;
  box-sizing: border-box;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: var(--r-pill);
  background: var(--ink);
  color: var(--bg-surface);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  pointer-events: none;
}
</style>
