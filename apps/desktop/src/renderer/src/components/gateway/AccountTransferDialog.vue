<script setup lang="ts">
import type { GatewayAccountImport } from '@/workbench/gateway'
import type { QoderAccountImport } from '@/workbench/qoder'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { copyText } from '@/clipboard'
import AppDialog from '@/components/AppDialog.vue'

/**
 * 账号导出 / 导入弹层（TBuddy 与 Qoder 共用同一副壳）。
 *
 * 导出只做一件事：把账号池的凭据给成一段 JSON，让用户抄进密码管理器；
 * 导入把那一段贴回来。**不走文件对话框** —— 这段东西本来就是拿去别处存的，
 * 多一个文件反而多一步清理。
 *
 * 导出内容含明文 token，所以它只由用户点「导出」触发；账号列表本身仍然不含 token。
 * 导入时同 uid 怎么办由用户当场选：跳过已有（默认）或覆盖本机。
 */
const props = defineProps<{
  kind: 'gateway' | 'qoder'
  mode: 'export' | 'import'
}>()

const emit = defineEmits<{
  imported: []
}>()

const open = defineModel<boolean>({ required: true })

const STRATEGIES = [
  { label: '跳过已有', value: 'skip' },
  { label: '覆盖本机', value: 'overwrite' },
]

const title = computed(() => `${props.kind === 'gateway' ? 'TBuddy' : 'Qoder'} 账号${props.mode === 'export' ? '导出' : '导入'}`)
const payload = ref('')
const busy = ref(false)
const strategy = ref<'skip' | 'overwrite'>('skip')

watch(open, (value) => {
  if (value)
    void prepare()
})

async function prepare(): Promise<void> {
  payload.value = ''
  strategy.value = 'skip'
  if (props.mode !== 'export')
    return
  busy.value = true
  const result = props.kind === 'gateway'
    ? await window.workbench.gatewayAccountsExport()
    : await window.workbench.qoderAccountsExport()
  busy.value = false
  if (!result.ok || !result.data) {
    ElMessage.error(result.error ?? '导出账号失败')
    open.value = false
    return
  }
  payload.value = result.data
}

async function submit(): Promise<void> {
  const text = payload.value.trim()
  if (!text)
    return
  busy.value = true
  const overwrite = strategy.value === 'overwrite'
  const result = props.kind === 'gateway'
    ? await window.workbench.gatewayAccountsImport(text, overwrite)
    : await window.workbench.qoderAccountsImport(text, overwrite)
  busy.value = false
  if (!result.ok || !result.data) {
    ElMessage.error(result.error ?? '导入账号失败')
    return
  }
  ElMessage.success(summary(result.data))
  open.value = false
  emit('imported')
}

function summary(result: GatewayAccountImport | QoderAccountImport): string {
  const parts = [`新增 ${result.added} 个`]
  if (result.updated)
    parts.push(`覆盖 ${result.updated} 个`)
  if (result.skipped)
    parts.push(`跳过 ${result.skipped} 个`)
  return parts.join('，')
}
</script>

<template>
  <!-- penetrable：导出要抄进密码管理器、导入要从那里粘回来，都得让背后点得到 -->
  <AppDialog v-model="open" :title="title" width="560" align-center penetrable>
    <div v-loading="busy" class="transfer">
      <el-input
        v-model="payload"
        type="textarea"
        :rows="12"
        size="small"
        resize="none"
        spellcheck="false"
        :readonly="mode === 'export'"
        :placeholder="mode === 'export' ? '' : '粘贴导出的 JSON'"
      />

      <div v-if="mode === 'import'" class="transfer__strategy">
        <span class="transfer__label">本机已有同一个号</span>
        <el-segmented v-model="strategy" :options="STRATEGIES" size="small" />
      </div>
    </div>

    <template #footer>
      <el-button @click="open = false">
        {{ mode === 'export' ? '关闭' : '取消' }}
      </el-button>
      <el-button
        v-if="mode === 'export'"
        type="primary"
        :disabled="!payload"
        @click="copyText"
      >
        复制
      </el-button>
      <el-button
        v-else
        type="primary"
        :loading="busy"
        :disabled="!payload.trim()"
        @click="submit"
      >
        导入
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.transfer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.transfer__strategy {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.transfer__label {
  font-size: var(--gw-fs-meta);
  color: var(--ink-3);
}
</style>
