<script setup lang="ts">
/**
 * 首页卡片网格下面的工作台面板。
 *
 * 卡片网格下面是整块空画布，项目少的时候尤其明显。这四块面板把剩下的高度接住：
 * 系统状态 / 最近使用 / 最近执行 / 快捷操作。列表顶在面板上沿、动作贴在下沿，
 * 窗口越高面板只是越舒展，不会出现半张空卡片。
 */
import { computed } from 'vue'
import { FolderOpened, Plus } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import { buildHints } from '@/hints'
import type { Project, ProjectStatus, RunRecord } from '@/types'

const store = useProjectsStore()

/** 状态 → 灯色，与卡片上的状态灯带保持一致 */
const TONE: Record<ProjectStatus, string> = {
  idle: 'idle',
  installing: 'run',
  running: 'run',
  building: 'run',
  success: 'ok',
  failed: 'fail'
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  idle: '空闲',
  installing: '安装中',
  running: '运行中',
  building: '打包中',
  success: '打包成功',
  failed: '执行失败'
}

const RESULT_META: Record<RunRecord['result'], { label: string; tone: string }> = {
  success: { label: '成功', tone: 'ok' },
  failed: { label: '失败', tone: 'fail' },
  stopped: { label: '已停止', tone: 'idle' }
}

const managers = [
  { key: 'npm', label: 'npm' },
  { key: 'pnpm', label: 'pnpm' },
  { key: 'yarn', label: 'yarn' }
] as const

/** 面板高度有限，列表都截断到一屏左右：最近使用 5 条刚好铺满最矮的面板，不会半行悬在边上 */
const RECENT_LIMIT = 5
const RUN_LIMIT = 8

function statusOf(project: Project): ProjectStatus {
  return store.runtimeOf(project.id).status
}

function toneOf(project: Project): string {
  return store.isPathValid(project.id) ? TONE[statusOf(project)] : 'fail'
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

/**
 * 一行小字说清这个项目现在什么情况：跑着就显示端口，没跑就显示上次用到什么时候。
 *
 * 不塞包管理器与框架名——窗口最小宽度下每栏只有 250px 左右，项目名要留位置，
 * 那两项在卡片上已经有了。
 */
function metaOf(project: Project): string {
  const port = store.runtimeOf(project.id).port
  return port ? `:${port}` : relativeTime(project.lastUsedAt)
}

/** 最近使用的时间要跟着秒针走，所以读 store.clock（它每秒跳一次） */
function relativeTime(timestamp?: number): string {
  if (!timestamp) return '未使用过'

  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const diff = Math.max(0, store.clock - timestamp)

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  return `${Math.floor(diff / (30 * day))} 个月前`
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDuration(ms?: number): string {
  return ms ? `${(ms / 1000).toFixed(1)}s` : '—'
}

const stats = computed(() => {
  const list = [
    { label: '项目', value: store.projects.length, tone: 'idle' },
    { label: '分组', value: store.groups.length, tone: 'idle' },
    { label: '运行中', value: store.runningCount, tone: store.runningCount ? 'run' : 'idle' }
  ]
  const invalid = store.projects.filter((p) => !store.isPathValid(p.id)).length
  // 只在真有问题时占一格，平时不占位置
  if (invalid) list.push({ label: '路径失效', value: invalid, tone: 'fail' })
  return list
})

const recent = computed(() =>
  store.projects
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, RECENT_LIMIT)
)

/** 所有项目的执行记录按时间倒序，取最近几条 */
const runs = computed(() => {
  const list: Array<{ key: string; project: Project; record: RunRecord }> = []
  for (const project of store.projects) {
    for (const record of project.history ?? []) {
      list.push({ key: `${project.id}:${record.id}`, project, record })
    }
  }
  return list.sort((a, b) => b.record.startedAt - a.record.startedAt).slice(0, RUN_LIMIT)
})

const nodeVersion = computed(() => store.packageManagers?.node || '未检测到')
const dataDir = computed(() => store.dataLocation?.dir ?? '')

const nvmLabel = computed(() => {
  const nvm = store.nvm
  if (!nvm?.available) return '未检测到'
  return nvm.current
    ? `已装 ${nvm.versions.length} 个 · 当前 ${nvm.current}`
    : `已装 ${nvm.versions.length} 个版本`
})

const hints = computed(() => buildHints(store.settings))
</script>

<template>
  <section class="panels">
    <!-- 系统状态 -->
    <article class="panel">
      <header class="panel__head">
        <span class="eyebrow">系统状态</span>
      </header>

      <div class="stats">
        <div v-for="s in stats" :key="s.label" class="stat">
          <b class="stat__value mono" :class="`tone-${s.tone}`">{{ s.value }}</b>
          <span class="stat__label">{{ s.label }}</span>
        </div>
      </div>

      <dl class="facts">
        <div class="fact">
          <dt>node</dt>
          <dd class="mono">{{ nodeVersion }}</dd>
        </div>
        <div class="fact">
          <dt>包管理器</dt>
          <dd class="pms">
            <span
              v-for="m in managers"
              :key="m.key"
              class="pm"
              :title="store.packageManagers?.[m.key] ? `${m.label} 可用` : `${m.label} 未安装`"
            >
              <i
                class="pm__dot"
                :class="store.packageManagers?.[m.key] ? 'is-ok' : 'is-off'"
                aria-hidden="true"
              />
              {{ m.label }}
            </span>
          </dd>
        </div>
        <div class="fact">
          <dt>nvm</dt>
          <dd class="mono">{{ nvmLabel }}</dd>
        </div>
      </dl>

      <div class="panel__foot">
        <el-icon class="foot__icon"><FolderOpened /></el-icon>
        <span class="foot__path mono truncate" :title="dataDir">{{ dataDir || '—' }}</span>
        <button v-if="dataDir" class="panel__link" type="button" @click="store.reveal(dataDir)">
          打开
        </button>
      </div>
    </article>

    <!-- 最近使用 -->
    <article class="panel">
      <header class="panel__head">
        <span class="eyebrow">最近使用</span>
        <span class="panel__count mono">{{ recent.length }}</span>
      </header>

      <ul class="rows">
        <li v-for="project in recent" :key="project.id">
          <!-- 整行可点开详情；项目名是个真按钮，键盘 Tab 也能到（Enter 合成的 click 会冒泡上来） -->
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
              {{ STATUS_LABEL[statusOf(project)] }}
            </span>
          </div>
        </li>
      </ul>

      <button class="add-row" type="button" @click="store.addDialogVisible = true">
        <el-icon><Plus /></el-icon>
        添加项目
      </button>
    </article>

    <!-- 最近执行 -->
    <article class="panel">
      <header class="panel__head">
        <span class="eyebrow">最近执行</span>
        <span v-if="runs.length" class="panel__count mono">{{ runs.length }}</span>
      </header>

      <ul v-if="runs.length" class="rows">
        <li v-for="item in runs" :key="item.key" class="run">
          <div class="run__line">
            <span class="run__result" :class="`tone-${RESULT_META[item.record.result].tone}`">
              {{ RESULT_META[item.record.result].label }}
            </span>
            <span class="run__name truncate" :title="item.project.name">{{ item.project.name }}</span>
            <span class="run__time mono">{{ formatTime(item.record.startedAt) }}</span>
          </div>
          <div class="run__line">
            <span class="run__cmd mono truncate" :title="item.record.command">
              {{ item.record.command }}
            </span>
            <span class="run__time mono">{{ formatDuration(item.record.durationMs) }}</span>
          </div>
        </li>
      </ul>

      <div v-else class="panel__empty">
        <span>还没有执行记录</span>
        <span>启动或打包一次，最近 8 条会留在这里。</span>
      </div>
    </article>

    <!-- 快捷操作 -->
    <article class="panel">
      <header class="panel__head">
        <span class="eyebrow">快捷操作</span>
      </header>

      <ul class="tips">
        <li v-for="item in hints" :key="item.text" class="tip">
          <span class="tip__text truncate" :title="item.text">{{ item.text }}</span>
          <kbd class="tip__key mono">{{ item.hint }}</kbd>
        </li>
      </ul>

      <p class="tips__note">主题、托盘、开机自启在右上角的设置里。</p>
    </article>
  </section>
</template>

<style scoped>
.panels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(266px, 1fr));
  /* 行高把剩余空间吃满；内容再多也不会压到 264px 以下，超出的部分由外层滚动 */
  grid-auto-rows: minmax(264px, 1fr);
  gap: 14px;
  flex: 1 1 auto;
  min-height: 264px;
  /* 屏幕再高也不让面板无限长高，否则四块面板会变成四根空柱子 */
  max-height: 720px;
}

/* 高窗口里四栏并排会拉成四根细高的空柱子，改成两栏两行（1080p 最大化后就会走到这里） */
@media (min-height: 880px) {
  .panels {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.panel__count {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* ---------- 统计格 ---------- */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(62px, 1fr));
  gap: var(--sp-2);
  flex-shrink: 0;
}

.stat {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
}

.stat__value {
  display: block;
  font-size: var(--fs-display);
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.stat__value.tone-run {
  color: var(--st-run);
}

.stat__value.tone-fail {
  color: var(--st-fail);
}

.stat__label {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* ---------- 系统状态面板的私有部分（明细行与包管理器点见全局 .facts / .pms） ---------- */
.foot__icon {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ink-3);
}

.foot__path {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* ---------- 列表 ---------- */
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
  padding: 5px 6px;
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

/* ---------- 最近执行 ---------- */
.run {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 6px;
  border-radius: var(--r-sm);
}

.run + .run {
  border-top: 1px solid var(--border);
  border-radius: 0;
}

.run__line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.run__result {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--r-pill);
  background: var(--st-idle-soft);
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-weight: 600;
  line-height: 16px;
}

.run__result.tone-ok {
  background: var(--st-ok-soft);
  color: var(--st-ok);
}

.run__result.tone-fail {
  background: var(--st-fail-soft);
  color: var(--st-fail);
}

.run__name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--ink);
}

.run__cmd {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.run__time {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* ---------- 快捷操作面板的私有部分（提示行本体见全局 .tips / .tip） ---------- */
.tips__note {
  margin-top: auto;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* ---------- 幽灵行：加项目 ---------- */
.add-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex-shrink: 0;
  margin-top: auto;
  height: 30px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--ink-3);
  font-size: var(--fs-meta);
  cursor: pointer;
  transition: border-color 0.18s ease, color 0.18s ease;
}

.add-row:hover {
  border-color: var(--ink);
  color: var(--ink);
}
</style>
