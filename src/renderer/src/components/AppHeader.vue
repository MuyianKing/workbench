<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Monitor, Search, Setting } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import SettingsDialog from '@/components/SettingsDialog.vue'

const store = useProjectsStore()
const searchInput = ref<HTMLInputElement | null>(null)
const settingsVisible = ref(false)

const versions = window.workbench?.versions ?? { electron: '—', node: '—', chrome: '—' }

const managers = [
  { key: 'npm', label: 'npm' },
  { key: 'yarn', label: 'yarn' },
  { key: 'pnpm', label: 'pnpm' }
] as const

function managerAvailable(key: 'npm' | 'yarn' | 'pnpm'): boolean {
  return store.packageManagers?.[key] ?? false
}

function focusSearch(): void {
  searchInput.value?.focus()
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    focusSearch()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <header class="header">
    <label class="search">
      <el-icon class="search__icon"><Search /></el-icon>
      <input
        ref="searchInput"
        v-model="store.keyword"
        class="search__field"
        type="text"
        placeholder="搜索项目名或路径"
        spellcheck="false"
      />
      <kbd class="search__hint mono">Ctrl K</kbd>
    </label>

    <div class="actions">
      <el-popover placement="bottom-end" :width="252" trigger="click" popper-class="env-popover">
        <template #reference>
          <el-button class="icon-btn" :icon="Monitor" aria-label="环境信息" />
        </template>

        <div class="env">
          <p class="eyebrow">运行环境</p>
          <ul class="env__list mono">
            <li>
              <span>node</span>
              <b>{{ store.packageManagers?.node || '未检测到' }}</b>
            </li>
            <li>
              <span>electron</span>
              <b>{{ versions.electron }}</b>
            </li>
            <li>
              <span>chromium</span>
              <b>{{ versions.chrome }}</b>
            </li>
          </ul>

          <p class="eyebrow env__gap">包管理器</p>
          <ul class="env__list">
            <li v-for="m in managers" :key="m.key">
              <span class="mono">{{ m.label }}</span>
              <b
                class="env__state"
                :class="managerAvailable(m.key) ? 'is-ok' : 'is-missing'"
              >
                {{ managerAvailable(m.key) ? '可用' : '未安装' }}
              </b>
            </li>
          </ul>
        </div>
      </el-popover>

      <el-button
        class="icon-btn"
        :icon="Setting"
        aria-label="设置"
        @click="settingsVisible = true"
      />
    </div>

    <SettingsDialog v-model="settingsVisible" />
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  gap: var(--sp-6);
  padding: 0 var(--sp-5);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
}

/* ---------- 搜索 ---------- */
.search {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 1;
  max-width: 420px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px solid transparent;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.search:focus-within {
  background: var(--bg-surface);
  border-color: var(--border-strong);
}

.search__icon {
  color: var(--ink-3);
  font-size: 14px;
}

.search__field {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--fs-body);
  color: var(--ink);
}

.search__field::placeholder {
  color: var(--ink-3);
}

.search__hint {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  background: var(--bg-surface);
}

/* ---------- 右侧操作 ---------- */
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-left: auto;
  flex-shrink: 0;
}

.icon-btn {
  width: 32px;
  padding: 0;
}

/* ---------- 环境信息弹层 ---------- */
.env {
  padding: var(--sp-1) 0;
}

.env__gap {
  display: block;
  margin-top: var(--sp-4);
  margin-bottom: var(--sp-1);
}

.env__list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 4px 0;
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

.env__list b {
  font-weight: 600;
  color: var(--ink-2);
}

.env__state.is-ok {
  color: var(--st-ok);
}

.env__state.is-missing {
  color: var(--st-fail);
}
</style>
