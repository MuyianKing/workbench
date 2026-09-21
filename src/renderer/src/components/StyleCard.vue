<script setup lang="ts">
/**
 * 样式卡片：网格里的一块，与技能卡 / 项目卡同一副外壳（同样的圆角、投影、不透明度跟随）。
 *
 * 卡面不用截图（上游那套预览页本身是英文的，与「界面全中文」冲突），而是**用它自己的 token 现画**：
 * 顶上一条按它挑好的色条，名字按它的字重与字距排，角标给出明暗与色系。
 * 字号固定在小一号上 —— 品牌真实的 display 字号（48–96px）摆不进卡片，那部分留给详情弹窗。
 *
 * 整卡可点、可键盘操作，与 SkillCard 同一条交互（role=button + Enter/Space）。
 */
import { computed } from 'vue'
import type { CSSProperties } from 'vue'
import {
  designStyleFamily,
  safeCssValue,
  THEME_LABELS,
  typographyScale,
  type DesignStyle
} from '@shared/design-styles'

const props = defineProps<{ design: DesignStyle }>()
const emit = defineEmits<{ (event: 'open'): void }>()

/** 卡片上的角标：浅色 · 红 */
const badge = computed(
  () => `${THEME_LABELS[props.design.theme]} · ${designStyleFamily(props.design)}`
)

/**
 * 名字借用这套设计的最大字阶：字体名多半没装（品牌专有字体），会回落到系统字体，
 * 但字重与字距是能看出来的，那正是「一套设计的字体气质」最省事的那部分。
 */
const nameStyle = computed<CSSProperties>(() => {
  const largest = typographyScale(props.design)[0]?.[1]
  return {
    fontFamily: safeCssValue(largest?.fontFamily),
    fontWeight: safeCssValue(largest?.fontWeight),
    letterSpacing: safeCssValue(largest?.letterSpacing)
  }
})

const stats = computed(() => {
  const { colors, typography, components } = props.design
  return `${Object.keys(colors).length} 色 · ${Object.keys(typography).length} 字阶 · ${
    Object.keys(components).length
  } 组件`
})
</script>

<template>
  <article
    class="card"
    role="button"
    tabindex="0"
    :aria-label="`查看 ${design.title} 的设计样式`"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <!-- 色条：上游按这套设计挑好的代表色，等分铺满卡宽 -->
    <div class="card__strip" aria-hidden="true">
      <i v-for="(color, index) in design.strip" :key="`${color}-${index}`" :style="{ background: color }" />
    </div>

    <div class="card__body">
      <div class="card__head">
        <h3 class="card__name" :style="nameStyle" :title="design.title">{{ design.title }}</h3>
        <span class="card__badge">{{ badge }}</span>
      </div>

      <p class="card__meta">
        <span class="card__category">{{ design.category }}</span>
        <span v-if="design.font" class="card__font mono" :title="`展示字体：${design.font}`">{{ design.font }}</span>
      </p>

      <p class="card__desc">{{ design.description }}</p>

      <p class="card__stats mono">{{ stats }}</p>
    </div>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  padding: 0;
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  overflow: hidden;
  transition: box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}

.card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-hover);
  transform: translateY(-1px);
}

.card:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.card__strip {
  display: flex;
  height: 10px;
  flex-shrink: 0;
}

.card__strip i {
  flex: 1;
  min-width: 0;
}

.card__body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
  min-width: 0;
}

.card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  min-width: 0;
}

.card__name {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: 20px;
  line-height: 1.2;
}

.card__badge {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  white-space: nowrap;
}

.card__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: 0;
  min-width: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.card__category {
  flex-shrink: 0;
}

.card__font {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__desc {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}

.card__stats {
  margin: 2px 0 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}
</style>
