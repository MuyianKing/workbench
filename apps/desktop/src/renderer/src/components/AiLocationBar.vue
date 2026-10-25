<script setup lang="ts">
import { Folder, FolderOpened, Share } from '@element-plus/icons-vue'
import { noteRootName } from '@workbench/notes'
/**
 * 位置那一栏（只在**挑中会话**那一屏）：这段对话在哪个目录里干活（+ 那个目录的 git 分支），
 * 贴着左缘、与 composer 对齐。目录是**定住的**（跟着会话走 —— Pi 按目录给会话分组，换目录
 * 等于换一段对话），所以下拉里只有「在资源管理器里打开 / 复制完整路径」，换目录要去左栏
 * 新建（起始那一屏的选目录按钮见 AiView 的 landing，不归这一栏）。
 *
 * git 分支那一格是父级（AiView）探好递下来的（它自己只显示，不探）。
 */
import { computed } from 'vue'
import { useAiStore } from '@/stores/ai'

const props = defineProps<{
  /** 当前目录的 git 分支（AiView 探好递下来的；空串是不显示那一格） */
  repoBranch: string
}>()

const ai = useAiStore()

/** 这一栏说的是哪个目录：会话那个（定死的） */
const dir = computed(() => ai.activeSession?.dir ?? '')
/** 行上显示的永远是目录名，完整路径挂在 title 上 */
const label = computed(() => (dir.value ? noteRootName(dir.value) : '挑一个工作目录'))

/** 下拉里那几项：看这个目录（打开 / 复制），换目录去左栏 */
function onCommand(command: string): void {
  if (command === 'reveal' && dir.value)
    void window.workbench.reveal(dir.value)
  else if (command === 'copy' && dir.value)
    void navigator.clipboard.writeText(dir.value)
}
</script>

<template>
  <div class="pick">
    <el-dropdown trigger="click" @command="onCommand">
      <button type="button" class="pick__item" :title="dir">
        <el-icon><FolderOpened v-if="dir" /><Folder v-else /></el-icon>
        {{ label }}
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="reveal" :icon="Folder">
            在资源管理器中打开
          </el-dropdown-item>
          <el-dropdown-item command="copy" :icon="Folder">
            复制完整路径
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <span v-if="props.repoBranch" class="pick__item is-static" title="这个目录当前的 git 分支">
      <el-icon><Share /></el-icon>
      {{ props.repoBranch }}
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
