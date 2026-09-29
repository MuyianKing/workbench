<script setup lang="ts">
/**
 * 「添加 AI 服务」第二步下面那两栏：左边是**端点报上来的模型**（点一下就加到右边），
 * 右边是**这个服务的清单**（每条一行，行上的「高级」摊开它的编辑面板：别名、
 * 上下文窗口 / 最大输出、思考档位、能力）。
 *
 * 两栏都由父组件传进来：`available` 是 ai_models_fetch 拉回来的那一份（端点说什么就是
 * 什么），`models` 是清单草稿（v-model）。这里只做「挑」这件事 —— 拉取、保存都在
 * AiProviderDialog 那一层。
 *
 * 上下文 / 最大输出 / 思考的默认值在 shared/ai.ts 的 aiModelFromId 里算（端点没报就按
 * 模型名认一遍，认不出留空），这里只负责让用户改。快捷档位只是**填数的捷径**：
 * 点一下把数字填进那一格，真正的值以输入框里的为准。
 */
import { computed, ref } from 'vue'
import { Delete, Plus, Refresh } from '@element-plus/icons-vue'
import {
  AI_MODEL_MAX,
  AI_THINKING_LEVELS,
  aiModelFromId,
  aiThinkingLabel,
  sanitizeAiThinkingLevels,
  type AiFetchedModel,
  type AiModelEntry
} from '@shared/ai'
import { notifyError } from '@/notify'

const props = defineProps<{
  /** 端点报上来的模型（还没拉过就是空的） */
  available: AiFetchedModel[]
  /** 正在拉列表 */
  loading: boolean
  /** 左栏空着时那句说明（没拉过 / 正在拉 / 没搜到，父组件说哪一句合适） */
  hint: string
  /** 服务的 preset id（内置目录里同名的厂商优先 —— 预填认得更准） */
  provider?: string
}>()

const models = defineModel<AiModelEntry[]>({ required: true })

const emit = defineEmits<{ refresh: [] }>()

const leftSearch = ref('')
const rightSearch = ref('')
const customId = ref('')
/** 摊开「高级」面板的那一行（一个模型 id；空串 = 全收着） */
const opened = ref('')

/** 左栏那一列：按搜索筛过 */
const offered = computed(() => {
  const keyword = leftSearch.value.trim().toLowerCase()
  if (!keyword) return props.available
  return props.available.filter(
    (item) => item.id.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword)
  )
})

/**
 * 左栏每一行显示的那几样（上下文 / 思考 / 图片）：**加进来会填成什么就先摆在这儿** ——
 * 与点「添加」走的是同一份预填（aiModelFromId：端点报了用端点的，没报的从随包 Pi 的
 * 内置目录认，再不行按名字认），带 ≒ 的那几样是端点没说、我们认出来的，加了还能改。
 */
const offeredRows = computed(() =>
  offered.value.map((item) => {
    const filled = aiModelFromId(
      item.id,
      {
        name: item.name,
        contextWindow: item.contextWindow,
        maxTokens: item.maxTokens,
        // 端点没说（null）就交给内置目录 / 按名字认的那两层
        ...(item.reasoning === null ? {} : { reasoning: item.reasoning })
      },
      props.provider ?? ''
    )
    return {
      model: item,
      context: filled.contextWindow,
      contextGuessed: !item.contextWindow,
      reasoning: filled.reasoning,
      reasoningGuessed: item.reasoning === null,
      image: filled.imageInput
    }
  })
)

/** 右栏那一列（清单草稿）：同样能搜 */
const chosen = computed(() => {
  const keyword = rightSearch.value.trim().toLowerCase()
  if (!keyword) return models.value
  return models.value.filter(
    (item) => item.id.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword)
  )
})

function has(id: string): boolean {
  return models.value.some((entry) => entry.id === id)
}

/** 左栏点一下：没加过的加进来，加过的撤下去（同一个动作来回切，不必找那个删除按钮） */
function toggle(item: AiFetchedModel): void {
  if (has(item.id)) return remove(item.id)
  if (models.value.length >= AI_MODEL_MAX) {
    notifyError(`一个服务最多留 ${AI_MODEL_MAX} 个模型（先在右边去掉几个）`)
    return
  }
  models.value = [
    ...models.value,
    aiModelFromId(
      item.id,
      {
        name: item.name,
        contextWindow: item.contextWindow,
        maxTokens: item.maxTokens,
        // 端点没说（null）就交给内置目录 / 按名字认的那两层
        ...(item.reasoning === null ? {} : { reasoning: item.reasoning })
      },
      props.provider ?? ''
    )
  ]
}

function remove(id: string): void {
  models.value = models.value.filter((entry) => entry.id !== id)
}

/** 手填一个 id（端点列表里没有的：私有部署、别名、还没发布的那种）——同样吃预填 */
function addCustom(): void {
  const id = customId.value.trim()
  if (!id) return
  if (!has(id) && models.value.length >= AI_MODEL_MAX) {
    notifyError(`一个服务最多留 ${AI_MODEL_MAX} 个模型（先在右边去掉几个）`)
    return
  }
  if (!has(id)) models.value = [...models.value, aiModelFromId(id, {}, props.provider ?? '')]
  customId.value = ''
}

function patch(entry: AiModelEntry, changes: Partial<AiModelEntry>): void {
  models.value = models.value.map((item) =>
    item.id === entry.id ? { ...item, ...changes } : item
  )
}

/**
 * token 数那一格：填的是 token 数，也认 `128k` 这种写法（手边只有一个数字时不必数零）。
 * 空 = 不知道 —— 那就 0，models.json 里不落这个字段，Pi 按它自己的默认兜底。
 */
function parseTokens(text: string): number {
  const value = text.trim().toLowerCase()
  if (!value) return 0
  const match = /^(\d+(?:\.\d+)?)\s*(k|m)?$/.exec(value)
  if (!match) return 0
  const size = Number(match[1])
  const unit = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  return Math.floor(size * unit)
}

function setContext(entry: AiModelEntry, text: string): void {
  patch(entry, { contextWindow: parseTokens(text) })
}

function setMaxOutput(entry: AiModelEntry, text: string): void {
  patch(entry, { maxTokens: parseTokens(text) })
}

/** 别名：清空就是不要别名 —— 直接回退到 id（界面上总得有个名字） */
function setName(entry: AiModelEntry, text: string): void {
  const alias = text.trim().slice(0, 40)
  patch(entry, { name: alias || entry.id })
}

/** 数值的快捷档位：点一下把数字填进那一格（与参考客户端同一组预设） */
const CONTEXT_PRESETS = [128_000, 256_000, 312_000, 500_000, 1_000_000]
const OUTPUT_PRESETS = [4_000, 8_000, 16_000, 32_000, 128_000]

/** token 数怎么念：1M / 384K / 4096 —— 行上摘要与快捷档位共用这一套 */
function tokenSummary(size: number): string {
  if (size >= 1_000_000) {
    const count = size / 1_000_000
    return `${Number.isInteger(count) ? count : count.toFixed(1)}M`
  }
  if (size >= 1_000) {
    const count = size / 1_000
    return `${Number.isInteger(count) ? count : Math.round(count)}K`
  }
  return size > 0 ? String(size) : ''
}

/** 行上那截摘要：`1M · 384K`（上下文 · 最大输出，缺哪样就少一截） */
function entrySummary(entry: AiModelEntry): string {
  return [entry.contextWindow, entry.maxTokens]
    .map(tokenSummary)
    .filter(Boolean)
    .join(' · ')
}

/** 「高级」面板摊开 / 收起（一次摊一行，再点一下收回去） */
function toggleOpen(id: string): void {
  opened.value = opened.value === id ? '' : id
}

/**
 * 思考档位那排 chips：**「关闭」与后面几档是一组** —— 点「关闭」关掉思考；
 * 点某一档是把它加进支持清单（思考顺带打开），把最后一档也点掉就等于关闭。
 * off 一直在清单里占着位（与 Pi 的算法一致，见 sanitizeAiThinkingLevels）。
 */
function levelOn(entry: AiModelEntry, id: string): boolean {
  if (id === 'off') return !entry.reasoning
  return entry.reasoning && entry.levels.includes(id)
}

function toggleLevel(entry: AiModelEntry, id: string): void {
  if (id === 'off') {
    patch(entry, { reasoning: false, levels: sanitizeAiThinkingLevels([], false) })
    return
  }
  const next = entry.reasoning && entry.levels.includes(id)
    ? entry.levels.filter((level) => level !== id)
    : [...entry.levels, id]
  const on = next.some((level) => level !== 'off')
  patch(entry, { reasoning: on, levels: sanitizeAiThinkingLevels(next, true) })
}

function contextText(size: number): string {
  return size > 0 ? String(size) : ''
}
</script>

<template>
  <div class="pick">
    <!-- 左栏：端点报上来的模型 -->
    <section class="pick__pane">
      <header class="pick__head">
        <span class="pick__title">该服务的模型</span>
        <span class="pick__tools">
          <el-input
            v-model="leftSearch"
            size="small"
            class="pick__search"
            placeholder="搜索模型 ID"
            clearable
          />
          <el-button size="small" :icon="Refresh" :loading="loading" @click="emit('refresh')">
            获取列表
          </el-button>
        </span>
      </header>

      <div class="pick__list">
        <p v-if="!offeredRows.length" class="pick__empty">{{ hint }}</p>
        <ul v-else class="pick__rows">
          <li v-for="row in offeredRows" :key="row.model.id" class="pick__row">
            <button
              type="button"
              class="pick__offer"
              :class="has(row.model.id) ? 'is-on' : ''"
              @click="toggle(row.model)"
            >
              <span class="pick__offer-text">
                <span class="pick__offer-name">{{ row.model.name }}</span>
                <!-- 端点没给显示名时 name 就是 id：两行写同一个字符串只是占地方 -->
                <span
                  v-if="row.model.id !== row.model.name"
                  class="pick__offer-id mono"
                  :title="row.model.id"
                >
                  {{ row.model.id }}
                </span>
              </span>
              <span class="pick__offer-meta">
                <span v-if="row.context" class="pick__meta">
                  {{ row.contextGuessed ? '≈' : '' }}{{ row.context }} ctx
                </span>
                <span v-if="row.reasoning" class="pick__meta">
                  {{ row.reasoningGuessed ? '≈' : '' }}思考
                </span>
                <span v-if="row.image" class="pick__meta">图片</span>
                <span class="pick__sign">{{ has(row.model.id) ? '已添加' : '添加' }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </section>

    <!-- 右栏：这个服务的清单（每条的上下文与思考在这儿改） -->
    <section class="pick__pane">
      <header class="pick__head">
        <span class="pick__title">模型设置<span class="pick__count">{{ models.length }}</span></span>
        <el-input
          v-model="rightSearch"
          size="small"
          class="pick__search"
          placeholder="搜索已添加模型"
          clearable
        />
      </header>

      <div class="pick__list">
        <p v-if="!models.length" class="pick__empty">尚未选择模型。请在左侧列表中点选。</p>
        <p v-else-if="!chosen.length" class="pick__empty">这些模型里没有匹配的。</p>
        <ul v-else class="pick__rows">
          <li v-for="entry in chosen" :key="entry.id" class="pick__row is-chosen">
            <div class="pick__line">
              <span class="pick__offer-text">
                <span class="pick__offer-name">{{ entry.name }}</span>
                <span v-if="entry.id !== entry.name" class="pick__offer-id mono" :title="entry.id">
                  {{ entry.id }}
                </span>
              </span>
              <span class="pick__sum mono" :title="`${entry.contextWindow} / ${entry.maxTokens}`">
                {{ entrySummary(entry) }}
              </span>
              <el-tooltip
                content="关掉的模型留在清单里，只是不进 Pi 的配置（models.json）"
                placement="top"
              >
                <el-switch
                  :model-value="entry.enabled"
                  size="small"
                  @update:model-value="(value: unknown) => patch(entry, { enabled: value === true })"
                />
              </el-tooltip>
              <el-button link size="small" @click="toggleOpen(entry.id)">
                {{ opened === entry.id ? '收起' : '高级' }}
              </el-button>
              <el-button link :icon="Delete" @click="remove(entry.id)" />
            </div>

            <!-- 高级面板：别名 / 上下文与最大输出 / 思考档位 / 能力（一次只摊一行） -->
            <div v-if="opened === entry.id" class="pick__adv">
              <div class="adv__field">
                <span class="adv__label">别名</span>
                <el-input
                  size="small"
                  :model-value="entry.name"
                  :placeholder="entry.id"
                  @change="(value: string) => setName(entry, value)"
                />
              </div>

              <div class="adv__grid">
                <div class="adv__field">
                  <span class="adv__label">上下文窗口</span>
                  <div class="adv__chips">
                    <button
                      v-for="size in CONTEXT_PRESETS"
                      :key="size"
                      type="button"
                      class="adv__chip mono"
                      :class="{ 'is-on': entry.contextWindow === size }"
                      @click="setContext(entry, String(size))"
                    >
                      {{ tokenSummary(size) }}
                    </button>
                  </div>
                  <el-input
                    size="small"
                    :model-value="contextText(entry.contextWindow)"
                    placeholder="未知"
                    @change="(value: string) => setContext(entry, value)"
                  />
                </div>
                <div class="adv__field">
                  <span class="adv__label">最大输出</span>
                  <div class="adv__chips">
                    <button
                      v-for="size in OUTPUT_PRESETS"
                      :key="size"
                      type="button"
                      class="adv__chip mono"
                      :class="{ 'is-on': entry.maxTokens === size }"
                      @click="setMaxOutput(entry, String(size))"
                    >
                      {{ tokenSummary(size) }}
                    </button>
                  </div>
                  <el-input
                    size="small"
                    :model-value="contextText(entry.maxTokens)"
                    placeholder="默认"
                    @change="(value: string) => setMaxOutput(entry, value)"
                  />
                </div>
              </div>

              <div class="adv__field">
                <span class="adv__label">思考等级</span>
                <div class="adv__chips">
                  <button
                    v-for="level in AI_THINKING_LEVELS"
                    :key="level.id"
                    type="button"
                    class="adv__chip"
                    :class="{ 'is-on': levelOn(entry, level.id) }"
                    @click="toggleLevel(entry, level.id)"
                  >
                    {{ aiThinkingLabel(level.id) }}
                  </button>
                </div>
              </div>

              <div class="adv__field">
                <span class="adv__label">能力</span>
                <div class="adv__ability">
                  <el-tooltip
                    content="勾上后截图与图片文件才会真的发给模型（models.json 的 input 带 image）；端点不收图就关掉"
                    placement="top"
                  >
                    <el-checkbox
                      :model-value="entry.imageInput"
                      @change="(value: unknown) => patch(entry, { imageInput: value === true })"
                    >
                      图片
                    </el-checkbox>
                  </el-tooltip>
                  <span class="adv__hint">勾上它，模型才看得到自己截的图</span>
                </div>
              </div>
            </div>
          </li>
        </ul>
      </div>

      <footer class="pick__foot">
        <span class="pick__foot-label">
          自定义
          <el-tooltip content="端点列表里没有的模型：手填它的 id（私有部署、别名都算）" placement="top">
            <span class="pick__tip">?</span>
          </el-tooltip>
        </span>
        <div class="pick__foot-row">
          <el-input
            v-model="customId"
            size="small"
            placeholder="输入模型 ID，如 my-model-v2"
            @keyup.enter="addCustom"
          />
          <el-button size="small" :icon="Plus" @click="addCustom">添加自定义模型</el-button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/**
 * 两栏等宽并排：左边是「能加的」，右边是「加过的」。
 *
 * **上下都要对齐**：上边由栏头那一条的高度钉住（`height: 28px` + 不换行 —— 一换行列表就
 * 被推下去，两栏立即错开），下边由这一格的总高钉住（两栏都铺满它：左栏的列表一直到底，
 * 右栏是「列表 + 自定义那一块」，于是左边列表的底与右边自定义那块儿的底齐平）。
 */
.pick {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--sp-3);
  height: 372px;
}

.pick__pane {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
  min-height: 0;
}

/* 栏头一条：两栏的控件不一样（左栏多一颗「获取列表」），高度得钉住才谈得上对齐 */
.pick__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  height: 28px;
  flex-wrap: nowrap;
}

.pick__title {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.pick__count {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.pick__tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  flex-shrink: 1;
}

/* 栏头不换行，所以搜索框得让得出宽度来（左栏比右栏多一颗按钮） */
.pick__search {
  width: 168px;
  min-width: 84px;
  flex-shrink: 1;
}

/* 两栏各自的列表：吃掉这一栏剩下的高度、自己滚（列表底就是这一栏的底） */
.pick__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.pick__empty {
  margin: 0;
  padding: var(--sp-4) var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-align: center;
}

.pick__rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.pick__row + .pick__row {
  border-top: 1px solid var(--border);
}

.pick__offer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.pick__offer:hover {
  background: var(--bg-surface);
}

.pick__offer.is-on .pick__sign {
  color: var(--st-ok);
}

.pick__offer-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pick__offer-name {
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick__offer-id {
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick__offer-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}

.pick__meta {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.pick__sign {
  color: var(--ink-2);
  font-size: var(--fs-micro);
}

.pick__row.is-chosen {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
}

.pick__line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.pick__line .pick__offer-text {
  flex: 1;
}

/* 行上那截摘要（1M · 384K）：数值对齐用等宽，缺哪样就少一截 */
.pick__sum {
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/**
 * 高级面板：一张浅底卡压在行里，字段从上往下排 —— 别名占满一行，上下文与最大输出
 * 并排（与参考客户端同一版式），思考与能力各占一行。
 */
.pick__adv {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin-top: var(--sp-1);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.adv__field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}

.adv__label {
  color: var(--ink-2);
  font-size: var(--fs-micro);
}

.adv__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-2) var(--sp-3);
}

/* 快捷档位与思考档位同一排 chips：能换行的按钮排 */
.adv__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}

.adv__chip {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font-size: var(--fs-micro);
  line-height: 1.5;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.adv__chip:hover {
  background: var(--bg-surface);
}

/* 选中态跟「当前选择」的主色走（与全局 .chip.is-active 同一条口径） */
.adv__chip.is-on {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary);
  color: var(--el-color-white);
}

.adv__ability {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.adv__ability :deep(.el-checkbox) {
  height: auto;
}

.adv__hint {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 自定义那一块：**自己是一张底卡**（浅底 + 描边），挂在右栏底下 —— 它和上面的列表
   一起占满右栏，于是它的底与左栏列表的底齐平 */
.pick__foot {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.pick__foot-label {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.pick__tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--ink-3);
  font-size: 9px;
  cursor: help;
}

.pick__foot-row {
  display: flex;
  gap: var(--sp-2);
}
</style>
