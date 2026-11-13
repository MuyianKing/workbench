<script setup lang="ts">
import type { Component } from 'vue'
import type { FloatingMenuItem } from '@/components/FloatingMenu.vue'
import { CopyDocument, FolderOpened, TopRight } from '@element-plus/icons-vue'
import FloatingMenu from '@/components/FloatingMenu.vue'
/**
 * 视频行的右键菜单：只有「读」的三件事，**不碰播放状态**
 * （打开的是另一个程序、定位的是资源管理器、复制的是路径）。
 *
 * 位置**贴指针**（`contextmenu` 的 clientX / clientY），不是贴行首：el-dropdown 的
 * contextmenu 触发器锚在触发元素上，右击行尾也会把菜单弹到行首去。外壳、落点与收起
 * 与笔记 / 邮件 / 联系人 / 钉图那几处右键菜单共用 FloatingMenu（贴指针 + 夹回窗口内）。
 *
 * 只管摆和收：点了哪一项经 `act` 交回 VideoTree，绝对路径由上层按视频根拼。
 */
type MenuAct = 'open-default' | 'reveal' | 'copy-path'

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
const items: FloatingMenuItem[] = [
  { name: 'open-default', label: '用默认程序打开', icon: TopRight as Component, sep: false },
  { name: 'reveal', label: '在资源管理器中显示', icon: FolderOpened as Component, sep: true },
  { name: 'copy-path', label: '复制路径', icon: CopyDocument as Component, sep: false },
]
</script>

<template>
  <FloatingMenu
    :x="props.x"
    :y="props.y"
    :items="items"
    @act="name => emit('act', name as MenuAct)"
    @close="emit('close')"
  />
</template>
