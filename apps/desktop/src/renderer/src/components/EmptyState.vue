<script setup lang="ts">
import type { Component } from 'vue'
/**
 * 空态：**一副小图 + 一句事实**，图是一张浮着的小卡片（里头顶一枚图标）压着一道投影。
 *
 * 为什么是这个样子：邮箱那两栏的空态原本就是这么画的（一张卡片 + 未读点 + 投影，轻轻浮动），
 * 这里把它收成**一处共用的** —— 换页看过去，「这儿还没有东西」都长一个样。
 * 窄栏 / 面板里用 `compact`（图小一圈），整页用默认那档。
 *
 * 文字只写事实，不写引导（见 AGENTS.md 第 4 节）：「还没有会话」是事实，
 * 「点这里开始」不是。去哪儿做、为什么空着放第二行（`hint`），动作按钮走 `#actions`。
 */
defineProps<{
  /** Element Plus 的那枚图标组件（`import { Message } from '@element-plus/icons-vue'` 那种） */
  icon: Component
  /** 一句事实 */
  text: string
  /** 第二行小字：空着的原因 / 去哪儿做（可不给） */
  hint?: string
  /** 小一号：树、面板这些窄地方用 */
  compact?: boolean
  /** 卡片右上角那枚小点（邮箱的未读点是它，别处不用） */
  dot?: boolean
}>()
</script>

<template>
  <div class="empty-state" :class="{ 'is-compact': compact }">
    <div class="empty-state__stage" aria-hidden="true">
      <span class="empty-state__card">
        <el-icon class="empty-state__icon">
          <component :is="icon" />
        </el-icon>
        <span v-if="dot" class="empty-state__dot" />
      </span>
      <span class="empty-state__shadow" />
    </div>

    <p class="empty-state__text">
      {{ text }}
    </p>
    <p v-if="hint" class="empty-state__hint">
      {{ hint }}
    </p>

    <div v-if="$slots.actions" class="empty-state__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
/* 竖着堆、居中：整栏空着时这一块占满那一栏（min-height 在高度不定时自然不起作用） */
.empty-state {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  min-height: 100%;
  padding: var(--sp-4) var(--sp-2);
  text-align: center;
}

.empty-state__stage {
  position: relative;
  width: 140px;
  height: 110px;
}

/* 卡片就是「图」的主体：里头那枚图标说这是什么，投影让它浮起来（不然只是一块灰方块） */
.empty-state__card {
  position: absolute;
  left: 50%;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 82px;
  height: 62px;
  margin-left: -41px;
  border-radius: var(--r-md);
  background: var(--bg-inset);
  animation: empty-state-hop 2.4s ease-in-out infinite;
}

.empty-state__icon {
  font-size: 34px;
  color: var(--ink-2);
}

.empty-state__dot {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 12px;
  height: 12px;
  border: 2px solid var(--bg-inset);
  border-radius: var(--r-pill);
  background: var(--ink);
}

.empty-state__shadow {
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 50px;
  height: 8px;
  margin-left: -25px;
  border-radius: var(--r-pill);
  background: var(--ink);
  opacity: 0.1;
  animation: empty-state-shadow 2.4s ease-in-out infinite;
}

.empty-state__text {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-title);
}

.empty-state__hint {
  max-width: 34ch;
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  line-height: 1.7;
  opacity: 0.85;
}

.empty-state__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}

/* 窄地方那一档：图小一圈、四周的留白也收一收 */
.empty-state.is-compact {
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-2);
}

.is-compact .empty-state__stage {
  width: 92px;
  height: 74px;
}

.is-compact .empty-state__card {
  width: 56px;
  height: 44px;
  margin-left: -28px;
  border-radius: var(--r-sm);
}

.is-compact .empty-state__icon {
  font-size: 26px;
}

.is-compact .empty-state__dot {
  top: -5px;
  right: -5px;
  width: 10px;
  height: 10px;
}

.is-compact .empty-state__shadow {
  bottom: 4px;
  width: 38px;
  height: 6px;
  margin-left: -19px;
}

/*
 * 动效只剩卡片轻跳那一档循环（ease-in-out；reduced-motion 由 global.css 全局兜底）。
 * **没有入场动画**：原先 stage / 文字各有一道 opacity:0 起步的入场（both 回填），
 * 在 WebView2 的某些时序下会冻在起始帧 —— 图那条冻住就「只有字」、字那条冻住就
 * 「只有图」，两种都真出现过（2026-10 无头环境复现）。可见性不交给动画。
 * 颜色全走灰度令牌 —— 活泼靠构图与动效，不靠彩色。
 */

/* 跳的节奏里织进姿态：跳起顺势摆正一点，回弹时歪回去，落地归位（卡片常驻微微左倾） */
@keyframes empty-state-hop {
  0%,
  58%,
  100% {
    transform: translateY(0) rotate(-4deg);
  }

  26% {
    transform: translateY(-14px) rotate(2deg);
  }

  72% {
    transform: translateY(-5px) rotate(-7deg);
  }

  86% {
    transform: translateY(0) rotate(-4deg);
  }
}

/* 地上的影子：卡片跳起来它就缩小变淡，落回去就摊平 */
@keyframes empty-state-shadow {
  0%,
  58%,
  100% {
    transform: scaleX(1);
    opacity: 0.1;
  }

  26% {
    transform: scaleX(0.62);
    opacity: 0.06;
  }

  72% {
    transform: scaleX(0.86);
    opacity: 0.08;
  }

  86% {
    transform: scaleX(1);
    opacity: 0.1;
  }
}
</style>
