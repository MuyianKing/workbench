<script setup lang="ts">
/**
 * 位置那一栏：**这段对话在哪个目录里干活**（+ 那个目录的 git 分支）。两屏共用 ——
 * 挑中会话那一屏它贴着左缘、与 composer 对齐，起始那一屏它在 composer 上方（居中由父级排）。
 *
 * 同一个壳、两种意思：
 *
 *  - **挑中会话那一屏**：目录是**定住的**（跟着会话走 —— Pi 按目录给会话分组，换目录等于
 *    换一段对话），所以下拉里只有「在资源管理器里打开 / 复制完整路径」，换目录要去左栏新建。
 *  - **起始那一屏**（还没挑中会话）：这一栏就是**挑目录**的地方 —— 下一个会话在哪儿干活，
 *    下拉里是最近用过的几个目录 + 「选择其他目录…」。挑完只是记下来，会话在发出第一句时
 *    才建（见 stores/ai.ts 的 run）。
 */
import { computed } from 'vue'
import { Folder, FolderAdd, FolderOpened, Share } from '@element-plus/icons-vue'
import { noteRootName } from '@workbench/notes'
import { useAiStore } from '@/stores/ai'

const ai = useAiStore()

/** 这一栏说的是哪个目录：有会话就是会话那个（定死的），没有就是起始那一屏挑的那个 */
const dir = computed(() => ai.activeSession?.dir ?? ai.newDir)
/** 行上显示的永远是目录名，完整路径挂在 title 上 */
const label = computed(() => (dir.value ? noteRootName(dir.value) : '挑一个工作目录'))

/** 下拉里那几项：看这个目录（挑中会话时）、或者挑下一个目录（起始那一屏） */
function onCommand(command: string): void {
  if (command === 'reveal' && dir.value) void window.workbench.reveal(dir.value)
  else if (command === 'copy' && dir.value) void navigator.clipboard.writeText(dir.value)
  else if (command === 'pick') void ai.pickNewDir()
  else if (command) ai.setNewDir(command)
}
</script>

<template>
  <div class="pick">
    <el-dropdown trigger="click" @command="onCommand">
      <button type="button" class="pick__item" :title="dir">
        <el-icon><FolderOpened v-if="dir" /><FolderAdd v-else /></el-icon>
        {{ label }}
      </button>
      <template #dropdown>
        <el-dropdown-menu v-if="ai.activeSession">
          <el-dropdown-item command="reveal" :icon="Folder">在资源管理器中打开</el-dropdown-item>
          <el-dropdown-item command="copy" :icon="Folder">复制完整路径</el-dropdown-item>
        </el-dropdown-menu>
        <el-dropdown-menu v-else>
          <el-dropdown-item v-for="item in ai.recentDirs" :key="item" :command="item">
            {{ noteRootName(item) }}
          </el-dropdown-item>
          <el-dropdown-item command="pick" :divided="ai.recentDirs.length > 0" :icon="FolderAdd">
            选择其他目录…
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <span v-if="ai.repoBranch" class="pick__item is-static" title="这个目录当前的 git 分支">
      <el-icon><Share /></el-icon>
      {{ ai.repoBranch }}
    </span>
  </div>
</template>

<style scoped>
.pick {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.pick__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--sp-3);
  border: 0;
  border-radius: var(--r-md);
  background: var(--bg-inset);
  color: var(--ink-2);
  font-family: inherit;
  font-size: var(--fs-meta);
  cursor: pointer;
}

.pick__item:hover {
  background: var(--bg-selected);
}

/* 分支那一格只是说事实，点不动 */
.pick__item.is-static {
  cursor: default;
  color: var(--ink-3);
}

.pick__item.is-static:hover {
  background: var(--bg-inset);
}
</style>
