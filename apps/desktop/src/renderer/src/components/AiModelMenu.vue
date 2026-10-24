<script setup lang="ts">
import { ArrowDown, ArrowRight, Check, Cpu } from '@element-plus/icons-vue'
import { aiThinkingLabel } from '@workbench/ai'
/**
 * composer 工具行那颗「模型」chip 与它点开的浮层：模型挑拣与思考档位合并成一处
 * （原先模型、思考是两颗下拉，照用户点名的参考设计合成这块面板）：
 *
 *  - 顶上一行「模型管理」入口（深色圆角方块图标 + 右箭头），报给页面开模型管理弹层；
 *  - 中间「模型」清单：模型名 + 服务名小签（描边药丸），选中的那行末尾打勾；
 *  - 底下「思考强度」：左标签右档名，一条绿→蓝渐变滑杆（这条彩色是用户点名要的参考样式，
 *    不进全局令牌）。
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

/** chip 上那一串：与从前的模型下拉同一副写法 —— 服务名顶在前面，光有模型名看不出挂哪个服务 */
const triggerLabel = computed(() =>
  ai.activeChoice ? `${ai.providerLabel} · ${ai.activeChoice.name}` : '还没配模型',
)

/** 清单里那一列（choices 的顺序就是挑拣顺序，挑的是 AiModelChoice.key） */
const options = computed(() =>
  ai.choices.map(choice => ({ key: choice.key, name: choice.name, provider: choice.providerLabel })),
)

/** 挑一个：写进 store 就合上面板（勾马上换行，再多停一步反而拖沓） */
function pick(key: string): void {
  if (key !== ai.activeChoiceKey)
    void ai.setChoice(key)
  open.value = false
}

/** 顶行入口：合上面板再报给页面开模型管理弹层 */
function configure(): void {
  open.value = false
  emit('configure')
}

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
</script>

<template>
  <div ref="rootRef" class="menu">
    <button
      type="button"
      class="menu__chip"
      :class="{ 'is-open': open }"
      :title="triggerLabel"
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
      <button type="button" class="menu__entry" @click="configure">
        <span class="menu__entry-icon"><el-icon><Cpu /></el-icon></span>
        <span class="menu__entry-text">模型管理</span>
        <el-icon class="menu__entry-arrow">
          <ArrowRight />
        </el-icon>
      </button>

      <div class="menu__sep" />

      <div class="menu__group">
        模型
      </div>
      <div class="menu__models">
        <p v-if="!options.length" class="menu__empty">
          还没有能挑的模型：先在模型管理里加一个服务
        </p>
        <template v-else>
          <button
            v-for="option in options"
            :key="option.key"
            type="button"
            class="menu__model"
            :title="`${option.provider} · ${option.name}`"
            @click="pick(option.key)"
          >
            <span class="menu__model-name">{{ option.name }}</span>
            <span class="menu__model-tag">{{ option.provider }}</span>
            <el-icon v-if="option.key === ai.activeChoiceKey" class="menu__model-check">
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
        <el-slider
          v-if="ai.thinkingLevels.length > 1"
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

/* 顶行入口：深色圆角方块图标 + 加粗标题 + 右箭头，悬停整行铺选中底 */
.menu__entry {
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

.menu__entry:hover {
  background: var(--bg-selected);
}

/* 那块深色方块（参考设计里是品牌位）：明暗两档各自反过来 —— ink 面配 surface 色 icon */
.menu__entry-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 7px;
  background: var(--ink);
  color: var(--bg-surface);
  font-size: 14px;
}

.menu__entry-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu__entry-arrow {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: 12px;
}

.menu__sep {
  height: 1px;
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

/* 服务名小签（参考设计里「预览」那枚描边药丸的样子）：几个服务可能有同名模型，
   这枚签说的就是它挂哪个服务 */
.menu__model-tag {
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu__model-check {
  flex-shrink: 0;
  color: var(--el-color-primary);
  font-size: 14px;
}

.menu__empty {
  margin: 0;
  padding: var(--sp-2);
  color: var(--ink-3);
  font-size: var(--fs-micro);
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
 * 滑杆：整条跑道铺绿→蓝渐变（用户点名的参考样式），白圆钮、药丸跑道；
 * EP 默认的「已过段」实色条会把渐变盖住，改成透的；跑道上面那层半透明白点是
 * 参考设计里的点状纹理。钮的尺寸走 EP 自己的变量（wrapper 的居中偏移按它算）。
 */
.menu__slider {
  --el-slider-border-radius: var(--r-pill);
  --el-slider-button-size: 14px;
}

.menu__slider :deep(.el-slider__runway) {
  background: linear-gradient(90deg, #34d399, #3b82f6);
}

.menu__slider :deep(.el-slider__runway::after) {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-image: radial-gradient(rgba(255, 255, 255, 0.5) 1px, transparent 1.4px);
  background-size: 10px 6px;
  pointer-events: none;
}

.menu__slider :deep(.el-slider__bar) {
  background: transparent;
}

.menu__slider :deep(.el-slider__button) {
  border: none;
  background-color: #fff;
  box-shadow: 0 1px 4px rgba(17, 21, 27, 0.35);
}
</style>
