<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Box,
  Download,
  MoreFilled,
  Refresh,
  Search,
  VideoPause,
  VideoPlay
} from '@element-plus/icons-vue'
import { DRAG_MIME } from '@/drag-mime'
import { formatClock, formatDurationMs } from '@/format'
import { sanitizeProjectColor, projectColorVar } from '@shared/project-color'
import { statusMeta, isBusyStatus } from '@/status'
import { useProjectsStore } from '@/stores/projects'
import { useTerminalStore } from '@/stores/terminal'
import type { Project, ProjectStatus } from '@/types'

const props = defineProps<{
  project: Project
}>()
const store = useProjectsStore()
const terminal = useTerminalStore()

const runtime = computed(() => terminal.runtimeOf(props.project.id))
const status = computed<ProjectStatus>(() => runtime.value?.status ?? 'idle')
const pathValid = computed(() => store.isPathValid(props.project.id))
/** 目录失效优先于运行态展示，避免对着一张点了必然失败的卡片操作 */
const meta = computed(() =>
  pathValid.value
    ? statusMeta(status.value, runtime.value?.kind)
    : { label: '路径无效', tone: 'fail' }
)
const pm = computed(() => store.resolvedPm(props.project))
const isBusy = computed(() => isBusyStatus(status.value))
const isRunning = computed(() => status.value === 'running')

/**
 * 项目标识色（在抽屉里选、新项目自动分配）。
 * 缺省时退回中性灰：老数据、手改坏的值都不该让卡片上出现一个空白的圆点。
 */
const colorVar = computed(() => {
  const color = sanitizeProjectColor(props.project.color)
  return color ? projectColorVar(color) : 'var(--border-strong)'
})

/** 运行 / 打包中显示已运行时长，命令结束后显示本次耗时 */
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
    return formatDurationMs(rt.durationMs)
  }
  return ''
})

/** 结束（正常退出）后给的才是本次总耗时，跑着的给的是还在走的那段 */
const elapsedLabel = computed(() => (status.value === 'success' ? '耗时' : '已运行'))

function open(): void {
  store.openDrawer(props.project.id)
}

function onBuild(script?: unknown): void {
  void store.build(props.project.id, typeof script === 'string' ? script : undefined)
}

function restart(): void {
  void store.restart(props.project.id)
}

/** 检测进行中：按钮转圈，避免连点重复探测 */
const detecting = ref(false)

/** 按监听端口判断项目是否已经跑着（可能是 Workbench 之外启动的） */
async function detect(): Promise<void> {
  detecting.value = true
  try {
    await store.detect(props.project.id)
  } finally {
    detecting.value = false
  }
}

/** 拖到筛选栏的分组标签上即可完成归类（场景 S7） */
function onDragStart(event: DragEvent): void {
  if (!event.dataTransfer) return
  event.dataTransfer.setData(DRAG_MIME.project, props.project.id)
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
  else if (command === 'vscode') void store.openInVSCode(props.project.path)
  else if (command === 'relocate') void store.relocate(id)
  else if (command === 'drawer') store.openDrawer(id)
  // 确认框在 store 里（项目卡与详情抽屉共用同一句）
  else if (command === 'remove') void store.removeProject(id)
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
      <!-- 标识色：项目之间一眼分得出来（左侧那条灯带留给运行状态，两者不能混） -->
      <i class="card__color" :style="{ background: colorVar }" aria-hidden="true" />
      <h3 class="card__name truncate" :title="project.name">{{ project.name }}</h3>
      <span
        class="state"
        :title="runtime?.external ? '由 Workbench 之外启动的服务' : undefined"
      >
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
      <!-- 安装 / 打包进行中也给一个停止入口，否则长命令卡住时只能干等 -->
      <el-button
        v-else-if="isBusy"
        size="small"
        :icon="VideoPause"
        @click="store.stop(project.id)"
      >
        停止
      </el-button>
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

      <!-- 只有一条打包命令时下拉没有意义，直接一个按钮；多条才给 split-button 切换。
           两种形态共用同一个 .build-label，保证外观一致，也跟详情页的打包按钮对齐 -->
      <el-button
        v-if="project.scripts.build.length <= 1"
        class="build-btn"
        size="small"
        :disabled="isBusy || !pathValid || !project.scripts.build.length"
        @click="onBuild()"
      >
        <span class="build-label"><el-icon><Box /></el-icon>打包</span>
      </el-button>

      <el-dropdown
        v-else
        class="build-split"
        split-button
        size="small"
        :disabled="isBusy || !pathValid || !project.scripts.build.length"
        @click="onBuild()"
        @command="onBuild"
      >
        <span class="build-label"><el-icon><Box /></el-icon>打包</span>
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

      <el-tooltip
        content="检测运行状态（按监听端口判断项目是否已启动）"
        placement="top"
        :show-after="400"
      >
        <el-button
          class="icon-btn"
          size="small"
          :icon="Search"
          :loading="detecting"
          aria-label="检测运行状态"
          @click="detect"
        />
      </el-tooltip>

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
            <el-dropdown-item v-if="pathValid" command="vscode">在 VS Code 中打开</el-dropdown-item>
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
  /* 行间距 9px（不是 --sp-2 的 8）：与下面三处字号一起把卡片自然高度定在 155px，
     六块卡片同高、网格各行高度一致；改字号时记得同步看这里。
     min-height 与「添加项目」幽灵卡共用同一个令牌，两边不会各自漂移 */
  gap: 9px;
  min-height: var(--h-project-card);
  padding: var(--sp-3) var(--sp-4) var(--sp-3) calc(var(--sp-4) + 3px);
  /* 与 .panel（global.css）同一条规则：底色浓度跟着设置里的「卡片不透明度」走 */
  background: rgba(var(--bg-surface-rgb), var(--card-alpha, 1));
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

/**
 * 项目标识色的小圆点。
 * 8px 与状态胶囊里那个点（5px）不是一个量级：那个说的是「现在在跑」，这个说的是「这是哪个项目」。
 */
.card__color {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.card__name {
  flex: 1;
  /* 项目名比通用标题大 1px：卡片高度的定高组合之一（见 .card 的 gap 注释） */
  font-size: 16px;
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
  /* 路径用正文字号（--fs-body 13px）：定高组合之一（见 .card 的 gap 注释） */
  font-size: var(--fs-body);
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
  /* 宽卡片一行放得下，窄卡片（首页「最近使用」里那些）就整项换行，别把字挤没 */
  flex-wrap: wrap;
  gap: var(--sp-2);
  /* 介于正文与 micro 之间：比路径小半档，又比原来的 10.5px 易读（定高组合之一） */
  font-size: 11.5px;
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
  /**
   * 一行放不下就整颗控件换行，绝不被压窄（压窄的后果见下面 .card__actions > *）。
   * 项目页的卡片永远够宽（网格下限 302px），这条是给嵌在别处的窄卡片兜底的 ——
   * 首页「最近使用」面板里那些只有两百多像素，栏宽再拖窄一点就放不下了。
   */
  flex-wrap: wrap;
  /* 比 --sp-1 再省 1px：运行态这排有 6 个控件，要放进最窄（302px）的卡片 */
  gap: 3px;
  margin-top: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}

/*
 * 运行态这排有 6 个控件，放到最窄的卡片（网格下限 302px）刚好占满。
 * 不许挤：拆分按钮被压窄后，Element Plus 的按钮组会换行，把「打包」叠成上下两块。
 */
.card__actions > * {
  flex-shrink: 0;
}

/**
 * 打包按钮保持中性（Element Plus 默认样式），和详情页的打包按钮一致。
 * 界面是灰度的，彩色只表达运行状态；绿色是「打包成功」的状态色，不能同时当常驻的操作按钮用，
 * 否则同一块绿在不同位置有两种含义，也抢掉实心黑「启动」的主操作位置。
 *
 * 单条命令时是普通按钮（.build-btn），多条时是 split-button（.build-split），
 * 两种形态要长得一样，所以选择器写在一起。
 */

/* Element Plus 把箭头按钮写死成 32px 宽，收到和其它图标按钮一样的 24px */
.build-split :deep(.el-dropdown__caret-button) {
  width: 24px;
  padding-left: 0;
  padding-right: 0;
}

/* 图标和文字用 flex 排，间距跟详情页的打包按钮一致（5px） */
.build-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.icon-btn {
  width: 24px;
  padding: 0;
}

.more {
  margin-left: auto;
}
</style>
