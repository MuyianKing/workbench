<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Monitor, Refresh, Search, Setting } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useProjectsStore } from '@/stores/projects'
import SettingsDialog from '@/components/SettingsDialog.vue'
import type { InstallablePackageManager } from '@/types'

const store = useProjectsStore()
const searchInput = ref<HTMLInputElement | null>(null)
const settingsVisible = ref(false)

const versions = window.workbench?.versions ?? { electron: '—', node: '—', chrome: '—' }

/** installable 为 true 的可以点一下用 npm 全局装；npm 自己随 Node.js 分发，装不了 */
const managers = [
  { key: 'npm', label: 'npm', installable: false },
  { key: 'yarn', label: 'yarn', installable: true },
  { key: 'pnpm', label: 'pnpm', installable: true }
] as const

function managerAvailable(key: 'npm' | 'yarn' | 'pnpm'): boolean {
  return store.packageManagers?.[key] ?? false
}

function installing(key: 'npm' | 'yarn' | 'pnpm'): boolean {
  return store.pmInstalling === key
}

async function installManager(key: 'npm' | 'yarn' | 'pnpm'): Promise<void> {
  if (key === 'npm') {
    ElMessage.warning('npm 随 Node.js 分发，请重新安装 Node.js 后再试')
    return
  }
  await store.installPackageManager(key as InstallablePackageManager)
}

/** 每次打开弹层都重探一次：可能在应用外面刚装完东西，状态不该等到下次启动才更新 */
function onEnvShow(): void {
  if (store.pmInstalling) return
  void store.refreshPackageManagers()
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
      <el-popover
        placement="bottom-end"
        :width="268"
        trigger="click"
        popper-class="env-popover"
        @show="onEnvShow"
      >
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

          <p class="eyebrow env__gap">
            包管理器
            <el-button
              class="env__refresh"
              link
              size="small"
              :icon="Refresh"
              :disabled="!!store.pmInstalling"
              title="重新检测"
              aria-label="重新检测"
              @click="store.refreshPackageManagers()"
            />
          </p>
          <ul class="env__list">
            <li v-for="m in managers" :key="m.key">
              <span class="mono">{{ m.label }}</span>

              <b v-if="managerAvailable(m.key)" class="env__state is-ok">可用</b>

              <el-button
                v-else-if="m.installable"
                class="env__install"
                link
                size="small"
                :loading="installing(m.key)"
                :disabled="!!store.pmInstalling && !installing(m.key)"
                @click="installManager(m.key)"
              >
                {{ installing(m.key) ? '安装中' : '安装' }}
              </el-button>

              <b v-else class="env__state is-missing" title="npm 随 Node.js 分发，请重新安装 Node.js">未安装</b>
            </li>
          </ul>

          <p v-if="store.pmInstalling && store.pmInstallLog" class="env__log mono truncate" :title="store.pmInstallLog">
            {{ store.pmInstallLog }}
          </p>
          <p v-else-if="store.pmInstalling" class="env__log env__log--idle">正在通过 npm 安装…</p>
          <p v-if="store.pmInstalling" class="env__note">完整输出在下方终端</p>
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
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: var(--sp-4);
  margin-bottom: var(--sp-1);
}

/* 标题旁边的重探按钮：不占地方，也不抢眼 */
.env__refresh {
  height: auto;
  padding: 0;
  color: var(--ink-3);
}

.env__refresh:hover {
  color: var(--ink);
}

/* 未安装时那一下点击：做成行内小按钮，别把列表撑高 */
.env__install {
  height: auto;
  padding: 0;
  font-size: var(--fs-meta);
  font-weight: 600;
}

.env__log {
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.env__log--idle {
  font-family: var(--font-ui);
}

.env__note {
  margin-top: 4px;
  font-size: var(--fs-micro);
  color: var(--ink-3);
  opacity: 0.75;
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
