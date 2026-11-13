<script setup lang="ts">
import { Box, Close, Download, FolderOpened, Refresh, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { isBusyStatus, STATUS_META, statusLabel } from '@/status'
import { useProjectsStore } from '@/stores/projects'
import { useTerminalStore } from '@/stores/terminal'

/**
 * 项目详情抽屉的头部：项目身份、状态灯、主操作（启动 / 打包 / 安装依赖）。
 *
 * 从 `ProjectDrawer.vue` 拆出来的整块。它只认 store 里那个「正在看的项目」，
 * 不持有抽屉的开关状态（`close` 交回父组件）。
 */
const emit = defineEmits<{
  close: []
}>()

const store = useProjectsStore()
const terminal = useTerminalStore()

const project = computed(() => store.drawerProject)
const runtime = computed(() => (project.value ? terminal.runtimeOf(project.value.id) : null))
const status = computed(() => runtime.value?.status ?? 'idle')
const isBusy = computed(() => isBusyStatus(status.value))
const isRunning = computed(() => status.value === 'running')
const pathValid = computed(() => (project.value ? store.isPathValid(project.value.id) : true))
const tone = computed(() => (pathValid.value ? STATUS_META[status.value].tone : 'fail'))

function restart(): void {
  const current = project.value
  if (current)
    void store.restart(current.id)
}

function onBuild(script?: unknown): void {
  const current = project.value
  if (current)
    void store.build(current.id, typeof script === 'string' ? script : undefined)
}
</script>

<template>
  <template v-if="project">
    <header class="drawer__head">
      <div class="drawer__identity">
        <h2 class="drawer__name truncate">
          {{ project.name }}
        </h2>
        <span class="drawer__path mono truncate" :title="project.path">{{ project.path }}</span>
      </div>
      <el-button class="icon-btn" :icon="Close" text aria-label="关闭" @click="emit('close')" />
    </header>

    <div class="drawer__status">
      <span class="pill" :class="`tone-${tone}`">
        <i class="pill__dot" />
        {{ pathValid ? statusLabel(status, runtime?.kind) : '路径无效' }}
      </span>
      <span v-if="runtime?.pid" class="mono drawer__pid">PID {{ runtime.pid }}</span>
      <el-button
        class="drawer__reveal"
        size="small"
        :icon="FolderOpened"
        text
        :disabled="!pathValid"
        @click="store.reveal(project.path)"
      >
        打开目录
      </el-button>
    </div>

    <p v-if="project.manageOnly" class="drawer__notice">
      这个项目是以「仅管理目录」加入的：package.json 无法解析，Workbench 只能帮你管目录，
      不会执行任何命令。修好 package.json 后可用「重新定位」重新识别。
    </p>

    <!-- 主操作 -->
    <div class="drawer__actions">
      <!-- 安装 / 打包进行中：只能停，不能启动，否则按钮全是灰的没处下手 -->
      <el-button v-if="isBusy" size="small" :icon="VideoPause" @click="store.stop(project.id)">
        停止
      </el-button>
      <template v-else-if="isRunning">
        <el-button size="small" :icon="VideoPause" @click="store.stop(project.id)">
          停止
        </el-button>
        <el-button size="small" :icon="Refresh" @click="restart">
          重启
        </el-button>
      </template>
      <el-button
        v-else
        size="small"
        type="primary"
        :icon="VideoPlay"
        :disabled="!pathValid || !project.scripts.serve || !!project.manageOnly"
        @click="store.start(project.id)"
      >
        启动
      </el-button>

      <el-dropdown
        split-button
        size="small"
        :disabled="isBusy || isRunning || !pathValid || !!project.manageOnly || !project.scripts.build.length"
        @click="onBuild()"
        @command="onBuild"
      >
        <span class="drawer__build"><el-icon><Box /></el-icon>打包</span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="s in project.scripts.build"
              :key="s"
              :command="s"
              :class="{ 'is-current': s === project.scripts.defaultBuild }"
            >
              {{ s }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-button
        size="small"
        :icon="Download"
        :loading="status === 'installing'"
        :disabled="isBusy || isRunning || !pathValid || !!project.manageOnly"
        @click="store.install(project.id)"
      >
        安装依赖
      </el-button>
    </div>
  </template>
</template>

<style scoped>
/* ---------- 头部 ---------- */
.drawer__head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
}

.drawer__identity {
  min-width: 0;
  flex: 1;
}

.drawer__name {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.drawer__path {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.drawer__status {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-3);
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: var(--r-pill);
  font-size: var(--fs-meta);
  font-weight: 500;
  background: var(--st-idle-soft);
  color: var(--ink-3);
}

.pill__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentcolor;
}

.pill.tone-run {
  background: var(--st-run-soft);
  color: var(--st-run);
}

.pill.tone-ok {
  background: var(--st-ok-soft);
  color: var(--st-ok);
}

.pill.tone-fail {
  background: var(--st-fail-soft);
  color: var(--st-fail);
}

.drawer__pid {
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.drawer__reveal {
  margin-left: auto;
}

.drawer__actions {
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-4);
  border-bottom: 1px solid var(--border);
}

/* 「仅管理目录」的说明条：把原因讲清楚，别让用户对着灰按钮猜 */
.drawer__notice {
  margin: 0 var(--sp-4) var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--st-run);
  border-radius: var(--r-sm);
  background: var(--st-run-soft);
  font-size: var(--fs-meta);
  line-height: 1.7;
  color: var(--ink-2);
}

.drawer__build {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.icon-btn {
  width: 28px;
  padding: 0;
  flex-shrink: 0;
}
</style>
