<script setup lang="ts">
import type { DesignStyle } from '@workbench/appearance'
import { DESIGN_FILE_NAME, designMarkdown, designPrompt } from '@workbench/appearance'
/**
 * 应用到项目的弹层：把一套设计规范写进选中的项目，顺带把给 AI 的提示词放进剪贴板。
 *
 * 两件事的顺序是有意的：**先写文件，写成了才动剪贴板** —— 文件都没落下去，剪贴板里却留下一段
 * 「请读 DESIGN.md」的提示词，只会误导人。剪贴板失败不算整体失败（规范已经在项目里了），
 * 单独提醒一句，用户自己选中复制即可。
 *
 * 同名文件直接覆盖（宿主只回报「原本有没有」），所以文案在写之前就说明这件事，而不是写完再问 ——
 * 用户点的是「应用这份规范」，覆盖自己上一版是预期内的动作。
 */
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import ProjectPickList from '@/components/ProjectPickList.vue'
import { notifyError, notifySuccess, notifyWarning } from '@/notify'
import { useProjectsStore } from '@/stores/projects'

const props = defineProps<{ design: DesignStyle | null }>()

/** 弹层开关:v-model 一条口径(与 AppDialog / el-dialog 相同,全应用的弹层都这么开) */
const open = defineModel<boolean>({ required: true })

const projects = useProjectsStore()

const selectedIds = ref<string[]>([])
const applying = ref(false)
const failures = ref<Array<{ id: string, name: string, error: string }>>([])

const visible = computed({
  get: () => open.value,
  set: (value) => {
    if (!applying.value)
      open.value = value
  },
})

const selected = computed(
  () => projects.projects.filter(project => selectedIds.value.includes(project.id)),
)

watch(open, (value) => {
  if (value) {
    selectedIds.value = []
    failures.value = []
  }
})

async function submit(): Promise<void> {
  const targets = [...selected.value]
  const design = props.design
  if (!targets.length || !design || applying.value)
    return

  applying.value = true
  failures.value = []
  let succeeded = 0
  let overwritten = 0
  try {
    const markdown = designMarkdown(design)
    for (const project of targets) {
      const written = await window.workbench.writeDesign(project.path, markdown)
      if (written.ok) {
        succeeded++
        if (written.data?.existed)
          overwritten++
      }
      else {
        failures.value.push({ id: project.id, name: project.name, error: written.error ?? `写入 ${DESIGN_FILE_NAME} 失败` })
      }
    }

    selectedIds.value = failures.value.map(project => project.id)
    let copied = false
    if (succeeded) {
      try {
        await navigator.clipboard.writeText(designPrompt(design))
        copied = true
      }
      catch {
        notifyWarning('提示词没能写进剪贴板，可以在规格档里手动复制')
      }
    }

    const summary = [`已写入 ${succeeded} 个项目`]
    if (overwritten)
      summary.push(`覆盖 ${overwritten} 个`)
    if (failures.value.length)
      summary.push(`失败 ${failures.value.length} 个`)
    if (copied)
      summary.push('提示词已复制')
    if (!failures.value.length)
      notifySuccess(summary.join('，'))
    else if (succeeded)
      notifyWarning(summary.join('，'))
    else
      notifyError(summary.join('，'))
  }
  finally {
    applying.value = false
  }
  if (!failures.value.length)
    visible.value = false
}
</script>

<template>
  <AppDialog
    v-model="visible"
    :title="`把「${design?.title ?? ''}」应用到项目`"
    width="520px"
    :show-close="!applying"
    :close-on-click-modal="!applying"
    :close-on-press-escape="!applying"
  >
    <p class="intro">
      写入 <code class="mono">{{ DESIGN_FILE_NAME }}</code>（已有同名文件会被覆盖），并复制提示词到剪贴板。
    </p>

    <ProjectPickList
      v-model="selectedIds"
      :projects="projects.projects"
      :disabled="applying"
      empty-text="还没有项目。先把项目加进来，再回来应用。"
    />
    <p v-if="selected.length === 1" class="hint">
      写到 <code class="mono">{{ selected[0].path }}\{{ DESIGN_FILE_NAME }}</code>
    </p>
    <div v-if="failures.length" class="failures" role="status">
      <p v-for="failure in failures" :key="failure.id">
        {{ failure.name }}：{{ failure.error }}
      </p>
    </div>

    <template #footer>
      <el-button :disabled="applying" @click="visible = false">
        取消
      </el-button>
      <el-button type="primary" :loading="applying" :disabled="!selected.length" @click="submit">
        写入并复制提示词{{ selected.length ? `（${selected.length}）` : '' }}
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.intro {
  margin: 0 0 var(--sp-3);
  color: var(--ink-2);
  font-size: var(--fs-meta);
  line-height: 1.7;
}

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
