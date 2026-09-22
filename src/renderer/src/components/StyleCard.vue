<script setup lang="ts">
/**
 * 样式卡片：网格里的一块，卡面就是这套设计的一小张页面。
 *
 * **卡面不铺应用底色，铺的是这套设计自己的画布色** —— 颜色、字阶、按钮都取它的 token，
 * 所以网格扫过去是 74 种风格的并排（浅色系一片浅底、深色系一片深底），而不是 74 段读完
 * 才知道差别的文字简介；完整的示例页面在详情弹窗的「预览」档里。
 *
 * 卡面只放首屏那一小段（导航 / 眉题 / 标题 / 副文案 / 按钮），文案与详情里那整页是同一份
 * （见 shared/design-demo.ts 的 `buildDesignDemo`），底部一行留作检索用的元信息 ——
 * 那行的文字色必须取这套设计的次文字色，深色画布上才读得出来。
 *
 * 整卡可点、可键盘操作，与 SkillCard 同一条交互（role=button + Enter/Space）。
 */
import { computed } from 'vue'
import type { DesignStyle } from '@shared/design-styles'
import { CARD_TYPE, buildDesignDemo, buttonCss, typeCss } from '@shared/design-demo'
import { designStyleFamily, safeCssValue, THEME_LABELS } from '@shared/design-styles'

const props = defineProps<{ design: DesignStyle }>()
const emit = defineEmits<{ (event: 'open'): void }>()

const demo = computed(() => buildDesignDemo(props.design))

/** 卡片上的角标：浅色 · 红 */
const badge = computed(
  () => `${THEME_LABELS[props.design.theme]} · ${designStyleFamily(props.design)}`
)

const componentCount = computed(() => Object.keys(props.design.components).length)

/** 这套设计的调色板走 CSS 变量，样式表里就只用 var() */
const rootStyle = computed<Record<string, string>>(() => {
  const { palette } = demo.value
  return {
    '--card-canvas': palette.canvas,
    '--card-ink': palette.ink,
    '--card-muted': palette.muted,
    '--card-hairline': palette.hairline,
    '--card-accent': palette.accent
  }
})

const brandStyle = computed(() => ({
  ...typeCss(demo.value.small, CARD_TYPE.brand),
  fontWeight: safeCssValue(demo.value.small?.fontWeight) ?? '600'
}))

const linkStyle = computed(() => ({ ...typeCss(demo.value.small, 11), color: 'var(--card-muted)' }))

const eyebrowStyle = computed(() => ({
  ...typeCss(demo.value.small, 10),
  color: 'var(--card-accent)',
  letterSpacing: safeCssValue(demo.value.small?.letterSpacing) ?? '0.08em'
}))

const titleStyle = computed(() => ({ ...typeCss(demo.value.hero, CARD_TYPE.title), color: 'var(--card-ink)' }))

const subtitleStyle = computed(() => ({
  ...typeCss(demo.value.body, CARD_TYPE.text),
  color: 'var(--card-muted)'
}))

const primaryStyle = computed(() =>
  buttonCss(demo.value.primary, demo.value.metrics.buttonRadius, CARD_TYPE.button, CARD_TYPE.buttonHeight)
)

const secondaryStyle = computed(() =>
  buttonCss(demo.value.secondary, demo.value.metrics.buttonRadius, CARD_TYPE.button, CARD_TYPE.buttonHeight)
)
</script>

<template>
  <article
    class="card"
    :style="rootStyle"
    role="button"
    tabindex="0"
    :aria-label="`查看 ${design.title} 的设计样式`"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
    @keydown.space.prevent="emit('open')"
  >
    <!-- 一行的导航：主色标志、品牌名、一个次级链接 -->
    <div class="card__nav">
      <i class="card__dot" aria-hidden="true" />
      <span class="card__brand" :style="brandStyle" :title="design.title">{{ design.title }}</span>
      <span class="card__link" :style="linkStyle">{{ demo.copy.nav[1] }}</span>
    </div>

    <!-- 首屏那一小段：眉题、标题、副文案、按钮 -->
    <p class="card__eyebrow" :style="eyebrowStyle">{{ demo.copy.eyebrow }}</p>
    <h3 class="card__title" :style="titleStyle">{{ demo.copy.title }}</h3>
    <p class="card__subtitle" :style="subtitleStyle">{{ demo.copy.subtitle }}</p>
    <div class="card__actions">
      <span class="card__button" :style="primaryStyle">{{ demo.copy.primary }}</span>
      <span class="card__button card__button--quiet" :style="secondaryStyle">{{ demo.copy.secondary }}</span>
    </div>

    <!-- 元信息：给检索用，不是样张的一部分 -->
    <footer class="card__meta">
      <span>{{ badge }}</span>
      <span class="card__category">{{ design.category }}</span>
      <span class="card__count">{{ componentCount }} 组件</span>
    </footer>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  /* 底部不留内边距：元信息那行自己铺到卡片边缘（见 .card__meta 的负边距） */
  padding: 12px 14px 0;
  background: var(--card-canvas);
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

.card__nav {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.card__dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 2px;
  background: var(--card-accent);
}

.card__brand {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__link {
  margin-left: auto;
  flex-shrink: 0;
}

.card__eyebrow {
  margin: 10px 0 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__title {
  margin: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.card__subtitle {
  margin: 4px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}

.card__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid transparent;
  white-space: nowrap;
}

/* 次按钮规格自带描边时用它的（内联样式在先）；没描边时这里补一条这套设计的分隔线色 */
.card__button--quiet {
  border-color: var(--card-hairline);
}

.card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px -14px 0;
  padding: 8px 14px;
  border-top: 1px solid var(--card-hairline);
  color: var(--card-muted);
  font-size: var(--fs-micro);
}

.card__category {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__count {
  margin-left: auto;
  flex-shrink: 0;
}
</style>
