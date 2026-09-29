<script setup lang="ts">
/**
 * 模型管理那个弹层：**跑一轮用哪个模型**这一件事的两半 ——
 *
 *  - 顶上写清楚这一轮的**默认模型**（服务 + 模型），点一下就能换；
 *  - 下面列着配过的 **AI 服务**（一个服务 = 一个端点 + 一份模型清单），
 *    能加、能改、能停用、能删。加 / 改走 AiProviderDialog（挑厂商 → 粘 Key → 挑模型）。
 *
 * 这个弹层自己不碰密钥、也不拼 models.json：每一步都落到 stores/ai.ts
 * （saveProvider / removeProvider / toggleProvider），那边负责「设置 + 凭据 + models.json」
 * 三处一起对齐。这里只把当前状态画出来。
 */
import { computed, ref } from 'vue'
import { Delete, Edit, Plus } from '@element-plus/icons-vue'
import type { AiProvider } from '@shared/ai'
import AppDialog from '@/components/AppDialog.vue'
import AiProviderDialog from '@/components/AiProviderDialog.vue'
import { useAiStore } from '@/stores/ai'

const visible = defineModel<boolean>({ required: true })
const store = useAiStore()

/** 正在编辑的服务（null = 没开那个弹层；开着而它为空就是「加一个新的」） */
const editing = ref<AiProvider | null>(null)
const providerVisible = ref(false)

/** 默认模型那一栏显示什么：`服务名 · 模型名`（名字与 id 不一样时两行都给） */
const defaultText = computed(() => {
  const choice = store.activeChoice
  if (!choice) return '还没配模型'
  return `${choice.providerLabel} · ${choice.name}`
})
const defaultId = computed(() => store.activeChoice?.model ?? '')

/** 下拉里按服务分组：一个服务一组，组名就是它的名字 */
const grouped = computed(() =>
  store.providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      provider,
      items: store.choices.filter((choice) => choice.provider === provider.id)
    }))
    .filter((group) => group.items.length > 0)
)

/** 行上那行小字：地址（去协议）+ 几个模型 + 没配密钥时说一句 */
function host(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function openNew(): void {
  editing.value = null
  providerVisible.value = true
}

function openEdit(provider: AiProvider): void {
  editing.value = provider
  providerVisible.value = true
}

/**
 * 停用 / 启用一个服务：停用的不进 Pi 的 models.json，也当不了默认模型
 * （默认模型落在它身上时，pickAiChoice 会退到下一个能挑的）。
 */
function toggle(provider: AiProvider, value: unknown): void {
  void store.toggleProvider(provider.id, value === true)
}
</script>

<template>
  <AppDialog v-model="visible" title="模型配置" width="720px">
    <div class="model">
      <!-- 默认模型：跑一轮用它（模型管理弹窗顶上那一栏，页面上那个下拉也是它） -->
      <section class="model__section">
        <p class="model__label">默认项</p>
        <div class="model__default">
          <span class="model__default-text">
            <span class="model__default-title">默认模型</span>
            <span class="model__default-value">
              {{ defaultText }}
              <span v-if="defaultId" class="model__default-id mono">{{ defaultId }}</span>
            </span>
          </span>
          <el-select
            class="model__default-pick"
            :model-value="store.activeChoiceKey"
            placeholder="还没能挑的模型"
            @change="(value: unknown) => void store.setChoice(String(value))"
          >
            <template #prefix>更改</template>
            <el-option-group
              v-for="group in grouped"
              :key="group.provider.id"
              :label="group.provider.label"
            >
              <el-option
                v-for="choice in group.items"
                :key="choice.key"
                :label="choice.name"
                :value="choice.key"
              >
                <span class="model__option">
                  <span class="model__option-name">{{ choice.name }}</span>
                  <span class="model__option-id mono">{{ choice.model }}</span>
                </span>
              </el-option>
            </el-option-group>
          </el-select>
        </div>
      </section>

      <!-- AI 服务：加 / 改 / 停用 / 删 -->
      <section class="model__section">
        <div class="model__head">
          <p class="model__label">
            AI 服务
            <span class="model__count">{{ store.providers.length }}</span>
          </p>
          <el-button type="primary" :icon="Plus" @click="openNew">添加服务</el-button>
        </div>

        <p v-if="!store.providers.length" class="model__empty">
          还没有服务。添加一个：挑一家厂商（或自定义端点）、粘上 API Key，
          模型清单会从端点自己拉回来。
        </p>

        <ul v-else class="model__rows">
          <li v-for="provider in store.providers" :key="provider.id" class="model__row">
            <span class="model__avatar">{{ provider.label.slice(0, 1).toUpperCase() }}</span>
            <span class="model__text">
              <span class="model__name">
                {{ provider.label }}
                <span class="model__badge">{{ provider.models.length }} 个模型</span>
                <span v-if="store.keyStates[provider.id] !== true" class="model__warn">未配密钥</span>
              </span>
              <span class="model__host" :title="provider.baseUrl">{{ host(provider.baseUrl) }}</span>
            </span>
            <el-switch
              :model-value="provider.enabled"
              @update:model-value="(value: unknown) => toggle(provider, value)"
            />
            <el-tooltip content="编辑（地址、密钥、模型清单）" placement="top">
              <el-button link :icon="Edit" @click="openEdit(provider)" />
            </el-tooltip>
            <el-tooltip content="删除（连同它的 API Key）" placement="top">
              <el-button link :icon="Delete" @click="store.removeProvider(provider.id)" />
            </el-tooltip>
          </li>
        </ul>
      </section>
    </div>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </AppDialog>

  <!-- 添加 / 编辑服务：挂在同一个父模板里，与上面这个弹层各管各的（见 AiProviderDialog） -->
  <AiProviderDialog v-model="providerVisible" :provider="editing" />
</template>

<style scoped>
.model {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.model__section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.model__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}

.model__label {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.model__count {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

/* 默认模型那一栏：左边写清现在是什么，右边那个下拉就是「更改」 */
.model__default {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-inset);
}

.model__default-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.model__default-title {
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

.model__default-value {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model__default-id {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.model__default-pick {
  width: 264px;
  flex-shrink: 0;
}

.model__default-pick :deep(.el-select__prefix) {
  margin-right: var(--sp-1);
  color: var(--ink-3);
  font-size: var(--fs-meta);
}

/* 下拉里那一行：显示名 + id（id 是 Pi 真正认的那个，摆在这儿省得猜） */
.model__option {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
}

.model__option-id {
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.model__rows {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.model__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}

.model__avatar {
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

.model__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.model__name {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--ink);
  font-size: var(--fs-meta);
}

.model__badge {
  padding: 0 var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--ink-3);
  font-size: var(--fs-micro);
}

.model__warn {
  color: var(--st-fail);
  font-size: var(--fs-micro);
}

.model__host {
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model__empty {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  line-height: 1.7;
}
</style>
