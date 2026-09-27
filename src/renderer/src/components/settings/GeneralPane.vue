<script setup lang="ts">
/**
 * 设置 · 通用：程序（名称 / 快捷键 / 开机自启）、天气、笔记（图片仓库）、账号与同步仓库。
 *
 * 四个文本项都是「草稿字段」（useDraftField）：边打边存会把半截内容写进设置，
 * 失焦 / 回车才提交，提交后由 store 收敛、收敛后的值回推草稿。
 *
 * 弹窗关掉时要退出快捷键的录制态（open 的 watch）—— 不然下次打开落在「请按下新的组合键」上，
 * 看着像出了错。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { accountLabel } from '@shared/auth'
import { APP_NAME_DEFAULT, APP_NAME_MAX_LENGTH } from '@shared/app-name'
import { WEATHER_CITY_MAX } from '@shared/weather'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import { useDraftField } from '@/composables/use-draft-field'
import AccountDialog from '@/components/AccountDialog.vue'
import type { AppSettings } from '@/types'

const props = defineProps<{ open: boolean }>()

const settings = useSettingsStore()
const auth = useAuthStore()

const account = computed(() => auth.status?.account ?? null)

/** 「账号」那一行开的弹窗。顶栏也有一颗入口，两处各自开各自的 */
const accountVisible = ref(false)

const isPackaged = computed(() => !import.meta.env.DEV)

function save(patch: Partial<AppSettings>): void {
  void settings.updateSettings(patch)
}

/** 快捷键录制状态 */
const recording = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) recording.value = false
  }
)

/**
 * 程序名称的草稿（useDraftField，见 composables/use-draft-field.ts）：
 * 边打边存会每敲一个字就回推一次设置（还会被主进程收敛后覆盖光标），
 * 所以本地先存着，失焦 / 回车时再提交。
 */
const appNameDraft = useDraftField(() => settings.settings.appName)

function commitAppName(): void {
  if (appNameDraft.value === settings.settings.appName) return
  save({ appName: appNameDraft.value })
}

/**
 * 同步仓库地址的草稿：与程序名称同理，边打边存会把半截地址写进设置
 * （每次落盘都会触发一轮注定失败的同步），失焦 / 回车时再提交。
 * 提交后由 store 收敛（去掉空白、认不出的当没填），回推的值会盖掉草稿。
 */
const syncRepoDraft = useDraftField(() => settings.settings.tokenSyncRepo)

function commitSyncRepo(): void {
  if (syncRepoDraft.value === settings.settings.tokenSyncRepo) return
  save({ tokenSyncRepo: syncRepoDraft.value })
}

// ---------- 笔记图片 ----------

const imageRepoDraft = useDraftField(() => settings.settings.noteImageRepo)

function commitImageRepo(): void {
  if (imageRepoDraft.value === settings.settings.noteImageRepo) return
  save({ noteImageRepo: imageRepoDraft.value })
}

// ---------- 天气 ----------

/**
 * 天气城市的草稿：与程序名称同一套（失焦 / 回车才提交，收敛后的值回推草稿）。
 * 留空提交 = 关闭这条出口 —— 收敛会把空白压成空串。
 */
const weatherCityDraft = useDraftField(() => settings.settings.weatherCity)

function commitWeatherCity(): void {
  if (weatherCityDraft.value === settings.settings.weatherCity) return
  save({ weatherCity: weatherCityDraft.value })
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

/** 浏览器 KeyboardEvent.key → 快捷键串里的一段（Rust 侧交给 tauri-plugin-global-shortcut 解析） */
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
  settings.settings.hotkey
    .split('+')
    .map((part: string) => part.trim())
    .filter(Boolean)
    .join(' + ')
)

function captureHotkey(event: KeyboardEvent): void {
  // Esc 是「放弃这次录制」的正常路径：静默退出录制态并拦住事件 ——
  // 不拦的话它会冒泡到 el-dialog 的 close-on-press-escape，把整个设置弹窗一起关掉
  if (event.key === 'Escape') {
    recording.value = false
    event.stopPropagation()
    return
  }

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
</script>

<template>
  <section class="pane">
    <div class="block">
      <h3 class="block__title">程序</h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">程序名称</span>
          <span class="row__hint">
            显示在标题栏、托盘提示与窗口标题上；留空恢复为 {{ APP_NAME_DEFAULT }}，
            最多 {{ APP_NAME_MAX_LENGTH }} 个字符。
          </span>
        </div>
        <el-input
          v-model="appNameDraft"
          class="name-input"
          size="small"
          :maxlength="APP_NAME_MAX_LENGTH"
          spellcheck="false"
          :placeholder="APP_NAME_DEFAULT"
          @change="commitAppName"
        />
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">全局快捷键</span>
          <span class="row__hint">在任何窗口下唤起 / 隐藏 {{ settings.settings.appName }}。</span>
        </div>
        <el-switch
          :model-value="settings.settings.hotkeyEnabled"
          size="small"
          @update:model-value="(value: unknown) => save({ hotkeyEnabled: Boolean(value) })"
        />
      </div>

      <div class="row row--hotkey">
        <button
          class="hotkey"
          :class="{ 'is-recording': recording }"
          type="button"
          :disabled="!settings.settings.hotkeyEnabled"
          @click="startRecording"
          @keydown="recording && captureHotkey($event)"
        >
          <span v-if="recording" class="hotkey__recording">请按下新的组合键…</span>
          <span v-else class="hotkey__value mono">{{ hotkeyLabel }}</span>
        </button>
        <span class="row__hint row__hint--tight">点击后直接按组合键即可替换（按 Esc 放弃）</span>
      </div>

      <div class="row">
        <div class="row__text">
          <span class="row__label">开机自启</span>
          <span class="row__hint">
            {{ isPackaged ? '登录系统后自动在后台启动，只在托盘显示图标，点击图标即可打开界面。' : '开发模式下不会写入系统自启项。' }}
          </span>
        </div>
        <el-switch
          :model-value="settings.settings.launchAtLogin"
          size="small"
          :disabled="!isPackaged"
          @update:model-value="(value: unknown) => save({ launchAtLogin: Boolean(value) })"
        />
      </div>
    </div>

    <!--
      天气：顶栏问候语旁那一小段实况（`多云 19°`）。只有一个配置项：城市名 ——
      留空就是整条出口关闭，与两个同步仓库「留空即关闭」同一条规矩。
    -->
    <div class="block">
      <h3 class="block__title">天气</h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">城市</span>
          <span class="row__hint">
            顶栏问候语旁显示当地的实时天气，每半小时更新一次；留空则不显示、也不联网。
            城市名会作为查询串发出去：查经纬度走 OpenStreetMap 的公开检索，取实况走
            Open-Meteo 的免费接口 —— 两处都免费、不需要凭据（如「上海」「常州」）。
          </span>
        </div>
        <el-input
          v-model="weatherCityDraft"
          class="name-input"
          size="small"
          :maxlength="WEATHER_CITY_MAX"
          spellcheck="false"
          placeholder="城市名，如 上海"
          @change="commitWeatherCity"
        />
      </div>
    </div>

    <!--
      笔记这一块管两件事：图片往哪儿推、技能库在仓库里的哪一层。
      笔记**本身**那个 git 仓库不在这里，也没有这个地方：同步到哪儿由那个文件夹自己连着的
      远端决定（见 shared/note.ts 的 NoteRepoState），没仓库的文件夹就是本机的笔记 ——
      应用既不替用户 init、也不替他接远端。笔记文件夹本身在笔记页左栏底部挑，这里不重复显示。
    -->
    <div class="block">
      <h3 class="block__title">笔记</h3>

      <!--
        笔记里的图片：粘贴的图片推到用户自己的一个 git 仓库里，正文里只留一个外链。
        地址由仓库地址推导（GitHub / Gitee / GitLab 三家自动认，其余推不出来），
        而落在仓库的哪一层是定死的（`images/<设备>/<笔记本>`，见 shared/note-image.ts），
        所以这一项要填的只有一样：往哪个仓库推。
      -->
      <div class="row row--stack">
        <div class="row__text">
          <span class="row__label">图片仓库</span>
          <span class="row__hint">
            往笔记里粘贴图片时推进这个仓库，正文里只留一个链接（留空则粘贴时提示）。
            图片落在仓库的 images/&lt;本机设备&gt;/&lt;笔记本&gt; 下；
            凭据跟着账号走：登录过就用账号的 token，没登录就用系统里 git 配好的。
          </span>
        </div>
        <el-input
          v-model="imageRepoDraft"
          size="small"
          spellcheck="false"
          placeholder="git@github.com:you/notes-images.git"
          @change="commitImageRepo"
        />
      </div>

      <!--
        技能（skill）没有设置项：技能库是**它自己的一个目录**（技能页那颗「选择技能文件夹」挑的），
        与上面那个笔记文件夹互不相干 —— 可以正好是同一处，也可以各有各的仓库。
        所以这里既没有「技能目录」也没有「它在仓库哪一层」：那一层由磁盘决定
        （从技能库目录往上找最近的 `.git`，见 shared/skills.ts 的 SkillLibraryState）。
      -->
    </div>

    <!--
      账号这一块只剩登录状态与同步仓库地址（从别的机器取外观已挪到「外观」那一屏）。
      没登录时地址那一行不出现 —— 数据全部留在本机，登录回来接着用。
    -->
    <div class="block">
      <h3 class="block__title">账号</h3>

      <div class="row">
        <div class="row__text">
          <span class="row__label">登录状态</span>
          <span class="row__hint">
            登录后同步就用这个账号的 token 授权（私有仓库省掉先配 git 凭据）；
            不登录也能同步，走系统里 git 配好的那一套。
          </span>
        </div>
        <el-button size="small" @click="accountVisible = true">
          {{ account ? accountLabel(account) : '登录…' }}
        </el-button>
      </div>

      <template v-if="account">
        <div class="row row--stack">
          <div class="row__text">
            <span class="row__label">同步仓库</span>
            <span class="row__hint">
              填一个 git 仓库地址（建议私有仓库），留空即不同步；失焦或回车生效。
            </span>
          </div>
          <el-input
            v-model="syncRepoDraft"
            size="small"
            spellcheck="false"
            placeholder="git@github.com:you/workbench-token.git"
            @change="commitSyncRepo"
          />
        </div>
      </template>
    </div>

    <AccountDialog v-model="accountVisible" />
  </section>
</template>

<style scoped>
/* 程序名称输入框：定宽，别把右边这列的宽度让给长名字 */
.name-input {
  width: 220px;
  flex-shrink: 0;
}

.row--hotkey {
  align-items: center;
  gap: var(--sp-3);
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
</style>
