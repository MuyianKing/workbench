<script setup lang="ts">
/**
 * 视频播放器本体：**全局单例**，挂在 App.vue 上（与终端面板同层），不随换页切换。
 *
 * 之前播放器住在视频页里，靠 KeepAlive「切走的页面不卸载」把播放延续成背景音 ——
 * 但画面看不见，想边看教学视频边记笔记就得来回切页。现在把 `<video>` 与它周围
 * 那一圈（速率、快捷键、播完自动接续）整体搬到这里，**内嵌与悬浮是同一个元素**：
 *   - 在视频页：Teleport 进视频页画布注册的宿主（use-video-stage），与原来内嵌一样；
 *   - 切到别的页（手上还有视频）：小窗改为固定定位的悬浮窗浮在界面上 —— 传送只是
 *     把同一个元素在两处之间搬，元素不重建，**播放因此一秒不断**。
 *
 * 悬浮窗带一条拖动手柄（视频名 / 速率 / 回视频页 / 关闭）与右下角的缩放手柄；
 * 位置与尺寸落 theme.json（videoFloatX/Y/W/H，两段式跟手 / 落盘与视频树宽同一套）。
 * 「回到视频页」只是把当前页切回去 —— 小窗内容原地传送进画布；「关闭」是停止播放。
 *
 * 快捷键跟着播放器走而不是跟着页面走：视频页内仍是整套（空格 / 方向键 / 速率），
 * 悬浮时只拦空格 —— 笔记页的树还要用方向键导航，而 Vditor 里打字由 typingOn 挡住。
 * 拦截规则照旧：捕获阶段拦下并 stopPropagation（媒体控件自己也会拿这几个键），
 * 没有正播的视频时一个键都不拦。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CaretBottom, Check, Close, Monitor } from '@element-plus/icons-vue'
import {
  fitVideoFloatGeometry,
  nextVideoNode,
  nextVideoRate,
  resizeVideoFloat,
  VIDEO_NEXT_SECONDS,
  VIDEO_RATES,
  VIDEO_SEEK_SECONDS
} from '@workbench/video'
import type { VideoNode } from '@workbench/video'
import { useVideoStore } from '@/stores/video'
import { useSettingsStore } from '@/stores/settings'
import { useNavStore } from '@/stores/nav'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { useVideoStageHost } from '@/composables/use-video-stage'

const store = useVideoStore()
const settings = useSettingsStore()
const nav = useNavStore()

const stageHost = useVideoStageHost()

/** 在视频页：内嵌（传送进画布）；不在：悬浮小窗。传送的开 / 关就是它 */
const inline = computed(() => nav.activeView === 'video')
/** 小窗显示没有：不在视频页且手上还有视频（播的、暂停的都算 —— 小窗是遥控器也是画面） */
const floating = computed(() => !inline.value && !!store.active)

// ---------- 播放器 ----------

const playerRef = ref<HTMLVideoElement | null>(null)

function applyRate(): void {
  const video = playerRef.value
  if (!video) return
  // defaultPlaybackRate 一起设：换视频重载后浏览器会把它复位回默认值
  video.defaultPlaybackRate = store.rate
  video.playbackRate = store.rate
}

function stepRate(direction: 1 | -1): void {
  store.rate = nextVideoRate(store.rate, direction)
}

watch(
  () => store.rate,
  () => applyRate()
)

/** 新视频挂上来（元素随 :key 整个换新）：把速率贴上去；播不播看 store 的意图 ——
 * 点树上的直接开播，恢复上次的那个只加载、停在首帧（空格或播放键在这儿等着） */
watch(
  () => store.active?.rel,
  async () => {
    // 换了视频，上一部播完时摆出的「即将播放」就算数了：无论是自动接过去的还是用户自己挑的
    clearUpNext()
    if (!store.active) return
    await nextTick()
    applyRate()
    if (!store.autoplayNext) return
    // 播不出来（还没缓冲完、或浏览器拦了自动播放）就停在原处，用户按空格再来
    void playerRef.value?.play().catch(() => {})
  }
)

// ---------- 播完自动接下去 ----------

/**
 * 一部播完（`ended`），树里还有下一个就在画布上压暗一层、摆出倒计时卡片，
 * 倒数 `VIDEO_NEXT_SECONDS` 秒后切过去；这一部就是最后一个（或它根本不在树里）时
 * 什么都不做，画面停在原地。卡片跟着播放器走：悬浮小窗里播完一样接得下去，
 * 笔记照写、下一部自动开。
 */
const upNext = ref<VideoNode | null>(null)
/** 倒计时还剩几秒；upNext 为 null 时它没有意义 */
const upNextLeft = ref(0)
let upNextTimer: ReturnType<typeof setInterval> | null = null

/** 收掉浮层与计时器（取消、切走、到点都要走这里，计时器不能留在后台空转） */
function clearUpNext(): void {
  if (upNextTimer !== null) {
    clearInterval(upNextTimer)
    upNextTimer = null
  }
  upNext.value = null
  upNextLeft.value = 0
}

/**
 * 切到下一个：倒计时到点与卡片上那颗「立即播放」共用这一条 —— 先收浮层再 select，
 * 与点树上的视频是同一条路（连播的下一部直接出声）。
 */
function goUpNext(): void {
  const target = upNext.value
  clearUpNext()
  if (target) store.select(target.rel)
}

function onEnded(): void {
  const current = store.active
  if (!current) return
  const next = nextVideoNode(store.nodes, current.rel)
  if (!next) return

  clearUpNext()
  upNext.value = next
  upNextLeft.value = VIDEO_NEXT_SECONDS
  upNextTimer = setInterval(() => {
    upNextLeft.value -= 1
    if (upNextLeft.value > 0) return
    goUpNext()
  }, 1000)
}

/** 倒计时里用户反悔了：留在当前这一个（播完了就停在最后一帧，接不接由用户再定） */
function cancelUpNext(): void {
  clearUpNext()
}

function togglePlay(): void {
  const video = playerRef.value
  if (!video) return
  if (video.paused) void video.play().catch(() => {})
  else video.pause()
}

/** 快进 / 快退：夹在 [0, 时长] 里，元数据还没到位（duration 是 NaN）就不动 */
function seekBy(delta: number): void {
  const video = playerRef.value
  if (!video || !Number.isFinite(video.duration)) return
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta))
}

// ---------- 快捷键 ----------

/** 这五个键在「有视频可播、内嵌着」时归播放器管 */
const HANDLED_KEYS = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/** 焦点落在文本框里时一个键都不拦（Vditor 是 contenteditable，笔记里打字靠它挡住） */
function typingOn(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  return Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))
}

/**
 * 快捷键（有正播的视频才拦）：
 *   内嵌时（视频页）整套 —— 空格播放暂停、← → 快退快进、↑ ↓ 速率；
 *   悬浮时只拦空格 —— 方向键让给别的页面（笔记树的键盘导航、列表的上下移动），
 *   暂停 / 续播是边看边记时唯一要随时按的那一个。
 *
 * **必须在捕获阶段拦，而且拦下就别再往下传**（stopPropagation）：焦点落在视频上时，
 * 媒体控件自己也会拿空格与左右键切播放 / seek —— 在冒泡末端拦，按一次空格就是两次 toggle。
 * 按住不放时 Space 只算一次（连发的 keydown 不再逐次 toggle），方向键保持连发（连续快进）。
 */
function onKeydown(event: KeyboardEvent): void {
  if (!store.active || event.isComposing || typingOn(event)) return

  if (floating.value) {
    if (event.code !== 'Space') return
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) togglePlay()
    return
  }

  if (!HANDLED_KEYS.has(event.code)) return
  event.preventDefault()
  event.stopPropagation()

  switch (event.code) {
    case 'Space':
      if (!event.repeat) togglePlay()
      break
    case 'ArrowLeft':
      seekBy(-VIDEO_SEEK_SECONDS)
      break
    case 'ArrowRight':
      seekBy(VIDEO_SEEK_SECONDS)
      break
    case 'ArrowUp':
      stepRate(1)
      break
    case 'ArrowDown':
      stepRate(-1)
      break
  }
}

/** 空格的 keyup 一起拦：媒体控件在 keyup 上还留着半只手，这里把门关死（见 VideoView 时代的注释） */
function onKeyup(event: KeyboardEvent): void {
  if (!store.active || event.code !== 'Space' || event.isComposing || typingOn(event)) return

  event.preventDefault()
  event.stopPropagation()
}

/** 内嵌或悬浮着就挂键，两样都不是（没视频、也没在视频页）就摘掉 —— 捕获监听成对摘挂 */
function bindKeys(bind: boolean): void {
  if (bind) {
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('keyup', onKeyup, true)
  } else {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keyup', onKeyup, true)
  }
}

watch([inline, floating], ([nextInline, nextFloating]) => bindKeys(nextInline || nextFloating), {
  immediate: true
})

onBeforeUnmount(() => {
  bindKeys(false)
  clearUpNext()
})

// ---------- 悬浮小窗：位置与尺寸 ----------

/**
 * 视口尺寸的响应式镜像：拖动 / 缩放 / 渲染落点都要按它 clamp，窗口拉大拉小时小窗
 * 不能被拉到界外去。存的是 theme.json 里的百分比落点，**最终落点在这里换算** ——
 * 百分比只知道「大概在哪」，压回视口内（小窗整个看得见）得靠此刻的真实宽高。
 */
const viewport = ref({ w: window.innerWidth, h: window.innerHeight })

function measureViewport(): void {
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
}

onMounted(() => {
  window.addEventListener('resize', measureViewport)
  measureViewport()
})

onBeforeUnmount(() => window.removeEventListener('resize', measureViewport))

/** 悬浮窗的落盘值（跟手时 settings 的 set 已把本地值改掉，这里只是统一读一处） */
const floatGeometry = computed(() => ({
  x: settings.themeConfig.videoFloatX,
  y: settings.themeConfig.videoFloatY,
  w: settings.themeConfig.videoFloatW,
  h: settings.themeConfig.videoFloatH
}))

const floatStyle = computed(() => {
  const { x, y, w, h } = floatGeometry.value
  const fit = fitVideoFloatGeometry({ x, y, w, h }, viewport.value)
  return {
    left: `${fit.left}px`,
    top: `${fit.top}px`,
    width: `${fit.width}px`,
    height: `${fit.height}px`
  }
})

/** 把视口内的像素落点折回百分比落盘值（拖动跟手走 settings 的 set，边界它自己再收一遍） */
function geometryOf(left: number, top: number, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const { w: vw, h: vh } = viewport.value
  return {
    x: (left / vw) * 100,
    y: (top / vh) * 100,
    w: width,
    h: height
  }
}

/** 拖手柄挪窗：起点是窗当前的像素落点，位移直接加上去，全程压在视口内 */
function onBarDown(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()

  const { left, top, width, height } = fitVideoFloatGeometry(floatGeometry.value, viewport.value)
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    // 拖动扫过视频画布（里面是媒体控件）时别把指针样式与文本选择丢给它们
    bodyClass: 'is-dragging-video-float',
    onMove: (moveEvent, start) => {
      const nextLeft = Math.min(Math.max(0, left + (moveEvent.clientX - start.x)), viewport.value.w - width)
      const nextTop = Math.min(Math.max(0, top + (moveEvent.clientY - start.y)), viewport.value.h - height)
      settings.setVideoFloatGeometry(geometryOf(nextLeft, nextTop, width, height))
    },
    onEnd: () => void settings.commitVideoFloatGeometry()
  })
}

/**
 * 抓角落缩放小窗：右下 / 左下两枚手柄共用这一份（口径在 shared/video.ts 的 resizeVideoFloat）。
 * 右下角：左上角钉住，宽高随位移长；左下角：**右上角钉住** —— 往左拖是长大，
 * 宽度的变化全部折进左缘（左缘不得越过视口左缘）。抓哪一角、对角就钉住不动；
 * 拖动期间只改本地，松手才落盘（与视频树宽同一套两段式）。
 */
function onGripDown(event: PointerEvent, edge: 'left' | 'right'): void {
  if (event.button !== 0) return
  event.preventDefault()

  const start = floatGeometry.value
  startPointerDrag({
    start: { x: event.clientX, y: event.clientY },
    bodyClass: 'is-resizing-video-float',
    onMove: (moveEvent, dragStart) => {
      settings.setVideoFloatGeometry(
        resizeVideoFloat(
          start,
          viewport.value,
          edge,
          moveEvent.clientX - dragStart.x,
          moveEvent.clientY - dragStart.y
        )
      )
    },
    onEnd: () => void settings.commitVideoFloatGeometry()
  })
}

/** 悬浮窗上的「回到视频页」：切回去，小窗内容原地传送进画布 */
function backToVideoView(): void {
  void nav.setActiveView('video')
}

/** 悬浮窗上的关闭 = 停止播放：active 清掉，小窗随它一起消失 */
function closePlayer(): void {
  store.closeVideo()
}
</script>

<template>
  <!--
    传送目标兜底到 body：理论上到不了（视频页没挂载过就不会有 active 的视频），
    但 Teleport 的目标不能是 null，兜一层免得边界状态把整个组件摔了。
  -->
  <Teleport :to="stageHost ?? 'body'" :disabled="floating">
    <div v-if="store.active" class="vplayer" :class="{ 'is-floating': floating }" :style="floating ? floatStyle : undefined">
      <!-- 悬浮窗的手柄条：整条都能拖；标题截断给原生 title，速率与两颗图标按钮各自带 tooltip -->
      <header v-if="floating" class="vplayer__bar" @pointerdown="onBarDown">
        <span class="vplayer__name" :title="store.active.name">{{ store.active.name }}</span>

        <el-dropdown
          trigger="click"
          placement="bottom-end"
          @pointerdown.stop
          @command="(value: number) => (store.rate = value)"
        >
          <button class="vplayer__rate" type="button" title="播放速率">
            {{ store.rate }}x
            <el-icon class="vplayer__rate-caret"><CaretBottom /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="value in VIDEO_RATES"
                :key="value"
                :command="value"
                :class="{ 'is-current': value === store.rate }"
              >
                <span class="vplayer__rate-item">
                  <el-icon v-if="value === store.rate" class="vplayer__rate-check"><Check /></el-icon>
                  {{ value }}x
                </span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <el-tooltip content="回到视频页" placement="bottom">
          <button class="vplayer__act" type="button" aria-label="回到视频页" @pointerdown.stop @click="backToVideoView">
            <el-icon><Monitor /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip content="停止播放" placement="bottom">
          <button class="vplayer__act" type="button" aria-label="停止播放" @pointerdown.stop @click="closePlayer">
            <el-icon><Close /></el-icon>
          </button>
        </el-tooltip>
      </header>

      <!-- 播放画布：始终深色（--term-* 那一族，与终端面板同一口径），视频按比例缩进画布里 -->
      <div class="vplayer__canvas">
        <!--
          :key 让每个视频都是一只新元素：旧视频的缓冲、进度与事件监听一起随它销毁。
          不放 autoplay 属性 —— 开播只由上面的 watch 按 store 的意图调 play()。
          play / seeking 是「用户接手了」的信号：倒计时摆着的时候用户重新播放或拖回
          进度条，说明他想重看这一部，自动接下去就得撤
        -->
        <video
          ref="playerRef"
          class="vplayer__screen"
          :src="store.active.url"
          controls
          preload="metadata"
          @loadedmetadata="applyRate"
          @play="cancelUpNext"
          @seeking="cancelUpNext"
          @ended="onEnded"
        ></video>

        <!--
          播完接下去的倒计时浮层（压暗层 + 卡片）：与视频同进退（传送时跟着元素一起搬），
          到点与卡片上的「立即播放」都走 goUpNext 切过去 —— 与点树上的视频是同一条路。
          悬浮时它照常出现在小窗里
        -->
        <div v-if="upNext" class="vplayer__next" role="status">
          <div class="vplayer__next-card">
            <div class="vplayer__next-head">
              <span class="vplayer__next-label">即将进入下一个视频</span>
              <span class="vplayer__next-left">{{ upNextLeft }} 秒后自动播放</span>
            </div>
            <p class="vplayer__next-name" :title="upNext.name">{{ upNext.name }}</p>
            <div class="vplayer__next-actions">
              <el-button size="small" type="primary" @click="goUpNext">立即播放</el-button>
              <el-button size="small" @click="cancelUpNext">取消</el-button>
            </div>
            <span class="vplayer__next-bar" :style="{ animationDuration: `${VIDEO_NEXT_SECONDS}s` }" />
          </div>
        </div>
      </div>

      <!--
        悬浮窗的缩放手柄：右下 / 左下两枚，抓哪一角、对角钉住 —— 右下是左上角不动、往右下长，
        左下是右上角不动、往左下长（往左拖是长大，宽度的变化全折进左缘）。
        平时不显形，指针贴上来 / 拖动中才亮
      -->
      <span
        v-if="floating"
        class="vplayer__grip"
        title="拖动调整小窗大小"
        @pointerdown="onGripDown($event, 'right')"
      />
      <span
        v-if="floating"
        class="vplayer__grip is-left"
        title="拖动调整小窗大小"
        @pointerdown="onGripDown($event, 'left')"
      />
    </div>
  </Teleport>
</template>

<style scoped>
/**
 * 播放器根。内嵌时就是画布本身的一份填充（宿主 .video__stage 铺满画布、不接事件，
 * 这一层把 pointer-events 要回来 —— 画布上的空态提示按钮在它下面照常点得到）；
 * 悬浮时整块变成 fixed 小窗，位置尺寸来自 theme.json（见 floatStyle）。
 */
.vplayer {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  pointer-events: auto;
}

.vplayer.is-floating {
  position: fixed;
  /**
   * 压过顶栏（z-index: 10）：小窗的默认落点就是右上角，恰好压住标题栏那三颗窗口按钮
   * 与顶栏的工具按钮 —— 层级低于顶栏的话，小窗会被它们盖掉半边（悬浮窗浮在最上层
   * 是画中画的常态，挡住了拖开它就是）。仍在弹层与导航栏之下：确认框照旧挡住小窗，
   * 导航栏的 int32 上限不变。
   */
  z-index: 20;
  border: 1px solid var(--term-border);
  border-radius: var(--r-md);
  background: var(--term-bg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}

/* ---------- 悬浮窗手柄条 ---------- */

.vplayer__bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 32px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  /* 手柄条是深色窗的一部分，底色比画布浮一档，看着是「窗的标题栏」而不是一块黑 */
  background: color-mix(in srgb, var(--term-ink) 8%, var(--term-bg));
  border-bottom: 1px solid var(--term-border);
  cursor: move;
  user-select: none;
}

.vplayer__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-meta);
  color: var(--term-ink);
}

/* 速率徽章：与视频页头部那枚同一副样子，字色换深色窗的这一族 */
.vplayer__rate {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px var(--sp-2);
  background: transparent;
  border: 1px solid var(--term-border);
  border-radius: var(--r-pill);
  font: inherit;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  color: var(--term-ink);
  cursor: pointer;
}

.vplayer__rate:hover {
  background: color-mix(in srgb, var(--term-ink) 12%, var(--term-bg));
}

.vplayer__rate-caret {
  font-size: 10px;
}

.vplayer__rate-item {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-variant-numeric: tabular-nums;
}

.vplayer__rate-check {
  font-size: 12px;
  color: var(--st-ok);
}

/* 手柄条上的图标按钮：tooltip 已给出名字，按钮本体保持安静 */
.vplayer__act {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  color: var(--term-ink);
  cursor: pointer;
}

.vplayer__act:hover {
  background: color-mix(in srgb, var(--term-ink) 12%, var(--term-bg));
}

/* ---------- 播放画布 ---------- */

.vplayer__canvas {
  flex: 1 1 auto;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  background: var(--term-bg);
}

/**
 * 视频铺满画布，按自己的宽高比在元素里伸缩（object-fit: contain）——
 * 与视频页时代同一副口径：能放多大放多大，兜不住的宽高比留黑边。
 */
.vplayer__screen {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  outline: none;
}

/* ---------- 播完接下去的倒计时浮层 ---------- */

/**
 * 两块：铺满画布的一层压暗 + 居中的卡片。
 *
 * 压暗这一层是「一眼看得见」的来源：视频停在最后一帧时画面往往还亮着，卡片直接贴上去
 * 会糊在画面里（原先就是这个样子）；先把画面压下去，卡片才立得起来 —— 一块实底 + 一级
 * 阴影在压暗的画面上是一层清清楚楚的浮层。
 *
 * **这一层不接事件**（pointer-events: none，卡片自己再把事件要回来）：下面的原生控件
 * 照常能点 —— 点重播 / 拖进度条是「用户接手了」的信号（见 <video> 上的 play / seeking），
 * 遮罩拦下来的话这两条出口就断了。
 *
 * 居中用「容器 margin: auto」而不是 align-items: center：悬浮小窗最小只有 240×135
 * （画布剩一百来像素高），卡片装不下时 align-items: center 会把上下两头一起切掉；
 * margin: auto 至少把标签与名字留在看得见的上沿。滚动条不画（指针压根进不来）。
 */
.vplayer__next {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  padding: var(--sp-2);
  background: color-mix(in srgb, var(--term-bg) 62%, transparent);
  overflow: auto;
  scrollbar-width: none;
  pointer-events: none;
  animation: vplayer-next-veil 0.15s ease-out;
}

.vplayer__next::-webkit-scrollbar {
  display: none;
}

/**
 * 卡片本身：三行 + 底缘一条进度线，行距按最小的小窗（画布一百来像素高）也放得下定。
 * 内容一律左对齐 —— 居中的三行在窄卡片里会显得散（同一句话在宽窄两种窗口下都要收得住）。
 */
.vplayer__next-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  width: min(320px, 100%);
  margin: auto;
  padding: var(--sp-2) var(--sp-3);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  pointer-events: auto;
  animation: vplayer-next-in 0.18s ease-out;
}

/* 标签与秒数同一行：左边说「接下来是什么事」，右边是那个一直在动的数字 */
.vplayer__next-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}

.vplayer__next-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-micro);
  color: var(--ink-3);
}

/* 秒数：倒计时是这个浮层里唯一「在动」的东西，用进行色（--st-run）标出来 */
.vplayer__next-left {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  font-weight: 600;
  color: var(--st-run);
  font-variant-numeric: tabular-nums;
}

.vplayer__next-name {
  margin: 0;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--ink);
}

.vplayer__next-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

/**
 * 底缘那条进度线：照 VIDEO_NEXT_SECONDS 秒**从左往右拉满**（时长由模板按常量绑定）——
 * 进度就是「离自动播放还有多久」，走完就切下一个。
 */
.vplayer__next-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--st-run);
  transform-origin: left;
  animation-name: vplayer-next-fill;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

@keyframes vplayer-next-fill {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}

/* 压暗层淡入、卡片轻轻上浮一下：这一下是用来把视线叫过来的 */
@keyframes vplayer-next-veil {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes vplayer-next-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ---------- 缩放手柄 ---------- */

.vplayer__grip {
  position: absolute;
  right: 0;
  bottom: 0;
  z-index: 6;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  touch-action: none;
}

/* 平时不显形，指针贴上来 / 拖动中才画两道斜线指示边界（保持灰度） */
.vplayer__grip::after {
  content: '';
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--term-ink);
  border-bottom: 2px solid var(--term-ink);
  border-bottom-right-radius: 3px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.vplayer__grip:hover::after,
body.is-resizing-video-float .vplayer__grip::after {
  opacity: 0.7;
}

/* 左下那枚：对角的另一枚 —— 指示线贴左缘，光标与斜线一起转向（↖↘ 的对角是 ↙↗） */
.vplayer__grip.is-left {
  right: auto;
  left: 0;
  cursor: nesw-resize;
}

.vplayer__grip.is-left::after {
  right: auto;
  left: 3px;
  border-right: 0;
  border-left: 2px solid var(--term-ink);
  border-bottom-right-radius: 0;
  border-bottom-left-radius: 3px;
}

/* 左下那枚：对角的另一枚 —— 指示线贴左缘，光标与斜线一起转向（↘↖ 的对角是 ↙↗） */
.vplayer__grip.is-left {
  right: auto;
  left: 0;
  cursor: nesw-resize;
}

.vplayer__grip.is-left::after {
  right: auto;
  left: 3px;
  border-right: 0;
  border-left: 2px solid var(--term-ink);
  border-bottom-right-radius: 0;
  border-bottom-left-radius: 3px;
}
</style>
