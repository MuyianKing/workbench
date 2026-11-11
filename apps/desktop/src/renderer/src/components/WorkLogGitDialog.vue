<script setup lang="ts">
import type { ProjectColor } from '@workbench/core'
import type { GitWorkLogDraft, GitWorkLogInput, WorkLogEntry, WorkRange } from '@workbench/work-log'
import { DocumentAdd } from '@element-plus/icons-vue'
import { sanitizeProjectColor } from '@workbench/core'
import { buildGitDrafts, dateOfDayKey, dayMeta, rangeBounds, WORK_RANGE_LABELS } from '@workbench/work-log'
import { ElMessage } from 'element-plus'
/**
 * 从项目仓库的提交生成工作记录（预览后写入）。
 *
 * 读提交、分组、去重都在 `@workbench/work-log` 的 `git-import.ts` 里（纯逻辑，有单测）；
 * 这个弹窗只做三件事：按当前范围逐个项目读、把草稿摆出来让人改、确认后交给适配层写入。
 *
 * 一个项目一天一条：同项目同一天已经有生成记录时标「追加」，新提交接在它后面；
 * 否则新建一条「已完成」。勾掉的行不写，正文被清空的行也跳过。
 */
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import EmptyState from '@/components/EmptyState.vue'
import PanelLoading from '@/components/PanelLoading.vue'
import ProjectTag from '@/components/ProjectTag.vue'

/** 预览里的一行：草稿 + 勾选状态（只有界面用，不落盘） */
interface DraftRow extends GitWorkLogDraft {
  checked: boolean
}

const props = defineProps<{
  /** 项目列表（取数用；颜色只用于预览里的标签） */
  projects: { id: string, name: string, path: string, color?: ProjectColor }[]
  /** 当前工作日志（去重与「追加到哪条」都靠它） */
  entries: readonly WorkLogEntry[]
  /** 当前范围；「待办」不是时段，页面不会在这一档打开这个弹窗 */
  range: Exclude<WorkRange, 'todo'>
  /** 页面的「现在」：范围边界与日期标题都按它算 */
  now: number
}>()

const emit = defineEmits<{
  /** 写入成功后把新建 / 改动过的记录交给页面并进内存列表 */
  imported: [entries: WorkLogEntry[]]
}>()

const open = defineModel<boolean>({ required: true })

const rows = ref<DraftRow[]>([])
const loading = ref(false)
const saving = ref(false)
/** 读取失败的项目（部分失败不影响其余项目生成） */
const warnings = ref<string[]>([])

const checkedCount = computed(() => rows.value.filter(row => row.checked).length)
const submitLabel = computed(() => (checkedCount.value ? `生成 ${checkedCount.value} 条` : '生成'))
const emptyText = computed(() => `${WORK_RANGE_LABELS[props.range]}没有可导入的提交`)
/** 空态第二行：先说是哪个项目出了问题，再退回「为什么没有」的常规解释 */
const emptyHint = computed(() => {
  if (warnings.value.length)
    return warnings.value[0]
  if (!props.projects.length)
    return '项目列表是空的。'
  return '已导入过的提交不会重复出现。'
})

/** 项目色：预览里的标签与时间轴上那枚同一个来源 */
function colorOf(projectId: string): ProjectColor | undefined {
  return sanitizeProjectColor(props.projects.find(project => project.id === projectId)?.color)
}

/**
 * git `--since` 的粗筛点（毫秒）。
 *
 * 从范围起始日的本地零点再往前放一天：`--since` 按提交时间算，而分组按作者时间，
 * 两者在 rebase / cherry-pick 之后会差开；多放一天只是让 git 多回几条，
 * 精确的日期过滤在 `buildGitDrafts` 里按作者时间做。
 */
function sinceOf(range: Exclude<WorkRange, 'todo'>, now: number): number | undefined {
  const start = dateOfDayKey(rangeBounds(range, now).from).getTime()
  return Number.isFinite(start) ? start - 86_400_000 : undefined
}

async function load(): Promise<void> {
  loading.value = true
  rows.value = []
  warnings.value = []

  try {
    const since = sinceOf(props.range, props.now)
    const reads = await Promise.all(props.projects.map(async (project) => {
      if (!project.path.trim())
        return { project, result: null }
      return { project, result: await window.workbench.projectGitLog(project.path, since) }
    }))

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

    rows.value = buildGitDrafts(inputs, props.range, props.now, props.entries)
      .map(draft => ({ ...draft, checked: true }))
  }
  finally {
    loading.value = false
  }
}

watch(open, (value) => {
  if (value)
    void load()
})

function reset(): void {
  rows.value = []
  warnings.value = []
}

async function submit(): Promise<void> {
  if (saving.value)
    return

  const picked = rows.value
    .filter(row => row.checked && row.content.trim())
    .map(({ checked: _checked, ...draft }) => draft)
  if (!picked.length) {
    ElMessage.warning('没有勾选可生成的内容')
    return
  }

  saving.value = true
  try {
    const result = await window.workbench.importGitDrafts(picked)
    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '生成工作记录失败')
      return
    }

    emit('imported', result.data)
    ElMessage.success(`已生成 ${result.data.length} 条工作记录`)
    open.value = false
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
          {{ WORK_RANGE_LABELS[range] }} · {{ rows.length }} 条记录 ·
          {{ rows.reduce((sum, row) => sum + row.commits.length, 0) }} 条提交
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
      <el-button type="primary" :disabled="!checkedCount || saving" @click="submit">
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

/* 草稿列表自己滚：范围一拉大（本月 × 多项目）也不让弹窗长到屏幕外面 */
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
