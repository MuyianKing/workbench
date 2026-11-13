<script setup lang="ts">
import type { ProjectColor } from '@workbench/core'
import type { GitWorkLogDraft, GitWorkLogInput, WorkLogDevice, WorkLogEntry } from '@workbench/work-log'
import { DocumentAdd } from '@element-plus/icons-vue'
import { addDays, dayKey, projectColorVar, sanitizeProjectColor } from '@workbench/core'
import { buildGitDrafts, dateOfDayKey, dayMeta, entriesOfDevice, workLogDeviceLabel } from '@workbench/work-log'
import { ElMessage } from 'element-plus'
/**
 * 从项目仓库的提交生成工作记录（预览后写入）。
 *
 * 读提交、分组、去重都在 `@workbench/work-log` 的 `git-import.ts` 里（纯逻辑，有单测）；
 * 这个弹窗负责三件事：选写到哪台设备 / 哪一天 / 哪些项目、把草稿摆出来让人改、确认后交给适配层写入。
 * 日期范围必选（默认今天，可快捷选今天 / 昨天 / 本周），项目多选（默认空 = 全部项目；没选项目就生成前先确认一次），
 * 设备默认取工作页当前正在看的那台 —— 去重与「追加到哪条」也只认这台设备的记录。
 *
 * 一个项目一天一条：同项目同一天已经有生成记录时标「追加」，新提交接在它后面；
 * 否则新建一条「已完成」。勾掉的行不写，正文被清空的行也跳过。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import EmptyState from '@/components/EmptyState.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import ProjectTag from '@/components/ProjectTag.vue'
import { confirmAction } from '@/notify'

/** 预览里的一行：草稿 + 勾选状态（只有界面用，不落盘） */
interface DraftRow extends GitWorkLogDraft {
  checked: boolean
}

const props = defineProps<{
  /** 项目列表（取数用；颜色只用于预览里的标签） */
  projects: { id: string, name: string, path: string, color?: ProjectColor }[]
  /** 整份工作日志：去重与「追加到哪条」都靠它，弹窗内部按选中的设备先筛一遍再用 */
  entries: readonly WorkLogEntry[]
  /** 设备清单（与工作页工具带同一份：本机恒在第一位） */
  devices: readonly WorkLogDevice[]
  /** 本机设备 id：认领没有 by 的老数据 */
  localDeviceId: string
  /** 打开弹窗时默认写到哪台设备（工作页当前正在看的那台） */
  defaultDeviceId: string
  /** 页面的「现在」：预览里的相对日期（今天 / 昨天 / 前天）按它算 */
  now: number
}>()

const emit = defineEmits<{
  /** 写入成功后把新建 / 改动过的记录，连同它们所属的设备交给页面并进内存列表 */
  imported: [entries: WorkLogEntry[], deviceId: string]
}>()

const open = defineModel<boolean>({ required: true })

/** 写到哪台设备：值是设备 id（本机那项也是真实 id）；打开弹窗时默认跟工作页当前看的那台一致 */
const deviceId = ref('')
/** 生成哪一段（必选、默认今天）：两端都是本地日期键，不跟工作页顶部的档位联动 */
const dateRange = ref<[string, string]>([dayKey(Date.now()), dayKey(Date.now())])
/** 选中的项目 id：空 = 全部项目（默认空，可以不选） */
const selectedIds = ref<string[]>([])

/** 设备下拉的选项：本机恒在第一位，名字与工具带同一个口径 */
const deviceOptions = computed(() => props.devices.map(item => ({
  id: item.id,
  label: workLogDeviceLabel(item),
})))

/** 新建条目实际落到哪台设备：还没选时认默认那台 */
const targetDeviceId = computed(() => deviceId.value || props.defaultDeviceId)

/** 只认这台设备的记录：别把提交接进别的设备的记录里，也别拿别处的哈希来去重 */
const deviceEntries = computed(() =>
  entriesOfDevice(props.entries, targetDeviceId.value, props.localDeviceId),
)

/**
 * 日期快捷项：与工作页顶栏那几档同一口径 —— 本周从周一起算。
 * 返回 Date，选择器按 value-format 落成本地日期键。
 */
const dateShortcuts = [
  {
    text: '今天',
    value: () => [new Date(), new Date()],
  },
  {
    text: '昨天',
    value: () => {
      const day = addDays(new Date(), -1)
      return [day, day]
    },
  },
  {
    text: '本周',
    value: () => {
      const today = new Date()
      const monday = addDays(today, -((today.getDay() + 6) % 7))
      return [monday, addDays(monday, 6)]
    },
  },
]

const rows = ref<DraftRow[]>([])
const loading = ref(false)
const saving = ref(false)
/** 读取失败的项目（部分失败不影响其余项目生成） */
const warnings = ref<string[]>([])

const checkedCount = computed(() => rows.value.filter(row => row.checked).length)
const commitCount = computed(() => rows.value.reduce((sum, row) => sum + row.commits.length, 0))
const submitLabel = computed(() => (checkedCount.value ? `生成 ${checkedCount.value} 条` : '生成'))

/** 空态标题里的日期范围：同一天说「今天 / 昨天 / 前天」，跨天报日期区间 */
const rangeTitle = computed(() => {
  const range = dateRange.value
  if (!range || !range[0] || !range[1])
    return ''

  const [from, to] = range
  if (from === to) {
    const meta = dayMeta(from, props.now)
    return meta.relative || meta.title || from
  }
  return `${dayMeta(from, props.now).title || from} – ${dayMeta(to, props.now).title || to}`
})
const emptyText = computed(() => `${rangeTitle.value}没有可导入的提交`)
/** 空态第二行：先说是哪个项目出了问题，再退回「为什么没有」的常规解释 */
const emptyHint = computed(() => {
  if (warnings.value.length)
    return warnings.value[0]
  if (!props.projects.length)
    return '项目列表是空的。'
  return '已导入过的提交不会重复出现。'
})

/** 下拉里的项目（带上标识色，选的时候就能对上号） */
const projectOptions = computed(() => props.projects.map(project => ({
  id: project.id,
  name: project.name,
  color: sanitizeProjectColor(project.color),
})))

/** 项目色：预览里的标签与时间轴上那枚同一个来源 */
function colorOf(projectId: string): ProjectColor | undefined {
  return sanitizeProjectColor(props.projects.find(project => project.id === projectId)?.color)
}

/**
 * 选中日期范围对应的粗筛区间（毫秒）。
 *
 * 两端各放一天：`--since` / `--until` 按提交时间算，而分组按作者时间，
 * 两者在 rebase / cherry-pick 之后会差开；多放一天只是让 git 多回几条，
 * 精确到天的过滤在 `buildGitDrafts` 里按作者时间做。
 */
function boundsOf(from: string, to: string): { since: number, until: number } | null {
  const start = dateOfDayKey(from).getTime()
  const end = dateOfDayKey(to).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end))
    return null
  return { since: start - 86_400_000, until: end + 2 * 86_400_000 }
}

/** 在途读取的代号：改日期 / 改项目后，早先那次读回来的结果直接丢掉 */
let loadToken = 0
let reloadTimer: number | null = null

async function load(): Promise<void> {
  const token = ++loadToken
  loading.value = true
  rows.value = []
  warnings.value = []

  try {
    const range = dateRange.value
    if (!range || !range[0] || !range[1])
      return
    const [from, to] = range
    const bounds = boundsOf(from, to)
    if (!bounds)
      return

    // 选了项目就只读这几个仓库；不选 = 全部项目
    const picked = selectedIds.value.length
      ? props.projects.filter(project => selectedIds.value.includes(project.id))
      : props.projects
    const reads = await Promise.all(picked.map(async (project) => {
      if (!project.path.trim())
        return { project, result: null }
      return { project, result: await window.workbench.projectGitLog(project.path, bounds.since, bounds.until) }
    }))
    if (token !== loadToken)
      return

    const inputs: GitWorkLogInput[] = []
    for (const { project, result } of reads) {
      if (!result)
        continue
      if (result.ok && result.data) {
        inputs.push({
          project: { id: project.id, name: project.name, path: project.path },
          log: result.data,
        })
      }
      else if (result.error) {
        warnings.value.push(`${project.name}：${result.error}`)
      }
    }

    rows.value = buildGitDrafts(inputs, from, to, deviceEntries.value)
      .map(draft => ({ ...draft, checked: true }))
  }
  finally {
    if (token === loadToken)
      loading.value = false
  }
}

/**
 * 合并同一轮里的连续变化再读：打开弹窗会同时复位日期与项目，
 * 多选时也可能连点几个项目 —— 每次点击都起一轮 git 没必要。
 */
function requestLoad(): void {
  if (reloadTimer)
    window.clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => {
    reloadTimer = null
    void load()
  }, 120)
}

watch(open, (value) => {
  if (!value)
    return
  // 每次打开都回到默认：当前看的那台设备 + 今天 + 全部项目
  const today = dayKey(Date.now())
  deviceId.value = props.defaultDeviceId
  dateRange.value = [today, today]
  selectedIds.value = []
  requestLoad()
})

/** 换设备等于换了去重与追加的依据，预览要重读 */
watch([dateRange, selectedIds, deviceId], () => {
  if (open.value)
    requestLoad()
}, { deep: true })

onBeforeUnmount(() => {
  if (reloadTimer)
    window.clearTimeout(reloadTimer)
})

function reset(): void {
  if (reloadTimer) {
    window.clearTimeout(reloadTimer)
    reloadTimer = null
  }
  // 丢掉在途结果：关掉弹窗之后回来的那批不该再摆回界面上
  loadToken += 1
  loading.value = false
  rows.value = []
  warnings.value = []
}

/**
 * 写入勾选的草稿。
 *
 * `closeAfter` 为 false 时（「添加并继续」）不关弹窗：已经写进去的行从预览里摘掉，
 * 剩下没勾选的行（连同正文的改动）留在原地，换个日期或项目可以接着加。
 */
async function commit(closeAfter: boolean): Promise<void> {
  if (saving.value || loading.value)
    return
  if (!dateRange.value?.[0] || !dateRange.value?.[1]) {
    ElMessage.warning('请先选择日期范围')
    return
  }

  const selectedRows = rows.value.filter(row => row.checked && row.content.trim())
  const picked = selectedRows.map(({ checked: _checked, ...draft }) => draft)
  if (!picked.length) {
    ElMessage.warning('没有勾选可生成的内容')
    return
  }

  // 项目不选 = 全部项目：写入前问一句，免得把没打算生成的项目一起写进去
  if (!selectedIds.value.length) {
    const agreed = await confirmAction(
      `没有选择项目，将从全部项目生成 ${picked.length} 条记录，是否继续？`,
      '从提交生成',
    )
    if (!agreed)
      return
  }

  saving.value = true
  try {
    const result = await window.workbench.importGitDrafts(picked, targetDeviceId.value)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '生成工作记录失败')
      return
    }

    emit('imported', result.data, targetDeviceId.value)
    if (closeAfter) {
      ElMessage.success(`已生成 ${result.data.length} 条工作记录`)
      open.value = false
    }
    else {
      // 写进去的行已经成了正式记录，从预览里摘掉；剩下的行继续留着
      const done = new Set(selectedRows)
      rows.value = rows.value.filter(row => !done.has(row))
      ElMessage.success(`已添加 ${result.data.length} 条工作记录`)
    }
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <AppDialog
    v-model="open"
    title="从提交生成工作记录"
    width="720"
    align-center
    @closed="reset"
  >
    <div class="git">
      <!-- 生成范围：写到哪台设备（默认当前看的那台）、日期范围必选、项目多选（默认空 = 全部项目） -->
      <el-form class="form" label-position="top" @submit.prevent>
        <div class="filters">
          <el-form-item v-if="deviceOptions.length > 1" label="设备" class="filters__device">
            <el-select v-model="deviceId" class="select" placeholder="选择设备">
              <el-option
                v-for="item in deviceOptions"
                :key="item.id"
                :label="item.label"
                :value="item.id"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="日期范围" class="filters__date">
            <el-date-picker
              v-model="dateRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              format="YYYY-MM-DD"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              :clearable="false"
              :shortcuts="dateShortcuts"
            />
          </el-form-item>

          <el-form-item label="项目" class="filters__project">
            <el-select
              v-model="selectedIds"
              class="select"
              multiple
              collapse-tags
              collapse-tags-tooltip
              clearable
              filterable
              placeholder="全部项目"
            >
              <el-option
                v-for="project in projectOptions"
                :key="project.id"
                :label="project.name"
                :value="project.id"
              >
                <span class="project-option">
                  <i
                    v-if="project.color"
                    class="project-option__dot"
                    :style="{ background: projectColorVar(project.color) }"
                  />
                  {{ project.name }}
                </span>
              </el-option>
            </el-select>
          </el-form-item>
        </div>
      </el-form>

      <PanelLoading v-if="loading" text="正在读取项目提交记录…" />

      <EmptyState
        v-else-if="!rows.length"
        compact
        :icon="DocumentAdd"
        :text="emptyText"
        :hint="emptyHint"
      />

      <template v-else>
        <p class="git__summary">
          {{ rows.length }} 条记录 · {{ commitCount }} 条提交
        </p>

        <p v-if="warnings.length" class="git__warn">
          {{ warnings.length }} 个项目读取失败：{{ warnings[0] }}
        </p>

        <ul class="git__list">
          <li v-for="row in rows" :key="`${row.projectId}-${row.date}`" class="draft">
            <div class="draft__head">
              <el-checkbox v-model="row.checked" />
              <span class="draft__project">
                <ProjectTag :name="row.projectName" :color="colorOf(row.projectId)" />
              </span>
              <span class="draft__date">{{ dayMeta(row.date, now).title }}</span>
              <span class="draft__count mono">{{ row.commits.length }} 条提交</span>
              <el-tag v-if="row.appendTo" class="draft__append" size="small" type="info" effect="plain">
                追加
              </el-tag>
            </div>

            <el-input
              v-model="row.content"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 8 }"
              resize="none"
            />
          </li>
        </ul>
      </template>
    </div>

    <template #footer>
      <el-button @click="open = false">
        取消
      </el-button>
      <el-button :disabled="!checkedCount || saving || loading" @click="commit(false)">
        添加并继续
      </el-button>
      <el-button type="primary" :disabled="!checkedCount || saving || loading" @click="commit(true)">
        {{ submitLabel }}
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.git {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-height: 220px;
}

/* 设备 + 日期 + 项目：设备与日期给固定宽度，项目吃掉剩下的地方 */
.filters {
  display: flex;
  gap: var(--sp-4);
}

.filters__device {
  flex: 0 0 160px;
}

.filters__date {
  flex: 0 0 300px;
}

.filters__project {
  flex: 1 1 auto;
  min-width: 0;
}

.filters__date :deep(.el-date-editor) {
  width: 100%;
}

/* el-select 的默认宽度是固定值，这一行里要它跟着格子走 */
.select {
  width: 100%;
}

/* 下拉选项里的项目：色点 + 名字，与项目卡上的圆点同色 */
.project-option {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}

.project-option__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.git__summary {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.git__warn {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--st-fail);
}

/* 草稿列表自己滚：多个项目一起生成时也不让弹窗长到屏幕外面 */
.git__list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-height: 52vh;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.draft {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
}

.draft__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.draft__date {
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.draft__count {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 项目名可能很长：限宽后只截断标签内容，日期与条数始终看得见 */
.draft__project {
  display: inline-flex;
  min-width: 0;
  max-width: 220px;
}

.draft__project :deep(.el-tag) {
  max-width: 100%;
}

.draft__project :deep(.el-tag__content) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「追加」这枚靠右：它说的是这条草稿的去向，不参与左侧的事实排列 */
.draft__append {
  margin-left: auto;
  flex-shrink: 0;
}
</style>
