<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CircleClose, FolderOpened, Picture } from '@element-plus/icons-vue'
import { useProjectsStore } from '@/stores/projects'
import { SIDE_PANEL_WIDTH_MAX, SIDE_PANEL_WIDTH_MIN } from '@shared/side-panel-width'
import {
  BACKGROUND_OPACITY_MAX,
  BACKGROUND_OPACITY_MIN
} from '@shared/workspace-background'
import { builtinIdOf } from '@shared/wallpaper'
import type { AppSettings, SidePanelPosition, ThemeSource } from '@/types'

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

/** 侧栏两条边，按钮顺序就是「左右」 */
const sidePositions: Array<{ value: SidePanelPosition; label: string }> = [
  { value: 'left', label: '左' },
  { value: 'right', label: '右' }
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
  <el-dialog v-model="visible" title="设置" width="760" align-center>
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

        <div class="row">
          <div class="row__text">
            <span class="row__label">首页侧栏位置</span>
            <span class="row__hint">
              「活跃度 / 系统状态 / 最近使用 / 快捷操作」四块面板放在卡片网格的哪一侧。
            </span>
          </div>
          <el-radio-group
            :model-value="store.settings.sidePanelPosition"
            size="small"
            @update:model-value="
              (value: unknown) => save({ sidePanelPosition: value as SidePanelPosition })
            "
          >
            <el-radio-button v-for="p in sidePositions" :key="p.value" :value="p.value">
              {{ p.label }}
            </el-radio-button>
          </el-radio-group>
        </div>

        <div class="row row--stack">
          <div class="row__text">
            <span class="row__label">首页侧栏宽度</span>
            <span class="row__hint">
              侧栏那条窄栏的宽度。窗口窄于 880px 时侧栏会自动排到卡片下方，这个值不再生效。
            </span>
          </div>
          <div class="slider">
            <el-slider
              :model-value="store.sidePanelWidth"
              :min="SIDE_PANEL_WIDTH_MIN"
              :max="SIDE_PANEL_WIDTH_MAX"
              :step="10"
              :show-tooltip="false"
              size="small"
              @input="(value: unknown) => (store.sidePanelWidth = Number(value))"
              @change="(value: unknown) => void store.setSidePanelWidth(Number(value))"
            />
            <span class="slider__value mono">{{ store.sidePanelWidth }} px</span>
          </div>
        </div>
        <div class="row row--stack">
          <div class="row__text">
            <span class="row__label">工作区背景</span>
            <span class="row__hint">
              图片铺在首页画布的最底层，只在留白与卡片间隙里透出来；卡片和右栏面板照旧压在它上面，
              显示与交互都不受影响。图片不进数据文件，这里只记路径。图片是渐淡进「渐淡色」的，
              那个颜色默认跟着主题的画布色走。
            </span>
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
 */
.settings :deep(.el-radio-button.is-active .el-radio-button__inner) {
  outline-color: var(--el-color-primary);
}

.slider__value {
  flex-shrink: 0;
  min-width: 52px;
  font-size: var(--fs-meta);
  color: var(--ink-2);
  text-align: right;
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
