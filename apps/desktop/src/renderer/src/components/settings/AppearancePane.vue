<script setup lang="ts">
/**
 * 设置 · 外观：看起来什么样。
 *
 * 最上面是「从别的机器取外观」（唯一的采用入口，本机这份配置仍留在仓库里）；
 * 下面依次是主题 / 主题色 / 主题色文字、工作区背景与内置壁纸、顶部样式、
 * 卡片不透明度与间距 —— 全是「界面长什么样」，落盘都在 theme.json 那一份里。
 *
 * 取数时机由外壳传进来的 open / active 驱动：打开弹窗、或切到这一屏时，
 * 把「从别的机器取外观」的设备列表重读一遍 —— 读的是上一次同步取回的仓库快照
 * （纯本地读，不联网），用户很可能刚从首页点过同步按钮再进来。
 */
import { computed, ref, watch } from 'vue'
import { CircleClose, Picture } from '@element-plus/icons-vue'
import { ACCENT_PRESETS, type AccentInkMode } from '@workbench/appearance'
import { CARD_GAP_MAX, CARD_GAP_MIN } from '@workbench/appearance'
import {
  BACKGROUND_OPACITY_MAX,
  BACKGROUND_OPACITY_MIN
} from '@workbench/appearance'
import { builtinIdOf } from '@workbench/appearance'
import { CARD_OPACITY_MAX, CARD_OPACITY_MIN } from '@workbench/appearance'
import { formatRelative } from '@/format'
import { useSettingsStore } from '@/stores/settings'
import { confirmAction } from '@/notify'
import type { SyncDeviceInfo, ThemeSource, TopBarStyle } from '@/types'
import type { ThemeOrigin } from '@/theme-transition'

const props = defineProps<{ open: boolean; active: boolean }>()

const settings = useSettingsStore()

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

/**
 * 应用另一台机器的配置。
 *
 * 会整份覆盖本机当前的外观与首页布局（连带对方的工作区背景设置），所以先问一句；
 * 确认之后由 store 走既有的 updateThemeConfig 通道落盘，界面上不需要另做刷新。
 */
async function applyAppearance(device: SyncDeviceInfo): Promise<void> {
  const agreed = await confirmAction(
    `把本机的外观与首页布局换成「${device.name}」那一套？本机现在这份仍然留在仓库里，随时可以再取回来。` +
      '对方若用的是它本机上的图片作背景，这边读不出来，需要重新选一张。',
    '应用外观配置',
    { confirmButtonText: '应用' }
  )
  if (!agreed) return
  await settings.applySyncAppearance(device.id)
}

/** 手动同步一次进行中 */
const syncing = ref(false)

/**
 * 手动同步一次**外观配置**，再把设备列表重新读一遍（列表是上一次同步取回来的样子）。
 *
 * 只推 / 拉 `config/` 那一份，用量分片一概不碰 —— 那是 Token 面板那颗同步按钮的事，
 * 它有自己的自动节流（见 workbench/token.ts 的 runSync）。两处能分开，靠的就是
 * `token_sync_config` 与 `token_sync_publish` 是两条通道。
 */
async function syncAppearanceNow(): Promise<void> {
  syncing.value = true
  try {
    await settings.syncAppearanceNow()
  } finally {
    syncing.value = false
    await settings.loadSyncDevices()
  }
}

/** 设备列表里的相对时间：打开设置时算一次就够，不必为它挂定时器 */
function deviceUpdatedText(device: SyncDeviceInfo): string {
  const prefix = device.self ? '本机 · ' : ''
  return device.theme
    ? `${prefix}更新于 ${formatRelative(device.updatedAt, Date.now())}`
    : `${prefix}没有配置`
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
  void settings.updateSettings({ theme: value }, origin)
}

function changeCardGap(value: number | undefined): void {
  if (typeof value === 'number') void settings.setCardGap(value)
}

// 打开弹窗、或切回这一屏时重读设备列表（纯本地读，见文件头）
watch(
  () => props.open && props.active,
  (current) => {
    if (current) void settings.loadSyncDevices()
  }
)
</script>

<template>
  <section class="pane">
    <!--
      从别的机器取外观：列表来自上一次同步取回的仓库快照（纯本地读，不联网），
      「应用」是唯一的采用入口 —— 本机这份配置仍然留在仓库里，随时可以再取回来。
      放在这一屏的最上面：它就是「这一屏该长什么样」的另一个来源。
      「同步一次」只推本机这一份配置、并把别的机器的新配置读回来，不碰用量分片
      （用量归 Token 面板那颗同步按钮，那边还有一小时一轮的自动同步）。
    -->
    <div v-if="settings.settings.tokenSyncRepo" class="block">
      <!-- 同步是「整块一起动」，所以按钮跟着标题走：放到底部会与列表最后一项混在一起 -->
      <div class="block__head">
        <h3 class="block__title">从别的机器取外观</h3>
        <el-button size="small" :loading="syncing" @click="syncAppearanceNow">
          同步一次
        </el-button>
      </div>

      <div class="row row--stack">
        <div class="row__text">
          <span class="row__hint">
            「应用」会把本机的外观与首页布局整份换成对方那一套，本机这份仍留在仓库里。
          </span>
        </div>

        <div class="devices">
          <!-- 本机也列出来（标「本机」）：它那份照常可「应用」，相当于取回上次推送时的外观 -->
          <div v-for="device in settings.syncDevices" :key="device.id" class="device">
            <span class="device__name truncate" :title="device.name">
              <span v-if="device.self" class="device__self">本机</span>{{ device.name }}
            </span>
            <span class="device__time">{{ deviceUpdatedText(device) }}</span>
            <el-button size="small" :disabled="!device.theme" @click="applyAppearance(device)">
              应用
            </el-button>
          </div>

          <span v-if="!settings.syncDevices.length" class="row__hint">
            还没有别的机器：在另一台机器上填同一个仓库并同步一次。
          </span>
        </div>
      </div>
    </div>

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

      <div class="row">
        <div class="row__text">
          <span class="row__label">卡片间距</span>
          <span class="row__hint">卡片之间（行间与行内）与页面四周的留白（px）。</span>
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
</template>

<style scoped>
/**
 * 带动作的区块标题：动作放在右上角，与它管辖的那一块内容在同一行上。
 * 标题自己的下边距由这一行统一给，免得两处叠加出双倍间距。
 */
.block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.block__head .block__title {
  margin-bottom: 0;
}

/**
 * 顶部样式的三个选项比「主题」那条文案长，不加这条会被左边的说明挤窄 ——
 * el-radio-group 是 inline-flex + 可换行，宽度不够时按钮就竖起来排了。
 * 让它自己撑开、由左边那段说明去换行。
 */
.style-pick {
  flex-shrink: 0;
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
.pane :deep(.el-radio-button.is-active:not(.is-disabled) .el-radio-button__inner) {
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
 * 卡片间距：取值只有一到两位，用 EP 默认的 120px 宽输入框会占掉半行、
 * 和旁边的说明文字抢地方，收窄到刚够放下数字加右侧的加减按钮
 * （高度由 .settings 上的 small 尺寸统一，见外壳）。
 */
.number-input {
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

/* 「本机」小标记：跟着机器名走，用状态色里最中性的一道描边区别于别的机器 */
.device__self {
  display: inline-block;
  margin-right: var(--sp-2);
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: var(--fs-micro);
  color: var(--ink-2);
}
</style>
