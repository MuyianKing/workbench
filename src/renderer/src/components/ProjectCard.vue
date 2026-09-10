<script setup lang="ts">
import { computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Download, MoreFilled, Refresh, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import type { Project, ProjectStatus } from '@/types'

const props = defineProps<{ project: Project }>()
const store = useProjectsStore()

const META: Record<ProjectStatus, { label: string; tone: string }> = {
  idle: { label: '空闲', tone: 'idle' },
  installing: { label: '安装中', tone: 'run' },
  running: { label: '运行中', tone: 'run' },
  building: { label: '打包中', tone: 'run' },
  success: { label: '打包成功', tone: 'ok' },
  failed: { label: '执行失败', tone: 'fail' }
}

const runtime = computed(() => store.runtimeOf(props.project.id))
const status = computed<ProjectStatus>(() => runtime.value?.status ?? 'idle')
const pathValid = computed(() => store.isPathValid(props.project.id))
/** 目录失效优先于运行态展示，避免对着一张点了必然失败的卡片操作 */
const meta = computed(() =>
  pathValid.value ? META[status.value] : { label: '路径无效', tone: 'fail' }
)
const pm = computed(() => store.resolvedPm(props.project))
const isBusy = computed(() => status.value === 'installing' || status.value === 'building')
const isRunning = computed(() => status.value === 'running')

/** 运行中显示已运行时长，打包成功显示本次耗时 */
const elapsed = computed(() => {
  const rt = runtime.value
  if (!rt) return ''
  if (status.value === 'running' && rt.startedAt) {
    return formatClock(store.clock - rt.startedAt)
  }
  if (status.value === 'building' && rt.startedAt) {
    return formatClock(store.clock - rt.startedAt)
  }
  if (status.value === 'success' && rt.durationMs) {
    return `${(rt.durationMs / 1000).toFixed(1)}s`
  }
  return ''
})

const elapsedLabel = computed(() => (status.value === 'success' ? '耗时' : '已运行'))

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function open(): void {
  store.openDrawer(props.project.id)
}

function onBuild(script?: unknown): void {
  void store.build(props.project.id, typeof script === 'string' ? script : undefined)
}

function restart(): void {
  void store.restart(props.project.id)
}

/** 拖到筛选栏的分组标签上即可完成归类（场景 S7） */
function onDragStart(event: DragEvent): void {
  if (!event.dataTransfer) return
  event.dataTransfer.setData('application/x-workbench-project', props.project.id)
  event.dataTransfer.setData('text/plain', props.project.id)
  event.dataTransfer.effectAllowed = 'move'
}

function onMore(command: string): void {
  const id = props.project.id

  if (command.startsWith('custom:')) {
    void store.runCustom(id, Number(command.slice('custom:'.length)))
    return
  }

  if (command === 'reveal') void store.reveal(props.project.path)
  else if (command === 'relocate') void store.relocate(id)
  else if (command === 'drawer') store.openDrawer(id)
  else if (command === 'remove') {
    void ElMessageBox.confirm(
      `确定把「${props.project.name}」从列表中移除？磁盘上的项目文件不会被删除。`,
      '移除项目',
      { confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning' }
    )
      .then(() => store.removeProject(id))
      .catch(() => undefined)
  }
}
</script>

<template>
  <article
    class="card"
    :class="[`tone-${meta.tone}`, { 'is-busy': isBusy }]"
    role="button"
    tabindex="0"
    draggable="true"
    @click="open"
    @keydown.enter.prevent="open"
    @keydown.space.prevent="open"
    @dragstart="onDragStart"
  >
    <span class="card__rail" aria-hidden="true" />

    <div class="card__head">
      <h3 class="card__name truncate" :title="project.name">{{ project.name }}</h3>
      <span class="state">
        <i class="state__dot" />
        {{ meta.label }}
      </span>
    </div>

    <div class="card__sub">
      <span class="card__path mono truncate" :title="project.path">{{ project.path }}</span>
      <span v-if="elapsed" class="card__elapsed mono">
        {{ elapsedLabel }} <b>{{ elapsed }}</b>
      </span>
    </div>

    <ul class="card__meta mono">
      <li>{{ pm }}</li>
      <li v-if="project.nodeVersion" class="card__node">node {{ project.nodeVersion }}</li>
      <li v-if="runtime?.port">:{{ runtime.port }}</li>
      <li v-if="project.manageOnly" class="card__flag">仅管理目录</li>
    </ul>

    <footer class="card__actions" @click.stop>
      <template v-if="isRunning">
        <el-button size="small" :icon="VideoPause" @click="store.stop(project.id)">停止</el-button>
        <el-tooltip content="重启" placement="top" :show-after="400">
          <el-button
            class="icon-btn"
            size="small"
            :icon="Refresh"
            aria-label="重启"
            @click="restart"
          />
        </el-tooltip>
      </template>
      <el-tooltip
        v-else
        :content="project.scripts.serve ? '启动开发服务' : '未配置启动命令'"
        placement="top"
        :show-after="400"
      >
        <el-button
          type="primary"
          size="small"
          :icon="VideoPlay"
          :disabled="isBusy || !pathValid || !project.scripts.serve"
          @click="store.start(project.id)"
        >
          启动
        </el-button>
      </el-tooltip>

      <el-dropdown
        split-button
        size="small"
        :disabled="isBusy || !pathValid || !project.scripts.build.length"
        @click="onBuild()"
        @command="onBuild"
      >
        打包
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

      <el-tooltip content="安装依赖" placement="top" :show-after="400">
        <el-button
          class="icon-btn"
          size="small"
          :icon="Download"
          :loading="status === 'installing'"
          :disabled="isBusy || isRunning || !pathValid || !!project.manageOnly"
          aria-label="安装依赖"
          @click="store.install(project.id)"
        />
      </el-tooltip>

      <el-dropdown
        trigger="click"
        placement="top-end"
        class="more"
        @command="onMore"
      >
        <el-button
          class="icon-btn icon-btn--end"
          size="small"
          :icon="MoreFilled"
          aria-label="更多"
          @click.stop
        />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="drawer">查看详情</el-dropdown-item>
            <el-dropdown-item v-if="pathValid" command="reveal">打开项目目录</el-dropdown-item>
            <el-dropdown-item v-else command="relocate">重新定位…</el-dropdown-item>
            <template v-if="project.scripts.custom?.length">
              <el-dropdown-item
                v-for="(item, index) in project.scripts.custom"
                :key="`${item.name}-${index}`"
                :command="`custom:${index}`"
                :disabled="isBusy || isRunning || !pathValid || !!project.manageOnly"
                divided
              >
                运行 {{ item.name }}
              </el-dropdown-item>
            </template>
            <el-dropdown-item command="remove" divided>从列表中移除</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </footer>
  </article>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4) var(--sp-3) calc(var(--sp-4) + 3px);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  overflow: hidden;
  transition: box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}

.card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-hover);
  transform: translateY(-1px);
}

.card:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.card.is-busy {
  cursor: default;
}

/* ---------- 状态灯带（本设计的标志性元素） ---------- */
.card__rail {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--st-idle);
  opacity: 0.35;
}

.tone-run .card__rail {
  background: var(--st-run);
  opacity: 1;
}

.tone-ok .card__rail {
  background: var(--st-ok);
  opacity: 1;
}

.tone-fail .card__rail {
  background: var(--st-fail);
  opacity: 1;
}

.tone-run .card__rail::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent, #fff8, transparent);
  animation: rail-sweep 2.4s linear infinite;
}

@keyframes rail-sweep {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: translateY(100%);
  }
}

/* ---------- 头部 ---------- */
.card__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.card__name {
  flex: 1;
  font-size: var(--fs-title);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  font-size: var(--fs-micro);
  font-weight: 500;
  background: var(--st-idle-soft);
  color: var(--ink-3);
}

.state__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentcolor;
}

.tone-run .state {
  background: var(--st-run-soft);
  color: var(--st-run);
}

.tone-ok .state {
  background: var(--st-ok-soft);
  color: var(--st-ok);
}

.tone-fail .state {
  background: var(--st-fail-soft);
  color: var(--st-fail);
}

.tone-run .state__dot {
  animation: dot-pulse 1.4s ease-in-out infinite;
}

@keyframes dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

/* ---------- 路径与时长 ---------- */
.card__sub {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.card__path {
  flex: 1;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.card__elapsed {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.card__elapsed b {
  font-weight: 600;
  color: var(--ink-2);
}

.tone-run .card__elapsed b {
  color: var(--st-run);
}

/* ---------- 元信息 ---------- */
.card__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-micro);
  color: var(--ink-3);
  padding-top: var(--sp-1);
}

.card__meta li + li::before {
  content: '·';
  margin-right: var(--sp-2);
  color: var(--border-strong);
}

/* 「仅管理目录」在元信息里点一下色，说明这张卡为什么按钮全是灰的 */
.card__flag {
  color: var(--st-run);
  font-weight: 600;
}

/* 项目级 Node 版本：非默认行为，值得比其它元信息重一点 */
.card__node {
  color: var(--ink-2);
  font-weight: 600;
}

/* ---------- 操作区 ---------- */
.card__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-top: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}

.icon-btn {
  width: 28px;
  padding: 0;
}

.more {
  margin-left: auto;
}
</style>
