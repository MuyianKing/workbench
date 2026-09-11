<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Grid, Moon, Search, Setting, Sunny } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import SettingsDialog from '@/components/SettingsDialog.vue'

const store = useProjectsStore()
const searchInput = ref<HTMLInputElement | null>(null)
const settingsVisible = ref(false)

function focusSearch(): void {
  searchInput.value?.focus()
}

/** 直接进首页布局编辑态，不用先打开设置再点「进入编辑」 */
function enterLayoutEdit(): void {
  store.setLayoutEditing(true)
}

/** 当前是不是暗色：图标画的是「点下去会切到哪一边」，所以亮色时显示月亮 */
const isDark = computed(() => store.effectiveTheme === 'dark')

/** 传点击坐标，明暗过渡就从这颗图标扩散开（与设置里的主题按钮同一套动效） */
function toggleTheme(event: MouseEvent): void {
  void store.toggleTheme({ x: event.clientX, y: event.clientY })
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
      <el-button
        class="icon-btn"
        :icon="Grid"
        title="编辑布局"
        aria-label="编辑布局"
        @click="enterLayoutEdit"
      />

      <el-button
        class="icon-btn"
        :icon="isDark ? Sunny : Moon"
        :title="isDark ? '切换到亮色' : '切换到暗色'"
        :aria-label="isDark ? '切换到亮色' : '切换到暗色'"
        @click="toggleTheme"
      />

      <el-button
        class="icon-btn"
        :icon="Setting"
        title="系统配置"
        aria-label="系统配置"
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
</style>
