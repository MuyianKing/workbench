<script setup lang="ts">
import { ArrowDown, ArrowRight, Check, Cpu } from '@element-plus/icons-vue'
import { aiThinkingLabel } from '@workbench/ai'
/**
 * composer 工具行那颗「模型」chip 与它点开的浮层：模型挑拣与思考档位合并成一处
 * （原先模型、思考是两颗下拉，照用户点名的参考设计合成这块面板）：
 *
 *  - 顶上一行是**当前服务**（字母头像 + 服务名 + API 小签 + 右箭头）：点开左边那张服务卡，
 *    卡里列启用的服务（当前那个打勾），点一个就落到这个服务的第一个模型；卡底「管理模型」
 *    报给页面开模型管理弹层；
 *  - 中间「模型」清单只列**这个服务**的模型：模型名 +「视觉」小签，选中的那行末尾打勾；
 *  - 底下「思考强度」：左标签右档名，一条绿→蓝渐变滑杆（这条彩色是用户点名要的参考样式，
 *    不进全局令牌）；点跑道上某一档时钮横向滑过去（不是瞬移）。
 *
 * 收放走 use-floating-dismiss（点别处 / Esc / 面板外滚轮都收）；「面板」报的是**组件根** ——
 * 点 chip 那一下不算「点别处」，开与关由 click 自己翻。与 store 的分工沿 composer 的老规矩：
 * 挑模型、换档位直接写 store（那是会话自己的配置记忆，见 stores/ai.ts 的 setChoice /
 * setThinking）；「模型管理」不归这里 —— 报给页面开那个弹层。
 */
import { computed, ref, watch } from 'vue'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'
import { useAiStore } from '@/stores/ai'

const emit = defineEmits<{ configure: [] }>()

const ai = useAiStore()

/** 浮层开着没（触发 chip 与整块面板都在这一层收放） */
const open = ref(false)

/** 组件根（chip + 面板都在它里面）：浮层收起拿它当「面板」 */
const rootRef = ref<HTMLElement | null>(null)

useFloatingDismiss({
  panel: () => rootRef.value,
  onDismiss: () => {
    open.value = false
  },
})

/** chip 上那一串：模型名 + 当前思考档（服务名放进悬停 —— 浮层顶行已经写着服务） */
const triggerLabel = computed(() => {
  if (!ai.activeChoice)
    return '还没配模型'
  const level = ai.thinkingLevels.length > 1 ? ` ${aiThinkingLabel(ai.thinking)}` : ''
  return `${ai.activeChoice.name}${level}`
})

/** chip 的悬停：说全「服务 · 模型」，光看名字认不出挂哪个服务 */
const triggerTitle = computed(() =>
  ai.activeChoice ? `${ai.providerLabel} · ${ai.activeChoice.name}` : '还没配模型',
)

/** 服务卡开着没（顶行那颗：点它展开 / 收起左边那张服务清单） */
const providersOpen = ref(false)

/** 当前服务：面板里的模型清单只列它（一个都没配上时给一句空话） */
const serviceLabel = computed(() => (ai.providerName ? ai.providerLabel : '还没有服务'))
const serviceInitial = computed(() => (ai.providerName ? serviceLabel.value.slice(0, 1).toUpperCase() : '?'))

/** 服务清单：启用的服务 × 它们能挑的模型（与 choices 同一份口径，一个能挑的都没有的不列） */
const services = computed(() =>
  ai.providers
    .filter(provider => provider.enabled && ai.choices.some(choice => choice.provider === provider.id))
    .map(provider => ({ id: provider.id, label: provider.label || provider.id })),
)

/** 面板中间那列：当前服务能挑的模型（服务之间的切换在左边那张服务卡里） */
const models = computed(() => ai.choices.filter(choice => choice.provider === ai.providerName))

/** 换服务：落到这个服务第一个能挑的模型（卡收起来，模型清单与档位跟着换） */
function switchService(id: string): void {
  providersOpen.value = false
  if (id === ai.providerName)
    return
  const first = ai.choices.find(choice => choice.provider === id)
  if (first)
    void ai.setChoice(first.key)
}

/** 挑一个：写进 store 就合上面板（勾马上换行，再多停一步反而拖沓） */
function pick(key: string): void {
  if (key !== ai.activeChoiceKey)
    void ai.setChoice(key)
  open.value = false
}

/** 收起服务卡与整块面板，报给页面开模型管理弹层 */
function configure(): void {
  providersOpen.value = false
  open.value = false
  emit('configure')
}

/** 面板合上时把服务卡也收掉：下次点开是一张干净的面板 */
watch(open, (value) => {
  if (!value)
    providersOpen.value = false
})

/** 滑杆停在**这个模型支持的档位**里的第几位（0..levels.length-1） */
const slider = ref(0)

/** 档位那头变了（换模型、换会话把 thinking 调回支持的档）就把滑杆对回去 */
watch(
  () => [ai.thinking, ai.thinkingLevels] as const,
  () => {
    const index = ai.thinkingLevels.indexOf(ai.thinking)
    slider.value = index >= 0 ? index : 0
  },
  { immediate: true },
)

/** 拖动只动本地那一位，松手（change）才写 store —— 一回拖动只落一次配置 */
function commitSlider(): void {
  const level = ai.thinkingLevels[slider.value]
  if (level && level !== ai.thinking)
    void ai.setThinking(level)
}

/** 跑道两端各给钮让出的半个钮（px）—— 与 .el-slider__runway 左右那两条透明边框同值 */
const TRACK_INSET = 14

/**
 * 点跑道上某一档：自己算好档位写进去，**不让 EP 把这一下当成一次拖动** ——
 * 它拖动时会直接改钮的位置（CSS 过渡被 .dragging 掐掉），钮就瞬移过去了；
 * 从外面改档位才会走 .el-slider__button-wrapper 上那条 left 过渡，钮横向滑过去。
 */
function pickLevel(event: MouseEvent): void {
  if (ai.thinkingLevels.length < 2)
    return
  // 按在钮上：那是拖动的起手，交给 EP 自己处理
  if ((event.target as HTMLElement).closest('.el-slider__button-wrapper'))
    return
  event.preventDefault()
  event.stopPropagation()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const width = rect.width - TRACK_INSET * 2
  if (width <= 0)
    return
  const percent = (event.clientX - rect.left - TRACK_INSET) / width
  slider.value = Math.round(Math.min(1, Math.max(0, percent)) * (ai.thinkingLevels.length - 1))
  commitSlider()
}

/** 档位点在跑道上的百分比位置：与钮走同一条刻度（两端点是钮停在最小 / 最大档时的位置） */
const stopLefts = computed(() =>
  ai.thinkingLevels.map((_, index) =>
    `${(index / Math.max(1, ai.thinkingLevels.length - 1)) * 100}%`,
  ),
)
</script>

<template>
  <div ref="rootRef" class="menu">
    <button
      type="button"
      class="menu__chip"
      :class="{ 'is-open': open }"
      :title="triggerTitle"
      @click="open = !open"
    >
      <el-icon class="menu__chip-icon">
        <Cpu />
      </el-icon>
      <span class="menu__chip-text">{{ triggerLabel }}</span>
      <el-icon class="menu__caret" :class="{ 'is-open': open }">
        <ArrowDown />
      </el-icon>
    </button>

    <!-- 面板开在 chip 正上方、右缘对齐；模型多时中间那一截自己滚 -->
    <div v-if="open" class="menu__panel">
      <!-- 顶行是当前服务：点它展开 / 收起左边那张服务卡（换服务 = 换到这个服务的第一个模型） -->
      <button
        type="button"
        class="menu__service"
        :class="{ 'is-open': providersOpen }"
        @click="providersOpen = !providersOpen"
      >
        <span class="menu__avatar">{{ serviceInitial }}</span>
        <span class="menu__service-name">{{ serviceLabel }}</span>
        <span v-if="ai.providerName" class="menu__pill">API</span>
        <el-icon class="menu__service-arrow">
          <ArrowRight />
        </el-icon>
      </button>

      <div class="menu__sep" />

      <div class="menu__group">
        模型
      </div>
      <div class="menu__models">
        <p v-if="!models.length" class="menu__empty">
          还没有能挑的模型：先在模型管理里加一个服务
        </p>
        <template v-else>
          <button
            v-for="model in models"
            :key="model.key"
            type="button"
            class="menu__model"
            :title="model.name"
            @click="pick(model.key)"
          >
            <span class="menu__model-name">{{ model.name }}</span>
            <span v-if="model.imageInput" class="menu__pill">视觉</span>
            <el-icon v-if="model.key === ai.activeChoiceKey" class="menu__model-check">
              <Check />
            </el-icon>
          </button>
        </template>
      </div>

      <div class="menu__sep" />

      <div class="menu__think">
        <div class="menu__think-head">
          <span class="menu__think-label">思考强度</span>
          <span class="menu__think-value">{{ aiThinkingLabel(ai.thinking) }}</span>
        </div>
        <!-- 只列这个模型支持的档位（与从前的档位下拉同一份口径）；不支持思考的没有滑杆 -->
        <div v-if="ai.thinkingLevels.length > 1" class="menu__slider-wrap" @mousedown.capture="pickLevel">
          <!-- 档位点：一档一颗，水平刻度与钮同源（选中那档正好压在钮下面） -->
          <div class="menu__stops" aria-hidden="true">
            <span
              v-for="(level, index) in ai.thinkingLevels"
              :key="level"
              class="menu__stop"
              :style="{ left: stopLefts[index] }"
            />
          </div>
          <el-slider
            v-model="slider"
            class="menu__slider"
            :min="0"
            :max="ai.thinkingLevels.length - 1"
            :step="1"
            :show-tooltip="false"
            @change="commitSlider"
          />
        </div>
      </div>

      <!-- 服务卡：主面板贴着窗口右缘，这张小卡往左开；底下一行是模型管理入口 -->
      <div v-if="providersOpen" class="menu__providers">
        <div class="menu__provider-list">
          <button
            v-for="service in services"
            :key="service.id"
            type="button"
            class="menu__provider"
            :title="service.label"
            @click="switchService(service.id)"
          >
            <span class="menu__avatar">{{ service.label.slice(0, 1).toUpperCase() }}</span>
            <span class="menu__provider-name">{{ service.label }}</span>
            <span class="menu__pill">API</span>
            <el-icon v-if="service.id === ai.providerName" class="menu__model-check">
              <Check />
            </el-icon>
          </button>
          <p v-if="!services.length" class="menu__empty">
            还没有能切换的服务
          </p>
        </div>
        <div class="menu__sep" />
        <button type="button" class="menu__manage" @click="configure">
          管理模型
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/**
 * 根只做定位锚：chip 摆在 composer 工具行里，浮层以根的右缘定位、开在 chip 上方
 * （composer 是这一栏最底下的元素，往上盖的是输入框那一截，不会撞出卡片外）。
 */
.menu {
  position: relative;
}

/* chip：与同一行另外两颗（权限下拉、发送）同一副样子 —— 无边框浅底、32px 高，
   字号对齐 EP 下拉在这行的默认 14px。悬停 / 开着时底色深一档、字取主题色文字
   （与 .composer__row 里那几颗 chip 同一条口径） */
.menu__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  max-width: 280px;
  padding: 0 var(--sp-2);
  border: 0;
  border-radius: var(--r-md);
  background: var(--bg-inset);
  color: var(--ink-2);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
}

.menu__chip:hover,
.menu__chip.is-open {
  background: var(--bg-selected);
  color: var(--ink-on-selected);
}

.menu__chip-icon {
  flex-shrink: 0;
}

.menu__chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 收展那颗小箭头：开合翻个面 */
.menu__caret {
  flex-shrink: 0;
  font-size: 12px;
  transition: transform 0.2s var(--ease-out);
}

.menu__caret.is-open {
  transform: rotate(180deg);
}

/* 面板本体：一张实心浮层卡（对话区是透的，再磨砂会与底下的字糊在一起），投影取弹层那一档 */
.menu__panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 360px;
  max-width: calc(100vw - 48px);
  padding: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
  box-shadow: var(--shadow-pop);
}

/* 顶行当前服务：头像 + 服务名 + API 小签 + 右箭头（点开左边那张服务卡） */
.menu__service {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: 7px var(--sp-2);
  border: 0;
  border-radius: var(--r-md);
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__service:hover,
.menu__service.is-open {
  background: var(--bg-selected);
}

/* 服务 / 模型行首那枚字母头像（与模型管理弹窗里服务行同一副样子） */
.menu__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 7px;
  background: var(--bg-inset);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.menu__service-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu__service-arrow {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: 12px;
}

/* 「API」/「视觉」这类小签：浅底药丸，不描边 */
.menu__pill {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.menu__sep {
  height: 1px;
  flex-shrink: 0;
  margin: var(--sp-1) var(--sp-2);
  background: var(--border);
}

.menu__group {
  padding: var(--sp-1) var(--sp-2) 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 模型清单：一列整行按钮，多了自己滚（滚轮不收浮层，见 use-floating-dismiss） */
.menu__models {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 248px;
  overflow-y: auto;
}

.menu__model {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: 6px var(--sp-2);
  border: 0;
  border-radius: var(--r-md);
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__model:hover {
  background: var(--bg-selected);
}

.menu__model-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 选中那一行末尾打勾（参考设计里是细黑勾，不抢主题色） */
.menu__model-check {
  flex-shrink: 0;
  color: var(--ink);
  font-size: 14px;
}

.menu__empty {
  margin: 0;
  padding: var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/**
 * 服务卡：主面板贴着窗口右缘（composer 就在这一栏最右边），这张小卡往左开；
 * 高度跟主面板走，服务多了在卡里滚 —— 不高过面板，免得盖住下面的 composer。
 */
.menu__providers {
  position: absolute;
  top: 0;
  right: calc(100% + 8px);
  display: flex;
  flex-direction: column;
  max-height: 100%;
  width: 224px;
  padding: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
  box-shadow: var(--shadow-pop);
}

.menu__provider-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}

.menu__provider {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: 6px var(--sp-2);
  border: 0;
  border-radius: var(--r-md);
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.menu__provider:hover {
  background: var(--bg-selected);
}

.menu__provider-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 卡底那一行：开模型管理弹层 */
.menu__manage {
  flex-shrink: 0;
  width: 100%;
  padding: 7px var(--sp-2);
  border: 0;
  border-radius: var(--r-md);
  background: none;
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-body);
  text-align: left;
  cursor: pointer;
}

.menu__manage:hover {
  background: var(--bg-selected);
}

/* 思考强度：一行「标签 · 当前档」+ 滑杆（档位就是这个模型支持的那几档） */
.menu__think {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2) var(--sp-2);
}

.menu__think-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}

.menu__think-label {
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.menu__think-value {
  color: var(--ink);
  font-size: var(--fs-meta);
  font-weight: 600;
}

/**
 * 滑杆：一条敦实的药丸跑道（24px）+ 比跑道略大的白圆钮（28px）—— 照参考设计放粗，
 * 钮停在两端时整颗仍在跑道里。做法：跑道左右各留 14px（= 钮半径）透明边框，
 * EP 的钮按 padding box 的百分比定位，正好被这两个边框往里收半个钮；渐变再用
 * background-origin: border-box 铺回整条（透明边框下面就是渐变，不是空档）。
 * EP 默认的「已过段」实色条会把渐变盖住，改成透的。跑道里只放档位点
 * （.menu__stops，一档一颗，位置与钮同源），没有别的纹理。钮的尺寸走 EP 自己的
 * 变量（wrapper 高 36，居中偏移按跑道高度算）。
 */
.menu__slider-wrap {
  position: relative;
}

/* 档位点：一档一颗小白点，横向刻度与钮同源 —— 两端各让 14px（= 钮半径），
   与跑道透明边那段行程一致；只作标记，不吃指针 */
.menu__stops {
  position: absolute;
  inset: 0 14px;
  z-index: 1;
  pointer-events: none;
}

.menu__stop {
  position: absolute;
  top: 50%;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.6);
  transform: translate(-50%, -50%);
}

/* 钮压在档位点上面：选中那档的点正好落在钮中心，被钮盖住。
   换档时钮按 left 滑过去（点跑道那一下由 pickLevel 直接改值，不经过拖动）；
   拖动时不能有过渡 —— 不然钮追着指针慢慢走，松手才到位 */
.menu__slider :deep(.el-slider__button-wrapper) {
  z-index: 2;
  transition: left 0.18s var(--ease-out);
}

.menu__slider :deep(.el-slider__button-wrapper.dragging) {
  transition: none;
}

.menu__slider {
  --el-slider-height: 24px;
  --el-slider-border-radius: var(--r-pill);
  --el-slider-button-size: 28px;
  --el-slider-button-wrapper-offset: -6px;
}

.menu__slider :deep(.el-slider__runway) {
  box-sizing: border-box;
  border-right: 14px solid transparent;
  border-left: 14px solid transparent;
  background: linear-gradient(90deg, #34d399, #3b82f6);
  background-clip: border-box;
  background-origin: border-box;
}

.menu__slider :deep(.el-slider__bar) {
  background: transparent;
}

/**
 * 钮的大小固定：不跟悬停 / 拖动缩放（EP 默认会 scale(1.2)、还给 button 挂了 all 过渡），
 * 思考强度这一块只留「换档时横向滑」这一处动画。
 */
.menu__slider :deep(.el-slider__button) {
  border: none;
  background-color: #fff;
  box-shadow: 0 2px 6px rgba(17, 21, 27, 0.28);
  transition: none;
}

.menu__slider :deep(.el-slider__button:hover),
.menu__slider :deep(.el-slider__button.hover),
.menu__slider :deep(.el-slider__button.dragging) {
  transform: none;
}
</style>
