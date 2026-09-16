<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleClose, FolderOpened, Picture, Rank } from '@element-plus/icons-vue'
import { accountLabel } from '@shared/auth'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'
import { useEnvironmentStore } from '@/stores/environment'
import { useAuthStore } from '@/stores/auth'
import AccountDialog from '@/components/AccountDialog.vue'
import { ACCENT_PRESETS, type AccentInkMode } from '@shared/accent-color'
import { APP_NAME_DEFAULT, APP_NAME_MAX_LENGTH } from '@shared/app-name'
import { CARD_GAP_MAX, CARD_GAP_MIN, GRID_STEP_MAX, GRID_STEP_MIN } from '@shared/theme'
import {
  BACKGROUND_OPACITY_MAX,
  BACKGROUND_OPACITY_MIN
} from '@shared/workspace-background'
import { builtinIdOf } from '@shared/wallpaper'
import { CARD_OPACITY_MAX, CARD_OPACITY_MIN } from '@shared/card-opacity'
import { imageRawUrl, imageRepoPath, imageScopeDir } from '@shared/note-image'
import { formatRelative } from '@/format'
import type { AppSettings, SyncDeviceInfo, ThemeSource, TopBarStyle } from '@/types'
import type { ThemeOrigin } from '@/theme-transition'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const store = useProjectsStore()
const settings = useSettingsStore()
const environment = useEnvironmentStore()
const auth = useAuthStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** 「账号」那一行开的弹窗。也挂在顶栏上，两处共用同一个 store 状态，谁先开都行 */
const accountVisible = ref(false)
const account = computed(() => auth.status?.account ?? null)

/** el-switch 的 model-value 是联合类型（开了 string/number 取值时），这里只要布尔 */
function setUseAccountForSync(value: boolean | string | number): void {
  save({ useAccountForSync: value === true })
}

/**
 * 左侧菜单只有两项：外观（含首页画布的布局，它们都是「看起来什么样」的设置）、
 * 通用（程序、快捷键、启动、数据目录、账号与同步）。选中项不随关闭重置，
 * 下次打开还停在上一屏，省得每次都要再点一次。
 */
type SettingsTab = 'appearance' | 'general'

const tabs: Array<{ value: SettingsTab; label: string }> = [
  { value: 'appearance', label: '外观' },
  { value: 'general', label: '通用' }
]

const activeTab = ref<SettingsTab>('appearance')

const themes: Array<{ value: ThemeSource; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' }
]

/** 顶部三条栏的三种处理方式，顺序与设置界面上的一致 */
const topBarStyles: Array<{ value: TopBarStyle; label: string }> = [
  { value: 'band', label: '正常' },
  { value: 'glass', label: '毛玻璃' },
  { value: 'clear', label: '透明' }
]

/** 主题色上文字的三种取法，顺序与设置界面上的一致 */
const accentInkModes: Array<{ value: AccentInkMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'white', label: '白字' },
  { value: 'dark', label: '黑字' }
]

const isPackaged = computed(() => !import.meta.env.DEV)

/**
 * 背景预览框里那行字：有图就是空的（img 顶掉它），没图要分清「还没选」和「选了但读不出来」，
 * 后者是图片被删 / 换了格式，得让用户知道该重新选一张。
 */
const backgroundHint = computed(() => {
  if (settings.backgroundImage) return ''
  if (settings.backgroundError) return '图片读不出来'
  return settings.settings.workspaceBackground ? '读取中…' : '未设置'
})

/**
 * 名字不再单独占一行（内置壁纸那一栏已经高亮说明了是哪张，自选的图看预览也知道），
 * 但「到底设的是哪个文件」还得能查到 —— 鼠标停在预览上给全名。
 */
const backgroundTitle = computed(
  () => settings.backgroundName || settings.settings.workspaceBackground || '还没有选择背景图'
)

/** 当前背景是自选的本地文件（不是内置壁纸），给「本地图片」那块一个选中态 */
const isLocalBackground = computed(
  () =>
    !!settings.settings.workspaceBackground &&
    builtinIdOf(settings.settings.workspaceBackground) === null
)

/**
 * 渐淡色：给几个跟这套界面同调的低饱和底色，省得每次现调。
 * 前两个就是明暗两套主题的画布色，选它们等于「跟随主题」的显式版本。
 */
const VEIL_PRESETS = [
  '#edeff2',
  '#1b212a',
  '#f3efe7',
  '#eef1ec',
  '#e9edf2',
  '#f6ece0',
  '#2a2620'
]

const veilLabel = computed(() =>
  settings.settings.workspaceBackgroundVeil
    ? settings.settings.workspaceBackgroundVeil.toUpperCase()
    : '默认（主题画布色）'
)

const accentPresets: string[] = [...ACCENT_PRESETS]

/** 主题色当前值：留空就是界面原本的中性色，得说清楚「没配」不等于没生效 */
const accentLabel = computed(() =>
  settings.settings.accentColor ? settings.settings.accentColor.toUpperCase() : '默认（中性色）'
)

/** 快捷键录制状态 */
const recording = ref(false)

/**
 * 程序名称的草稿：边打边存会每敲一个字就回推一次设置（还会被主进程收敛后覆盖光标），
 * 所以本地先存着，失焦 / 回车时再提交。
 */
const appNameDraft = ref('')
watch(
  () => settings.settings.appName,
  (value) => {
    appNameDraft.value = value
  },
  { immediate: true }
)

function commitAppName(): void {
  if (appNameDraft.value === settings.settings.appName) return
  save({ appName: appNameDraft.value })
}

/**
 * 同步仓库地址的草稿：与程序名称同理，边打边存会把半截地址写进设置
 * （每次落盘都会触发一轮注定失败的同步），失焦 / 回车时再提交。
 * 提交后由 store 收敛（去掉空白、认不出的当没填），回推的值会盖掉草稿。
 */
const syncRepoDraft = ref('')
watch(
  () => settings.settings.tokenSyncRepo,
  (value) => {
    syncRepoDraft.value = value
  },
  { immediate: true }
)

function commitSyncRepo(): void {
  if (syncRepoDraft.value === settings.settings.tokenSyncRepo) return
  save({ tokenSyncRepo: syncRepoDraft.value })
}

/** el-switch 的 model-value 可能是联合类型，这里只要布尔 */
function setSyncAppearance(value: boolean | string | number): void {
  save({ syncAppearance: value === true })
}

/**
 * 应用另一台机器的配置。
 *
 * 会整份覆盖本机当前的外观与首页布局（连带对方的工作区背景设置），所以先问一句；
 * 确认之后由 store 走既有的 updateThemeConfig 通道落盘，界面上不需要另做刷新。
 */
async function applyAppearance(device: SyncDeviceInfo): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `把本机的外观与首页布局换成「${device.name}」那一套？本机现在这份仍然留在仓库里，随时可以再取回来。` +
        '对方若用的是它本机上的图片作背景，这边读不出来，需要重新选一张。',
      '应用外观配置',
      { type: 'warning', confirmButtonText: '应用', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await settings.applySyncAppearance(device.id)
}

/** 手动同步一次，再把设备列表重新读一遍（列表是上一次同步取回来的样子） */
async function syncNow(): Promise<void> {
  syncing.value = true
  try {
    await settings.syncNow()
  } finally {
    syncing.value = false
    await settings.loadSyncDevices()
  }
}

/** 手动同步一次进行中 */
const syncing = ref(false)

/** 设备列表里的相对时间：打开设置时算一次就够，不必为它挂定时器 */
function deviceUpdatedText(device: SyncDeviceInfo): string {
  return device.theme
    ? `更新于 ${formatRelative(device.updatedAt, Date.now())}`
    : '没有配置'
}

function save(patch: Partial<AppSettings>): void {
  void settings.updateSettings(patch)
}

// ---------- 笔记仓库 ----------

/*
 * 与下面那三个图片输入框同一条做法：先落草稿、失焦或回车时才提交（地址是逐字符敲进去的），
 * 提交后由 store 收敛（去空白、认不出的当没填），回推的值会盖掉草稿。
 */
const noteRepoDraft = ref('')

watch(
  () => settings.settings.noteSyncRepo,
  (value) => {
    noteRepoDraft.value = value
  },
  { immediate: true }
)

function commitNoteRepo(): void {
  if (noteRepoDraft.value === settings.settings.noteSyncRepo) return
  save({ noteSyncRepo: noteRepoDraft.value })
}

// ---------- 笔记图片 ----------

const imageRepoDraft = ref('')
const imageDirDraft = ref('')
const imageBaseUrlDraft = ref('')

watch(
  () => settings.settings.noteImageRepo,
  (value) => {
    imageRepoDraft.value = value
  },
  { immediate: true }
)
watch(
  () => settings.settings.noteImageDir,
  (value) => {
    imageDirDraft.value = value
  },
  { immediate: true }
)
watch(
  () => settings.settings.noteImageBaseUrl,
  (value) => {
    imageBaseUrlDraft.value = value
  },
  { immediate: true }
)

function commitImageRepo(): void {
  if (imageRepoDraft.value === settings.settings.noteImageRepo) return
  save({ noteImageRepo: imageRepoDraft.value })
}

function commitImageDir(): void {
  if (imageDirDraft.value === settings.settings.noteImageDir) return
  save({ noteImageDir: imageDirDraft.value })
}

function commitImageBaseUrl(): void {
  if (imageBaseUrlDraft.value === settings.settings.noteImageBaseUrl) return
  save({ noteImageBaseUrl: imageBaseUrlDraft.value })
}

/**
 * 照当前配置给一个样例地址，让人一眼看出「上传之后插进正文的是什么」。
 *
 * 中间那两层（设备 / 笔记本）由应用自己加上，这里用占位值示意 —— 真实值分别是本机设备 id
 * 与「笔记本目录名 + 路径摘要」（见 shared/note-image.ts 的 imageScopeDir）。
 * 分支拿 `main` 举例（真实分支是克隆之后才知道的），所以这里明说了是示例；
 * 拼不出来时是空串 —— 那正是在提醒：下面那栏得自己填。
 */
const imageUrlSample = computed(() =>
  imageRawUrl({
    repo: settings.settings.noteImageRepo,
    branch: 'main',
    path: imageRepoPath(
      imageScopeDir(settings.settings.noteImageDir, 'device-id', 'Notebook'),
      '20260916-104512-ab12cd34.png'
    ),
    baseUrl: settings.settings.noteImageBaseUrl
  })
)

/**
 * 主题切换的扩散起点：记按下位置，切换动画就从那颗按钮长出来。
 * 用 pointerdown 是因为它一定早于 radio 的 change；键盘切换没有按下位置，交给 store 从中心扩散。
 */
const themeOrigin = ref<ThemeOrigin | null>(null)

function rememberThemeOrigin(event: PointerEvent): void {
  themeOrigin.value = { x: event.clientX, y: event.clientY }
}

function changeTheme(value: ThemeSource): void {
  const origin = themeOrigin.value
  themeOrigin.value = null
  void settings.updateSettings({ theme: value }, origin)
}

/** 进入首页布局编辑态：关掉设置，把画面让给画布上的拖动把手 */
function enterLayoutEdit(): void {
  store.setLayoutEditing(true)
  visible.value = false
}

function changeGridStep(value: number | undefined): void {
  if (typeof value === 'number') void settings.setGridStep(value)
}

function changeCardGap(value: number | undefined): void {
  if (typeof value === 'number') void settings.setCardGap(value)
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
  if (!open) {
    recording.value = false
    return
  }
  // 内置壁纸的缩略图要现压，按需在第一次打开面板时取（见 store 的 ensureWallpapers）
  void settings.ensureWallpapers()
})

/**
 * 通用那一屏里的「从别的机器取外观」要一份设备列表。
 * 读的是上一次同步取回的仓库快照（不联网），所以每次切到这一屏都重读一遍最省心 ——
 * 用户很可能刚从首页点过同步按钮再进来。
 */
watch([visible, activeTab], ([open, tab]) => {
  if (open && tab === 'general') void settings.loadSyncDevices()
})
</script>

<template>
  <!--
    append-to-body：弹层必须离开 .app 子树，否则会被顶部毛玻璃的 backdrop-filter 连累（见 global.css 弹层一节）。
    class / body-class：两栏骨架与固定高度都在 global.css 里（见 .el-dialog.settings-dialog）。
    没有 footer：这里的设置都是改完即生效的，留一个「完成」按钮只是关窗用，不如省掉那一条 ——
    关窗走右上角的 ×、Esc 或点遮罩，三条都是 EP 自带的。
  -->
  <el-dialog
    v-model="visible"
    class="settings-dialog"
    title="设置"
    width="920"
    align-center
    append-to-body
    body-class="settings-body"
  >
    <div class="settings">
      <!-- 左侧菜单：只有两项，点哪项右侧就换成哪一屏 -->
      <nav class="settings__nav">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          class="nav-item"
          type="button"
          :class="{ 'is-active': activeTab === tab.value }"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
        </button>
      </nav>

      <!-- 内容区只是过道；每个 pane 自己滚，切屏时各留各的位置 -->
      <div class="settings__body">
        <!-- 外观：主题、背景、顶部样式，以及首页画布的布局 -->
        <section v-show="activeTab === 'appearance'" class="pane">
          <!-- 这一组就是导航项本身，不再另起小标题 -->
          <div class="block">
            <div class="row">
              <div class="row__text">
                <span class="row__label">主题</span>
                <span class="row__hint">跟随系统时随系统切换。</span>
              </div>
              <el-radio-group
                :model-value="settings.settings.theme"
                size="small"
                @pointerdown="rememberThemeOrigin"
                @update:model-value="(value: unknown) => changeTheme(value as ThemeSource)"
              >
                <el-radio-button v-for="t in themes" :key="t.value" :value="t.value">
                  {{ t.label }}
                </el-radio-button>
              </el-radio-group>
            </div>

            <div class="row">
              <div class="row__text">
                <span class="row__label">主题色</span>
                <span class="row__hint">界面交互态用的颜色；留空是原本的中性灰。</span>
              </div>
              <div class="slider">
                <el-color-picker
                  :model-value="settings.settings.accentColor || null"
                  size="small"
                  :predefine="accentPresets"
                  @change="(value: unknown) => void settings.setAccentColor(String(value ?? ''))"
                />
                <span class="accent__value mono">{{ accentLabel }}</span>
                <el-button
                  link
                  size="small"
                  :disabled="!settings.settings.accentColor"
                  @click="settings.setAccentColor('')"
                >
                  恢复默认
                </el-button>
              </div>
            </div>

            <div class="row">
              <div class="row__text">
                <span class="row__label">主题色文字</span>
                <span class="row__hint">主题色上那层字；自动按底色深浅挑黑白，也可手动指定。</span>
              </div>
              <el-radio-group
                class="style-pick"
                :model-value="settings.settings.accentInk"
                size="small"
                @update:model-value="(value: unknown) => void settings.setAccentInk(value as AccentInkMode)"
              >
                <el-radio-button v-for="m in accentInkModes" :key="m.value" :value="m.value">
                  {{ m.label }}
                </el-radio-button>
              </el-radio-group>
            </div>

            <div class="row row--stack">
              <div class="row__text">
                <span class="row__label">工作区背景</span>
              </div>

              <div class="bg">
                <div class="bg__preview" :title="backgroundTitle">
                  <img v-if="settings.backgroundImage" :src="settings.backgroundImage" alt="工作区背景预览" />
                  <span v-else class="bg__empty">{{ backgroundHint }}</span>
                </div>

                <div class="bg__body">
                  <div class="slider">
                    <span class="bg__label">浓淡</span>
                    <el-slider
                      :model-value="settings.backgroundOpacity"
                      :min="BACKGROUND_OPACITY_MIN"
                      :max="BACKGROUND_OPACITY_MAX"
                      :step="5"
                      :show-tooltip="false"
                      size="small"
                      :disabled="!settings.settings.workspaceBackground"
                      @input="(value: unknown) => (settings.backgroundOpacity = Number(value))"
                      @change="(value: unknown) => void settings.setBackgroundOpacity(Number(value))"
                    />
                    <span class="slider__value mono">{{ settings.backgroundOpacity }}%</span>
                  </div>

                  <!-- 蒙版色：图片渐淡进去的那个颜色；留空就跟着主题的画布色走 -->
                  <div class="slider">
                    <span class="bg__label">渐淡色</span>
                    <el-color-picker
                      :model-value="settings.settings.workspaceBackgroundVeil || null"
                      size="small"
                      :predefine="VEIL_PRESETS"
                      @change="(value: unknown) => void settings.setBackgroundVeil(String(value ?? ''))"
                    />
                    <span class="bg__veil mono">{{ veilLabel }}</span>
                    <el-button
                      link
                      size="small"
                      :disabled="!settings.settings.workspaceBackgroundVeil"
                      @click="settings.setBackgroundVeil('')"
                    >
                      跟随主题
                    </el-button>
                  </div>

                  <p v-if="settings.backgroundError" class="bg__error">{{ settings.backgroundError }}</p>
                </div>
              </div>

              <!--
                壁纸：摆出方格直接点选，选中即生效 —— 没有单独的「选择 / 清除」按钮。
                每格都是「正方形图位 + 下方标签」，壁纸、本地入口、无背景三者形状完全一致。
                内置的那几张引用 builtin:<id> 而不是安装路径（路径换个安装位置就失效了）；
                「本地图片」是自选磁盘文件的入口，「无背景」相当于清除。
                内置目录为空（老版本升级上来）时只少几块图，入口仍在。
              -->
              <div class="wallpapers">
                <span v-if="settings.wallpapers.length" class="bg__label">内置壁纸</span>

                <div class="wallpapers__list">
                  <button
                    v-for="item in settings.wallpapers"
                    :key="item.reference"
                    class="wallpaper"
                    type="button"
                    :class="{ 'is-active': settings.settings.workspaceBackground === item.reference }"
                    :title="item.name"
                    @click="settings.useWallpaper(item.reference)"
                  >
                    <span class="wallpaper__thumb">
                      <img v-if="item.thumbnail" :src="item.thumbnail" alt="" />
                      <span v-else class="wallpaper__name">读不出来</span>
                    </span>
                    <span class="wallpaper__name truncate">{{ item.id }}</span>
                  </button>

                  <button
                    class="wallpaper wallpaper--local"
                    type="button"
                    :class="{ 'is-active': isLocalBackground }"
                    :title="backgroundTitle"
                    @click="settings.pickBackground()"
                  >
                    <span class="wallpaper__thumb wallpaper__thumb--blank">
                      <el-icon><Picture /></el-icon>
                    </span>
                    <span class="wallpaper__name truncate">本地图片</span>
                  </button>

                  <button
                    class="wallpaper"
                    type="button"
                    :class="{ 'is-active': !settings.settings.workspaceBackground }"
                    title="恢复默认画布"
                    @click="settings.clearBackground()"
                  >
                    <span class="wallpaper__thumb wallpaper__thumb--blank">
                      <el-icon><CircleClose /></el-icon>
                    </span>
                    <span class="wallpaper__name">无背景</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="row">
              <div class="row__text">
                <span class="row__label">顶部样式</span>
                <span class="row__hint">正常＝实底，毛玻璃＝磨砂，透明＝透出壁纸。</span>
              </div>
              <el-radio-group
                class="style-pick"
                :model-value="settings.settings.topBarStyle"
                size="small"
                @update:model-value="(value: unknown) => void settings.setTopBarStyle(value as TopBarStyle)"
              >
                <el-radio-button v-for="s in topBarStyles" :key="s.value" :value="s.value">
                  {{ s.label }}
                </el-radio-button>
              </el-radio-group>
            </div>

            <div class="row">
              <div class="row__text">
                <span class="row__label">卡片不透明度</span>
                <span class="row__hint">首页卡片底色的浓度；越小越透，背景从卡片底下透出来。</span>
              </div>
              <div class="slider card-slider">
                <el-slider
                  :model-value="settings.cardOpacity"
                  :min="CARD_OPACITY_MIN"
                  :max="CARD_OPACITY_MAX"
                  :step="5"
                  :show-tooltip="false"
                  size="small"
                  @input="(value: unknown) => (settings.cardOpacity = Number(value))"
                  @change="(value: unknown) => void settings.setCardOpacity(Number(value))"
                />
                <span class="slider__value mono">{{ settings.cardOpacity }}%</span>
              </div>
            </div>
          </div>

          <div class="block">
            <h3 class="block__title">首页布局</h3>

            <div class="row">
              <div class="row__text">
                <span class="row__label">布局调整</span>
                <span class="row__hint">
                  编辑模式里可拖动卡片换栏、调顺序，拖下沿改高度，拖栏间竖线改宽度。
                </span>
              </div>
              <el-button class="layout-edit" size="small" :icon="Rank" @click="enterLayoutEdit">
                进入编辑
              </el-button>
            </div>

            <div class="row">
              <div class="row__text">
                <span class="row__label">拖动步进</span>
                <span class="row__hint">位置与尺寸按这个像素网格吸附。</span>
              </div>
              <el-input-number
                class="number-input"
                :model-value="settings.gridStep"
                :min="GRID_STEP_MIN"
                :max="GRID_STEP_MAX"
                :step="1"
                size="small"
                controls-position="right"
                @change="changeGridStep"
              />
            </div>

            <div class="row">
              <div class="row__text">
                <span class="row__label">卡片间距</span>
                <span class="row__hint">卡片之间与页面四周的留白（px）。</span>
              </div>
              <el-input-number
                class="number-input"
                :model-value="settings.cardGap"
                :min="CARD_GAP_MIN"
                :max="CARD_GAP_MAX"
                :step="1"
                size="small"
                controls-position="right"
                @change="changeCardGap"
              />
            </div>
          </div>
        </section>

        <!-- 通用：程序本身、窗口与托盘、启动退出、数据目录、账号与同步（登录后才出现同步那几项） -->
        <section v-show="activeTab === 'general'" class="pane">
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
          </div>

          <div class="block">
            <h3 class="block__title">窗口与托盘</h3>

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
              <span class="row__hint row__hint--tight">点击后直接按组合键即可替换（Esc 放弃需重开）</span>
            </div>
          </div>

          <div class="block">
            <h3 class="block__title">启动与退出</h3>

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

          <div class="block">
            <h3 class="block__title">数据存储</h3>

            <div class="row row--stack">
              <div class="row__text">
                <span class="row__label">数据目录</span>
                <span class="row__hint">
                  {{ settings.settings.appName }} 的东西都放这个目录里，换位置会把当前数据整体搬过去。
                </span>
              </div>
              <p class="path mono truncate" :title="environment.dataLocation?.dir">
                {{ environment.dataLocation?.dir ?? '读取中…' }}
              </p>
              <div class="path__actions">
                <el-button size="small" :icon="FolderOpened" @click="environment.changeDataDir()">
                  更改目录
                </el-button>
                <span class="row__hint row__hint--tight">
                  {{ environment.dataLocation?.isDefault ? '当前是默认目录（应用数据目录）' : '数据文件：workbench-data.json' }}
                </span>
              </div>
            </div>
          </div>

          <!--
            笔记本身同步：同步的就是**当前那个笔记文件夹**（所以这里把它也显示出来），
            与图片那条路一样，地址留空 = 关掉这个功能（笔记页那颗按钮点了只会得到一句提示）。
          -->
          <div class="block">
            <h3 class="block__title">笔记</h3>

            <div class="row row--stack">
              <div class="row__text">
                <span class="row__label">笔记仓库</span>
                <span class="row__hint">
                  笔记页左栏底部那颗同步按钮会把当前笔记本当成一个 git 工作区：提交本机改动、
                  拉回别处的改动（第一次同步会在那个文件夹里 git init 并接上这个地址）。
                  留空就是不同步。用账号授权同步的开关同样管这里；没登录就用系统里 git 配好的凭据。
                </span>
              </div>
              <el-input
                v-model="noteRepoDraft"
                size="small"
                spellcheck="false"
                placeholder="git@github.com:you/notes.git"
                @change="commitNoteRepo"
              />
            </div>

            <!-- 同步的是「当前这个文件夹」，所以它得看得见：它是在笔记页挑的，不在这里改 -->
            <div class="row">
              <div class="row__text">
                <span class="row__label">当前笔记本</span>
                <span class="row__hint mono truncate" :title="settings.settings.noteDir">
                  {{ settings.settings.noteDir || '还没选（在笔记页左栏底部挑一个文件夹）' }}
                </span>
              </div>
            </div>
          </div>

          <!--
            笔记里的图片：粘贴的图片推到用户自己的一个 git 仓库里，正文里只留一个外链。
            地址由仓库地址推导（GitHub / Gitee / GitLab 三家自动认，其余自己填前缀），
            所以这一块的核心是那三个输入框 —— 它们填完长什么样，下面那句示例直接给出来。
          -->
          <div class="block">
            <h3 class="block__title">笔记图片</h3>

            <div class="row row--stack">
              <div class="row__text">
                <span class="row__label">图片仓库</span>
                <span class="row__hint">
                  往笔记里粘贴图片时，图会推进这个 git 仓库，正文里只留一个链接（留空则粘贴时提示）。
                  用账号授权同步的开关同样管这里；没登录就用系统里 git 配好的凭据。
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
              路径这一栏**不跟着仓库地址一起藏**：它本来就是「上传到仓库哪里」的那一项，
              仓库还没填时也得看得见（看不见会让人以为根本没有这一栏）。
              后面两项（访问地址前缀与那句示例）只跟地址有关，没填仓库时留着是噪音。
            -->
            <div class="row">
              <div class="row__text">
                <span class="row__label">图片目录</span>
                <span class="row__hint">
                  上传到仓库的哪个目录下，例如 images 就是传进仓库的 images 目录（可以写多级，
                  如 notes/images）。应用会在它下面再按「本机设备 / 笔记本」分两层，
                  素材管理只看得到当前笔记本自己那一层；留空就是从仓库根目录开始分这两层。
                </span>
              </div>
              <el-input
                v-model="imageDirDraft"
                class="name-input"
                size="small"
                spellcheck="false"
                placeholder="images"
                @change="commitImageDir"
              />
            </div>

            <template v-if="settings.settings.noteImageRepo">
              <div class="row row--stack">
                <div class="row__text">
                  <span class="row__label">访问地址前缀</span>
                  <span class="row__hint">
                    留空按仓库地址自动推导（GitHub / Gitee / GitLab）；
                    自建 GitLab / Gitea、图床镜像或 Pages 在这里填前缀。
                  </span>
                </div>
                <el-input
                  v-model="imageBaseUrlDraft"
                  size="small"
                  spellcheck="false"
                  placeholder="https://cdn.example.com/notes"
                  @change="commitImageBaseUrl"
                />
              </div>

              <div class="row">
                <div class="row__text">
                  <span class="row__label">上传后插入的地址</span>
                  <span class="row__hint mono truncate" :title="imageUrlSample || ''">
                    {{ imageUrlSample || '推不出来：仓库地址认不出托管方，请填上面的前缀' }}
                  </span>
                </div>
              </div>
            </template>
          </div>

          <!--
            账号与同步同属一块：同步的凭据来自账号，所以没登录时下面几行整个不出现 ——
            数据全部留在本机（地址等设置不丢，登录回来接着用）。
          -->
          <div class="block">
            <h3 class="block__title">账号</h3>

            <div class="row">
              <div class="row__text">
                <span class="row__label">登录状态</span>
                <span class="row__hint">
                  登录后可把用量与外观同步到多台机器；不登录则只用本机数据。
                </span>
              </div>
              <el-button size="small" @click="accountVisible = true">
                {{ account ? accountLabel(account) : '登录…' }}
              </el-button>
            </div>

            <template v-if="account">
              <div class="row">
                <div class="row__text">
                  <span class="row__label">用这个账号授权同步</span>
                  <span class="row__hint">关掉则改用系统里 git 配好的凭据。</span>
                </div>
                <el-switch
                  :model-value="settings.settings.useAccountForSync"
                  @update:model-value="setUseAccountForSync"
                />
              </div>

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

              <div class="row">
                <div class="row__text">
                  <span class="row__label">同步外观配置</span>
                  <span class="row__hint">连同外观与首页布局一起同步；只同步用量数字就关掉。</span>
                </div>
                <el-switch
                  :model-value="settings.settings.syncAppearance"
                  @update:model-value="setSyncAppearance"
                />
              </div>

              <!-- 别台机器的外观：列表来自上一次同步取回的仓库快照，「应用」是唯一的采用入口 -->
              <div v-if="settings.settings.tokenSyncRepo" class="row row--stack">
                <div class="row__text">
                  <span class="row__label">从别的机器取外观</span>
                  <span class="row__hint">
                    「应用」会把本机的外观与首页布局整份换成对方那一套，本机这份仍留在仓库里。
                  </span>
                </div>

                <div class="devices">
                  <div v-for="device in settings.syncDevices" :key="device.id" class="device">
                    <span class="device__name truncate" :title="device.name">{{ device.name }}</span>
                    <span class="device__time">{{ deviceUpdatedText(device) }}</span>
                    <el-button
                      size="small"
                      :disabled="!device.theme"
                      @click="applyAppearance(device)"
                    >
                      应用
                    </el-button>
                  </div>

                  <span v-if="!settings.syncDevices.length" class="row__hint">
                    还没有别的机器：在另一台机器上填同一个仓库并同步一次。
                  </span>
                </div>

                <div class="path__actions">
                  <el-button size="small" :loading="syncing" @click="syncNow">同步一次</el-button>
                </div>
              </div>
            </template>
          </div>
        </section>
      </div>
    </div>
  </el-dialog>

  <AccountDialog v-model="accountVisible" />
</template>

<style scoped>
/**
 * 两栏骨架：左侧菜单定宽、不滚动，右侧内容自己滚。
 * 正文是 flex 容器（见 global.css 的 .el-dialog__body.settings-body），这里撑满它，
 * 两栏就都拿到了确定的高度 —— 右侧内容区能滚、左侧菜单也不会漏出弹窗。
 */
.settings {
  display: flex;
  flex: 1;
  min-width: 0;
  /*
   * 弹窗里所有 small 控件统一 28px 高。global.css 把 small 按钮定成 28px，而 EP 的输入框 /
   * 数字框 / 取色器走自己的 --el-component-size-small（24px），不改就会同列一个高一个矮
   * （首页布局那列：按钮 28、两个数字框 24，一眼看出错位）。只影响输入类控件，开关与单选不受影响。
   */
  --el-component-size-small: 28px;
}

.settings__nav {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 148px;
  padding: var(--sp-3) var(--sp-3) var(--sp-4);
  border-right: 1px solid var(--border);
}

/**
 * 菜单项：一块能点中的文字，选中时落一层灰底（界面主体灰度，彩色只留给运行状态）。
 * button 只继承到 font-family，字号得自己给，否则会退回浏览器默认的 13.33px。
 */
.nav-item {
  padding: 7px 10px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-2);
  font-size: var(--fs-body);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.nav-item:hover {
  background: var(--bg-inset);
  color: var(--ink);
}

.nav-item.is-active {
  background: var(--bg-selected);
  color: var(--ink);
  font-weight: 600;
}

/* 内容区只是个过道：自己不留内边距、也不滚，两件事都下放给每一屏（见 .pane） */
.settings__body {
  display: flex;
  flex: 1;
  min-width: 0;
}

/**
 * 每一屏自己滚。
 *
 * 不能两屏共用一个滚动容器：那样滚动条长度与位置都是共享的 —— 在外观滚到底再切到通用，
 * 通用会停在它自己的底部；切回外观时位置也回不到原处（浏览器把越界的值截到新内容的上限后就不动了）。
 * 各滚各的之后，每一屏有自己的滚动区间与位置，互不干扰。
 */
.pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  overflow-y: auto;
  /* 两屏各自成列，间距与原来「每个块之间 20px」保持一致 */
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

/* 程序名称输入框：定宽，别把右边这列的宽度让给长名字 */
.name-input {
  width: 220px;
  flex-shrink: 0;
}

/**
 * 顶部样式的三个选项比「主题」那条文案长，不加这条会被左边的说明挤窄 ——
 * el-radio-group 是 inline-flex + 可换行，宽度不够时按钮就竖起来排了。
 * 让它自己撑开、由左边那段说明去换行。
 */
.style-pick {
  flex-shrink: 0;
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

/* ---------- 宽度滑块 ---------- */
.slider {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

/**
 * 滑块的圆形手柄在两端会探出跑道半个身位（hover 时还要放大 1.2 倍），
 * 留一圈横向内边距当缓冲，免得它被滚动容器的裁剪边界切掉半个圆。
 * 现在这套内边距之外还有右侧内容区自己的 20px 内边距兜着，看起来比需要的宽 —— 别顺手去掉，
 * 那是两层保护里的一层，去掉后一旦内容区贴边，最小值处的手柄就又会被切。
 */
.slider :deep(.el-slider) {
  flex: 1;
  min-width: 0;
  padding: 0 12px;
}

/**
 * 主题切换：Element Plus 靠 box-shadow 盖住相邻按钮之间那道 1px 的缝，但选中项自身的
 * 灰色 outline 会画在这道阴影之上，于是选中「亮色」时左边就留下一条灰竖线。
 * 把选中项的 outline 换成主色，让它和实心块同色即可（首 / 末项的外沿也跟着填充色走）。
 *
 * 只管能点的项：禁用态的取色由 global.css 统一收敛，否则一块灰底上会挂一圈主色亮边。
 */
.settings :deep(.el-radio-button.is-active:not(.is-disabled) .el-radio-button__inner) {
  outline-color: var(--el-color-primary);
}

.slider__value {
  flex-shrink: 0;
  min-width: 52px;
  font-size: var(--fs-meta);
  color: var(--ink-2);
  text-align: right;
}

/* 卡片不透明度这条滑块是行内右列控件，自己定宽，别跟左边说明抢地方 */
.card-slider {
  width: 240px;
  flex-shrink: 0;
}

/**
 * 主题色当前值。这一列被挤窄时该换行的是左边那段说明，不是这个标签 ——
 * 否则「默认（中性色）」会断成「默认（中 / 性色）」，色号也会跟着折行。
 */
.accent__value {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: var(--fs-micro);
  color: var(--ink-2);
}

/**
 * 拖动步进 / 卡片间距：取值只有一到两位，用 EP 默认的 120px 宽输入框会占掉半行、
 * 和旁边的说明文字抢地方，收窄到刚够放下数字加右侧的加减按钮。
 *
 * 首页布局那一列的三件控件（进入编辑 + 这两个数字框）宽度取同一个 100px，
 * 右边缘才对得齐（高度由 .settings 上的 small 尺寸统一，见上）。
 */
.number-input,
.layout-edit {
  width: 100px;
  flex-shrink: 0;
}

/**
 * 数字框右侧那两个加减按钮。EP 是按 24px 高的框算死的：每个 11px、上下各让 1px、
 * 中间再留 2px 缝。上面把框抬到 28px 之后那套数字就不成立了 —— 按钮还是 11px，
 * 中间于是空出一道白缝。这里只让它们跟着框长：各占一半（减掉上下各 1px），
 * 外沿圆角跟着输入框走（--r-sm 就是框的圆角）。
 *
 * **别把 EP 那 1px 的右 / 上 / 下内缩也去掉**：输入框的边框是画在框上的一圈 inset 阴影，
 * 按钮贴到边上就会把它盖掉，表现成「最右边那条边框没了」（踩过一次）。
 */
.number-input :deep(.el-input-number__increase),
.number-input :deep(.el-input-number__decrease) {
  /*
   * 高度直接写：EP 把它塞在 --el-input-number-controls-height 里，而给那个变量赋值的选择器
   * （.is-controls-right[class*=small] [class*=increase]）比这里长，改变量压不过它。
   * 这条能生效靠的是本组件样式排在 element-plus 之后，与 global.css 里改 small 按钮高度同一个道理。
   */
  height: calc(50% - 1px);
}

.number-input :deep(.el-input-number__increase) {
  border-radius: 0 var(--r-sm) 0 0;
}

.number-input :deep(.el-input-number__decrease) {
  border-radius: 0 0 var(--r-sm) 0;
}

/* ---------- 工作区背景 ---------- */

.bg {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.bg__preview {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 132px;
  height: 78px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  overflow: hidden;
}

.bg__preview img {
  display: block;
  width: 100%;
  height: 100%;
  /* 预览只交代「选了哪张图」，不按画布的 cover 裁切，缩略图更容易认 */
  object-fit: cover;
}

.bg__empty {
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.bg__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: var(--sp-2);
  min-width: 0;
}

.bg__label {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

.bg__veil {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--ink-2);
}

/* ---------- 内置壁纸 ---------- */

.wallpapers {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.wallpapers__list {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: var(--sp-2);
}

.wallpaper {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /*
   * 68px × 9 格（7 张内置 + 本地图片 + 无背景）在正文里排成一行，右边还留一点白；
   * 再加图或把弹窗收窄就会换行。算式（弹窗 920）：正文 = 920 − 弹窗左右内边距 32 −
   * 菜单 148 − 分隔线 1 − 正文左右内边距 40 − 滚动条 10 = 689，9 格需要 9×68 + 8×8 = 676。
   */
  width: 68px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.wallpaper:hover {
  border-color: var(--border-strong);
}

/* 选中态用主色描边而不是换底色：缩略图本身颜色各异，底色一变就看不出图了 */
.wallpaper.is-active {
  border-color: var(--ink);
  box-shadow: 0 0 0 1px var(--ink);
}

/**
 * 图位：正方形。壁纸、本地入口、无背景共用同一副骨架，
 * 所以一排格子的外形完全一致，只有里面是图还是图标之分。
 */
.wallpaper__thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 3px;
  background: var(--bg-inset);
  overflow: hidden;
}

.wallpaper__thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.wallpaper__thumb--blank {
  font-size: 17px;
  color: var(--ink-3);
}

.wallpaper.is-active .wallpaper__thumb--blank {
  color: var(--ink);
}

.wallpaper__name {
  font-size: var(--fs-micro);
  color: var(--ink-3);
  text-align: center;
}

.wallpaper.is-active .wallpaper__name {
  color: var(--ink);
  font-weight: 600;
}

/* 本地入口用虚框：一眼看出这不是一张图 */
.wallpaper--local {
  border-style: dashed;
}

/* 图片读不出来是一种状态，按「颜色只表达状态」的规矩用失败色，而不是随手来个红字 */
.bg__error {
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--st-fail);
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

/* ---------- 同步设备（从别的机器取外观） ---------- */
.devices {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

/* 一行 = 机器名 + 那份配置的时间 + 一颗按钮；外壳与数据目录那条路径同一副形状 */
.device {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
}

.device__name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-meta);
  color: var(--ink);
}

.device__time {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}
</style>
