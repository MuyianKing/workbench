<script setup lang="ts">
import { Check } from '@element-plus/icons-vue'
import { basenameOf } from '@/format'
/**
 * Git 页「换仓库」的那份菜单：项目 → 最近打开 → 打开其他文件夹…
 *
 * 头部仓库名与空态里的「选择项目」共用这一份，菜单只在 [GitView](GitView.vue) 里出现，
 * 别在两处各写一遍。根是 `el-dropdown-menu`：每一项的 `command` 原样交给外层
 * `el-dropdown` 的 `command` 事件（`pick` 表示去挑一个新文件夹，其余是路径本身）。
 * 外观（宽度、分组名、名字 / 路径的排布）在 global.css 的 `.git-repo-menu` 一处。
 */
defineProps<{
  /** 项目页里的项目，顺序照项目页；目录不存在的置灰 */
  projects: { id: string, name: string, path: string, disabled: boolean }[]
  /** 最近打开过的文件夹（已去掉与项目重复的） */
  recent: string[]
  /** 当前正打开的那个文件夹：打勾用 */
  currentPath: string
}>()

/** 路径比较按 Windows 的口径：不分大小写、`/` 与 `\` 等价 */
function isCurrentPath(path: string, currentPath: string): boolean {
  return Boolean(path)
    && path.replace(/\\/g, '/').toLowerCase() === currentPath.replace(/\\/g, '/').toLowerCase()
}
</script>

<template>
  <el-dropdown-menu>
    <template v-if="projects.length">
      <el-dropdown-item disabled class="repo-menu__label">
        项目
      </el-dropdown-item>
      <el-dropdown-item
        v-for="project in projects"
        :key="project.id"
        :command="project.path"
        :disabled="project.disabled"
        :title="project.disabled ? `${project.path}（目录不存在）` : project.path"
      >
        <span class="repo-item__name">{{ project.name }}</span>
        <span class="repo-item__path mono">{{ project.path }}</span>
        <el-icon v-if="isCurrentPath(project.path, currentPath)" class="repo-item__mark">
          <Check />
        </el-icon>
      </el-dropdown-item>
    </template>

    <template v-if="recent.length">
      <el-dropdown-item
        disabled
        class="repo-menu__label"
        :divided="projects.length > 0"
      >
        最近打开
      </el-dropdown-item>
      <el-dropdown-item
        v-for="item in recent"
        :key="item"
        :command="item"
        :title="item"
      >
        <span class="repo-item__name">{{ basenameOf(item) }}</span>
        <span class="repo-item__path mono">{{ item }}</span>
        <el-icon v-if="isCurrentPath(item, currentPath)" class="repo-item__mark">
          <Check />
        </el-icon>
      </el-dropdown-item>
    </template>

    <el-dropdown-item
      :divided="projects.length > 0 || recent.length > 0"
      command="pick"
    >
      打开其他文件夹…
    </el-dropdown-item>
  </el-dropdown-menu>
</template>
