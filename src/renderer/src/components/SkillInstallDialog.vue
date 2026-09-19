<script setup lang="ts">
/**
 * 安装到项目的弹层：列出本机项目，选一个装进去（复制到 `<项目>/.agents/skills/<技能名>/`）。
 *
 * 「已安装」不在打开时预查：安装那次调用由 Rust 报回来，弹窗拿这个错误去问
 * 「要不要覆盖」—— 覆盖会把项目里那份整个换成库里的当前版本，必须经过确认。
 */
import { computed, ref, watch } from 'vue'
import { SKILL_INSTALL_DIR } from '@shared/skills'
import { confirmAction, notifyError, notifySuccess } from '@/notify'
import { useProjectsStore } from '@/stores/projects'
import { useSkillsStore } from '@/stores/skills'

const props = defineProps<{ open: boolean; skillId: string; skillName: string }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const projects = useProjectsStore()
const store = useSkillsStore()

const selectedId = ref('')
const installing = ref(false)

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

watch(
  () => props.open,
  (value) => {
    if (value) {
      selectedId.value = ''
      installing.value = false
    }
  }
)

async function submit(): Promise<void> {
  const project = projects.projects.find((item) => item.id === selectedId.value)
  if (!project || installing.value) return

  installing.value = true
  const first = await store.install(props.skillId, project.path, false)
  if (first.ok) {
    installing.value = false
    notifySuccess(`已安装到「${project.name}」`)
    visible.value = false
    return
  }

  // 只有「已安装」这一种错误值得追问一句；别的（路径不在了、技能没有清单）照实报
  if (!/已经装/.test(first.error ?? '')) {
    installing.value = false
    notifyError(first.error ?? '安装失败')
    return
  }

  installing.value = false
  const overwrite = await confirmAction(
    `「${props.skillId}」已经装在「${project.name}」里了。覆盖后项目里的那份会被整个换成库里的当前版本。`,
    '要覆盖吗？',
    { confirmButtonText: '覆盖' }
  )
  if (!overwrite) return

  installing.value = true
  const retry = await store.install(props.skillId, project.path, true)
  installing.value = false
  if (retry.ok) {
    notifySuccess(`已覆盖「${project.name}」里的安装`)
    visible.value = false
  } else {
    notifyError(retry.error ?? '安装失败')
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="`安装「${skillName}」到项目`" width="520px" append-to-body>
    <div v-if="!projects.projects.length" class="state">
      还没有项目。先把项目加进来，再回来装。
    </div>
    <template v-else>
      <div class="list" role="radiogroup" aria-label="选择项目">
        <button
          v-for="project in projects.projects"
          :key="project.id"
          class="list__item"
          type="button"
          role="radio"
          :aria-checked="selectedId === project.id"
          :class="{ 'is-active': selectedId === project.id }"
          @click="selectedId = project.id"
        >
          <span class="list__name">{{ project.name }}</span>
          <span class="list__path mono" :title="project.path">{{ project.path }}</span>
        </button>
      </div>
      <p class="hint">
        装到 <code class="mono">{{ SKILL_INSTALL_DIR }}/{{ props.skillId }}</code> ——
        项目里已有的同名技能需要确认后才会覆盖。
      </p>
    </template>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="installing"
        :disabled="!selectedId"
        @click="submit"
      >
        安装
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.state {
  padding: var(--sp-4) 0;
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
  margin-bottom: var(--sp-3);
}

.list__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--r-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.list__item:hover {
  background: var(--bg-inset);
}

.list__item.is-active {
  background: var(--bg-selected);
  border-color: var(--border);
}

.list__name {
  color: var(--ink);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.list__path {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.6;
}
</style>
