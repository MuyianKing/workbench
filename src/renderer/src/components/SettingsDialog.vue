<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import type { AppSettings, ThemeSource } from '@/types'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const store = useProjectsStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const themes: Array<{ value: ThemeSource; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' }
]

const isPackaged = computed(() => !import.meta.env.DEV)

/** 快捷键录制状态 */
const recording = ref(false)

function save(patch: Partial<AppSettings>): void {
  void store.updateSettings(patch)
}

// ---------- 快捷键 ----------

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'])

const KEY_ALIAS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

const PUNCTUATION = '`-=[]\\;\',./'

/** 浏览器 KeyboardEvent.key → Electron accelerator 片段 */
function normalizeKey(key: string): string | null {
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key)) return key
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  if (KEY_ALIAS[key]) return KEY_ALIAS[key]
  if (PUNCTUATION.includes(key)) return key
  return null
}

/** 人类可读的展示形式：Control+Shift+W → Ctrl + Shift + W */
const hotkeyLabel = computed(() =>
  store.settings.hotkey
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' + ')
)

function captureHotkey(event: KeyboardEvent): void {
  const key = normalizeKey(event.key)
  // 只按住修饰键时还没构成组合，继续等
  if (MODIFIER_KEYS.has(event.key) || !key) return

  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.shiftKey) parts.push('Shift')
  if (event.altKey) parts.push('Alt')
  if (event.metaKey) parts.push('Super')

  if (parts.length === 0) {
    ElMessage.warning('快捷键至少需要一个修饰键（Ctrl / Shift / Alt）')
    return
  }

  const accelerator = [...parts, key].join('+')
  recording.value = false
  // 换了组合键要重新注册，所以一定带上启用开关
  save({ hotkey: accelerator, hotkeyEnabled: true })
}

function startRecording(): void {
  recording.value = true
}

watch(visible, (open) => {
  if (!open) recording.value = false
})
</script>

<template>
  <el-dialog v-model="visible" title="设置" width="560" align-center>
    <div class="settings">
      <!-- 外观 -->
      <section class="block">
        <h3 class="block__title">外观</h3>

        <div class="row">
          <div class="row__text">
            <span class="row__label">主题</span>
            <span class="row__hint">跟随系统时会随系统切换实时变化。</span>
          </div>
          <el-radio-group
            :model-value="store.settings.theme"
            size="small"
            @update:model-value="(value: unknown) => save({ theme: value as ThemeSource })"
          >
            <el-radio-button v-for="t in themes" :key="t.value" :value="t.value">
              {{ t.label }}
            </el-radio-button>
          </el-radio-group>
        </div>
      </section>

      <!-- 窗口与托盘 -->
      <section class="block">
        <h3 class="block__title">窗口与托盘</h3>

        <div class="row">
          <div class="row__text">
            <span class="row__label">最小化到托盘</span>
            <span class="row__hint">
              开启后，最小化窗口会收进托盘。关闭按钮始终是收进托盘，托盘图标可以随时找回窗口。
            </span>
          </div>
          <el-switch
            :model-value="store.settings.minimizeToTray"
            size="small"
            @update:model-value="(value: unknown) => save({ minimizeToTray: Boolean(value) })"
          />
        </div>

        <div class="row">
          <div class="row__text">
            <span class="row__label">全局快捷键</span>
            <span class="row__hint">在任何窗口下唤起 / 隐藏 Workbench。</span>
          </div>
          <el-switch
            :model-value="store.settings.hotkeyEnabled"
            size="small"
            @update:model-value="(value: unknown) => save({ hotkeyEnabled: Boolean(value) })"
          />
        </div>

        <div class="row row--hotkey">
          <button
            class="hotkey"
            :class="{ 'is-recording': recording }"
            type="button"
            :disabled="!store.settings.hotkeyEnabled"
            @click="startRecording"
            @keydown="recording && captureHotkey($event)"
          >
            <span v-if="recording" class="hotkey__recording">请按下新的组合键…</span>
            <span v-else class="hotkey__value mono">{{ hotkeyLabel }}</span>
          </button>
          <span class="row__hint row__hint--tight">点击后直接按组合键即可替换（Esc 放弃需重开）</span>
        </div>
      </section>

      <!-- 启动与退出 -->
      <section class="block">
        <h3 class="block__title">启动与退出</h3>

        <div class="row">
          <div class="row__text">
            <span class="row__label">开机自启</span>
            <span class="row__hint">
              {{ isPackaged ? '登录系统后自动在后台启动。' : '开发模式下不会写入系统自启项。' }}
            </span>
          </div>
          <el-switch
            :model-value="store.settings.launchAtLogin"
            size="small"
            :disabled="!isPackaged"
            @update:model-value="(value: unknown) => save({ launchAtLogin: Boolean(value) })"
          />
        </div>

        <div class="row row--stack">
          <div class="row__text">
            <span class="row__label">退出行为</span>
            <span class="row__hint">
              关闭按钮只收进托盘，真正退出要走托盘菜单的「退出」；这里决定退出时怎么处理在跑的项目。
            </span>
          </div>
          <el-radio-group
            :model-value="store.settings.closeBehavior"
            size="small"
            class="stacked"
            @update:model-value="
              (value: unknown) => save({ closeBehavior: value as AppSettings['closeBehavior'] })
            "
          >
            <el-radio value="confirm">先提示确认，确认后再全部停止并退出</el-radio>
            <el-radio value="stopAll">不提示，直接停止所有项目并退出</el-radio>
          </el-radio-group>
        </div>
      </section>

      <!-- 数据存储 -->
      <section class="block">
        <h3 class="block__title">数据存储</h3>

        <div class="row row--stack">
          <div class="row__text">
            <span class="row__label">数据目录</span>
            <span class="row__hint">
              Workbench 写的东西都放这个目录里，换位置会把当前数据整体搬过去；目标目录已有同名数据文件时会拒绝并提示。
            </span>
          </div>
          <p class="path mono truncate" :title="store.dataLocation?.dir">
            {{ store.dataLocation?.dir ?? '读取中…' }}
          </p>
          <div class="path__actions">
            <el-button size="small" :icon="FolderOpened" @click="store.changeDataDir()">
              更改目录
            </el-button>
            <span class="row__hint row__hint--tight">
              {{ store.dataLocation?.isDefault ? '当前是默认目录（应用数据目录）' : '数据文件：workbench-data.json' }}
            </span>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <el-button @click="visible = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}

.block + .block {
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border);
}

.block__title {
  margin-bottom: var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--ink);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
}

.row + .row {
  margin-top: var(--sp-3);
}

.row--stack {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}

.row--hotkey {
  align-items: center;
  gap: var(--sp-3);
}

.row__text {
  min-width: 0;
}

.row__label {
  display: block;
  font-size: var(--fs-body);
  color: var(--ink);
}

.row__hint {
  display: block;
  margin-top: 3px;
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--ink-3);
}

.row__hint--tight {
  margin-top: 0;
  flex-shrink: 0;
}

.hotkey {
  min-width: 168px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--ink);
  font-size: var(--fs-meta);
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.hotkey:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.hotkey:disabled {
  color: var(--ink-3);
  cursor: not-allowed;
}

.hotkey.is-recording {
  border-color: var(--st-run);
  color: var(--st-run);
  background: var(--st-run-soft);
}

.stacked {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
}

.stacked :deep(.el-radio) {
  margin-right: 0;
}

/* ---------- 数据位置 ---------- */
.path {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  font-size: var(--fs-meta);
  color: var(--ink-2);
}

.path__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
</style>
