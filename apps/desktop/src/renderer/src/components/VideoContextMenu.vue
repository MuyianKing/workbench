<script setup lang="ts">
import type { Component } from 'vue'
import { CopyDocument, FolderOpened, TopRight } from '@element-plus/icons-vue'
import { onMounted, ref } from 'vue'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'
import { useFloatingPosition } from '@/composables/use-floating-position'
/**
 * 视频行的右键菜单：只有「读」的三件事，**不碰播放状态**
 * （打开的是另一个程序、定位的是资源管理器、复制的是路径）。
 *
 * 位置**贴指针**（`contextmenu` 的 clientX / clientY），不是贴行首：el-dropdown 的
 * contextmenu 触发器锚在触发元素上，右击行尾也会把菜单弹到行首去。落点与收起的骨架
 * 与笔记正文、邮件清单行、目录树空白区共用 composables 里的那一套（贴指针 + 夹回窗口内）。
 *
 * 只管摆和收：点了哪一项经 `act` 交回 VideoTree，绝对路径由上层按视频根拼。
 */
type MenuAct = 'open-default' | 'reveal' | 'copy-path'

/** 一个菜单项；`sep` 在它前面画一道分隔线（与原来 el-dropdown 的 divided 同一位置） */
interface MenuItem {
  name: MenuAct
  label: string
  icon: Component
  sep: boolean
}

const props = defineProps<{
  /** 打开的位置，视口坐标（取自 contextmenu 的 clientX / clientY） */
  x: number
  y: number
}>()

const emit = defineEmits<{
  /** 选中了一项：open-default / reveal / copy-path */
  act: [name: MenuAct]
  close: []
}>()

/** 三项固定不变：打开 / 定位 / 复制，中间隔一道线把「打开」与另两项分开 */
const ITEMS: MenuItem[] = [
  { name: 'open-default', label: '用默认程序打开', icon: TopRight as Component, sep: false },
  { name: 'reveal', label: '在资源管理器中显示', icon: FolderOpened as Component, sep: true },
  { name: 'copy-path', label: '复制路径', icon: CopyDocument as Component, sep: false },
]

const panel = ref<HTMLDivElement | null>(null)

// 落点骨架（贴指针 + 夹回窗口）在 composables 里；follow 让「右击另一行」沿用同一实例时跟着新落点走
const { pos, place } = useFloatingPosition({
  x: () => props.x,
  y: () => props.y,
  panel: () => panel.value,
  follow: true,
})

function pick(name: MenuAct): void {
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
      <template v-for="item in ITEMS" :key="item.name">
        <span v-if="item.sep" class="menu__sep" />
        <button
          class="menu__item"
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
 * 与笔记右键菜单、邮件清单行菜单同一副外壳：厚一档的玻璃（--glass-fill）——
 * 它压在树的字上，所以底下那层必须被磨开（backdrop-filter 之后只剩色块、认不出字）。
 * 入场 150ms 淡入下沉（动效口径：≤300ms、--ease-out；reduced-motion 由 global.css 兜底）。
 */
.menu {
  position: fixed;
  /* 挂在 body 上（见模板里的 Teleport），比卡片与终端面板高，但仍在弹窗（EP 的 2000+）下面 */
  z-index: 1200;
  min-width: 172px;
  padding: var(--sp-1);
  background: var(--glass-fill);
  backdrop-filter: var(--glass-filter);
  border: 1px solid var(--glass-border-color);
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

.menu__sep {
  display: block;
  height: 1px;
  margin: var(--sp-1) var(--sp-2);
  background: var(--border);
}
</style>
