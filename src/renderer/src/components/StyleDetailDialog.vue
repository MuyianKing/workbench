<script setup lang="ts">
/**
 * 样式详情弹窗：一套设计语言的样张，全部用它自己的 token 现画。
 *
 * **没有 iframe、没有截图**。上游给的那套 `preview.html` 是英文页面，塞进来就等于把英文又请回界面；
 * 这里改成按 token 现渲染八段 —— 配色 / 字体 / 按钮 / 卡片 / 表单 / 版式 / 间距 / 圆角，
 * 颜色、字体、圆角、内边距、高度都取它自己的值，所以看到的是这套设计的真实比例关系，
 * 而不是一张图。
 *
 * 三段要留意的地方：
 *
 * 1. **值必须经 `componentStyle` 展开**：组件规格里写的是 `{colors.primary}` 这种引用，
 *    展开不出来时宁可不画（见 shared/design-styles.ts 的 `resolveTokenRef`）。
 * 2. **字体多半是品牌专有字体，本机没装**，会回落到系统字体 —— 字号、字重、字距、
 *    行高这些比例仍然是真的，界面不假装它是原字体。
 * 3. **三个品牌（lamborghini / runwayml / tesla）上游没给组件规格**，三段样张自然为空，
 *    这里如实说明一句，不留白板。
 */
import { computed } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import { notifyError, notifySuccess } from '@/notify'
import {
  COLOR_GROUPS,
  THEME_LABELS,
  colorGroup,
  colorLabel,
  componentLabel,
  componentSamples,
  componentStyle,
  designStyleFamily,
  inkOn,
  isColorValue,
  numericScale,
  roundedLabel,
  safeCssValue,
  spacingLabel,
  typeLabel,
  typographyScale,
  type ComponentGroup,
  type DesignStyle,
  type DesignTypeToken
} from '@shared/design-styles'

const props = defineProps<{ open: boolean; design: DesignStyle | null }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

const title = computed(() => props.design?.title ?? '')
const badge = computed(() =>
  props.design ? `${props.design.category} · ${THEME_LABELS[props.design.theme]} · ${designStyleFamily(props.design)}` : ''
)

async function copy(text: string, what: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    notifySuccess(`${what}已复制`)
  } catch {
    notifyError('复制失败，可以手动选中再复制')
  }
}

/** 把空值剔掉，避免往 :style 上一堆空串 */
function compact(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) if (value) out[key] = value
  return out
}

// ---------------------------------------------------------------- 配色

interface Swatch {
  key: string
  value: string
  label: string
  ink: string
}

const colorSections = computed(() => {
  const style = props.design
  if (!style) return []
  const buckets = new Map<string, Swatch[]>()
  for (const [key, value] of Object.entries(style.colors)) {
    if (!isColorValue(value)) continue
    const group = colorGroup(key)
    const list = buckets.get(group) ?? []
    list.push({ key, value, label: colorLabel(style, key), ink: inkOn(value) })
    buckets.set(group, list)
  }
  return COLOR_GROUPS.filter((group) => buckets.has(group)).map((group) => ({
    group,
    swatches: buckets.get(group) ?? []
  }))
})

// ---------------------------------------------------------------- 字体

interface TypeRow {
  key: string
  label: string
  spec: string
  style: Record<string, string>
  sample: string
}

/** 字号上限 44px：再大就把每一行撑成一张屏，弹窗里看不出层次 */
function clampSize(raw: string | undefined, max: number): string | undefined {
  const matched = raw ? /([\d.]+)/.exec(raw) : null
  if (!matched) return safeCssValue(raw)
  const value = Number(matched[1])
  return value > max ? `${max}px` : `${Math.round(value)}px`
}

function typeRow(style: DesignStyle, key: string, token: DesignTypeToken): TypeRow {
  const size = clampSize(token.fontSize, 44)
  const parts = [token.fontSize, token.fontWeight ? `字重 ${token.fontWeight}` : '']
  if (token.lineHeight) parts.push(`行高 ${token.lineHeight}`)
  if (token.letterSpacing) parts.push(`字距 ${token.letterSpacing}`)
  const big = Number(/([\d.]+)/.exec(token.fontSize ?? '')?.[1] ?? 0) >= 24
  return {
    key,
    label: typeLabel(style, key),
    spec: parts.filter(Boolean).join(' · '),
    style: compact({
      fontFamily: safeCssValue(token.fontFamily),
      fontSize: size,
      fontWeight: safeCssValue(token.fontWeight),
      lineHeight: safeCssValue(token.lineHeight),
      letterSpacing: safeCssValue(token.letterSpacing)
    }),
    sample: big ? '设计样式预览' : '这是一段正文示例文字，用来看行距与字距。'
  }
}

const typeRows = computed(() => {
  const style = props.design
  if (!style) return []
  return typographyScale(style).map(([key, token]) => typeRow(style, key, token))
})

// ---------------------------------------------------------------- 组件样张

interface Sample {
  key: string
  label: string
  style: Record<string, string>
  text: string
}

const SAMPLE_TEXT: Record<ComponentGroup, string> = {
  按钮: '按钮',
  卡片: '卡片标题',
  表单: '请输入内容',
  版式: '版式元素'
}

/** 样张内边距收一收：上游有 `96px` 这种首屏级内边距，照搬会把弹窗撑爆 */
function clampPadding(raw: string | undefined): string | undefined {
  const value = safeCssValue(raw)
  if (!value) return undefined
  return value.replace(/([\d.]+)px/g, (_, number: string) =>
    `${Math.min(32, Math.round(Number(number)))}px`
  )
}

function toSample(style: DesignStyle, key: string, group: ComponentGroup): Sample {
  const resolved = componentStyle(style.components[key] ?? {}, style)
  return {
    key,
    label: componentLabel(style, key),
    style: compact({
      background: resolved.background,
      color: resolved.color,
      border: resolved.border,
      borderRadius: resolved.borderRadius,
      padding: clampPadding(resolved.padding),
      boxShadow: resolved.boxShadow,
      fontFamily: safeCssValue(resolved.font?.fontFamily),
      fontSize: clampSize(resolved.font?.fontSize, 18),
      fontWeight: safeCssValue(resolved.font?.fontWeight),
      letterSpacing: safeCssValue(resolved.font?.letterSpacing)
    }),
    text: SAMPLE_TEXT[group]
  }
}

const componentGroups = computed(() => {
  const style = props.design
  if (!style) return []
  return componentSamples(style).map((entry) => ({
    group: entry.group,
    rest: entry.rest,
    samples: entry.keys.map((key) => toSample(style, key, entry.group))
  }))
})

const componentCount = computed(() => Object.keys(props.design?.components ?? {}).length)

// ---------------------------------------------------------------- 间距与圆角

const spacingSteps = computed(() => {
  const style = props.design
  if (!style) return []
  const steps = numericScale(style.spacing)
  const max = Math.max(1, ...steps.map((step) => step[2]))
  return steps.map(([key, raw, value]) => ({
    key,
    raw,
    label: spacingLabel(style, key),
    // 最宽的一档占满整行，其余按比例
    width: `${Math.max(3, Math.round((value / max) * 100))}%`
  }))
})

const roundedSteps = computed(() => {
  const style = props.design
  if (!style) return []
  const max = Math.max(1, ...numericScale(style.rounded).map((step) => step[2]))
  return numericScale(style.rounded).map(([key, raw, value]) => ({
    key,
    raw,
    label: roundedLabel(style, key),
    // 圆角用 44px 的方块展示：超过 22px 的半径画出来都一样（已经是全圆）
    radius: `${Math.min(22, Math.max(0, value))}px`,
    full: value >= max
  }))
})

const accent = computed(() => props.design?.accent ?? '')
const canvas = computed(() => props.design?.canvas ?? '')
</script>

<template>
  <AppDialog v-model="visible" class="style-dialog" width="980px" :title="title">
    <template v-if="design">
      <p class="lede">
        <span class="lede__badge">{{ badge }}</span>
        <button v-if="canvas" class="lede__color" type="button" @click="copy(canvas, '画布色')">
          画布 <i :style="{ background: canvas }" /> <span class="mono">{{ canvas }}</span>
        </button>
        <button v-if="accent" class="lede__color" type="button" @click="copy(accent, '主色')">
          主色 <i :style="{ background: accent }" /> <span class="mono">{{ accent }}</span>
        </button>
        <span v-if="design.font" class="lede__font">展示字体 {{ design.font }}</span>
      </p>

      <p class="desc">{{ design.description }}</p>

      <!-- 01 配色 -->
      <section class="sec">
        <h4 class="sec__title">配色</h4>
        <p class="sec__hint">按角色分组，点色块复制色值，点变量名复制名字</p>
        <div v-for="section in colorSections" :key="section.group" class="color-group">
          <span class="eyebrow">{{ section.group }}</span>
          <div class="swatches">
            <div v-for="swatch in section.swatches" :key="swatch.key" class="swatch">
              <button
                class="swatch__chip mono"
                type="button"
                :style="{ background: swatch.value, color: swatch.ink }"
                :title="`复制 ${swatch.value}`"
                @click="copy(swatch.value, '色值')"
              >
                {{ swatch.value }}
              </button>
              <span class="swatch__label">{{ swatch.label }}</span>
              <button
                class="swatch__key mono"
                type="button"
                :title="`复制变量名 ${swatch.key}`"
                @click="copy(swatch.key, '变量名')"
              >
                {{ swatch.key }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 02 字体 -->
      <section class="sec">
        <h4 class="sec__title">字体</h4>
        <p class="sec__hint">
          字号与字重取自这套设计；字体本身多为品牌专有字体，本机没装时会回落到系统字体
        </p>
        <div class="types">
          <div v-for="row in typeRows" :key="row.key" class="type-row">
            <div class="type-row__meta">
              <span class="type-row__label">{{ row.label }}</span>
              <button
                class="type-row__key mono"
                type="button"
                :title="`复制变量名 ${row.key}`"
                @click="copy(row.key, '变量名')"
              >
                {{ row.key }}
              </button>
              <span class="type-row__spec mono">{{ row.spec }}</span>
            </div>
            <p class="type-row__sample" :style="row.style">{{ row.sample }}</p>
          </div>
        </div>
      </section>

      <!-- 03–06 组件样张 -->
      <section v-if="componentGroups.length" class="sec">
        <h4 class="sec__title">组件</h4>
        <p class="sec__hint">
          底色、字色、圆角、内边距都取这套设计自己的规格；{{ componentCount }} 个组件里挑了代表性的这些
        </p>
        <div v-for="entry in componentGroups" :key="entry.group" class="samples">
          <span class="eyebrow">{{ entry.group }}</span>
          <div class="samples__row" :class="`samples__row--${entry.group}`">
            <div v-for="sample in entry.samples" :key="sample.key" class="sample">
              <div
                class="sample__box"
                :class="`sample__box--${entry.group}`"
                :style="sample.style"
              >
                {{ sample.text }}
              </div>
              <button
                class="sample__label mono"
                type="button"
                :title="`复制变量名 ${sample.key}`"
                @click="copy(sample.key, '变量名')"
              >
                {{ sample.label }}
              </button>
            </div>
          </div>
          <p v-if="entry.rest" class="samples__rest">另有 {{ entry.rest }} 个同类组件未展开</p>
        </div>
      </section>

      <section v-else class="sec">
        <h4 class="sec__title">组件</h4>
        <p class="sec__hint">
          这套 DESIGN.md 只给了配色与字体，没有组件规格 —— 上游的 74 套里只有
          Lamborghini、Runway、Tesla 这三套是这样。
        </p>
      </section>

      <!-- 07 间距 -->
      <section v-if="spacingSteps.length" class="sec">
        <h4 class="sec__title">间距</h4>
        <p class="sec__hint">按数值从小到大</p>
        <div class="steps">
          <div v-for="step in spacingSteps" :key="step.key" class="step">
            <span class="step__label">{{ step.label }}</span>
            <span class="step__bar"><i :style="{ width: step.width }" /></span>
            <span class="step__raw mono">{{ step.raw }}</span>
          </div>
        </div>
      </section>

      <!-- 08 圆角 -->
      <section v-if="roundedSteps.length" class="sec">
        <h4 class="sec__title">圆角</h4>
        <p class="sec__hint">同一块 44px 的方块，按各自的圆角值切</p>
        <div class="radii">
          <div v-for="step in roundedSteps" :key="step.key" class="radius">
            <span class="radius__box" :style="{ borderRadius: step.radius }" />
            <span class="radius__label">{{ step.label }}</span>
            <span class="radius__raw mono">{{ step.raw }}</span>
          </div>
        </div>
      </section>
    </template>
  </AppDialog>
</template>

<style scoped>
.lede {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.lede__badge {
  color: var(--ink-2);
  font-weight: 500;
}

.lede__color {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font-size: var(--fs-micro);
  cursor: pointer;
}

.lede__color:hover {
  border-color: var(--border-strong);
}

.lede__color i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  border: 1px solid var(--border);
}

.desc {
  margin: 0 0 var(--sp-5);
  color: var(--ink-2);
  font-size: var(--fs-body);
  line-height: 1.8;
}

.sec {
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border);
}

.sec__title {
  margin: 0 0 2px;
  color: var(--ink);
  font-size: var(--fs-body);
}

.sec__hint {
  margin: 0 0 var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* ---- 配色 ---- */
.color-group + .color-group {
  margin-top: var(--sp-3);
}

.swatches {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: var(--sp-2);
  margin-top: 6px;
}

.swatch {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.swatch__chip {
  height: 40px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}

.swatch__label {
  color: var(--ink-2);
  font-size: var(--fs-micro);
  line-height: 1.3;
}

.swatch__key {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-align: left;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  cursor: pointer;
}

.swatch__key:hover {
  color: var(--ink);
}

/* ---- 字体 ---- */
.type-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: var(--sp-4);
  align-items: baseline;
  padding: var(--sp-2) 0;
}

.type-row + .type-row {
  border-top: 1px dashed var(--border);
}

.type-row__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.type-row__label {
  color: var(--ink);
  font-size: var(--fs-meta);
}

.type-row__key,
.sample__label,
.type-row__spec {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

button.type-row__key,
button.sample__label {
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

button.type-row__key:hover,
button.sample__label:hover {
  color: var(--ink);
}

.type-row__sample {
  margin: 0;
  min-width: 0;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 组件样张 ---- */
.samples + .samples {
  margin-top: var(--sp-3);
}

.samples__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--sp-3);
  margin-top: 6px;
}

.samples__row--卡片,
.samples__row--版式 {
  align-items: stretch;
}

.samples__rest {
  margin: 6px 0 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.sample {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.sample__box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  /* 组件没给底色时留个中性底，免得样张看不见 */
  background: var(--bg-inset);
  color: var(--ink);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 6px 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sample__box--卡片 {
  flex: 1 1 150px;
  min-height: 60px;
  justify-content: flex-start;
  align-items: flex-start;
  white-space: normal;
}

.sample__box--表单 {
  flex: 0 0 200px;
  justify-content: flex-start;
}

.sample__box--版式 {
  flex: 1 1 140px;
  min-height: 34px;
}

/* ---- 间距 ---- */
.steps {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 6px;
}

.step {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr) 56px;
  align-items: center;
  gap: var(--sp-3);
}

.step__label {
  color: var(--ink-2);
  font-size: var(--fs-micro);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.step__bar {
  display: block;
  height: 10px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  overflow: hidden;
}

.step__bar i {
  display: block;
  height: 100%;
  background: var(--st-idle);
}

.step__raw {
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-align: right;
}

/* ---- 圆角 ---- */
.radii {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4);
  margin-top: 6px;
}

.radius {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 64px;
}

.radius__box {
  width: 44px;
  height: 44px;
  background: var(--bg-inset);
  border: 1px solid var(--border-strong);
}

.radius__label {
  color: var(--ink-2);
  font-size: var(--fs-micro);
  text-align: center;
  line-height: 1.3;
}

.radius__raw {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}
</style>
