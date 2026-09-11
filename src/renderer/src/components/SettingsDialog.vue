<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CircleClose, FolderOpened, Picture, Rank } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import { ACCENT_PRESETS, type AccentInkMode } from '@shared/accent-color'
import { APP_NAME_DEFAULT, APP_NAME_MAX_LENGTH } from '@shared/app-name'
import { CARD_GAP_MAX, CARD_GAP_MIN, GRID_STEP_MAX, GRID_STEP_MIN } from '@shared/theme'
import {
  BACKGROUND_OPACITY_MAX,
  BACKGROUND_OPACITY_MIN
} from '@shared/workspace-background'
import { builtinIdOf } from '@shared/wallpaper'
import type { AppSettings, ThemeSource, TopBarStyle } from '@/types'
import type { ThemeOrigin } from '@/theme-transition'

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
  if (store.backgroundImage) return ''
  if (store.backgroundError) return '图片读不出来'
  return store.settings.workspaceBackground ? '读取中…' : '未设置'
})

/**
 * 名字不再单独占一行（内置壁纸那一栏已经高亮说明了是哪张，自选的图看预览也知道），
 * 但「到底设的是哪个文件」还得能查到 —— 鼠标停在预览上给全名。
 */
const backgroundTitle = computed(
  () => store.backgroundName || store.settings.workspaceBackground || '还没有选择背景图'
)

/** 当前背景是自选的本地文件（不是内置壁纸），给「本地图片」那块一个选中态 */
const isLocalBackground = computed(
  () =>
    !!store.settings.workspaceBackground &&
    builtinIdOf(store.settings.workspaceBackground) === null
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
  store.settings.workspaceBackgroundVeil
    ? store.settings.workspaceBackgroundVeil.toUpperCase()
    : '默认（主题画布色）'
)

const accentPresets: string[] = [...ACCENT_PRESETS]

/** 主题色当前值：留空就是界面原本的中性色，得说清楚「没配」不等于没生效 */
const accentLabel = computed(() =>
  store.settings.accentColor ? store.settings.accentColor.toUpperCase() : '默认（中性色）'
)

/** 快捷键录制状态 */
const recording = ref(false)

/**
 * 程序名称的草稿：边打边存会每敲一个字就回推一次设置（还会被主进程收敛后覆盖光标），
 * 所以本地先存着，失焦 / 回车时再提交。
 */
const appNameDraft = ref('')
watch(
  () => store.settings.appName,
  (value) => {
    appNameDraft.value = value
  },
  { immediate: true }
)

function commitAppName(): void {
  if (appNameDraft.value === store.settings.appName) return
  save({ appName: appNameDraft.value })
}

function save(patch: Partial<AppSettings>): void {
  void store.updateSettings(patch)
}

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
  void store.updateSettings({ theme: value }, origin)
}

/** 进入首页布局编辑态：关掉设置，把画面让给画布上的拖动把手 */
function enterLayoutEdit(): void {
  store.setLayoutEditing(true)
  visible.value = false
}

function changeGridStep(value: number | undefined): void {
  if (typeof value === 'number') void store.setGridStep(value)
}

function changeCardGap(value: number | undefined): void {
  if (typeof value === 'number') void store.setCardGap(value)
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
  if (!open) recording.value = false
})
</script>

<template>
  <!-- append-to-body：弹层必须离开 .app 子树，否则会被顶部毛玻璃的 backdrop-filter 连累（见 global.css 弹层一节） -->
  <el-dialog v-model="visible" title="设置" width="760" align-center append-to-body>
    <div class="settings">
      <!-- 程序 -->
      <section class="block">
        <h3 class="block__title">程序</h3>

        <div class="row">
          <div class="row__text">
            <span class="row__label">程序名称</span>
            <span class="row__hint">
              显示在标题栏、托盘提示与窗口标题上的名字。留空恢复为 {{ APP_NAME_DEFAULT }}，最多
              {{ APP_NAME_MAX_LENGTH }} 个字符；输入后失焦或按回车生效。
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
      </section>

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
            <span class="row__hint">用在开关、选中、聚焦环与主按钮上；留空是界面原本的中性灰。</span>
          </div>
          <div class="slider">
            <el-color-picker
              :model-value="store.settings.accentColor || null"
              size="small"
              :predefine="accentPresets"
              @change="(value: unknown) => void store.setAccentColor(String(value ?? ''))"
            />
            <span class="accent__value mono">{{ accentLabel }}</span>
            <el-button
              link
              size="small"
              :disabled="!store.settings.accentColor"
              @click="store.setAccentColor('')"
            >
              恢复默认
            </el-button>
          </div>
        </div>

        <div class="row">
          <div class="row__text">
            <span class="row__label">主题色文字</span>
            <span class="row__hint">
              铺在主题色上的那层字（主按钮、选中的胶囊、单选按钮）。自动按主题色的深浅挑：
              底色深用白字、底色浅用黑字；也可以手动钉死一种（还没设主题色时先存着，看不出效果）。
            </span>
          </div>
          <el-radio-group
            class="style-pick"
            :model-value="store.settings.accentInk"
            size="small"
            @update:model-value="(value: unknown) => void store.setAccentInk(value as AccentInkMode)"
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
              <img v-if="store.backgroundImage" :src="store.backgroundImage" alt="工作区背景预览" />
              <span v-else class="bg__empty">{{ backgroundHint }}</span>
            </div>

            <div class="bg__body">
              <div class="slider">
                <span class="bg__label">浓淡</span>
                <el-slider
                  :model-value="store.backgroundOpacity"
                  :min="BACKGROUND_OPACITY_MIN"
                  :max="BACKGROUND_OPACITY_MAX"
                  :step="5"
                  :show-tooltip="false"
                  size="small"
                  :disabled="!store.settings.workspaceBackground"
                  @input="(value: unknown) => (store.backgroundOpacity = Number(value))"
                  @change="(value: unknown) => void store.setBackgroundOpacity(Number(value))"
                />
                <span class="slider__value mono">{{ store.backgroundOpacity }}%</span>
              </div>

              <!-- 蒙版色：图片渐淡进去的那个颜色；留空就跟着主题的画布色走 -->
              <div class="slider">
                <span class="bg__label">渐淡色</span>
                <el-color-picker
                  :model-value="store.settings.workspaceBackgroundVeil || null"
                  size="small"
                  :predefine="VEIL_PRESETS"
                  @change="(value: unknown) => void store.setBackgroundVeil(String(value ?? ''))"
                />
                <span class="bg__veil mono">{{ veilLabel }}</span>
                <el-button
                  link
                  size="small"
                  :disabled="!store.settings.workspaceBackgroundVeil"
                  @click="store.setBackgroundVeil('')"
                >
                  跟随主题
                </el-button>
              </div>

              <p v-if="store.backgroundError" class="bg__error">{{ store.backgroundError }}</p>
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
            <span v-if="store.wallpapers.length" class="bg__label">内置壁纸</span>

            <div class="wallpapers__list">
              <button
                v-for="item in store.wallpapers"
                :key="item.reference"
                class="wallpaper"
                type="button"
                :class="{ 'is-active': store.settings.workspaceBackground === item.reference }"
                :title="item.name"
                @click="store.useWallpaper(item.reference)"
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
                @click="store.pickBackground()"
              >
                <span class="wallpaper__thumb wallpaper__thumb--blank">
                  <el-icon><Picture /></el-icon>
                </span>
                <span class="wallpaper__name truncate">本地图片</span>
              </button>

              <button
                class="wallpaper"
                type="button"
                :class="{ 'is-active': !store.settings.workspaceBackground }"
                title="恢复默认画布"
                @click="store.clearBackground()"
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
            <span class="row__hint">正常＝实底，毛玻璃＝整块磨砂，透明＝全部透出壁纸。</span>
          </div>
          <el-radio-group
            class="style-pick"
            :model-value="store.settings.topBarStyle"
            size="small"
            @update:model-value="(value: unknown) => void store.setTopBarStyle(value as TopBarStyle)"
          >
            <el-radio-button v-for="s in topBarStyles" :key="s.value" :value="s.value">
              {{ s.label }}
            </el-radio-button>
          </el-radio-group>
        </div>
      </section>

      <!-- 首页布局 -->
      <section class="block">
        <h3 class="block__title">首页布局</h3>

        <div class="row">
          <div class="row__text">
            <span class="row__label">布局调整</span>
            <span class="row__hint">
              进入编辑模式后：拖动卡片可以在左中右三栏之间移动、调整栏内顺序；拖卡片下沿改高度；
              拖两栏之间的竖线改左右栏宽度（中栏自动占满剩余宽度）。没有卡片的栏平时不显示，
              编辑时会全部摆出来。布局单独保存在 theme.json 里，不跟项目数据混在一起。
            </span>
          </div>
          <el-button size="small" :icon="Rank" @click="enterLayoutEdit">进入编辑</el-button>
        </div>

        <div class="row">
          <div class="row__text">
            <span class="row__label">拖动步进</span>
            <span class="row__hint">位置与尺寸按这个像素网格吸附，越小越精细。</span>
          </div>
          <el-input-number
            class="number-input"
            :model-value="store.gridStep"
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
            <span class="row__hint">
              卡片之间的留白（px）：三栏之间、同栏卡片之间、项目列表里的项目卡之间都用它。0 表示紧贴。
            </span>
          </div>
          <el-input-number
            class="number-input"
            :model-value="store.cardGap"
            :min="CARD_GAP_MIN"
            :max="CARD_GAP_MAX"
            :step="1"
            size="small"
            controls-position="right"
            @change="changeCardGap"
          />
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
            <span class="row__hint">在任何窗口下唤起 / 隐藏 {{ store.settings.appName }}。</span>
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
              {{ isPackaged ? '登录系统后自动在后台启动，只在托盘显示图标，点击图标即可打开界面。' : '开发模式下不会写入系统自启项。' }}
            </span>
          </div>
          <el-switch
            :model-value="store.settings.launchAtLogin"
            size="small"
            :disabled="!isPackaged"
            @update:model-value="(value: unknown) => save({ launchAtLogin: Boolean(value) })"
          />
        </div>
      </section>

      <!-- 数据存储 -->
      <section class="block">
        <h3 class="block__title">数据存储</h3>

        <div class="row row--stack">
          <div class="row__text">
            <span class="row__label">数据目录</span>
            <span class="row__hint">
              {{ store.settings.appName }} 写的东西都放这个目录里，换位置会把当前数据整体搬过去；目标目录已有同名数据文件时会拒绝并提示。
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
 * 弹窗正文是滚动容器（overflow-y: auto），横向裁剪边界落在正文自己的 padding box 上；
 * 而 16px 内边距在外层的 .el-dialog 上、不在正文身上，所以正文左边缘就是裁剪线。
 * 滑块的圆形手柄在两端会探出跑道半个身位，最小值时左半边正好被这条线裁掉。
 * 给滑块留出略大于半只手柄（含 hover 放大的 1.2 倍）的横向内边距即可。
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
 */
.number-input {
  width: 100px;
  flex-shrink: 0;
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
  /* 72px × 6 格（4 张内置 + 本地图片 + 无背景）在 760px 弹窗里只占左半，右边留白；再加图才会换行 */
  width: 72px;
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
</style>
