<script setup lang="ts">
/**
 * 工作页：按天分组的工作日志时间轴。
 *
 * 与其它页面一样，它是导航栏上的一项（见 shared/views.ts），换页由 App.vue 的
 * `<KeepAlive><component :is>` 负责 —— 所以这一页在离开时会留在内存里，滚动位置与
 * 展开状态都不会丢；数据也不会因为切走再回来而重读。
 *
 * 数据住在本机的 `work-log.json`（**不进同步仓库**，见 shared/work-log.ts）。
 * 时间的最小刻度是「天」：一天可以有多条记录，所以分页按**天**走 ——
 * 一天里的几条不该被翻页切成两半。范围、分组、分页都是 shared 里的纯函数，
 * 这一层只做取数与交互。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Plus } from '@element-plus/icons-vue'
import { addDays, dayKey } from '@shared/activity'
import { markdownToPlainText } from '@shared/markdown'
import { projectColorVar, sanitizeProjectColor, type ProjectColor } from '@shared/project-color'
import {
  DELETED_PROJECT_ID,
  WORK_PAGE_DAYS,
  WORK_RANGES,
  WORK_RANGE_LABELS,
  WORK_SORTS,
  WORK_SORT_LABELS,
  WORK_STATUS_LABELS,
  dayMeta,
  groupByProject,
  isWorkSort,
  paginate,
  timelineOf,
  toggleWorkLogStatus,
  type WorkLogEntry,
  type WorkRange,
  type WorkSort
} from '@shared/work-log'
import { useProjectsStore } from '@/stores/projects'
import WorkLogCard from '@/components/WorkLogCard.vue'
import WorkLogDialog from '@/components/WorkLogDialog.vue'

const store = useProjectsStore()

const entries = ref<WorkLogEntry[]>([])
const loading = ref(true)
/** 读盘失败与「一条都还没写过」是两回事，不能都显示成空列表 */
const loadError = ref('')
const range = ref<WorkRange>('today')
/** 排序维度：按时间（天为轴）或按项目（项目为轴） */
const sort = ref<WorkSort>('time')
/** 只看待办：把已完成的筛掉（默认关） */
const todoOnly = ref(false)
const page = ref(1)
/** 当前时刻：决定「今天 / 本周 / 本月」的边界，也决定时间轴上的「今天」标记 */
const now = ref(Date.now())
const dialogVisible = ref(false)
const editing = ref<WorkLogEntry | null>(null)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const result = await window.workbench.listWorkLogs()
    if (result.ok && result.data) entries.value = result.data
    else loadError.value = result.error ?? '读取工作日志失败'
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '读取工作日志失败'
  } finally {
    loading.value = false
    now.value = Date.now()
  }
}

/**
 * 跨过午夜时把「现在」往后推一格：停在应用里过夜之后，
 * 「今天」那一档与分组上的相对说法都得跟着走到新的一天。
 */
let timer: number | null = null

onMounted(() => {
  void load()
  timer = window.setInterval(() => {
    const next = Date.now()
    if (dayKey(next) !== dayKey(now.value)) now.value = next
  }, 60_000)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

/**
 * 当前维度下的分组（时间 = 一天一栏，项目 = 一个项目一栏），再按页大小切开。
 *
 * 两种维度共用同一套分页：页大小还是「7」，只是单位从天变成项目 ——
 * 项目通常只有几个，所以项目模式基本上一页装得下，页脚会把当前单位写清楚。
 *
 * 「只看待办」在分组之前先把已完成筛掉：分组函数只管怎么摆，不管该不该出现。
 */
const sections = computed(() => {
  const visible = todoOnly.value
    ? entries.value.filter((entry) => entry.status !== 'done')
    : entries.value

  if (sort.value === 'time') {
    return timelineOf(visible, range.value, now.value).map((group) => ({
      key: group.day,
      day: group.day,
      projectId: null as string | null,
      entries: group.entries
    }))
  }

  return groupByProject(
    visible,
    range.value,
    now.value,
    store.projects.map((project) => ({ id: project.id, name: project.name }))
  ).map((group) => ({
    key: group.projectId ?? 'none',
    day: '',
    projectId: group.projectId,
    entries: group.entries
  }))
})

const paged = computed(() => paginate(sections.value, page.value, WORK_PAGE_DAYS))

/** 当前页里的栏 + 各自的栏头信息（时间维度给日期，项目维度给项目名与颜色） */
const groups = computed(() =>
  paged.value.items.map((section) => ({
    ...section,
    meta: dayMeta(section.day, now.value),
    title: projectTitleOf(section.projectId),
    color: projectColorOf(section.projectId)
  }))
)

/** 当前范围里的记录条数（不是栏数）：头部那个计数与分页都从它来 */
const total = computed(() => sections.value.reduce((sum, group) => sum + group.entries.length, 0))

/**
 * 当前范围里的待办条数：筛选标签上那个数字。
 * 从**全部**记录里数（不受筛选影响），否则一打开筛选它自己就归零了。
 */
const todoCount = computed(
  () =>
    timelineOf(entries.value, range.value, now.value).reduce(
      (sum, group) => sum + group.entries.filter((entry) => entry.status !== 'done').length,
      0
    )
)

/** 换范围、换维度或开关筛选后回到第一页，否则会停在一个新视图里并不存在的页码上 */
watch([range, sort, todoOnly], () => {
  page.value = 1
})

function pickSort(value: string): void {
  // 走 action 式的收敛：非法值不会被写进 sort
  if (isWorkSort(value)) sort.value = value
}

const projectNames = computed(() => new Map(store.projects.map((item) => [item.id, item])))

/** 记录上的项目名；项目已被删除时返回 null，由卡片显示「项目已删除」 */
function projectNameOf(entry: WorkLogEntry): string | null {
  const project = entry.projectId ? projectNames.value.get(entry.projectId) : undefined
  return project?.name ?? null
}

/** 记录上那个项目标签的颜色：与项目卡上的圆点同一个来源（项目标识色） */
function projectColorOf(projectId?: string | null): ProjectColor | undefined {
  const project = projectId ? projectNames.value.get(projectId) : undefined
  return sanitizeProjectColor(project?.color)
}

/** 项目维度下栏头上的名字：未关联 / 已删除各说各的 */
function projectTitleOf(projectId?: string | null): string {
  if (!projectId) return '未关联项目'
  if (projectId === DELETED_PROJECT_ID) return '项目已删除'
  return projectNames.value.get(projectId)?.name ?? '项目已删除'
}

/** 卡片上的项目标签颜色（时间维度下每条记录各自算） */
function entryColorOf(entry: WorkLogEntry): ProjectColor | undefined {
  return projectColorOf(entry.projectId)
}

/** 新增时的默认日期：停在「昨天」就默认记到昨天，其余档位按今天 */
const defaultDate = computed(() =>
  range.value === 'yesterday' ? dayKey(addDays(now.value, -1)) : dayKey(now.value)
)

function openCreate(): void {
  editing.value = null
  dialogVisible.value = true
}

function openEdit(entry: WorkLogEntry): void {
  editing.value = entry
  dialogVisible.value = true
}

/** 保存成功后把结果并进内存里那份列表：不重读文件，也不等下一次进页面 */
function onSaved(entry: WorkLogEntry): void {
  const index = entries.value.findIndex((item) => item.id === entry.id)
  if (index === -1) entries.value = [...entries.value, entry]
  else entries.value.splice(index, 1, entry)
  // 新记的那条未必落在当前范围里（例如停在「昨天」却记到了今天），把时刻推一下让范围重新算
  now.value = Date.now()
}

/**
 * 点记录 = 在「已完成 / 待办」之间切一下。
 *
 * 交互要立刻有反馈，所以先把内存里那条改掉、再落盘；写失败就把它改回去并说明原因 ——
 * 点一下还要等一次 IPC 往返才动，手感会明显发钝。
 */
async function toggleStatus(entry: WorkLogEntry): Promise<void> {
  const before = entry.status
  const next = toggleWorkLogStatus(before)
  const index = entries.value.findIndex((item) => item.id === entry.id)
  if (index === -1) return
  entries.value.splice(index, 1, { ...entry, status: next })

  const result = await window.workbench.updateWorkLog(entry.id, { status: next })
  if (!result.ok || !result.data) {
    entries.value.splice(index, 1, entry)
    ElMessage.error(result.error ?? '修改状态失败')
    return
  }
  entries.value.splice(index, 1, result.data)
}

async function remove(entry: WorkLogEntry): Promise<void> {
  // 确认框里放摘要而不是 markdown 原文：标记混在问句里读起来很别扭
  const preview = markdownToPlainText(entry.content)
  const short = preview.length > 24 ? `${preview.slice(0, 24)}…` : preview
  try {
    await ElMessageBox.confirm(`删除「${short}」？删除后不可恢复。`, '删除记录', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return // 用户取消
  }

  const result = await window.workbench.removeWorkLog(entry.id)
  if (!result.ok) {
    ElMessage.error(result.error ?? '删除工作记录失败')
    return
  }
  entries.value = entries.value.filter((item) => item.id !== entry.id)
  ElMessage.success('已删除')
}
</script>

<template>
  <main class="work-view">
    <!-- 工具条与项目页那条同款（底色由 global.css 按顶部样式给），搜索栏以下的第一条 -->
    <div class="filter">
      <div class="filter__head">
        <div class="ranges" role="tablist" aria-label="时间范围">
          <button
            v-for="item in WORK_RANGES"
            :key="item"
            type="button"
            class="tab"
            :class="{ 'is-active': range === item }"
            role="tab"
            :aria-selected="range === item"
            @click="range = item"
          >
            {{ WORK_RANGE_LABELS[item] }}
          </button>
        </div>

        <!-- 只看待办：一枚筛选标签，带当前范围里的待办条数（与项目页那些筛选标签同一副样子） -->
        <button
          class="chip"
          :class="{ 'is-active': todoOnly }"
          type="button"
          role="switch"
          :aria-checked="todoOnly"
          :disabled="!todoCount && !todoOnly"
          @click="todoOnly = !todoOnly"
        >
          {{ WORK_STATUS_LABELS.todo }}
          <span class="chip__count mono">{{ todoCount }}</span>
        </button>
      </div>

      <div class="filter__tools">
        <!-- 排序维度：时间（一天一栏）或项目（一个项目一栏），与项目页的「排序」同一副控件 -->
        <el-dropdown trigger="click" placement="bottom-end" @command="pickSort">
          <button class="sort" type="button">
            <span class="sort__label">排序</span>
            <span class="sort__value">{{ WORK_SORT_LABELS[sort] }}</span>
            <el-icon class="sort__caret"><ArrowDown /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="item in WORK_SORTS"
                :key="item"
                :command="item"
                :class="{ 'is-current': sort === item }"
              >
                {{ WORK_SORT_LABELS[item] }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <el-button type="primary" size="small" @click="openCreate">
          <el-icon><Plus /></el-icon>
          记一条
        </el-button>
      </div>
    </div>

    <div class="work-view__body">
      <!-- 读盘失败：把原因说出来并给一次重试，不能显示成「还没有记录」 -->
      <div v-if="loadError" class="empty">
        <p>{{ loadError }}</p>
        <el-button size="small" @click="load()">重试</el-button>
      </div>

      <div v-else-if="loading" class="empty">
        <p>正在读取工作日志…</p>
      </div>

      <div v-else-if="!total" class="empty">
        <p>{{ WORK_RANGE_LABELS[range] }}{{ todoOnly ? '没有待办' : '还没有记录' }}</p>
        <p class="empty__hint">
          <template v-if="todoOnly">这个范围里的记录都已完成。</template>
          <template v-else>
            点右上角「记一条」写下做了什么；一天可以记多条，记录只保存在本机。
          </template>
        </p>
      </div>

      <section v-for="group in groups" :key="group.key" class="day">
        <!-- 栏头按维度换：时间维度给日期 / 星期，项目维度给项目色点 + 项目名 -->
        <header class="day__head">
          <template v-if="sort === 'time'">
            <span class="day__dot" aria-hidden="true" />
            <span class="day__title">{{ group.meta.title }}</span>
            <span class="day__weekday">{{ group.meta.weekday }}</span>
            <span v-if="group.meta.relative" class="day__relative">{{ group.meta.relative }}</span>
          </template>
          <template v-else>
            <i
              class="day__swatch"
              :style="{ background: group.color ? projectColorVar(group.color) : 'var(--border-strong)' }"
              aria-hidden="true"
            />
            <span class="day__title">{{ group.title }}</span>
          </template>
          <span class="day__count mono">{{ group.entries.length }} 条</span>
        </header>

        <ol class="timeline">
          <li v-for="entry in group.entries" :key="entry.id" class="timeline__item">
            <WorkLogCard
              :entry="entry"
              :project-name="projectNameOf(entry)"
              :project-color="entryColorOf(entry)"
              :show-date="sort === 'project'"
              @edit="openEdit"
              @remove="remove"
              @toggle="toggleStatus"
            />
          </li>
        </ol>
      </section>
    </div>

    <!-- 分页按「栏」走：时间维度就是每页 7 天，项目维度是每页 7 个项目 -->
    <footer class="work-view__foot">
      <span class="foot__hint">
        每页 {{ WORK_PAGE_DAYS }} {{ sort === 'time' ? '天' : '个项目' }} · 共
        {{ sections.length }} {{ sort === 'time' ? '天' : '个项目' }} / {{ total }} 条
      </span>
      <el-pagination
        v-model:current-page="page"
        :page-count="paged.pages"
        :pager-count="5"
        layout="prev, pager, next"
        size="small"
        background
      />
    </footer>

    <WorkLogDialog
      v-model="dialogVisible"
      :entry="editing"
      :default-date="defaultDate"
      @saved="onSaved"
    />
  </main>
</template>

<style scoped>
.work-view {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
}

/* 工具带左侧：时间范围 + 「只看待办」筛选标签 */
.filter__head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

/* 范围切换：分段控件的样式（与写日志弹窗里的「编写 / 预览」同一副） */
.ranges {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
}

.tab {
  padding: 2px 12px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  font-size: var(--fs-meta);
  color: var(--ink-3);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.tab:hover {
  color: var(--ink);
}

.tab.is-active {
  background: var(--bg-surface);
  color: var(--ink);
  font-weight: 500;
}

/* 工具带右侧：排序下拉 + 「记一条」。条数不在这里重复一遍，页脚已经有「共 N 天 / M 条」 */
.filter__tools {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

/* 时间轴区域自己滚，工具条与分页钉在上下两头 */
.work-view__body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-height: 0;
  overflow-y: auto;
  /* 四周留白与卡片间距同源（--card-gap 由 .app 统一给，设置里改「卡片间距」这里跟着变），
     与项目页的画布、首页的卡片是同一套 */
  padding: var(--card-gap, 10px);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  flex: 1;
  min-height: 200px;
  text-align: center;
  font-size: var(--fs-body);
  color: var(--ink-2);
}

.empty p {
  margin: 0;
}

.empty__hint {
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.day {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  flex-shrink: 0;
  min-width: 0;
}

/* 一天的头：日期 + 星期 + 相对说法 + 条数，左侧一个圆点与下面的时间轴竖线对齐 */
.day__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding-left: 2px;
}

.day__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink-3);
}

.day__title {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.day__weekday,
.day__relative,
.day__count {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.day__relative {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--bg-inset);
  color: var(--ink-2);
}

/* 项目维度栏头上的色块：与项目卡上的圆点同色，一眼看出这一栏是哪个项目 */
.day__swatch {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.day__count {
  margin-left: auto;
}

/**
 * 时间轴：一条竖线穿起一天里的多条记录，记录卡片退到线的右侧。
 * 线画在容器上（::before），不用每张卡片自己的边框 —— 那样卡片之间会断开。
 */
.timeline {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin: 0;
  padding: 0 0 0 22px;
  list-style: none;
}

.timeline::before {
  content: '';
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 5px;
  width: 1px;
  background: var(--border);
}

.timeline__item {
  position: relative;
  min-width: 0;
}

/* 每条记录在线上点一个节，与当天头部的圆点同色系 */
.timeline__item::before {
  content: '';
  position: absolute;
  top: 16px;
  left: -20px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--border-strong);
}

/**
 * 页脚：左边一句「每页几栏 / 共几条」，右边分页器。
 * 左右留白走全局间距令牌（--sp-*），与页内其它地方同一个口径；上下另留一档呼吸。
 */
.work-view__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-2) 0;
  margin: 0 var(--sp-2);
  border-top: 1px solid var(--border);
}

.foot__hint {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}
</style>
