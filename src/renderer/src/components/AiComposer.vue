<script setup lang="ts">
/**
 * 写指令的那一条：输入框 + 一行控件（工具权限、这一轮用哪个模型、思考几档、发送 / 停止）。
 *
 * **就是「在这一段对话里说一句」**：发出去的那句接在这个会话的对话后面（会话见左栏那棵树），
 * 上下文由那个会话的 Pi 进程接着 —— 不是新起一轮。
 *
 * 它自己读 store：说一句、换权限、换模型与换档位都是这一页的动作，归它发。模型配置那个弹层
 * **不归它** —— 弹层挂在页面最外层，所以这里只报一声「要开配置」。
 *
 * 权限那一栏在下拉里给每一档挂一行小字（这一档到底问不问）—— 下拉挂在 body 上，
 * 那两行字的样式在 global.css（`.composer-permission-pop`）。
 */
import { computed } from 'vue'
import { Promotion, Setting, VideoPause } from '@element-plus/icons-vue'
import { AI_PERMISSION_MODES, AI_THINKING_LEVELS } from '@shared/ai'
import { useAiStore } from '@/stores/ai'

const emit = defineEmits<{ configure: [] }>()

const ai = useAiStore()

/** 模型下拉里的每一项：提供方 / 模型 id（Pi 认的就是这个前缀写法） */
function modelLabel(id: string): string {
  return ai.providerName ? `${ai.providerName}/${id}` : id
}

/** 下拉挑了什么就记进设置（el-select 的 change 给的是宽联合，这里只可能是字符串） */
function chooseModel(value: unknown): void {
  void ai.setRunModel(String(value))
}

function chooseThinking(value: unknown): void {
  void ai.setThinking(String(value))
}

function choosePermission(value: unknown): void {
  void ai.setPermission(String(value))
}

/** 那一颗按钮：没在跑就是「发送」，跑着就是「停止」 */
function sendOrStop(): void {
  if (ai.running) void ai.stop()
  else void ai.run()
}

/**
 * Enter 发送、Shift + Enter 换行；中文输入法选字时敲的 Enter 不算（isComposing）。
 * 发不了的时候不拦它 —— 那时 Enter 就是普通的换行，别把输入框锁住。
 */
function onEnter(event: KeyboardEvent): void {
  if (event.isComposing || ai.running || !ai.canRun) return
  event.preventDefault()
  void ai.run()
}

/** 发送按钮的提示：跑着时它是停止，其余时候把还差什么说清楚 */
const sendTitle = computed(() => {
  if (ai.running) return '停掉这一轮（先让它自己停，卡住了才按进程树杀）'
  if (!ai.canRun) return ai.blocking || '还跑不起来'
  return '发送：接着这段对话说下去（Enter）'
})
</script>

<template>
  <section class="composer">
    <el-input
      v-model="ai.instruction"
      class="composer__input"
      type="textarea"
      resize="none"
      :autosize="{ minRows: 2, maxRows: 8 }"
      placeholder="接着这段对话说点什么 —— 它会自己读目录里的说明、改文件，也可能执行命令。"
      @keydown.enter.exact="onEnter"
    />

    <div class="composer__row">
      <!--
        工具权限：**左边这一栏**。两档的差别只有一个 —— 执行命令问不问（读写文件都不问）；
        它交给 Rust 决定加不加载那份确认扩展（见 shared/ai.ts 的 AI_PERMISSION_MODES）。
        下拉里每一条底下那行小字说的就是这个（样式在 global.css）。
      -->
      <el-select
        class="composer__permission"
        popper-class="composer-permission-pop"
        :fit-input-width="false"
        :model-value="ai.permission"
        @change="choosePermission"
      >
        <template #prefix>权限</template>
        <el-option
          v-for="mode in AI_PERMISSION_MODES"
          :key="mode.id"
          :label="mode.label"
          :value="mode.id"
        >
          <span class="composer-permission-label">{{ mode.label }}</span>
          <span class="composer-permission-hint">{{ mode.hint }}</span>
        </el-option>
      </el-select>

      <div class="composer__tools">
        <!--
          三个控件都不带 size：一行里得同高。EP 的默认尺寸是 32px（按钮与下拉各有一份
          「小」尺寸实现，下拉那边是写死的 24px，调不成同一个高度），所以统一走默认。
        -->
        <el-select
          class="composer__model"
          :model-value="ai.runModel"
          placeholder="还没配模型"
          @change="chooseModel"
        >
          <template #prefix>模型</template>
          <el-option v-for="id in ai.enabledModels" :key="id" :label="modelLabel(id)" :value="id" />
          <template #empty>
            <p class="composer__empty">清单里还没有启用的模型</p>
          </template>
          <template #footer>
            <el-button link size="small" :icon="Setting" @click="emit('configure')">
              模型配置…
            </el-button>
          </template>
        </el-select>

        <el-select
          class="composer__thinking"
          :model-value="ai.thinking"
          @change="chooseThinking"
        >
          <template #prefix>思考</template>
          <el-option
            v-for="level in AI_THINKING_LEVELS"
            :key="level.id"
            :label="level.label"
            :value="level.id"
          />
        </el-select>

        <el-tooltip :content="sendTitle" placement="top">
          <el-button
            class="composer__send"
            :type="ai.running ? 'danger' : 'primary'"
            :icon="ai.running ? VideoPause : Promotion"
            :disabled="!ai.running && !ai.canRun"
            @click="sendOrStop"
          />
        </el-tooltip>
      </div>
    </div>
  </section>
</template>

<style scoped>
/**
 * composer 自己就是一张卡片：底色与边框照 .panel 那一套（卡片的写法见 global.css）——
 * 它比内容面板矮一档，所以圆角与内边距自己定。
 */
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
  box-shadow: var(--shadow-card);
}

/* 输入框长在卡片里：边框与底色都归卡片，它自己只剩文字（悬停 / 聚焦也不画框） */
.composer__input :deep(.el-textarea__inner) {
  padding: 0;
  font-family: inherit;
  line-height: 1.7;
  background: transparent;
  box-shadow: none;
}

.composer__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

/* 权限那一栏在左边这一格：宽度放得下「完全访问」（下拉本身比它宽，
   选项里那两行小字的样式在 global.css —— 下拉挂在 body 上，作用域样式够不着） */
.composer__permission {
  width: 132px;
}

.composer__tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-left: auto;
}

/* 模型那一栏要能放下「提供方/模型 id」，思考那一栏只要放得下「极高」两个字。
   字号随默认尺寸涨到 14px 了，宽度跟着放宽一点，不然模型名比原来还早被截断 */
.composer__model {
  width: 270px;
  max-width: 100%;
}

.composer__thinking {
  width: 116px;
}

/* 「模型」「思考」两个前缀只是标签：比选中的值浅、比它小一档 */
.composer__tools :deep(.el-select__prefix) {
  margin-right: var(--sp-1);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 下拉底部的「模型配置…」：挨着最后一条模型，点开就是那个弹层 */
.composer__tools :deep(.el-select-dropdown__footer) {
  padding: var(--sp-1) var(--sp-2);
  border-top: 1px solid var(--border);
}

.composer__empty {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 发送那颗是方块：宽跟着默认尺寸的高（32px）走，与旁边两个下拉同高 */
.composer__send {
  width: 32px;
}
</style>
