<script setup lang="ts">
/**
 * 首页「最近使用」卡片：按 lastUsedAt 排出的最近几个项目。
 *
 * 一行小字说清这个项目现在什么情况：跑着就显示端口，没跑就显示上次用到什么时候。
 * 项目一个都没有时给一句空状态，免得卡片里是一片空白。
 */
import { computed } from 'vue'
import { formatRelative } from '@/format'
import { STATUS_META, statusLabel } from '@/status'
import { useProjectsStore } from '@/stores/projects'
import type { Project, ProjectStatus } from '@/types'

const store = useProjectsStore()

/** 卡片高度有限，列表截断到一屏左右 */
const RECENT_LIMIT = 5

function statusOf(project: Project): ProjectStatus {
  return store.runtimeOf(project.id).status
}

function toneOf(project: Project): string {
  return store.isPathValid(project.id) ? STATUS_META[statusOf(project)].tone : 'fail'
}

function isRunning(project: Project): boolean {
  return statusOf(project) === 'running'
}

function canStart(project: Project): boolean {
  return statusOf(project) === 'idle' && store.isPathValid(project.id) && !!project.scripts.serve
}

/** 启动按钮为什么是灰的，鼠标停上去能看到原因 */
function startHint(project: Project): string {
  if (!store.isPathValid(project.id)) return '项目目录不存在，先重新定位'
  if (!project.scripts.serve) return '未配置启动命令'
  return '启动开发服务'
}

function metaOf(project: Project): string {
  const port = store.runtimeOf(project.id).port
  // 最近使用的时间要跟着秒针走，所以传 store.clock（它每秒跳一次）
  return port ? `:${port}` : formatRelative(project.lastUsedAt, store.clock)
}

const recent = computed(() =>
  store.projects
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, RECENT_LIMIT)
)
</script>

<template>
  <article class="panel">
    <header class="panel__head">
      <span class="eyebrow">最近使用</span>
      <span class="panel__count mono">{{ recent.length }}</span>
    </header>

    <ul v-if="recent.length" class="rows">
      <li v-for="project in recent" :key="project.id">
        <!-- 整行可点开详情；项目名是个真按钮，键盘 Tab 也能到 -->
        <div class="row" @click="store.openDrawer(project.id)">
          <i class="dot" :class="`tone-${toneOf(project)}`" aria-hidden="true" />
          <button class="row__name truncate" type="button" :title="project.path">
            {{ project.name }}
          </button>
          <span class="row__meta mono truncate">{{ metaOf(project) }}</span>

          <button
            v-if="isRunning(project)"
            class="row__act"
            type="button"
            @click.stop="store.stop(project.id)"
          >
            停止
          </button>
          <button
            v-else-if="statusOf(project) === 'idle'"
            class="row__act"
            type="button"
            :title="startHint(project)"
            :disabled="!canStart(project)"
            @click.stop="store.start(project.id)"
          >
            启动
          </button>
          <span v-else class="row__act is-static" :class="`tone-${toneOf(project)}`">
            {{ statusLabel(statusOf(project)) }}
          </span>
        </div>
      </li>
    </ul>

    <p v-else class="panel__empty">还没有项目<br />添加一个项目后，最近用过的会排在这里。</p>
  </article>
</template>

<style scoped>
.panel__count {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  /* 只留上下：左右缩进会让整行和面板标题、右上角计数对不齐 */
  padding: 5px 0;
  border-radius: var(--r-sm);
  cursor: pointer;
}

.row:hover {
  background: var(--bg-subtle);
}

.dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--st-idle);
}

.dot.tone-run {
  background: var(--st-run);
}

.dot.tone-ok {
  background: var(--st-ok);
}

.dot.tone-fail {
  background: var(--st-fail);
}

.row__name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  font-family: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--ink);
  cursor: pointer;
}

.row__meta {
  flex-shrink: 1;
  max-width: 46%;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.row__act {
  /* 按钮和状态文字共用这个盒子：自己居中，别指望 <button> 的默认行为 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-surface);
  color: var(--ink-2);
  font-size: var(--fs-micro);
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.row__act:hover:not(:disabled) {
  border-color: var(--ink);
  color: var(--ink);
}

.row__act:disabled {
  cursor: default;
  opacity: 0.45;
}

/* 不能点的时候它就是一句状态文字，按状态上色（和卡片的状态灯一个语义） */
.row__act.is-static {
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--ink-3);
}

.row__act.is-static.tone-run {
  color: var(--st-run);
}

.row__act.is-static.tone-ok {
  color: var(--st-ok);
}

.row__act.is-static.tone-fail {
  color: var(--st-fail);
}
</style>
