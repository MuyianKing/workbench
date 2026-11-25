<script setup lang="ts">
import { Check, FolderOpened } from '@element-plus/icons-vue'
import { projectColorVar, sanitizeProjectColor } from '@workbench/core'
import { SKILL_INSTALL_DIR } from '@workbench/skills'
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import EmptyState from '@/components/EmptyState.vue'
import { confirmAction, notifyError, notifySuccess, notifyWarning } from '@/notify'
import { useProjectsStore } from '@/stores/projects'
import { useSkillsStore } from '@/stores/skills'

const props = defineProps<{ skillId: string, skillName: string }>()
const open = defineModel<boolean>({ required: true })

const projects = useProjectsStore()
const store = useSkillsStore()
const selectedIds = ref<string[]>([])
const installing = ref(false)
const failures = ref<Array<{ id: string, name: string, error: string }>>([])
const selected = computed(() => projects.projects.filter(project => selectedIds.value.includes(project.id)))

const visible = computed({
  get: () => open.value,
  set: (value) => {
    if (!installing.value)
      open.value = value
  },
})

watch(open, (value) => {
  if (value) {
    selectedIds.value = []
    failures.value = []
  }
})

function toggle(id: string): void {
  if (installing.value)
    return
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter(item => item !== id)
    : [...selectedIds.value, id]
}

function selectAll(): void {
  selectedIds.value = projects.projects.map(project => project.id)
}

function clearSelection(): void {
  selectedIds.value = []
}

/** 标识色的取用口径在 packages/core/src/project-color.ts，这里只管画出来 */
function colorVarOf(color: string | null | undefined): string {
  const value = sanitizeProjectColor(color ?? undefined)
  return value ? projectColorVar(value) : 'var(--border-strong)'
}

async function submit(): Promise<void> {
  const targets = [...selected.value]
  const skillId = props.skillId
  if (!targets.length || installing.value)
    return

  installing.value = true
  failures.value = []
  let succeeded = 0
  const conflicts: typeof targets = []
  let skipped: string[] = []
  try {
    for (const project of targets) {
      const result = await store.install(skillId, project.path, false)
      if (result.ok)
        succeeded++
      else if (/已经装/.test(result.error ?? ''))
        conflicts.push(project)
      else
        failures.value.push({ id: project.id, name: project.name, error: result.error ?? '安装失败' })
    }

    if (conflicts.length) {
      const overwrite = await confirmAction(
        `以下项目已安装「${skillId}」：${conflicts.map(project => `「${project.name}」`).join('、')}。覆盖后，这些项目里的整份技能目录会被替换为库中的当前版本。`,
        '要覆盖吗？',
        { confirmButtonText: '覆盖', cancelButtonText: '跳过' },
      )
      if (overwrite) {
        for (const project of conflicts) {
          const result = await store.install(skillId, project.path, true)
          if (result.ok)
            succeeded++
          else
            failures.value.push({ id: project.id, name: project.name, error: result.error ?? '覆盖失败' })
        }
      }
      else {
        skipped = conflicts.map(project => project.id)
      }
    }

    selectedIds.value = [...failures.value.map(project => project.id), ...skipped]
    const summary = [`已安装 ${succeeded} 个项目`]
    if (failures.value.length)
      summary.push(`失败 ${failures.value.length} 个`)
    if (skipped.length)
      summary.push(`跳过 ${skipped.length} 个`)
    if (!selectedIds.value.length)
      notifySuccess(summary.join('，'))
    else if (succeeded || skipped.length)
      notifyWarning(summary.join('，'))
    else
      notifyError(summary.join('，'))
  }
  finally {
    installing.value = false
    // 装进去的副本与库一致：重扫一遍卡片上的「项目有更新」徽标，刚装的那张要跟着消掉
    store.refreshCopyBadges()
  }
  if (!selectedIds.value.length)
    visible.value = false
}
</script>

<template>
  <AppDialog
    v-model="visible"
    :title="`安装「${skillName}」到项目`"
    width="620px"
    :show-close="!installing"
    :close-on-click-modal="!installing"
    :close-on-press-escape="!installing"
  >
    <div class="lead">
      <span class="lead__badge" aria-hidden="true">
        {{ skillName.slice(0, 1).toUpperCase() }}
      </span>
      <div class="lead__text">
        <strong class="lead__name truncate">{{ skillName }}</strong>
        <span class="lead__sub">选择要安装的项目，可多选</span>
      </div>
    </div>

    <div class="picker__bar">
      <span class="picker__title">目标项目</span>
      <span class="picker__count">已选 <b>{{ selected.length }}</b> / {{ projects.projects.length }}</span>
      <div class="picker__tools">
        <el-button text :disabled="installing || !projects.projects.length" @click="selectAll">
          全选
        </el-button>
        <el-button text :disabled="installing || !selected.length" @click="clearSelection">
          清空
        </el-button>
      </div>
    </div>

    <EmptyState
      v-if="!projects.projects.length"
      compact
      :icon="FolderOpened"
      text="还没有项目"
      hint="先把项目加进来，再回来装。"
    />
    <div v-else class="picker" role="group" aria-label="选择项目">
      <button
        v-for="project in projects.projects"
        :key="project.id"
        class="picker__row"
        type="button"
        :aria-pressed="selectedIds.includes(project.id)"
        :disabled="installing"
        :class="{ 'is-active': selectedIds.includes(project.id) }"
        @click="toggle(project.id)"
      >
        <i class="picker__dot" :style="{ background: colorVarOf(project.color) }" aria-hidden="true" />
        <span class="picker__name truncate" :title="project.name">{{ project.name }}</span>
        <span class="picker__path mono truncate" :title="project.path">{{ project.path }}</span>
        <span class="picker__check" aria-hidden="true">
          <el-icon><Check /></el-icon>
        </span>
      </button>
    </div>

    <div class="dest">
      <div class="dest__row">
        <span>安装目录</span>
        <code class="mono">{{ SKILL_INSTALL_DIR }}/{{ skillId }}</code>
      </div>
      <div class="dest__row">
        <span>同名技能</span>
        <span>会先确认覆盖</span>
      </div>
    </div>

    <div v-if="failures.length" class="failures" role="status">
      <p v-for="failure in failures" :key="failure.id">
        {{ failure.name }}：{{ failure.error }}
      </p>
    </div>

    <template #footer>
      <el-button :disabled="installing" @click="visible = false">
        取消
      </el-button>
      <el-button
        type="primary"
        class="install-btn"
        :loading="installing"
        :disabled="!selected.length"
        @click="submit"
      >
        安装{{ selected.length ? `（${selected.length}）` : '' }}
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
/* 技能标识条：一眼确认装的是什么，不靠读标题 */
.lead {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
}

.lead__badge {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: var(--r-md);
  background: var(--bg-surface);
  box-shadow: var(--shadow-card);
  color: var(--ink);
  font-size: var(--fs-title);
  font-weight: 700;
}

.lead__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lead__name {
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
}

.lead__sub {
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 工具行：计数与全选/清空贴右端，与标题同一行 */
.picker__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-5) 0 var(--sp-3);
}

.picker__title {
  color: var(--ink-2);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.picker__count {
  margin-left: auto;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.picker__count b {
  color: var(--ink);
  font-weight: 700;
}

.picker__tools {
  display: flex;
  gap: var(--sp-1);
}

.picker__tools :deep(.el-button) {
  height: 26px;
  padding: 0 var(--sp-2);
  font-size: var(--fs-meta);
}

/* 列表不画外框：行本身是卡片，选中态用底色 + 描边，不用发丝线堆成表格 */
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
}

.picker__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-width: 0;
  padding: var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}

.picker__row:hover:not(:disabled) {
  background: var(--bg-subtle);
}

.picker__row:disabled {
  cursor: default;
}

.picker__row.is-active {
  border-color: var(--border-strong);
  background: var(--bg-selected);
}

/* 标识色点：与项目卡、工作日志里选项目那处的圆点同一个口径 */
.picker__dot {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

/* 名字先让位（最多吃掉四成半），路径跟着缩，两边都省略号收尾 */
.picker__name {
  flex: 0 1 auto;
  max-width: 45%;
  color: var(--ink);
  font-size: var(--fs-body);
  font-weight: 600;
}

.picker__path {
  flex: 1 1 auto;
  min-width: 0;
  text-align: right;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 勾选圈常驻占宽：未选是空心灰圈，选中是实心墨底白勾 —— 一眼数清选了几个 */
.picker__check {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  color: transparent;
  font-size: var(--fs-meta);
}

.picker__row.is-active .picker__check {
  border-color: transparent;
  background: var(--ink);
  color: var(--ink-inverse);
}

/* 安装位置单独成块，跟选择区分开：这是提交前最后要确认的事实 */
.dest {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border);
  font-size: var(--fs-meta);
}

.dest__row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}

.dest__row > span:first-child {
  flex-shrink: 0;
  min-width: 56px;
  color: var(--ink-3);
}

.dest__row > :last-child {
  color: var(--ink-2);
}

.dest code {
  overflow-wrap: anywhere;
}

.failures {
  margin-top: var(--sp-3);
  color: var(--st-fail);
  font-size: var(--fs-meta);
  overflow-wrap: anywhere;
}

.failures p {
  margin: var(--sp-1) 0 0;
}

.install-btn {
  min-width: 116px;
}
</style>
