<script setup lang="ts">
/**
 * 示例页面：一套设计语言的 token 装成的完整中文落地页。
 *
 * 这是详情弹窗「预览」档的那一半（另一半是 token 陈列的「规格」档）。上游那套成品预览页
 * 没随包带进来（英文页面），所以整页是按 token 现画的 —— 结构（导航 / 首屏 / 功能卡 / 数据带 /
 * 行动横幅 / 页脚）是真实网页的那一套，颜色、字阶、圆角、内边距取这套设计自己的值。
 *
 * 三条落在具体写法上的约定：
 *
 * 1. **素材全部来自 `buildDesignDemo`**，这里只负责画：挑角色、配文案、收敛尺寸的逻辑在
 *    shared/design-demo.ts 里（带单测）。
 * 2. **画布色铺满整块**：深色设计在这里就是深色页面、浅色设计就是浅色页面，页面自带明暗，
 *    所以它不受应用主题影响（弹窗外壳照旧跟着应用走）。
 * 3. **字号按档位收敛**：品牌真实的 display 字号（48–96px）在这块宽度里太大，上限压到 48px；
 *    卡片标题 17px、说明 13px。收敛的是尺寸，字重与字距保持原样 —— 那才是气质所在。
 */
import { computed } from 'vue'
import type { DesignStyle } from '@shared/design-styles'
import { buttonCss, buildDesignDemo, typeCss } from '@shared/design-demo'
import { safeCssValue } from '@shared/design-styles'

const props = defineProps<{ design: DesignStyle }>()

const demo = computed(() => buildDesignDemo(props.design))

/** 行动横幅里的那枚按钮：底色与字色跟横幅反过来 */
const ctaButtonStyle = computed<Record<string, string>>(() => {
  const { palette, metrics } = demo.value
  return {
    background: palette.onAccent,
    color: palette.accent,
    borderRadius: metrics.buttonRadius,
    padding: '10px 22px',
    ...typeCss(demo.value.small, 15)
  }
})

/** 三处按钮与四处文字各按自己那一档收敛（按钮高度也收：真实网页的 48px 在这块里太厚） */
const navButtonStyle = computed(() => buttonCss(demo.value.primary, demo.value.metrics.buttonRadius, 13, 34))

const heroButtonStyle = computed(() => buttonCss(demo.value.primary, demo.value.metrics.buttonRadius, 15, 46))

const secondaryButtonStyle = computed(() =>
  buttonCss(demo.value.secondary, demo.value.metrics.buttonRadius, 15, 46)
)

const heroStyle = computed(() => typeCss(demo.value.hero, 48))

const bodyStyle = computed(() => typeCss(demo.value.body, 17))

const smallStyle = computed(() => typeCss(demo.value.small, 13))

const statStyle = computed(() => typeCss(demo.value.hero, 32))

/** 功能卡的封面：拿这套设计的代表色拼一条渐变，省得画外链图 */
function thumbStyle(index: number): Record<string, string> {
  const strip = props.design.strip
  const palette = demo.value.palette
  const colors = strip.length
    ? [0, 1, 2].map((offset) => strip[(index * 3 + offset) % strip.length])
    : [palette.accent, palette.surface]
  return { background: `linear-gradient(135deg, ${colors.join(', ')})` }
}

/** 整页的调色板与尺寸走 CSS 变量，样式表里就只用 var() */
const rootStyle = computed<Record<string, string>>(() => {
  const { palette, metrics } = demo.value
  return {
    '--demo-canvas': palette.canvas,
    '--demo-surface': palette.surface,
    '--demo-hairline': palette.hairline,
    '--demo-ink': palette.ink,
    '--demo-muted': palette.muted,
    '--demo-accent': palette.accent,
    '--demo-on-accent': palette.onAccent,
    '--demo-section': `${metrics.section}px`,
    '--demo-block': `${metrics.block}px`,
    '--demo-gap': `${metrics.gap}px`,
    '--demo-card-radius': metrics.cardRadius,
    '--demo-button-radius': metrics.buttonRadius
  }
})
</script>

<template>
  <div class="demo" :style="rootStyle">
    <!-- 导航 -->
    <header class="demo__nav">
      <div class="demo__wrap demo__nav-inner">
        <span class="demo__logo">
          <i class="demo__dot" aria-hidden="true" />
          <span :style="{ ...typeCss(demo.small, 16), fontWeight: safeCssValue(demo.small?.fontWeight) ?? '600' }">
            {{ design.title }}
          </span>
        </span>
        <nav class="demo__links">
          <span v-for="item in demo.copy.nav" :key="item">{{ item }}</span>
        </nav>
        <span class="demo__button" :style="navButtonStyle">{{ demo.copy.primary }}</span>
      </div>
    </header>

    <div class="demo__wrap">
      <!-- 首屏 -->
      <section class="demo__hero">
        <p class="demo__eyebrow" :style="smallStyle">{{ demo.copy.eyebrow }}</p>
        <h3 class="demo__title" :style="heroStyle">{{ demo.copy.title }}</h3>
        <p class="demo__subtitle" :style="{ ...bodyStyle, color: 'var(--demo-muted)' }">{{ demo.copy.subtitle }}</p>
        <div class="demo__actions">
          <span class="demo__button" :style="heroButtonStyle">{{ demo.copy.primary }}</span>
          <span class="demo__button demo__button--quiet" :style="secondaryButtonStyle">{{ demo.copy.secondary }}</span>
        </div>
      </section>

      <!-- 功能卡 -->
      <section class="demo__cards">
        <article v-for="(card, index) in demo.copy.cards" :key="card.title" class="demo__card">
          <span class="demo__thumb" :style="thumbStyle(index)" aria-hidden="true" />
          <h4 class="demo__card-title" :style="{ ...typeCss(demo.body, 17), fontWeight: safeCssValue(demo.body?.fontWeight) ?? '600' }">
            {{ card.title }}
          </h4>
          <p class="demo__card-text" :style="{ ...smallStyle, color: 'var(--demo-muted)' }">{{ card.text }}</p>
        </article>
      </section>

      <!-- 数据带 -->
      <section class="demo__stats">
        <div v-for="stat in demo.copy.stats" :key="stat.label" class="demo__stat">
          <strong class="demo__stat-value" :style="statStyle">{{ stat.value }}</strong>
          <span class="demo__stat-label" :style="{ ...smallStyle, color: 'var(--demo-muted)' }">{{ stat.label }}</span>
        </div>
      </section>

      <!-- 行动横幅 -->
      <section class="demo__cta">
        <p class="demo__cta-text" :style="{ ...typeCss(demo.body, 20), fontWeight: safeCssValue(demo.body?.fontWeight) ?? '600' }">
          {{ demo.copy.cta }}
        </p>
        <span class="demo__button" :style="ctaButtonStyle">{{ demo.copy.ctaButton }}</span>
      </section>

      <!-- 页脚 -->
      <footer class="demo__footer">
        <span v-for="item in demo.copy.footer" :key="item" :style="{ ...smallStyle, color: 'var(--demo-muted)' }">
          {{ item }}
        </span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.demo {
  background: var(--demo-canvas);
  color: var(--demo-ink);
  font-size: 15px;
  line-height: 1.6;
}

/* 内容区限宽居中 —— 真实网页的样子；窄了（卡片档）自然铺满 */
.demo__wrap {
  max-width: 940px;
  margin: 0 auto;
  padding: 0 clamp(18px, 3vw, 40px);
}

.demo__nav {
  border-bottom: 1px solid var(--demo-hairline);
}

.demo__nav-inner {
  display: flex;
  align-items: center;
  gap: var(--demo-block);
  height: 62px;
}

.demo__logo {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-right: auto;
  min-width: 0;
  font-weight: 600;
  white-space: nowrap;
}

.demo__dot {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  border-radius: 3px;
  background: var(--demo-accent);
}

.demo__links {
  display: flex;
  align-items: center;
  gap: var(--demo-block);
  color: var(--demo-muted);
  font-size: 13px;
  white-space: nowrap;
}

.demo__hero {
  padding: var(--demo-section) 0;
}

.demo__eyebrow {
  margin: 0 0 10px;
  color: var(--demo-accent);
  letter-spacing: 0.08em;
}

.demo__title {
  margin: 0;
  color: var(--demo-ink);
}

.demo__subtitle {
  max-width: 46em;
  margin: var(--demo-block) 0 0;
}

.demo__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--demo-gap);
  margin-top: calc(var(--demo-section) * 0.6);
}

.demo__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: var(--demo-button-radius);
  padding: 10px 22px;
  font-size: 14px;
  white-space: nowrap;
}

/* 挑到的次按钮规格自带描边（用它的描边色）；没挑到时这里给一条淡淡的分隔线色 */
.demo__button--quiet {
  border-color: var(--demo-hairline);
}

.demo__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--demo-gap);
  padding-bottom: var(--demo-section);
}

.demo__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--demo-block);
  background: var(--demo-surface);
  border: 1px solid var(--demo-hairline);
  border-radius: var(--demo-card-radius);
}

.demo__thumb {
  height: 96px;
  border-radius: calc(var(--demo-card-radius) * 0.6);
}

.demo__card-title {
  margin: 4px 0 0;
  color: var(--demo-ink);
}

.demo__card-text {
  margin: 0;
}

.demo__stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--demo-section);
  padding: var(--demo-block) 0 var(--demo-section);
  border-top: 1px solid var(--demo-hairline);
}

.demo__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.demo__stat-value {
  color: var(--demo-accent);
}

.demo__cta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--demo-block);
  padding: var(--demo-block) calc(var(--demo-block) * 1.4);
  border-radius: var(--demo-card-radius);
}

.demo__cta-text {
  margin: 0;
  color: var(--demo-on-accent);
}

.demo__footer {
  display: flex;
  flex-wrap: wrap;
  gap: var(--demo-block);
  padding: var(--demo-block) 0 calc(var(--demo-block) * 1.5);
  border-top: 1px solid var(--demo-hairline);
}
</style>
