<script setup lang="ts">
import type { FloatingMenuItem } from '@/components/FloatingMenu.vue'
import { Close, CopyDocument, Download, ScaleToOriginal } from '@element-plus/icons-vue'
import FloatingMenu from '@/components/FloatingMenu.vue'
/**
 * 钉图的右键菜单：复制 / 另存为 / 适应屏幕 / 关闭。
 *
 * 只管摆和收：位置贴指针、夹回窗口内，收起交给 FloatingMenu；点选动作经 act 交回 PinApp。
 * 这扇窗口是透明的，所以外壳走实底档（`variant="solid"`），玻璃底在桌面上读不清。
 */
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

const items: FloatingMenuItem[] = [
  { name: 'copy', label: '复制到剪贴板', icon: CopyDocument },
  { name: 'save', label: '另存为…', icon: Download },
  { name: 'fit', label: '适应屏幕', icon: ScaleToOriginal },
  { name: 'close', label: '关闭钉图', icon: Close, danger: true, sep: true },
]
</script>

<template>
  <FloatingMenu
    :x="props.x"
    :y="props.y"
    :items="items"
    variant="solid"
    @act="name => emit('act', name as 'copy' | 'save' | 'fit' | 'close')"
    @close="emit('close')"
  />
</template>
