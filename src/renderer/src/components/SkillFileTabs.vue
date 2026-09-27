<script setup lang="ts">
/**
 * 技能的文件条：横向滚动的一排文件名，点哪个看 / 编哪个。
 *
 * 两个弹窗共用同一副（原先各抄一份）：技能详情（编辑，store.files）与内容差异
 * （对比，两侧内容对）。差异场景传 `markedRels`：有差异的文件挂一枚圆点，
 * 且**整条**的文件名都让出圆点的位置 —— 一排里的文字起点才对得齐；
 * 纯编辑场景不传，条上只有文件名。
 */
import { computed } from 'vue'

const props = defineProps<{
  /** 文件清单：两个场景各自的对象里都有 rel，这里只认 rel */
  files: Array<{ rel: string }>
  activeRel: string
  /** 无障碍名（「技能文件」/「对比文件」）：两个场景的清单语义不同 */
  label: string
  /** 要挂圆点的文件 rel（对比时两侧内容不同的那些）；不传或为空 = 纯文件条 */
  markedRels?: string[]
}>()

const emit = defineEmits<{ select: [rel: string] }>()

const dotted = computed(() => (props.markedRels?.length ?? 0) > 0)

const isMarked = (rel: string): boolean => props.markedRels?.includes(rel) ?? false
</script>

<template>
  <div class="skill-file-tabs" :class="{ 'has-dots': dotted }" role="tablist" :aria-label="label">
    <button
      v-for="file in files"
      :key="file.rel"
      class="skill-file-tabs__file mono"
      :class="{ 'is-active': activeRel === file.rel }"
      type="button"
      role="tab"
      :aria-selected="activeRel === file.rel"
      :title="file.rel"
      @click="emit('select', file.rel)"
    >
      <i v-if="isMarked(file.rel)" class="skill-file-tabs__dot" aria-hidden="true" />
      {{ file.rel }}
    </button>
  </div>
</template>

<style scoped>
/* 文件条：横向滚动的一排文件名（附属文件多时也不撑破弹窗） */
.skill-file-tabs {
  display: flex;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
  flex-shrink: 0;
}

.skill-file-tabs__file {
  position: relative;
  flex-shrink: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}

/* 圆点在场时每个文件名都让出它的位置：一排里的文字起点对得齐 */
.skill-file-tabs.has-dots .skill-file-tabs__file {
  padding-left: 18px;
}

.skill-file-tabs__file:hover {
  background: var(--bg-inset);
  color: var(--ink-2);
}

.skill-file-tabs__file.is-active {
  background: var(--bg-selected);
  border-color: var(--border);
  color: var(--ink);
}

/* 差异圆点：左上角一枚，标出「这一份动过」的文件 */
.skill-file-tabs__dot {
  position: absolute;
  top: 7px;
  left: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--st-run);
}
</style>
