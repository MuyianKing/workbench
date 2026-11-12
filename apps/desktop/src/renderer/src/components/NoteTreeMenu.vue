<script setup lang="ts">
import type { NoteKind } from '@workbench/notes'
import type { Component } from 'vue'
import { CopyDocument, FolderAdd, FolderOpened, Plus, TopRight } from '@element-plus/icons-vue'
import { computed, onMounted, ref } from 'vue'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'
import { useFloatingPosition } from '@/composables/use-floating-position'
/**
 * 笔记树节点行的右键菜单：节点行上的新建 / 重命名 / 删除与三项「读」的动作。
 *
 * 位置**贴指针**（`contextmenu` 的 clientX / clientY），不是贴行首：el-dropdown 的
 * contextmenu 触发器锚在触发元素上（整行），右击行尾也会把菜单弹到行首去。落点与收起的
 * 骨架与笔记正文、邮件清单行、目录树空白区共用 composables 里的那一套（贴指针 + 夹回窗口内）。
 *
 * 只管摆和收：点了哪一项经 `act` 交回 NoteTree，新建落在哪个目录、路径怎么落到系统上
 * 都由那一层决定 —— 这里不认树的数据，只知道「这一行是笔记还是文件夹」。
 */
type MenuAct = 'new-note' | 'new-folder' | 'rename' | 'remove' | 'reveal' | 'copy-path' | 'open-default'

/** 一个菜单项；`sep` 在它前面画一道分隔线（与原来 el-dropdown 的 divided 同一位置） */
interface MenuItem {
  name: MenuAct
  label: string
  /** 重命名 / 删除没有图标（与从前那份菜单一致） */
  icon?: Component
  sep: boolean
}

const props = defineProps<{
  /** 打开的位置，视口坐标（取自 contextmenu 的 clientX / clientY） */
  x: number
  y: number
  /** 右击的是哪一行：文件夹没有「用默认程序打开」这一项 */
  kind: NoteKind
}>()

const emit = defineEmits<{
  /** 选中了一项：new-note / new-folder / rename / remove / reveal / copy-path / open-default */
  act: [name: MenuAct]
  close: []
}>()

/** 写的那一组 / 读的那一组，中间各隔一道线；文件夹走 reveal 就是进到它里面 */
const items = computed<MenuItem[]>(() => [
  { name: 'new-note', label: '新建笔记', icon: Plus as Component, sep: false },
  { name: 'new-folder', label: '新建文件夹', icon: FolderAdd as Component, sep: true },
  { name: 'rename', label: '重命名', sep: true },
  { name: 'remove', label: '删除', sep: false },
  { name: 'reveal', label: '在资源管理器中显示', icon: FolderOpened as Component, sep: true },
  { name: 'copy-path', label: '复制路径', icon: CopyDocument as Component, sep: false },
  ...(props.kind === 'note'
    ? [{ name: 'open-default' as const, label: '用默认程序打开', icon: TopRight as Component, sep: false }]
    : []),
])

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
      <template v-for="item in items" :key="item.name">
        <span v-if="item.sep" class="menu__sep" />
        <button
          class="menu__item"
          type="button"
          role="menuitem"
          @click="pick(item.name)"
        >
          <el-icon v-if="item.icon" class="menu__icon">
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
 * 与笔记正文、视频行、邮件清单行的右键菜单同一副外壳：厚一档的玻璃（--glass-fill）——
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
