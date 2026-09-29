<script setup lang="ts">
/**
 * 「添加 AI 服务」第一步的那张网格：一格一个预设厂商（第一个是「自定义端点」），
 * 顶上一条搜索框。**只挑地址**（Base URL 与 API 形态都由预设带齐），
 * 密钥与模型清单在下一步填（见 AiProviderDialog）。
 *
 * 区位/头像都是现画的（首字母），不引任何图标资源 —— 这个应用不联网取图。
 * 它自己不留状态：搜什么、挑了什么都是父组件的事（挑完就进下一步）。
 */
import { computed, ref } from 'vue'
import { Plus, Search } from '@element-plus/icons-vue'
import { AI_PROVIDER_PRESETS, type AiProviderPreset } from '@shared/ai'

const emit = defineEmits<{
  /** 挑了一个预设（地址与形态都由它带齐） */
  pick: [preset: AiProviderPreset]
  /** 挑「自定义端点」：三个字段都自己填 */
  custom: []
}>()

const search = ref('')

/** 厂商名或地址里带这几个字就算匹配（与别处的搜索同一条口径：小写后比对） */
const matched = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return AI_PROVIDER_PRESETS
  return AI_PROVIDER_PRESETS.filter(
    (preset) =>
      preset.label.toLowerCase().includes(keyword) ||
      preset.baseUrl.toLowerCase().includes(keyword) ||
      preset.id.includes(keyword)
  )
})

/** 头像上那个字：中文厂商用第一个字，英文厂商用首字母 */
function initial(label: string): string {
  return label.trim().slice(0, 1).toUpperCase()
}

/** 行里那行小字：地址去掉协议，长了下边自己截（全文在 title 里） */
function host(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** 自定义端点那一格要不要显示：搜的内容不在它身上就是「没搜到」 */
const showCustom = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return !keyword || '自定义端点'.includes(keyword) || 'custom'.includes(keyword)
})
</script>

<template>
  <div class="preset">
    <el-input v-model="search" class="preset__search" placeholder="筛选服务" clearable>
      <template #prefix>
        <el-icon><Search /></el-icon>
      </template>
    </el-input>

    <p class="preset__label">用 API Key 连接</p>

    <div class="preset__grid">
      <button v-if="showCustom" type="button" class="preset__cell" @click="emit('custom')">
        <span class="preset__avatar is-custom"><el-icon><Plus /></el-icon></span>
        <span class="preset__text">
          <span class="preset__name">自定义端点</span>
          <span class="preset__host">任意 OpenAI 或 Anthropic 兼容地址</span>
        </span>
      </button>

      <button
        v-for="preset in matched"
        :key="preset.id"
        type="button"
        class="preset__cell"
        @click="emit('pick', preset)"
      >
        <span class="preset__avatar">{{ initial(preset.label) }}</span>
        <span class="preset__text">
          <span class="preset__name">{{ preset.label }}</span>
          <span class="preset__host" :title="preset.baseUrl">{{ host(preset.baseUrl) }}</span>
        </span>
      </button>
    </div>

    <p v-if="!showCustom && !matched.length" class="preset__empty">
      没有匹配的服务。要自己填地址就清空上面这一栏，用第一格的「自定义端点」。
    </p>
  </div>
</template>

<style scoped>
.preset {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.preset__label {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--fs-meta);
}

/* 一格一格铺开：窗口窄了就少几列，格子高度一致 */
.preset__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
  gap: var(--sp-2);
}

.preset__cell {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
  padding: var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.preset__cell:hover {
  border-color: var(--ink-3);
}

/* 首字母头像：灰度底 + 深字（彩色只留给运行状态，见 AGENTS.md 第 4 节） */
.preset__avatar {
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

.preset__avatar.is-custom {
  border: 1px dashed var(--border);
  background: transparent;
}

.preset__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.preset__name {
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preset__host {
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preset__empty {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--fs-micro);
}
</style>
