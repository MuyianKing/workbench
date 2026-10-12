<script setup lang="ts">
/**
 * 钉图的右键菜单：复制 / 另存为 / 适应屏幕 / 关闭。
 *
 * 只管摆和收：位置贴指针、夹回窗口内，收起交给 useFloatingDismiss
 * （左键点别处、右键别处、Esc、滚轮、窗口缩放 / 失焦）；点选动作经 act 交回 PinApp。
 * 外壳与笔记正文 / 邮件清单行那几处右键菜单同一副（见 MailContextMenu.vue）。
 */
import type { Component } from 'vue'
import { Close, CopyDocument, Download, ScaleToOriginal } from '@element-plus/icons-vue'
import { computed, onMounted, ref } from 'vue'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'
import { useFloatingPosition } from '@/composables/use-floating-position'

const props = defineProps<{
  /** 打开位置，视口坐标（取自 contextmenu 的 clientX / clientY） */
  x: number
  y: number
}>()

const emit = defineEmits<{
  /** 选中了一项：copy / save / fit / close */
  act: [name: 'copy' | 'save' | 'fit' | 'close']
  close: []
}>()

interface MenuItem {
  name: 'copy' | 'save' | 'fit' | 'close'
  label: string
  icon: Component
  danger: boolean
  sep: boolean
}

const items = computed<MenuItem[]>(() => [
  { name: 'copy', label: '复制到剪贴板', icon: CopyDocument, danger: false, sep: false },
  { name: 'save', label: '另存为…', icon: Download, danger: false, sep: false },
  { name: 'fit', label: '适应屏幕', icon: ScaleToOriginal, danger: false, sep: false },
  { name: 'close', label: '关闭钉图', icon: Close, danger: true, sep: true },
])

const panel = ref<HTMLDivElement | null>(null)

const { pos, place } = useFloatingPosition({
  x: () => props.x,
  y: () => props.y,
  panel: () => panel.value,
  follow: true,
})

function pick(name: MenuItem['name']): void {
  emit('act', name)
  emit('close')
}

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
 * 与别处右键菜单同一副外壳。这扇窗口是透明的，卡片必须是实底 ——
 * 令牌取的是暗色那一份（pin.html 上固定 data-theme="dark"）。
 */
.menu {
  position: fixed;
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
  background: var(--bg-inset);
  color: var(--ink);
}

.menu__item.is-danger:hover {
  background: var(--st-fail-soft, rgb(245 34 45 / 12%));
  color: var(--st-fail, #f5222d);
}

.menu__icon {
  font-size: 15px;
}

.menu__sep {
  display: block;
  height: 1px;
  margin: var(--sp-1) var(--sp-2);
  background: var(--border);
}
</style>
