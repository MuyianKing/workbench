<script setup lang="ts">
/**
 * 添加 / 编辑一条命令。
 *
 * 只收三件事：名称、命令原文、可选的监听端口。命令没有工作目录配置，
 * 一律在用户主目录下执行 —— 这类命令多是全局 CLI，等价于新开一个终端直接敲它。
 */
import { computed, reactive, watch } from 'vue'
import type { FormRules } from 'element-plus'
import { parsePort } from '@shared/port'
import AppDialog from '@/components/AppDialog.vue'
import { useProjectsStore } from '@/stores/projects'
import { useCatalogStore } from '@/stores/catalog'

const store = useProjectsStore()
const catalog = useCatalogStore()

const form = reactive({
  name: '',
  command: '',
  port: ''
})

const visible = computed({
  get: () => catalog.commandDialogVisible,
  set: (value: boolean) => catalog.setCommandDialogVisible(value)
})

const editing = computed(() => catalog.commandEditing)
const title = computed(() => (editing.value ? '编辑命令' : '添加命令'))

/** 端口写了但不是 1–65535 的整数：既拦提交，也让下面的提示出现 */
const portInvalid = computed(() => !!form.port.trim() && !parsePort(form.port))

const canSubmit = computed(
  () => !!form.name.trim() && !!form.command.trim() && !portInvalid.value
)

/**
 * 校验规则：名称与命令必填，端口留空表示不检测、填了就必须是 1–65535。
 * 失败原因由 el-form 就地显示在字段下面（原来只有那行小字变红 + 一个转瞬即逝的提示）。
 */
function validatePort(_rule: unknown, value: string, callback: (error?: Error) => void): void {
  const text = String(value ?? '').trim()
  if (!text || parsePort(text)) callback()
  else callback(new Error('监听端口需要是 1–65535 的整数'))
}

const rules: FormRules = {
  name: [{ required: true, message: '请填写名称', trigger: 'blur' }],
  command: [{ required: true, message: '请填写要执行的命令', trigger: 'blur' }],
  port: [{ validator: validatePort, trigger: 'blur' }]
}

/** 打开弹窗时按当前模式填值：编辑就回填已有配置，新增就是一张白纸 */
function reset(): void {
  const entry = catalog.commandEditing
  form.name = entry?.name ?? ''
  form.command = entry?.command ?? ''
  form.port = entry?.port ? String(entry.port) : ''
}

watch(
  () => catalog.commandDialogVisible,
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
    ? await catalog.updateCommand(current.id, payload)
    : await catalog.addCommand(payload)

  if (done) visible.value = false
}

</script>

<template>
  <!-- penetrable：命令常常是从笔记里抄过来的（见 AppDialog.vue） -->
  <AppDialog
    v-model="visible"
    :title="title"
    width="520"
    align-center
    penetrable
    @closed="reset"
  >
    <el-form class="form" :model="form" :rules="rules" label-position="top" @submit.prevent>
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" placeholder="显示在卡片上的名字" />
      </el-form-item>

      <el-form-item label="命令" prop="command">
        <div class="field__stack">
          <el-input
            v-model="form.command"
            placeholder="npx @deepseek-ai/dsh web"
            spellcheck="false"
          />
          <p class="field__hint">
            整行原样交给系统 shell，在用户主目录下执行；不能包含换行（一行只跑一条命令）。
          </p>
        </div>
      </el-form-item>

      <el-form-item label="监听端口" prop="port">
        <div class="field__stack">
          <el-input v-model="form.port" placeholder="留空表示不检测" spellcheck="false" />
          <p class="field__hint">
            命令的服务端口。填了才能判断它是否已经在运行 —— 包括在 Workbench 之外启动、
            至今还占着端口的那种。
          </p>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">
        {{ editing ? '保存' : '添加' }}
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
/* 字段排版（标签 / 说明小字 / 错误行）由 global.css 的「弹窗表单」一节统一给 */
</style>
