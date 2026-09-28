<script setup lang="ts">
/**
 * 模型配置：一个**自定义端点** —— 名称、Base URL、API 形态、密钥、模型清单（可启停）。
 *
 * 四样东西的落点各不相同，界面要说清楚：
 *  - 名称 / Base URL / API 形态 / 清单进**设置**，并由 Rust 写成 Pi 的 `models.json`
 *    （见 src-tauri/src/ai.rs 的 provider_write）；
 *  - API Key 进 **Windows 凭据管理器**（`Workbench/ai/<名称>/token`），保存之后就再也读不回来，
 *    所以这里只显示「已配置 / 未配置」，输入框保存完立刻清空；
 *  - 模型 id 由用户按提供方的叫法填：应用不认识任何一家的模型清单（那清单变得太快）。
 */
import { computed, ref, watch } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import type { FormInstance, FormRules } from 'element-plus'
import { AI_API_FORMATS } from '@shared/ai'
import { confirmAction } from '@/notify'
import AppDialog from '@/components/AppDialog.vue'
import { useAiStore } from '@/stores/ai'

const store = useAiStore()
const visible = defineModel<boolean>({ required: true })

const formRef = ref<FormInstance | null>(null)

const name = ref('')
const baseUrl = ref('')
const apiFormat = ref('')
const models = ref<Array<{ id: string; enabled: boolean }>>([])
const keyDraft = ref('')
const newModel = ref('')
const saving = ref(false)

const rules: FormRules = {
  name: [
    { required: true, message: '给这个端点起个名字（小写字母、数字、连字符）', trigger: 'blur' },
    {
      pattern: /^[a-z0-9][a-z0-9-]*$/,
      message: '只能用小写字母、数字与连字符',
      trigger: 'blur'
    }
  ],
  baseUrl: [
    { required: true, message: '填 Base URL', trigger: 'blur' },
    {
      pattern: /^https?:\/\/\S+$/,
      message: '要以 http:// 或 https:// 开头',
      trigger: 'blur'
    }
  ],
  apiFormat: [{ required: true, message: '选一个 API 形态', trigger: 'change' }]
}

/** 每次打开都从设置里取一份草稿（关掉不保存就丢掉） */
watch(visible, (open) => {
  if (!open) return
  name.value = store.providerName
  baseUrl.value = store.baseUrl
  apiFormat.value = store.apiFormat || AI_API_FORMATS[0].id
  models.value = store.models.map((entry) => ({ ...entry }))
  keyDraft.value = ''
  newModel.value = ''
  void store.refreshKey()
})

/** 草稿与已保存的设置是否一致：不一致时不让存 Key（凭据名跟着名称走，先把配置落下来） */
const dirty = computed(
  () =>
    name.value !== store.providerName ||
    baseUrl.value !== store.baseUrl ||
    apiFormat.value !== store.apiFormat ||
    JSON.stringify(models.value) !== JSON.stringify(store.models)
)

const enabledCount = computed(() => models.value.filter((entry) => entry.enabled).length)

function addModel(): void {
  const id = newModel.value.trim()
  if (!id) return
  if (id.length > 120) return
  if (!models.value.some((entry) => entry.id === id)) {
    models.value = [...models.value, { id, enabled: true }]
  }
  newModel.value = ''
}

function removeModel(id: string): void {
  models.value = models.value.filter((entry) => entry.id !== id)
}

async function save(): Promise<void> {
  const form = formRef.value
  if (form && !(await form.validate().catch(() => false))) return
  if (!enabledCount.value) return

  saving.value = true
  const saved = await store.saveEndpoint({
    name: name.value,
    baseUrl: baseUrl.value,
    apiFormat: apiFormat.value,
    models: models.value
  })
  saving.value = false
  if (saved) visible.value = false
}

async function saveKey(): Promise<void> {
  const secret = keyDraft.value.trim()
  if (!secret) return
  const saved = await store.saveKey(secret)
  if (saved) keyDraft.value = ''
}

async function clearKey(): Promise<void> {
  if (!(await confirmAction(`清掉 ${store.providerName} 的 API Key？`, '清除密钥', { type: 'warning' })))
    return
  await store.clearKey()
}
</script>

<template>
  <AppDialog v-model="visible" title="模型配置" width="560px">
    <el-form ref="formRef" :model="{ name, baseUrl, apiFormat }" :rules="rules" label-position="top">
      <el-form-item label="提供方名称" prop="name">
        <el-input v-model="name" placeholder="如 opencode" @blur="name = name.trim()" />
      </el-form-item>

      <el-form-item label="Base URL" prop="baseUrl">
        <el-input v-model="baseUrl" placeholder="https://opencode.ai/zen/go/v1" />
      </el-form-item>

      <el-form-item label="API 格式" prop="apiFormat">
        <el-select v-model="apiFormat" class="model__select">
          <el-option v-for="item in AI_API_FORMATS" :key="item.id" :label="item.label" :value="item.id" />
        </el-select>
      </el-form-item>
    </el-form>

    <div class="model__key">
      <div class="model__key-head">
        <span class="model__key-label">
          API Key
          <span class="model__state" :class="store.keyReady ? 'is-ok' : ''">
            {{ store.keyReady ? '已配置' : '未配置' }}
          </span>
        </span>
        <el-button :disabled="!store.keyReady" link size="small" @click="clearKey">清除</el-button>
      </div>
      <div class="model__key-row">
        <el-input
          v-model="keyDraft"
          type="password"
          show-password
          :disabled="dirty"
          :placeholder="dirty ? '先保存上面的配置' : store.keyReady ? '已存好，重填即覆盖' : '粘贴 API Key'"
          @keyup.enter="saveKey"
        />
        <el-button :disabled="dirty || !keyDraft.trim()" @click="saveKey">保存</el-button>
      </div>
      <p class="model__hint">
        存在 Windows 凭据管理器里；Pi 的配置文件里只有一个环境变量引用，不落明文。
      </p>
    </div>

    <div class="model__list">
      <div class="model__list-head">
        <span class="model__list-title">模型列表</span>
        <span class="model__list-tools">
          <el-input
            v-model="newModel"
            size="small"
            class="model__add-input"
            placeholder="模型 id，如 deepseek-v4.1-flash"
            @keyup.enter="addModel"
          />
          <el-button size="small" :icon="Plus" @click="addModel">添加模型</el-button>
        </span>
      </div>

      <p v-if="!models.length" class="model__empty">
        还没有模型。按提供方的叫法填 id（一个端点下可以有多个，跑的时候用第一个启用的）。
      </p>
      <ul v-else class="model__rows">
        <li v-for="entry in models" :key="entry.id" class="model__row">
          <span class="model__row-id mono">{{ entry.id }}</span>
          <el-switch v-model="entry.enabled" size="small" />
          <el-button link :icon="Delete" @click="removeModel(entry.id)" />
        </li>
      </ul>

      <p v-if="models.length && !enabledCount" class="model__error">
        至少要启用一个模型。
      </p>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!enabledCount" @click="save">
        保存配置
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.model__select {
  width: 100%;
}

.model__key {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-bottom: var(--sp-4);
}

.model__key-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.model__key-label {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.model__state {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.model__state.is-ok {
  color: var(--st-ok);
}

.model__key-row {
  display: flex;
  gap: var(--sp-2);
}

.model__hint,
.model__empty,
.model__error {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.model__error {
  color: var(--st-fail);
}

.model__list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.model__list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.model__list-title {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.model__list-tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.model__add-input {
  width: 240px;
}

.model__rows {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}

.model__row-id {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
  font-size: var(--fs-meta);
}
</style>
