<script setup lang="ts">
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
import type { DesignStyle } from '@shared/design-styles'
import { DESIGN_FILE_NAME, designMarkdown, designPrompt } from '@shared/design-export'
import AppDialog from '@/components/AppDialog.vue'
import { notifyError, notifySuccess, notifyWarning } from '@/notify'
import { useProjectsStore } from '@/stores/projects'

const props = defineProps<{ open: boolean; design: DesignStyle | null }>()
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()

const projects = useProjectsStore()

const selectedId = ref('')
const applying = ref(false)

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

const selected = computed(
  () => projects.projects.find((project) => project.id === selectedId.value) ?? null
)

watch(
  () => props.open,
  (value) => {
    if (value) {
      selectedId.value = ''
      applying.value = false
    }
  }
)

async function submit(): Promise<void> {
  const project = selected.value
  const design = props.design
  if (!project || !design || applying.value) return

  applying.value = true
  const written = await window.workbench.writeDesign(project.path, designMarkdown(design))
  applying.value = false
  if (!written.ok) {
    notifyError(written.error ?? `写入 ${DESIGN_FILE_NAME} 失败`)
    return
  }

  let copied = true
  try {
    await navigator.clipboard.writeText(designPrompt(design))
  } catch {
    copied = false
  }

  const verb = written.data?.existed ? '已覆盖' : '已写入'
  notifySuccess(
    `${verb}「${project.name}」的 ${DESIGN_FILE_NAME}${copied ? '，提示词已复制到剪贴板' : ''}`
  )
  if (!copied) {
    notifyWarning('提示词没能写进剪贴板，可以在规格档里手动复制')
  }
  visible.value = false
}
</script>

<template>
  <AppDialog v-model="visible" :title="`把「${design?.title ?? ''}」应用到项目`" width="520px">
    <p class="intro">
      会把这份设计规范写成 <code class="mono">{{ DESIGN_FILE_NAME }}</code> 放进项目根目录
      （已有同名文件会被覆盖），同时把一段「照这份规范实现界面」的提示词复制到剪贴板，
      粘给 AI 编码助手即可。
    </p>

    <div v-if="!projects.projects.length" class="state">
      还没有项目。先把项目加进来，再回来应用。
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
        <template v-if="selected">
          写到 <code class="mono">{{ selected.path }}\{{ DESIGN_FILE_NAME }}</code>
        </template>
        <template v-else>选一个项目。规范按这套设计的 token 现生成，不联网。</template>
      </p>
    </template>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="applying" :disabled="!selectedId" @click="submit">
        写入并复制提示词
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
  overflow-wrap: anywhere;
}
</style>
