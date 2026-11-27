<script setup lang="ts">
import { ArrowRight } from '@element-plus/icons-vue'
/**
 * 一轮的**过程**收成的一块：模型想的那几段、工具调用、报错、中途那些旁白都在它里面。
 *
 * 为什么整块收：一段对话要读的是「我说了什么、它最后说了什么」；中间那些步骤一次读文件、
 * 一条命令就占一行，摊着就是一面墙（见 packages/ai/src/ai.ts 的 aiTurns —— 过程 / 答案 / 收据怎么切
 * 是在那儿定的，有单测）。
 *
 * **跑着的时候摊开、跑完自动收起**；点标题那一行随时展开 / 收起。
 * 「还在跑」的状态不在这儿 —— 它跟在这轮对话内容的末尾（见 AiRunPanel），
 * 顶部那行说的是等你确认 / 接历史 / 在停 / 装 Pi / 出错。
 */
import { ref, watch } from 'vue'

const props = defineProps<{
  /** 标题那句话：过程步数（「过程 · 12 步」） */
  label: string
  /** 还在跑：内容自动摊开 */
  active: boolean
}>()

/** 摊开还是收着：跑着摊开，跑完自动收起（之后再点是用户自己的事） */
const expanded = ref(props.active)

watch(
  () => props.active,
  (active) => {
    if (!active)
      expanded.value = false
  },
)
</script>

<template>
  <div class="proc" :class="{ 'is-live': active }">
    <button type="button" class="proc__head" @click="expanded = !expanded">
      <el-icon class="proc__chevron" :class="{ 'is-open': expanded }">
        <ArrowRight />
      </el-icon>
      <span class="proc__label">{{ label }}</span>
    </button>

    <div v-if="expanded" class="proc__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.proc {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: var(--sp-1) 0;
}

/* 标题那一行：与注脚同一档轻，做成一个可点的小开关（不是按钮的样子） */
.proc__head {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: var(--sp-1);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-3);
  font: inherit;
  font-size: var(--fs-micro);
  cursor: pointer;
}

.proc__head:hover .proc__label {
  color: var(--ink-2);
  text-decoration: underline;
}

.proc__chevron {
  font-size: var(--fs-meta);
  transition: transform 0.15s ease;
}

.proc__chevron.is-open {
  transform: rotate(90deg);
}

/**
 * 过程里那些行：**整体压浅一档**（它们不是对话本身，是这一轮干了什么），
 * 左边一道细规线把「过程」与「对话」分开。里面各行的画法（工具行等宽、报错走失败色）
 * 由 AiRunPanel 管 —— 那几条规则是整条日志共用的。
 */
.proc__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
  padding-left: var(--sp-3);
  border-left: 2px solid var(--border);
}
</style>
