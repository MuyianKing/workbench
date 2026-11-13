<script setup lang="ts">
import type { NoteKind } from '@workbench/notes'
import type { Component } from 'vue'
import type { FloatingMenuItem } from '@/components/FloatingMenu.vue'
import { CopyDocument, FolderAdd, FolderOpened, Plus, TopRight } from '@element-plus/icons-vue'
import { computed } from 'vue'
import FloatingMenu from '@/components/FloatingMenu.vue'
/**
 * 笔记树节点行的右键菜单：节点行上的新建 / 重命名 / 删除与三项「读」的动作。
 *
 * 位置**贴指针**（`contextmenu` 的 clientX / clientY），不是贴行首：el-dropdown 的
 * contextmenu 触发器锚在触发元素上（整行），右击行尾也会把菜单弹到行首去。外壳、落点与
 * 收起与视频行、邮件清单行、联系人、钉图共用 FloatingMenu（贴指针 + 夹回窗口内）。
 *
 * 只管摆和收：点了哪一项经 `act` 交回 NoteTree，新建落在哪个目录、路径怎么落到系统上
 * 都由那一层决定 —— 这里不认树的数据，只知道「这一行是笔记还是文件夹」。
 */
type MenuAct = 'new-note' | 'new-folder' | 'rename' | 'remove' | 'reveal' | 'copy-path' | 'open-default'

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
const items = computed<FloatingMenuItem[]>(() => [
  { name: 'new-note', label: '新建笔记', icon: Plus as Component, sep: false },
  { name: 'new-folder', label: '新建文件夹', icon: FolderAdd as Component, sep: true },
  { name: 'rename', label: '重命名', sep: true },
  { name: 'remove', label: '删除', sep: false },
  { name: 'reveal', label: '在资源管理器中显示', icon: FolderOpened as Component, sep: true },
  { name: 'copy-path', label: '复制路径', icon: CopyDocument as Component, sep: false },
  ...(props.kind === 'note'
    ? [{ name: 'open-default', label: '用默认程序打开', icon: TopRight as Component, sep: false }]
    : []),
])
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
