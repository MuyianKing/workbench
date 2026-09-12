<script setup lang="ts">
/**
 * 添加 / 编辑一条命令。
 *
 * 只收三件事：名称、命令原文、可选的监听端口。命令没有工作目录配置，
 * 一律在用户主目录下执行 —— 这类命令多是全局 CLI，等价于新开一个终端直接敲它。
 */
import { computed, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { parsePort } from '@shared/port'
import { useProjectsStore } from '@/stores/projects'

const store = useProjectsStore()

const form = reactive({
  name: '',
  command: '',
  port: ''
})

const visible = computed({
  get: () => store.commandDialogVisible,
  set: (value: boolean) => store.setCommandDialogVisible(value)
})

const editing = computed(() => store.commandEditing)
const title = computed(() => (editing.value ? '编辑命令' : '添加命令'))

/** 端口写了但不是 1–65535 的整数：既拦提交，也让下面的提示出现 */
const portInvalid = computed(() => !!form.port.trim() && !parsePort(form.port))

const canSubmit = computed(
  () => !!form.name.trim() && !!form.command.trim() && !portInvalid.value
)

/** 打开弹窗时按当前模式填值：编辑就回填已有配置，新增就是一张白纸 */
function reset(): void {
  const entry = store.commandEditing
  form.name = entry?.name ?? ''
  form.command = entry?.command ?? ''
  form.port = entry?.port ? String(entry.port) : ''
}

watch(
  () => store.commandDialogVisible,
  (open) => {
    if (open) reset()
  }
)

async function submit(): Promise<void> {
  if (!canSubmit.value) return

  const payload = {
    name: form.name.trim(),
    command: form.command.trim(),
    // 留空表示「不检测」：显式送 null，主进程才知道要把它清掉
    port: form.port.trim() ? parsePort(form.port) : null
  }

  const current = editing.value
  const done = current
    ? await store.updateCommand(current.id, payload)
    : await store.addCommand(payload)

  if (done) visible.value = false
}

function onPortBlur(): void {
  if (portInvalid.value) ElMessage.warning('监听端口需要是 1–65535 的整数')
}
</script>

<template>
  <!-- append-to-body：弹层必须离开 .app 子树，否则会被顶部毛玻璃的 backdrop-filter 连累（见 global.css 弹层一节） -->
  <el-dialog
    v-model="visible"
    :title="title"
    width="520"
    align-center
    append-to-body
    :close-on-click-modal="false"
    @closed="reset"
  >
    <div class="form">
      <div class="field">
        <label class="field__label">名称</label>
        <el-input v-model="form.name" placeholder="显示在卡片上的名字" />
      </div>

      <div class="field">
        <label class="field__label">命令</label>
        <el-input
          v-model="form.command"
          placeholder="npx @deepseek-ai/dsh web"
          spellcheck="false"
        />
        <p class="field__hint">
          整行原样交给系统 shell，在用户主目录下执行；不能包含换行（一行只跑一条命令）。
        </p>
      </div>

      <div class="field">
        <label class="field__label">监听端口</label>
        <el-input
          v-model="form.port"
          placeholder="留空表示不检测"
          spellcheck="false"
          @blur="onPortBlur"
        />
        <p class="field__hint" :class="{ 'is-invalid': portInvalid }">
          <template v-if="portInvalid">监听端口需要是 1–65535 的整数。</template>
          <template v-else>
            命令的服务端口。填了才能判断它是否已经在运行 —— 包括在 Workbench 之外启动、
            至今还占着端口的那种。
          </template>
        </p>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">
        {{ editing ? '保存' : '添加' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.field__label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.field__hint {
  margin-top: 5px;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--ink-3);
}

.field__hint.is-invalid {
  color: var(--st-fail);
}
</style>
