<script setup lang="ts">
/**
 * 会话的位置那一栏：这段对话在哪个目录里干活（+ 那个目录的 git 分支）。
 *
 * **目录跟着会话走、在会话里是定住的**（Pi 按目录给会话分组，换目录等于换一段对话），
 * 所以这一栏不再提供「换一个工作目录」—— 要换目录就新建一个会话（左栏那颗「+」）。
 * 两屏共用：控制台那一屏贴着左缘与 composer 对齐，居中那一屏由父级把内容居中。
 */
import { Folder, FolderOpened, Share } from '@element-plus/icons-vue'
import { useAiStore } from '@/stores/ai'

const ai = useAiStore()

/** 这一栏那个下拉里的两项：在资源管理器里打开、把完整路径复制走 */
function onCommand(command: string): void {
  if (command === 'reveal' && ai.activeSession) void window.workbench.reveal(ai.activeSession.dir)
  else if (command === 'copy' && ai.activeSession) void navigator.clipboard.writeText(ai.activeSession.dir)
}
</script>

<template>
  <div v-if="ai.activeSession" class="pick">
    <el-dropdown trigger="click" @command="onCommand">
      <button type="button" class="pick__item" :title="ai.activeSession.dir">
        <el-icon><FolderOpened /></el-icon>
        {{ ai.locationText }}
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="reveal" :icon="Folder">在资源管理器中打开</el-dropdown-item>
          <el-dropdown-item command="copy" :icon="Folder">复制完整路径</el-dropdown-item>
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
