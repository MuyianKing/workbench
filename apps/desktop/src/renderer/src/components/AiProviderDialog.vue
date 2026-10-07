<script setup lang="ts">
import type { AiFetchedModel, AiModelEntry, AiProvider, AiProviderPreset } from '@workbench/ai'
import { AI_API_FORMATS, aiProviderReady, uniqueAiName } from '@workbench/ai'
/**
 * 「添加 / 编辑一个 AI 服务」那个弹层：**一条链路走到底** ——
 *
 *  1. 挑服务（预设厂商的网格，或第一个「自定义端点」）；
 *  2. 粘 API Key（**粘完自动连一次、把模型列表拉回来**）；
 *  3. 从左栏点几下挑模型（上下文与思考档位在右栏改，端点没说就按名字认一遍）；
 *  4. 保存服务 —— 落设置、写 models.json、存密钥都在 store 里（见 stores/ai.ts 的 saveProvider）。
 *
 * 地址与 API 形态由预设带齐，要改（中转地址、私有部署）就在「高级设置」里改。**服务名
 * 只收小写字母 / 数字 / 连字符**：它同时是 Pi 的 provider 名与凭据管理器里的那一条。
 *
 * 这个弹层是**填内容的那种**（要从别处把 API Key 粘进来），所以不挡背后 ——
 * 与密码、添加项目那几个同一条（见 AGENTS.md 第 4 节）。
 */
import { computed, ref, watch } from 'vue'
import AiModelPicker from '@/components/AiModelPicker.vue'
import AiPresetGrid from '@/components/AiPresetGrid.vue'
import AppDialog from '@/components/AppDialog.vue'
import { useAiStore } from '@/stores/ai'

const props = defineProps<{
  /** 正在编辑的服务；null = 新加一个 */
  provider: AiProvider | null
}>()

const visible = defineModel<boolean>({ required: true })
const store = useAiStore()

/** 第一步（挑服务）还是第二步（配它） */
const step = ref<'pick' | 'edit'>('pick')
/** 高级设置摊开着没有（名称 / Base URL / API 形态） */
const advanced = ref(false)
/** 服务名是不是用户自己动过：没动过就跟着名字走（自定义端点那种） */
const idTouched = ref(false)

const id = ref('')
const label = ref('')
const baseUrl = ref('')
const apiFormat = ref(AI_API_FORMATS[0].id)
const preset = ref('')
const models = ref<AiModelEntry[]>([])

const keyDraft = ref('')
const fetched = ref<AiFetchedModel[]>([])
const fetching = ref(false)
const fetchError = ref('')
const saving = ref(false)
/** 保存走到一半失败的那句话（toast 会消失，这行留在弹窗里，关掉重开才清） */
const saveError = ref('')

/** 编辑一个已经保存过的服务时，它的原名（改了名要把旧的那条凭据清掉） */
const originalId = computed(() => props.provider?.id ?? '')
const keyConfigured = computed(() => !!originalId.value && store.keyStates[originalId.value] === true)
/** 已经用掉的服务名（新增时避重名用；编辑时把自己那个排除掉） */
const takenIds = computed(() =>
  store.providers.filter(item => item.id !== originalId.value).map(item => item.id),
)

/** 每次打开都从零开始：编辑就是那份现成的，新增就是空的（关掉不保存不留下痕迹） */
watch(visible, (open) => {
  if (!open)
    return
  const editing = props.provider
  step.value = editing ? 'edit' : 'pick'
  advanced.value = !!editing && !editing.preset
  idTouched.value = !!editing
  id.value = editing?.id ?? ''
  label.value = editing?.label ?? ''
  baseUrl.value = editing?.baseUrl ?? ''
  apiFormat.value = editing?.apiFormat ?? AI_API_FORMATS[0].id
  preset.value = editing?.preset ?? ''
  models.value = editing ? editing.models.map(entry => ({ ...entry })) : []
  keyDraft.value = ''
  fetched.value = []
  fetchError.value = ''
  saveError.value = ''
  saving.value = false
})

/** 挑一个预设：地址与形态都从它来，服务名先照着它的 id 排（重名就排个后缀） */
function pickPreset(item: AiProviderPreset): void {
  id.value = uniqueAiName(item.id, takenIds.value)
  label.value = item.label
  baseUrl.value = item.baseUrl
  apiFormat.value = item.apiFormat
  preset.value = item.id
  idTouched.value = false
  advanced.value = false
  step.value = 'edit'
}

/** 自定义端点：三个字段都自己填（展开高级设置，不然用户不知道该填哪儿） */
function pickCustom(): void {
  id.value = uniqueAiName('custom', takenIds.value)
  label.value = '自定义端点'
  baseUrl.value = ''
  apiFormat.value = AI_API_FORMATS[0].id
  preset.value = ''
  idTouched.value = false
  advanced.value = true
  step.value = 'edit'
}

/** 「更换」：回到第一步重挑一个（已经填的清单留着 —— 多半是地址选错了） */
function back(): void {
  step.value = 'pick'
}

/**
 * 服务名跟着名字走：没被用户动过时，改名字就顺手把 id 也改一个能用的出来
 * （中文名字折不出字符就是空串，那时保持不动）。
 */
function onLabelChange(): void {
  if (idTouched.value)
    return
  const next = uniqueAiName(label.value, takenIds.value)
  if (next && next !== 'custom')
    id.value = next
}

/**
 * 用户动了服务名：自定义端点那种「名字就是它自己起的那个服务名」，
 * 顺手把行上的标题也换成它（预设厂商那种标题是厂商的名字，不动）。
 */
function onIdInput(): void {
  idTouched.value = true
  if (!preset.value && (!label.value || label.value === '自定义端点'))
    label.value = id.value
}

/** 拉一次模型列表：地址与 Key 都齐了才走（Rust 那边打的是用户自己那个端点） */
async function load(): Promise<void> {
  if (fetching.value)
    return
  if (!/^https?:\/\//.test(baseUrl.value.trim())) {
    fetchError.value = '先填 Base URL（要以 http:// 或 https:// 开头）'
    return
  }
  if (!keyDraft.value.trim() && !keyConfigured.value) {
    fetchError.value = '先粘上 API Key'
    return
  }

  fetching.value = true
  fetchError.value = ''
  const result = await store.fetchModels({
    provider: id.value || 'draft',
    baseUrl: baseUrl.value,
    api: apiFormat.value,
    secret: keyDraft.value.trim(),
  })
  fetching.value = false

  if (!result.ok) {
    fetchError.value = result.error ?? '没拉到模型列表'
    return
  }
  fetched.value = result.data ?? []
  if (!fetched.value.length)
    fetchError.value = '这个端点没有报出任何模型，可以自己填 id'
}

/** 粘完 Key 自动连一次（粘贴事件早于 v-model 更新，所以推到下一个 tick 再读） */
function onPasteKey(): void {
  setTimeout(() => void load(), 0)
}

/** 左栏空着时那句说明：把「为什么空」说清楚，别让用户猜 */
const listHint = computed(() => {
  if (fetching.value)
    return '正在连端点取模型列表…'
  if (fetchError.value)
    return fetchError.value
  if (!fetched.value.length)
    return '粘上 API Key 就会自动获取模型列表，也可以点上面的「获取列表」。'
  return '这些模型里没有匹配的。'
})

async function save(): Promise<void> {
  const draft: AiProvider = {
    id: id.value,
    label: label.value,
    baseUrl: baseUrl.value,
    apiFormat: apiFormat.value,
    preset: preset.value,
    enabled: props.provider?.enabled !== false,
    models: models.value,
  }
  if (!aiProviderReady(draft)) {
    fetchError.value = '还差东西：服务名、Base URL、API 形态，以及至少一个启用的模型'
    return
  }

  saving.value = true
  const saved = await store.saveProvider(draft, keyDraft.value.trim(), originalId.value)
  saving.value = false
  if (!saved) {
    // store 那边已经飘过具体原因的 toast；这里留一行不消失的，别让人以为保存成功了
    saveError.value = '保存没有完成（原因见刚才那条提示），处理之后再保存一次'
    return
  }
  visible.value = false
}

/** 清掉这个服务已经存着的 Key（新加的那种没有） */
async function clearKey(): Promise<void> {
  if (!originalId.value)
    return
  await store.clearProviderKey(originalId.value)
}

const title = computed(() => (props.provider ? '编辑 AI 服务' : '添加 AI 服务'))
</script>

<template>
  <!-- 1080：模型设置那半栏里的上下文档位（128K…1M 五颗）再对半分就放不下了，窄了必换行 -->
  <AppDialog v-model="visible" :title="title" width="1080px" penetrable>
    <!-- 第一步：挑服务 -->
    <AiPresetGrid v-if="step === 'pick'" @pick="pickPreset" @custom="pickCustom" />

    <!-- 第二步：配它 -->
    <div v-else class="svc">
      <div class="svc__head">
        <div class="svc__service">
          <span class="svc__avatar">{{ (label || '?').slice(0, 1).toUpperCase() }}</span>
          <span class="svc__text">
            <span class="svc__name">{{ label || '还没起名字' }}</span>
            <span class="svc__host">{{ baseUrl || '还没填地址' }}</span>
          </span>
          <el-button link size="small" @click="back">
            更换
          </el-button>
        </div>
        <el-button link size="small" @click="advanced = !advanced">
          {{ advanced ? '收起高级设置' : '高级设置' }}
        </el-button>
      </div>

      <div v-if="advanced" class="svc__fields">
        <el-form label-position="top" class="svc__form">
          <el-form-item label="显示名称">
            <el-input v-model="label" placeholder="界面上怎么叫它" @change="onLabelChange" />
          </el-form-item>
          <el-form-item label="服务名称">
            <el-input
              v-model="id"
              placeholder="小写字母、数字与连字符"
              @update:model-value="onIdInput"
            />
          </el-form-item>
          <el-form-item label="Base URL">
            <el-input v-model="baseUrl" placeholder="https://api.deepseek.com/v1" />
          </el-form-item>
          <el-form-item label="API 形态">
            <el-select v-model="apiFormat" class="svc__api">
              <el-option
                v-for="item in AI_API_FORMATS"
                :key="item.id"
                :label="item.label"
                :value="item.id"
              />
            </el-select>
          </el-form-item>
        </el-form>
      </div>

      <!-- API Key：只在粘贴那一刻读一次，存起来之后就再也读不回来（凭据管理器里那条） -->
      <div class="svc__key">
        <span class="svc__key-label">
          API 密钥
          <span class="svc__state" :class="keyConfigured ? 'is-ok' : ''">
            {{ keyConfigured ? '已配置' : '未配置' }}
          </span>
        </span>
        <div class="svc__key-row">
          <el-input
            v-model="keyDraft"
            type="password"
            show-password
            :placeholder="keyConfigured ? '已存好，重填即覆盖' : '粘贴 API Key'"
            @paste="onPasteKey"
            @keyup.enter="load"
          />
          <el-button :loading="fetching" @click="load">
            获取列表
          </el-button>
          <el-button v-if="keyConfigured" link @click="clearKey">
            清除
          </el-button>
        </div>
        <p class="svc__hint">
          粘贴 API Key 后自动连接并获取模型；它存在 Windows 凭据管理器里，只经环境变量交给
          Pi，不落明文。
        </p>
      </div>

      <AiModelPicker
        v-model="models"
        :available="fetched"
        :loading="fetching"
        :hint="listHint"
        :provider="preset"
        @refresh="load"
      />

      <p v-if="saveError" class="svc__save-error">
        {{ saveError }}
      </p>
    </div>

    <template #footer>
      <el-button @click="visible = false">
        取消
      </el-button>
      <el-button v-if="step === 'edit'" type="primary" :loading="saving" @click="save">
        保存服务
      </el-button>
    </template>
  </AppDialog>
</template>

<style scoped>
.svc {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/* 服务这一行：头像 + 名字 + 地址，右边那颗「更换」回第一步 */
.svc__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}

.svc__service {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  flex: 1;
  min-width: 0;
}

.svc__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.svc__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.svc__name {
  color: var(--ink);
  font-size: var(--fs-meta);
}

.svc__host {
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.svc__fields {
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.svc__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-2) var(--sp-3);
}

.svc__form :deep(.el-form-item) {
  margin-bottom: 0;
}

.svc__api {
  width: 100%;
}

.svc__key {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.svc__key-label {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.svc__state {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.svc__state.is-ok {
  color: var(--st-ok);
}

.svc__key-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.svc__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.svc__save-error {
  margin: 0;
  color: var(--st-fail);
  font-size: var(--fs-micro);
}
</style>
