<script setup lang="ts">
import type { ProjectColor } from '@workbench/core'
import type { WorkLogEntry, WorkLogStatus, WorkRange, WorkRangeBounds, WorkSort } from '@workbench/work-log'
import { ArrowDown, Download, Memo, Plus, Warning } from '@element-plus/icons-vue'
import { addDays, dayKey, markdownToPlainText, projectColorVar, sanitizeProjectColor } from '@workbench/core'
import { dayMeta, defaultWorkRangeBounds, DELETED_PROJECT_ID, groupByProject, isWorkSort, paginate, sanitizeWorkRange, sanitizeWorkRangeBounds, sanitizeWorkSort, timelineOf, toggleWorkLogStatus, WORK_PAGE_DAYS, WORK_RANGE_LABELS, WORK_RANGES, WORK_SORT_LABELS, WORK_SORTS, WORK_STATUS_DEFAULT } from '@workbench/work-log'
import { ElMessage } from 'element-plus'
/**
 * 工作页：按天分组的工作日志时间轴。
 *
 * 与其它页面一样，它是导航栏上的一项（见 packages/appearance/src/views.ts），换页由 App.vue 的
 * `<KeepAlive><component :is>` 负责 —— 所以这一页在离开时会留在内存里，滚动位置与
 * 展开状态都不会丢；数据也不会因为切走再回来而重读。
 *
 * 数据住在本机的 `work-log.json`（配了同步仓库时按设备分片共享，见
 * packages/work-log/src/work-log.ts 与 work-log-sync.ts）。
 * 时间的最小刻度是「天」：一天可以有多条记录，所以分页按**天**走 ——
 * 一天里的几条不该被翻页切成两半。范围、分组、分页都是 shared 里的纯函数，
 * 这一层只做取数与交互。
 */
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import WorkLogCard from '@/components/WorkLogCard.vue'
import WorkLogDialog from '@/components/WorkLogDialog.vue'
import WorkLogGitDialog from '@/components/WorkLogGitDialog.vue'
import { confirmAction } from '@/notify'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'

const store = useProjectsStore()
const settings = useSettingsStore()
const auth = useAuthStore()

const entries = ref<WorkLogEntry[]>([])
const loading = ref(true)
/** 读盘失败与「一条都还没写过」是两回事，不能都显示成空列表 */
const loadError = ref('')
const range = ref<WorkRange>(sanitizeWorkRange(settings.settings.workRange))
/** 自定义范围（只在「自定义」那一档用）：设置里没存过就按今天一天 */
const customRange = ref<WorkRangeBounds>(
  sanitizeWorkRangeBounds(settings.settings.workRangeCustom?.from, settings.settings.workRangeCustom?.to)
  ?? defaultWorkRangeBounds(Date.now()),
)
/** 日期范围控件的 model：Element Plus 要 [开始, 结束]，内部统一收成 { from, to } */
const customRangeInput = computed<[string, string]>({
  get: (): [string, string] => [customRange.value.from, customRange.value.to],
  set: (value: [string, string] | null) => {
    const next = sanitizeWorkRangeBounds(value?.[0], value?.[1])
    if (next)
      customRange.value = next
  },
})
/** 时间范围的选项：Element Plus 的分段控件要 { label, value }，标签表在 shared 里（最左是「待办」） */
const rangeOptions = WORK_RANGES.map(value => ({ label: WORK_RANGE_LABELS[value], value }))
/** 排序维度：按时间（天为轴）或按项目（项目为轴） */
const sort = ref<WorkSort>(sanitizeWorkSort(settings.settings.workSort))

/** 设置是异步载入的、数据目录还可能整份换掉，所以这两项要跟着核一遍 */
watch(
  () => settings.settings.workRange,
  (value) => {
    range.value = sanitizeWorkRange(value)
  },
)

/** 数据目录整个换掉时，自定义区间也跟着设置重新取一次（认不出就回今天） */
watch(
  () => settings.settings.workRangeCustom,
  (value) => {
    const next = sanitizeWorkRangeBounds(value?.from, value?.to) ?? defaultWorkRangeBounds(Date.now())
    if (next.from !== customRange.value.from || next.to !== customRange.value.to)
      customRange.value = next
  },
)

watch(
  () => settings.settings.workSort,
  (value) => {
    sort.value = sanitizeWorkSort(value)
  },
)

const page = ref(1)
/** 当前时刻：决定「今天 / 本周 / 本月」的边界，也决定时间轴上的「今天」标记 */
const now = ref(Date.now())
const dialogVisible = ref(false)
const editing = ref<WorkLogEntry | null>(null)
/** 「从提交生成」弹窗；日期与项目都在弹窗里选，不跟这一排的档位联动 */
const gitVisible = ref(false)

/**
 * 多机同步：只在这两样都齐了才跑 —— 没登录 / 没填同步仓库时安静跳过，
 * 这一页不摆一颗按下去只会报错的按钮（与保险库同一条口径）。
 */
const syncReady = computed(() =>
  Boolean(auth.status?.account) && Boolean(settings.settings.tokenSyncRepo.trim()),
)
const syncing = ref(false)
const syncFailed = ref(false)
const syncNote = ref('')
/** 同步拿回来的本机设备 id：远端条目的项目名兜底要看它 */
const localDeviceId = ref('')
let queuedSync = false

/** 登录状态 / 同步仓库是异步载入的：第一次真正就绪时补跑一轮（首次挂载那条已经跑过也无妨，会合并成一趟） */
watch(syncReady, (ready, wasReady) => {
  if (ready && !wasReady)
    void syncNow()
})

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const result = await window.workbench.listWorkLogs()
    if (result.ok && result.data)
      entries.value = result.data
    else loadError.value = result.error ?? '读取工作日志失败'
  }
  catch (error) {
    loadError.value = error instanceof Error ? error.message : '读取工作日志失败'
  }
  finally {
    loading.value = false
    now.value = Date.now()
  }
}

/**
 * 同步一轮：拉别的设备的分片 → 合并写回本机 → 推本机分片。
 *
 * 节奏与保险库同一套：进页面（含从别的页切回来）与每次增删改成功后各跑一轮；
 * 跑着的时候又改了，等这轮完了补一趟。失败只在工具带留一行字 —— 成功一个字都不写，
 * 不把工具带变成常驻状态栏。
 */
async function syncNow(): Promise<void> {
  if (!syncReady.value)
    return
  if (syncing.value) {
    queuedSync = true
    return
  }

  syncing.value = true
  try {
    do {
      queuedSync = false
      const result = await window.workbench.syncWorkLogs()
      if (!result.ok) {
        syncFailed.value = true
        syncNote.value = result.error ?? '同步失败'
        break
      }
      if (!result.data || !result.data.enabled)
        break
      localDeviceId.value = result.data.device
      // 远端条目并进来了：直接换成本机文件合并后的那份，不再多读一次盘
      if (result.data.changed) {
        entries.value = result.data.entries
        now.value = Date.now()
      }
      syncFailed.value = false
      syncNote.value = ''
    } while (queuedSync)
  }
  catch (error) {
    syncFailed.value = true
    syncNote.value = error instanceof Error ? error.message : '同步失败'
  }
  finally {
    syncing.value = false
  }
}

/**
 * 跨过午夜时把「现在」往后推一格：停在应用里过夜之后，
 * 「今天」那一档与分组上的相对说法都得跟着走到新的一天。
 */
let timer: number | null = null

onMounted(() => {
  // 先读本机再同步：反过来会让合并后的列表被先到的旧快照盖回去
  void load().then(() => syncNow())
  timer = window.setInterval(() => {
    const next = Date.now()
    if (dayKey(next) !== dayKey(now.value))
      now.value = next
  }, 60_000)
})

/** 第一次激活跟在首次挂载后面，不重复跑；之后每次切回这一页再同步一轮 */
let activatedOnce = false

onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true
    return
  }
  void syncNow()
})

onBeforeUnmount(() => {
  if (timer)
    window.clearInterval(timer)
})

/**
 * 领域函数只认「这一段」：不在自定义档时传 null，其余档自己按 now 算边界。
 */
const customBounds = computed(() => (range.value === 'custom' ? customRange.value : null))

/**
 * 当前维度下的分组（时间 = 一天一栏，项目 = 一个项目一栏），再按页大小切开。
 *
 * 两种维度共用同一套分页：页大小还是「7」，只是单位从天变成项目 ——
 * 项目通常只有几个，所以项目模式基本上一页装得下，页脚会把当前单位写清楚。
 *
 * 「待办」这一档在包里就把已完成的筛掉了（见 `entriesInRange`）：分组函数只管怎么摆，
 * 不管该不该出现。
 */
const sections = computed(() => {
  if (sort.value === 'time') {
    return timelineOf(entries.value, range.value, now.value, customBounds.value).map(group => ({
      key: group.day,
      day: group.day,
      projectId: null as string | null,
      entries: group.entries,
    }))
  }

  return groupByProject(
    entries.value,
    range.value,
    now.value,
    store.projects.map(project => ({ id: project.id, name: project.name })),
    customBounds.value,
  ).map(group => ({
    key: group.projectId ?? 'none',
    day: '',
    projectId: group.projectId,
    entries: group.entries,
  }))
})

const paged = computed(() => paginate(sections.value, page.value, WORK_PAGE_DAYS))

/** 当前页里的栏 + 各自的栏头信息（时间维度给日期，项目维度给项目名与颜色） */
const groups = computed(() =>
  paged.value.items.map(section => ({
    ...section,
    meta: dayMeta(section.day, now.value),
    title: projectTitleOf(section.projectId),
    color: projectColorOf(section.projectId),
  })),
)

/** 当前范围里的记录条数（不是栏数）：头部那个计数与分页都从它来 */
const total = computed(() => sections.value.reduce((sum, group) => sum + group.entries.length, 0))

/**
 * 空态里那句「最近一次是……」。空串表示**整份日志一条都没有**，与「这段时间没有」不是一回事。
 *
 * 数的是整份 `entries`（不受范围与筛选影响），所以空态里拿到的必定是范围之外的那一天 ——
 * 这正是它的用处：只说「本月还没有记录」，用户分不清是自己没记、还是记录丢了。
 * 日期键是 YYYY-MM-DD，直接比字符串就是比先后。
 */
const lastLoggedText = computed(() => {
  const latest = entries.value.reduce(
    (max, entry) => (entry.date > max ? entry.date : max),
    '',
  )
  if (!latest)
    return ''

  // 近几天说「昨天 / 前天」比报日期更像人话，再远就报日期（dayMeta 自己就是这套口径）
  const meta = dayMeta(latest, now.value)
  return meta.relative || meta.title
})

/** 自定义档在空态里的名字：单日说「今天 / 昨天」，跨天报「M月D日 – M月D日」 */
const customRangeTitle = computed(() => {
  const { from, to } = customRange.value
  if (from === to) {
    const meta = dayMeta(from, now.value)
    return meta.relative || meta.title || from
  }
  return `${dayMeta(from, now.value).title || from} – ${dayMeta(to, now.value).title || to}`
})

/**
 * 空态的第一句。「待办」那一档不是时段，说「待办还没有记录」读着别扭，直接说「没有待办」；
 * 「自定义」报具体区间，否则「自定义还没有记录」读不出是哪段时间。
 */
const emptyTitle = computed(() => {
  if (range.value === 'todo')
    return '没有待办'
  if (range.value === 'custom')
    return `${customRangeTitle.value}还没有记录`
  return `${WORK_RANGE_LABELS[range.value]}还没有记录`
})

/**
 * 空态的第二句。
 *
 * 日期那一档在「有记录、只是不在这段时间里」时会把「最近一次是哪天」说出来 —— 只说
 * 「本月还没有记录」的话，用户分不清是自己没记、还是记录丢了。「待办」档同样要区分
 * 「一条记录都没有」与「都做完了」：前者才是原来那句引导。
 */
const emptyHint = computed(() => {
  if (range.value === 'todo') {
    return entries.value.length
      ? '所有记录都已完成。'
      : '点右上角「记一条」写下待办；一天可以记多条，记录只保存在本机。'
  }

  if (lastLoggedText.value)
    return `最近一次是${lastLoggedText.value}，点右上角「记一条」写下做了什么。`

  return '点右上角「记一条」写下做了什么；一天可以记多条，记录只保存在本机。'
})

/** 换范围或维度后回到第一页，否则会停在一个新视图里并不存在的页码上 */
watch([range, sort, customRange], () => {
  page.value = 1
})

/**
 * 范围与维度是**行为记忆**（见 apps/desktop/src/renderer/src/types.ts 的那一段）：初值来自设置，改了写回去，
 * 下次打开还停在上一眼看的那一档，不必每次重新拉一遍。
 *
 * 「待办」是这一排里的一档，跟其余四档一样会记住：它现在是一个视图（所有还欠着的事），
 * 不是临时戴上的镜片。
 */
watch([range, sort, customRange], () => {
  void settings.updateSettings({
    workRange: range.value,
    workSort: sort.value,
    workRangeCustom: { ...customRange.value },
  })
})

function pickSort(value: string): void {
  // 走 action 式的收敛：非法值不会被写进 sort
  if (isWorkSort(value))
    sort.value = value
}

const projectNames = computed(() => new Map(store.projects.map(item => [item.id, item])))

/**
 * 记录上的项目名；项目已被删除时返回 null，由卡片显示「项目已删除」。
 *
 * 别的设备来的条目（`by` 不是本机）在本地项目列表里找不到时，用条目里冗余的项目名 ——
 * 项目列表本身不跨设备同步，不兜底的话远端条目的标签会一律显示成「项目已删除」。
 */
function projectNameOf(entry: WorkLogEntry): string | null {
  const project = entry.projectId ? projectNames.value.get(entry.projectId) : undefined
  if (project)
    return project.name
  if (entry.projectId && localDeviceId.value && entry.by && entry.by !== localDeviceId.value)
    return entry.projectName ?? null
  return null
}

/** 记录上那个项目标签的颜色：与项目卡上的圆点同一个来源（项目标识色） */
function projectColorOf(projectId?: string | null): ProjectColor | undefined {
  const project = projectId ? projectNames.value.get(projectId) : undefined
  return sanitizeProjectColor(project?.color)
}

/** 项目维度下栏头上的名字：未关联 / 已删除各说各的；远端项目用条目里带的名字兜底 */
function projectTitleOf(projectId?: string | null): string {
  if (!projectId)
    return '未关联项目'
  if (projectId === DELETED_PROJECT_ID)
    return '项目已删除'
  const known = projectNames.value.get(projectId)?.name
  if (known)
    return known
  const remote = entries.value.find(entry =>
    entry.projectId === projectId
    && localDeviceId.value
    && entry.by
    && entry.by !== localDeviceId.value,
  )
  return remote?.projectName ?? '项目已删除'
}

/** 卡片上的项目标签颜色（时间维度下每条记录各自算） */
function entryColorOf(entry: WorkLogEntry): ProjectColor | undefined {
  return projectColorOf(entry.projectId)
}

/** 新增时的默认日期：停在「昨天」就默认记到昨天，其余档位按今天（待办不属于某一天，就是今天） */
const defaultDate = computed(() =>
  range.value === 'yesterday' ? dayKey(addDays(now.value, -1)) : dayKey(now.value),
)

/**
 * 新增时的默认状态：停在「待办」这一档就默认记一条待办 ——
 * 否则刚记下的那条（默认已完成）会立刻从眼前的列表里消失，看着像没存上。
 */
const defaultStatus = computed<WorkLogStatus>(() =>
  range.value === 'todo' ? 'todo' : WORK_STATUS_DEFAULT,
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
  const index = entries.value.findIndex(item => item.id === entry.id)
  if (index === -1)
    entries.value = [...entries.value, entry]
  else entries.value.splice(index, 1, entry)
  // 新记的那条未必落在当前范围里（例如停在「昨天」却记到了今天），把时刻推一下让范围重新算
  now.value = Date.now()
  void syncNow()
}

/** 从提交生成之后同样并进内存列表：这次可能是新建，也可能是追加到已有记录 */
function onGitImported(changed: WorkLogEntry[]): void {
  for (const entry of changed) {
    const index = entries.value.findIndex(item => item.id === entry.id)
    if (index === -1)
      entries.value.push(entry)
    else entries.value.splice(index, 1, entry)
  }
  now.value = Date.now()
  void syncNow()
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
  const index = entries.value.findIndex(item => item.id === entry.id)
  if (index === -1)
    return
  entries.value.splice(index, 1, { ...entry, status: next })

  const result = await window.workbench.updateWorkLog(entry.id, { status: next })
  if (!result.ok || !result.data) {
    entries.value.splice(index, 1, entry)
    ElMessage.error(result.error ?? '修改状态失败')
    return
  }
  entries.value.splice(index, 1, result.data)
  void syncNow()
}

async function remove(entry: WorkLogEntry): Promise<void> {
  // 确认框里放摘要而不是 markdown 原文：标记混在问句里读起来很别扭
  const preview = markdownToPlainText(entry.content)
  const short = preview.length > 24 ? `${preview.slice(0, 24)}…` : preview
  const agreed = await confirmAction(`删除「${short}」？删除后不可恢复。`, '删除记录', {
    confirmButtonText: '删除',
  })
  if (!agreed)
    return

  const result = await window.workbench.removeWorkLog(entry.id)
  if (!result.ok) {
    ElMessage.error(result.error ?? '删除工作记录失败')
    return
  }
  entries.value = entries.value.filter(item => item.id !== entry.id)
  ElMessage.success('已删除')
  void syncNow()
}
</script>

<template>
  <main class="work-view">
    <!-- 工具条与项目页那条同款（底色由 global.css 按顶部样式给），顶栏以下的第一条 -->
    <div class="filter">
      <div class="filter__head">
        <!-- 六档：最左是「待办」（所有还没做完的事），中间四档是预置时间范围，最右「自定义」配一枚日期范围选择器 -->
        <el-segmented
          v-model="range"
          class="ranges"
          :options="rangeOptions"
          aria-label="范围"
        />

        <el-date-picker
          v-if="range === 'custom'"
          v-model="customRangeInput"
          class="custom-range"
          type="daterange"
          value-format="YYYY-MM-DD"
          format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          :clearable="false"
        />
      </div>

      <div class="filter__tools">
        <!-- 同步失败只在这一行留个字：成功不写（不把工具带变成常驻状态栏） -->
        <span v-if="syncFailed && syncNote" class="sync-note" :title="syncNote">{{ syncNote }}</span>

        <!-- 排序维度：时间（一天一栏）或项目（一个项目一栏），与项目页的「排序」同一副控件 -->
        <el-dropdown trigger="click" placement="bottom-end" @command="pickSort">
          <button class="sort" type="button">
            <span class="sort__label">排序</span>
            <span class="sort__value">{{ WORK_SORT_LABELS[sort] }}</span>
            <el-icon class="sort__caret">
              <ArrowDown />
            </el-icon>
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

        <!-- 从项目仓库的提交生成：先预览再写入。日期在弹窗里选，五档都能用 -->
        <el-button size="small" @click="gitVisible = true">
          <el-icon><Download /></el-icon>
          从提交生成
        </el-button>

        <el-button type="primary" size="small" @click="openCreate">
          <el-icon><Plus /></el-icon>
          记一条
        </el-button>
      </div>
    </div>

    <div class="work-view__body">
      <!-- 读盘失败：把原因说出来并给一次重试，不能显示成「还没有记录」 -->
      <EmptyState v-if="loadError" tone="error" :icon="Warning" :text="loadError">
        <template #actions>
          <el-button size="small" @click="load()">
            重试
          </el-button>
        </template>
      </EmptyState>

      <PanelLoading v-else-if="loading" text="正在读取工作日志…" />

      <EmptyState v-else-if="!total" :icon="Memo" :text="emptyTitle" :hint="emptyHint" />

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

    <!--
      分页按「栏」走：时间维度就是每页 7 天，项目维度是每页 7 个项目。
      这段时间一条记录都没有时整条不画 —— 空态居中那两行字就是全部，再摆一排
      「每页 7 天 · 共 0 天 / 0 条」和一颗孤零零的「1」，等于什么都没说。
    -->
    <footer v-if="total" class="work-view__foot">
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
      :default-status="defaultStatus"
      @saved="onSaved"
    />

    <!-- 提交生成：项目与日志都从这一页取，读写各归适配层；日期与项目在弹窗里选 -->
    <WorkLogGitDialog
      v-model="gitVisible"
      :projects="store.projects"
      :entries="entries"
      :now="now"
      @imported="onGitImported"
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

/* 工具带左右两组（.filter__head / .filter__tools）的排版在 global.css：三个页面共用同一条带子，
   谁都不该是「规矩的出处」。这里只留这一页自己的那点东西。 */

/* 范围切换用 el-segmented：外壳（底色 / 圆角 / 选中态）在 global.css，这里只补不显形的一行 */
.ranges.el-segmented {
  flex-shrink: 0;
}

/* 「自定义」后面那枚日期范围：宽度给到刚好装下两端日期，不与右边的工具抢地方 */
.custom-range.el-date-editor {
  flex: 0 0 260px;
  width: 260px;
}

/* 同步失败：工具带上一行红字，悬停看全文（与保险库同一套，成功时不占地方） */
.sync-note {
  max-width: 200px;
  overflow: hidden;
  font-size: var(--fs-micro);
  color: var(--st-fail);
  text-overflow: ellipsis;
  white-space: nowrap;
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

/**
 * 页脚：左边一句「每页几栏 / 共几条」，右边分页器。
 * 只在有记录时渲染（模板里 v-if="total"）：空态时它是一排无意义的「共 0 条」。
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
