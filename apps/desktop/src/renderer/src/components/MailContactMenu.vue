<script setup lang="ts">
import type { FloatingMenuItem } from '@/components/FloatingMenu.vue'
import { Delete, EditPen } from '@element-plus/icons-vue'
import FloatingMenu from '@/components/FloatingMenu.vue'
/**
 * 联系人那一行的右键菜单：编辑 / 删除。
 *
 * 通讯录那一名单本身是「列表归列表」—— 行上不带按钮，动作都收在这份菜单里
 * （外壳与邮件清单行、笔记、视频、钉图共用 FloatingMenu，窄一档）。
 *
 * 只管摆和收：位置贴指针、夹回窗口内，收起交给 FloatingMenu（左键点别处、右键别处、
 * Esc、滚轮、窗口缩放 / 失焦）；点选动作经 act 交回 MailView
 * （编辑开那颗表单弹窗、删除直接删 —— 确认口径都在那边）。
 */
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
const items: FloatingMenuItem[] = [
  { name: 'edit', label: '编辑联系人', icon: EditPen },
  { name: 'delete', label: '删除联系人', icon: Delete, danger: true },
]
</script>

<template>
  <FloatingMenu
    :x="props.x"
    :y="props.y"
    :items="items"
    :min-width="148"
    @act="name => emit('act', name as 'edit' | 'delete')"
    @close="emit('close')"
  />
</template>
