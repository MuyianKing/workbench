<script setup lang="ts">
import { SKILL_INSTALL_DIR } from '@workbench/skills'
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import ProjectPickList from '@/components/ProjectPickList.vue'
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
  }
  if (!selectedIds.value.length)
    visible.value = false
}
</script>

<template>
  <AppDialog
    v-model="visible"
    :title="`安装「${skillName}」到项目`"
    width="520px"
    :show-close="!installing"
    :close-on-click-modal="!installing"
    :close-on-press-escape="!installing"
  >
    <ProjectPickList
      v-model="selectedIds"
      :projects="projects.projects"
      :disabled="installing"
      empty-text="还没有项目。先把项目加进来，再回来装。"
    />
    <p v-if="projects.projects.length" class="hint">
      安装目录 <code class="mono">{{ SKILL_INSTALL_DIR }}/{{ skillId }}</code>
      <span>已有同名技能会先确认覆盖</span>
    </p>
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
.hint {
  margin: var(--sp-3) 0 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.6;
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
</style>
