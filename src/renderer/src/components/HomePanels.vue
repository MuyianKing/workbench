<script setup lang="ts">
/**
 * 首页卡片网格旁边的工作台面板。
 *
 * 卡片网格之外是整块空画布，项目少的时候尤其明显。这几块面板把剩下的空间接住：
 * 系统状态 / 最近使用 / 快捷操作。列表顶在面板上沿、动作贴在下沿，
 * 窗口越高面板只是越舒展，不会出现半张空卡片。
 */
import { computed } from 'vue'
import { FolderOpened } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import { buildHints } from '@/hints'
import ActivityGraph from '@/components/ActivityGraph.vue'
import type { Project, ProjectStatus } from '@/types'

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

const managers = [
  { key: 'npm', label: 'npm' },
  { key: 'pnpm', label: 'pnpm' },
  { key: 'yarn', label: 'yarn' }
] as const

/** 面板高度有限，列表截断到一屏左右：5 条刚好铺满最矮的面板，不会半行悬在边上 */
const RECENT_LIMIT = 5

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

const recent = computed(() =>
  store.projects
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, RECENT_LIMIT)
)

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
    <!-- 活跃度：53 列要横着铺满一整行，塞不进下面那些窄面板 -->
    <ActivityGraph class="panel--wide" />

    <!-- 系统状态 -->
    <article class="panel">
      <header class="panel__head">
        <span class="eyebrow">系统状态</span>
      </header>

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
  /* 侧栏就一条窄栏那么宽：面板只能竖着叠，活跃度图跨满整列（.panel--wide） */
  grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: auto;
  gap: 14px;
  min-height: 0;
}

/* 活跃度图始终占满整列——它需要整宽来铺一年 53 周 */
.panel--wide {
  grid-column: 1 / -1;
}

.panel__count {
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
  /* 没有按钮那圈边框，就不用再为它留内缩，右缘才和右上角计数齐平 */
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

/* ---------- 快捷操作面板的私有部分（提示行本体见全局 .tips / .tip） ---------- */
.tips__note {
  /**
   * 说明是列表的补充，但它的字号只比行文字小 1.5px，光靠字号差和 12px 的
   * 面板 gap 分不出层次：最后一条提示会跟它黏成一坨。
   * 用一条实线把它划到列表外面——行间是虚线，说明用实线，读起来是"列表到此为止"。
   *
   * 负上距抵消面板 gap 后只留 4px，线紧贴在最后一条提示下面（不抵消会被
   * 12px 的 gap 推到说明头上，看着像说明的边框）；上内距 10px 顶开说明，
   * 下面不留内距——说明贴着面板自己的 --sp-4 下边距收尾就行。
   */
  margin-top: calc(var(--sp-3) * -1 + 4px);
  padding: calc(var(--sp-2) + 2px) 0 0;
  border-top: 1px solid var(--border);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}
</style>
