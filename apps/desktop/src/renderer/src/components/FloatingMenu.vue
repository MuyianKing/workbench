<script lang="ts">
import type { Component } from 'vue'
</script>

<script setup lang="ts">
/**
 * 贴着指针弹出的浮层菜单：笔记 / 视频 / 邮件清单 / 联系人 / 钉图五处右键菜单共用的那副外壳。
 *
 * 只长这一份。差异只在三处，都用 props 表达：
 *  - `items`：菜单项（文案、图标、分隔线、危险档）；
 *  - `variant`：`glass`（压在有字的画布上，厚一档的玻璃）或 `solid`（钉图那扇透明窗口，实底）；
 *  - `minWidth`：窄菜单（联系人两项）给 148，其余 172。
 *
 * 落点与收起的骨架仍在 composables 里（`use-floating-position` / `use-floating-dismiss`）：
 * 贴指针、夹回窗口内、点别处 / 右键别处 / Esc / 滚轮 / 窗口变化都收起。
 * 这里只管摆和收：点了哪一项经 `act` 交回调用方。
 */
import { onMounted, ref } from 'vue'
import { useFloatingDismiss } from '@/composables/use-floating-dismiss'
import { useFloatingPosition } from '@/composables/use-floating-position'

/** 一项菜单：`sep` 在它前面画一道分隔线；`danger` 是找不回来的那类（常驻红字） */
export interface FloatingMenuItem {
  /** 交回给调用方的动作名 */
  name: string
  label: string
  icon?: Component
  danger?: boolean
  sep?: boolean
}

const props = withDefaults(defineProps<{
  /** 打开的位置，视口坐标（取自 contextmenu 的 clientX / clientY） */
  x: number
  y: number
  items: FloatingMenuItem[]
  /** 外壳：玻璃（默认）/ 实底（钉图那扇透明窗口） */
  variant?: 'glass' | 'solid'
  /** 最小宽度（逻辑像素） */
  minWidth?: number
}>(), { variant: 'glass', minWidth: 172 })

const emit = defineEmits<{
  /** 选中了一项（名字原样带回，由调用方按自己的动作表认） */
  act: [name: string]
  close: []
}>()

const panel = ref<HTMLDivElement | null>(null)

// 落点骨架（贴指针 + 夹回窗口）在 composables 里；follow 让「右击另一行」沿用同一实例时跟着新落点走
const { pos, place } = useFloatingPosition({
  x: () => props.x,
  y: () => props.y,
  panel: () => panel.value,
  follow: true,
})

function pick(name: string): void {
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
      :class="{ 'is-solid': variant === 'solid' }"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, minWidth: `${minWidth}px` }"
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
 * 厚一档的玻璃（--glass-fill）：它压在树 / 清单的字上，底下那层必须被磨开
 * （backdrop-filter 之后只剩色块、认不出字）。
 * 入场 150ms 淡入下沉（动效口径：≤300ms、--ease-out；reduced-motion 由 global.css 兜底）。
 */
.menu {
  position: fixed;
  /* 挂在 body 上（见模板里的 Teleport），比卡片与终端面板高，但仍在弹窗（EP 的 2000+）下面 */
  z-index: 1200;
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

/* 删除 / 关闭这类找不回来的动作：图标与字常驻危险档，悬停只换底色不换语义 */
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

/*
 * 实底档：钉图那扇窗口是透明的，玻璃底在桌面上读不清 —— 改实底（暗色令牌由 pin.html 定）。
 */
.menu.is-solid {
  background: var(--bg-surface);
  backdrop-filter: none;
  border-color: var(--border);
}

.menu.is-solid .menu__item:hover {
  background: var(--bg-inset);
}

.menu.is-solid .menu__item.is-danger:hover {
  background: var(--st-fail-soft, rgb(245 34 45 / 12%));
}
</style>
