<script setup lang="ts">
import type { Component } from 'vue'
import { Delete, EditPen } from '@element-plus/icons-vue'
/**
 * 联系人那一行的右键菜单：编辑 / 删除。
 *
 * 通讯录那一名单本身是「列表归列表」—— 行上不带按钮，动作都收在这份菜单里
 * （这与邮件清单行的右键菜单是同一种做法，外壳也是同一副）。
 *
 * 只管摆和收：位置贴指针、夹回窗口内，收起交给 useFloatingDismiss
 * （左键点别处、右键别处、Esc、滚轮、窗口缩放 / 失焦）；点选动作经 act 交回 MailView
 * （编辑开那颗表单弹窗、删除直接删 —— 确认口径都在那边）。
 * 应用全局已关掉 WebView2 的默认右键菜单（main.rs 的初始化脚本），这里的
 * `@contextmenu.prevent` 只是兜住事件冒泡。
 */
import { onMounted, ref } from 'vue'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'
import { useFloatingPosition } from '@/composables/use-floating-position'

const props = defineProps<{
  /** 打开的位置，视口坐标（取自 contextmenu 的 clientX / clientY） */
  x: number
  y: number
}>()

const emit = defineEmits<{
  /** 选中了一项：edit（开编辑弹窗）/ delete（从名单里删掉，确认口径在视图层） */
  act: [name: 'edit' | 'delete']
  close: []
}>()

/** 菜单项：删除是找不回来的那一种，常驻危险档 */
const items: { name: 'edit' | 'delete', label: string, icon: Component, danger: boolean }[] = [
  { name: 'edit', label: '编辑联系人', icon: EditPen, danger: false },
  { name: 'delete', label: '删除联系人', icon: Delete, danger: true },
]

const panel = ref<HTMLDivElement | null>(null)

// 落点骨架（贴指针 + 夹回窗口）在 composables 里，与邮件清单行、笔记右键菜单共用
const { pos, place } = useFloatingPosition({
  x: () => props.x,
  y: () => props.y,
  panel: () => panel.value,
  follow: true,
})

function pick(name: 'edit' | 'delete'): void {
  emit('act', name)
  emit('close')
}

// 点别处 / 右键别处 / Esc / 滚轮 / 窗口变化都收起（骨架在 composables 里）
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
      <button
        v-for="item in items"
        :key="item.name"
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
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 浮层卡片与邮件清单行的右键菜单同一副外壳；压在名单的字上，底色必须是实底。
 * 入场 150ms 淡入下沉（动效口径：≤300ms、--ease-out；reduced-motion 由 global.css 兜底）。
 */
.menu {
  position: fixed;
  /* 挂在 body 上（见模板里的 Teleport），比卡片高，但仍在弹窗（EP 的 2000+）下面 */
  z-index: 1200;
  min-width: 148px;
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

/* 删除常驻危险档：悬停只换底色不换语义 */
.menu__item.is-danger,
.menu__item.is-danger .menu__icon {
  color: var(--st-fail);
}

.menu__item.is-danger:hover {
  background: var(--bg-subtle);
}
</style>
