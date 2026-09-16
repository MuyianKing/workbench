<script setup lang="ts">
/**
 * 写一条工作记录（新增 / 编辑）。
 *
 * 三件事：哪一天（日期）、属于哪个项目（下拉取自项目列表，非必填）、做了什么（必填，markdown）。
 * 正文在「编写 / 预览」之间切换，预览用的就是记录展示时那套渲染（shared/markdown.ts），
 * 写的时候看到什么样，时间轴上就是什么样。
 *
 * 数据写入由这个弹窗自己负责（它是这次业务动作的发起方），落库成功后再把结果抛给页面。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { dayKey } from '@shared/activity'
import { projectColorVar, sanitizeProjectColor } from '@shared/project-color'
import { WORK_STATUSES, WORK_STATUS_DEFAULT, WORK_STATUS_LABELS } from '@shared/work-log'
import { useProjectsStore } from '@/stores/projects'
import MarkdownView from '@/components/MarkdownView.vue'
import type { WorkLogEntry } from '@/types'

const props = defineProps<{
  modelValue: boolean
  /** 编辑对象；null 表示新增 */
  entry: WorkLogEntry | null
  /** 新增时的默认日期（跟随当前时间范围，例如停在「昨天」时默认记到昨天） */
  defaultDate: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 保存成功；页面据此把这条记录并进列表 */
  saved: [entry: WorkLogEntry]
}>()

const store = useProjectsStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const form = reactive({
  date: '',
  projectId: '',
  content: '',
  status: WORK_STATUS_DEFAULT
})

/** 预览态：写的时候不用离开弹窗就能看渲染结果 */
const mode = ref<'write' | 'preview'>('write')
/** 两处分段控件的选项（Element Plus 的分段控件要 { label, value }） */
const statusOptions = WORK_STATUSES.map((value) => ({ label: WORK_STATUS_LABELS[value], value }))
const modeOptions = [
  { label: '编写', value: 'write' },
  { label: '预览', value: 'preview' }
]
const saving = ref(false)

const editing = computed(() => props.entry)
const title = computed(() => (editing.value ? '编辑工作记录' : '记一条工作记录'))
const canSubmit = computed(() => !!form.content.trim() && !saving.value)

/**
 * 下拉里的项目。
 *
 * 记录关联的项目可能已经被删掉，这时补一个占位项：不补的话下拉会显示成空值，
 * 用户以为「本来就没关联」，一保存就把这条记录的项目关联悄悄清掉了。
 */
const projects = computed(() => {
  const list = store.projects.map((project) => ({
    id: project.id,
    name: project.name,
    color: sanitizeProjectColor(project.color)
  }))
  const current = form.projectId
  if (current && !list.some((item) => item.id === current)) {
    list.unshift({ id: current, name: '已删除的项目', color: undefined })
  }
  return list
})

/** 打开弹窗时按当前模式填值：编辑回填，新增给一张白纸（日期用页面给的默认值） */
function reset(): void {
  const entry = props.entry
  form.date = entry?.date ?? (props.defaultDate || dayKey(Date.now()))
  form.projectId = entry?.projectId ?? ''
  form.content = entry?.content ?? ''
  // 新增默认「已完成」（写下这条时事情多半已经做完了），要记待办就点一下
  form.status = entry?.status ?? WORK_STATUS_DEFAULT
  mode.value = 'write'
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
  }
)

async function submit(): Promise<void> {
  if (!canSubmit.value) return

  const payload = {
    date: form.date || dayKey(Date.now()),
    projectId: form.projectId || undefined,
    content: form.content.trim(),
    status: form.status
  }

  saving.value = true
  try {
    const current = props.entry
    const result = current
      ? await window.workbench.updateWorkLog(current.id, {
          date: payload.date,
          // 清空下拉 = 解除关联：显式传 null，主进程才知道要把这个字段摘掉
          projectId: form.projectId || null,
          content: payload.content,
          status: payload.status
        })
      : await window.workbench.addWorkLog(payload)

    if (!result.ok || !result.data) {
      ElMessage.error(result.error ?? '保存工作记录失败')
      return
    }

    emit('saved', result.data)
    ElMessage.success(current ? '已保存' : '已记录')
    visible.value = false
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- append-to-body：弹层必须离开 .app 子树，否则会被顶部毛玻璃的 backdrop-filter 连累（见 global.css 弹层一节） -->
  <el-dialog
    v-model="visible"
    :title="title"
    width="640"
    align-center
    append-to-body
    :close-on-click-modal="false"
    @closed="reset"
  >
    <el-form class="form" :model="form" label-position="top" @submit.prevent>
      <div class="form__row">
        <el-form-item label="日期" class="field--date">
          <el-date-picker
            v-model="form.date"
            type="date"
            value-format="YYYY-MM-DD"
            format="YYYY-MM-DD"
            :clearable="false"
            placeholder="选择日期"
          />
        </el-form-item>

        <el-form-item label="所属项目" class="field--project">
          <el-select
            v-model="form.projectId"
            class="select"
            clearable
            filterable
            placeholder="不关联项目"
          >
            <el-option
              v-for="project in projects"
              :key="project.id"
              :label="project.name"
              :value="project.id"
            >
              <!-- 与项目卡、时间轴上的标签同一个颜色：选的时候就能对上号 -->
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

        <!-- 状态：默认「已完成」，要记一条待办就点过去；时间轴上点记录也能改 -->
        <el-form-item label="状态" class="field--status">
          <el-segmented
            v-model="form.status"
            class="tabs"
            :options="statusOptions"
            aria-label="状态"
          />
        </el-form-item>
      </div>


      <el-form-item class="field--content">
        <template #label>
          <span class="field__head">
            <span>工作内容</span>
            <el-segmented
              v-model="mode"
              class="tabs"
              :options="modeOptions"
              aria-label="编辑或预览"
            />
          </span>
        </template>

        <!-- 正文与下面那行说明必须包在 .field__stack 里：.el-form-item__content 是 flex 行，
             说明直接当它的兄弟节点时，会按内容宽度和正文挤在同一行，正文被压成一小条 -->
        <div class="field__stack">
          <el-input
            v-if="mode === 'write'"
            v-model="form.content"
            type="textarea"
            :rows="8"
            resize="vertical"
            placeholder="做了什么、卡在哪、下一步…（支持 markdown：标题、列表、**粗体**、`代码`、链接）"
          />
          <!-- 预览区高度跟着写的那份走，切换时块不会突然长高变矮 -->
          <div v-else class="preview">
            <MarkdownView v-if="form.content.trim()" :source="form.content" />
            <p v-else class="preview__empty">还没有内容</p>
          </div>

          <p class="field__hint" :class="{ 'is-invalid': !form.content.trim() }">
            <template v-if="!form.content.trim()">工作内容是必填项。</template>
            <template v-else>支持 markdown 语法，时间轴上按这里的预览渲染。</template>
          </p>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">
        {{ editing ? '保存' : '记录' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* .form（竖排 + 间距）在 global.css 的「弹窗表单」一节 */
.form__row {
  display: flex;
  gap: var(--sp-4);
}

.form__row .field--date {
  flex: 0 0 160px;
}

/* 状态是两档的分段控件，给一个刚好的宽度，别让它跟着格子拉伸 */
.form__row .field--status {
  flex: 0 0 auto;
}

.form__row .field--project {
  flex: 1 1 auto;
  min-width: 0;
}

/* 「工作内容」那行：标签撑满整行当容器用，行内左边是文字、右边是「编写 / 预览」 */
.field--content :deep(.el-form-item__label) {
  display: block;
  width: 100%;
}

.field__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
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

/* 日期选择器同理 */
.field--date :deep(.el-date-editor) {
  width: 100%;
}



/* 编辑 / 预览的分段控件：与工作页头部的范围切换同一副样子 */
/* 两处分段控件用 el-segmented：外壳（底色 / 圆角 / 选中态）在 global.css，
   这里只留这一处的字号与内边距 */
.tabs.el-segmented {
  font-size: var(--fs-micro);
}

.tabs :deep(.el-segmented__item) {
  padding: 1px 10px;
}

/* 预览块：与输入框同一档高度，高度写死才不会在切换时抖动 */
.preview {
  height: 178px;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  overflow-y: auto;
}

.preview__empty {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}


</style>
