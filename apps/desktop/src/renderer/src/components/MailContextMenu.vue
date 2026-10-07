<script setup lang="ts">
import type { Component } from 'vue'
import { CircleCheck, Delete, Finished, Flag, Hide, View } from '@element-plus/icons-vue'
/**
 * 收件箱清单行的右键菜单：标记广告 / 翻已读 / 多选删除 / 删信。
 *
 * **标记为广告**是广告过滤的主入口：发件人地址进黑名单（设置里的 mailBulkSenders），
 * 这个发件人过去与将来的信在清单里都算广告 —— 自动启发式只兜显然的那种，
 * 什么算广告最终由主人说了算。对着黑名单里的发件人再右击，这一项变成「取消广告标记」。
 *
 * **多选删除**跟着勾选态变：还没勾选时它是个入口 —— 把右击的这封勾进批次（行首
 * 复选框随之亮起，勾选条出现）；已勾选时它变成「删除所选 N 封」，直接确认删掉整批。
 * 「删除邮件」始终只删右击的那一封。
 *
 * 只管摆和收：位置贴指针、夹回窗口内，收起交给 useFloatingDismiss
 * （左键点别处、右键别处、Esc、滚轮、窗口缩放 / 失焦）；点选动作经 act 交回 MailView。
 * 应用全局已关掉 WebView2 的默认右键菜单（main.rs 的初始化脚本），这里的
 * `@contextmenu.prevent` 只是兜住事件冒泡。
 */
import { computed, onMounted, ref } from 'vue'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'
import { useFloatingPosition } from '@/composables/use-floating-position'

const props = defineProps<{
  /** 打开的位置，视口坐标（取自 contextmenu 的 clientX / clientY） */
  x: number
  y: number
  /** 这一行的发件人已在黑名单里：首项变成「取消广告标记」 */
  bulk: boolean
  /** 这一行的已读态：中间项在「标记为已读 / 未读」之间切换 */
  seen: boolean
  /** 此刻勾了几封（0 = 还没勾）：决定「多选删除」是入口还是直接删这批 */
  pickedCount: number
}>()

const emit = defineEmits<{
  /** 选中了一项：bulk（标记 / 取消广告）、toggle-seen（翻已读态）、multi-pick（把这封勾进批次）、
   *  multi-delete / delete（删勾选批次 / 删这一封，确认在视图层） */
  act: [name: 'bulk' | 'toggle-seen' | 'multi-pick' | 'multi-delete' | 'delete']
  close: []
}>()

/** 菜单项：图标与文案跟着状态走；危险项前画分隔线（相邻两个危险项只画一道） */
const items = computed(() => [
  {
    name: 'bulk' as const,
    label: props.bulk ? '取消广告标记' : '标记为广告',
    icon: props.bulk ? CircleCheck : Flag,
    danger: false,
    sep: false,
  },
  {
    name: 'toggle-seen' as const,
    label: props.seen ? '标记为未读' : '标记为已读',
    icon: props.seen ? Hide : View,
    danger: false,
    sep: false,
  },
  props.pickedCount > 0
    ? {
        name: 'multi-delete' as const,
        label: `删除所选 ${props.pickedCount} 封`,
        icon: Delete as Component,
        danger: true,
        sep: true,
      }
    : { name: 'multi-pick' as const, label: '多选删除', icon: Finished as Component, danger: false, sep: true },
  { name: 'delete' as const, label: '删除邮件', icon: Delete as Component, danger: true, sep: props.pickedCount === 0 },
])

const panel = ref<HTMLDivElement | null>(null)

// 落点骨架（贴指针 + 夹回窗口）在 composables 里，与笔记正文、目录树空白区共用
const { pos, place } = useFloatingPosition({
  x: () => props.x,
  y: () => props.y,
  panel: () => panel.value,
  follow: true,
})

type MenuAct = 'bulk' | 'toggle-seen' | 'multi-pick' | 'multi-delete' | 'delete'

function pick(name: MenuAct): void {
  emit('act', name)
  emit('close')
}

// 点别处 / 右键别处 / Esc / 滚轮 / 窗口变化都收起（骨架在 composables 里，与笔记右键菜单共用）
useFloatingDismiss({ panel: () => panel.value, onDismiss: () => emit('close') })

onMounted(place)
</script>

<template>
  <Teleport to="body">
    <div
      ref="panel"
      class="menu"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      role="menu"
      @mousedown.prevent
      @contextmenu.prevent
    >
      <template v-for="item in items" :key="item.name">
        <span v-if="item.sep" class="menu__sep" />
        <button
          class="menu__item"
          :class="{ 'is-danger': item.danger }"
          type="button"
          role="menuitem"
          @click="pick(item.name)"
        >
          <el-icon class="menu__icon">
            <component :is="item.icon" />
          </el-icon>
          <span class="menu__label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 浮层卡片与笔记右键菜单同一副外壳；压在清单的字上，底色必须是实底。
 * 入场 150ms 淡入下沉（动效口径：≤300ms、--ease-out；reduced-motion 由 global.css 兜底）。
 */
.menu {
  position: fixed;
  /* 挂在 body 上（见模板里的 Teleport），比卡片高，但仍在弹窗（EP 的 2000+）下面 */
  z-index: 1200;
  min-width: 172px;
  padding: var(--sp-1);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  animation: menu-in 0.15s var(--ease-out);
}

@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
}

.menu__item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: 28px;
  padding: 0 var(--sp-2);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  font: inherit;
  font-size: var(--fs-body);
  color: var(--ink-2);
  text-align: left;
  cursor: pointer;
}

.menu__item:hover {
  color: var(--ink);
  background: var(--bg-subtle);
}

.menu__icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--ink-3);
}

.menu__item:hover .menu__icon {
  color: var(--ink-2);
}

/* 删除是找不回来的那一种：图标与字常驻危险档，悬停只换底色不换语义 */
.menu__item.is-danger,
.menu__item.is-danger .menu__icon {
  color: var(--st-fail);
}

.menu__item.is-danger:hover {
  background: var(--bg-subtle);
}

.menu__sep {
  display: block;
  height: 1px;
  margin: var(--sp-1) var(--sp-2);
  background: var(--border);
}
</style>
