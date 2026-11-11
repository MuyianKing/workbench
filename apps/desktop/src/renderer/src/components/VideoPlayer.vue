<script setup lang="ts">
import type { VideoNode } from '@workbench/video'
import { fitVideoFloatGeometry, nextVideoNode, nextVideoRate, resizeVideoFloat, VIDEO_NEXT_SECONDS, VIDEO_SEEK_SECONDS } from '@workbench/video'
/**
 * 视频播放器本体：**全局单例**，挂在 App.vue 上（与终端面板同层），不随换页切换。
 *
 * 之前播放器住在视频页里，靠 KeepAlive「切走的页面不卸载」把播放延续成背景音 ——
 * 但画面看不见，想边看教学视频边记笔记就得来回切页。现在把 `<video>` 与它周围
 * 那一圈（速率、快捷键、播完自动接续）整体搬到这里，**内嵌与悬浮是同一个元素**：
 *   - 在视频页：Teleport 进视频页画布注册的宿主（use-video-stage），与原来内嵌一样；
 *   - 悬浮小窗：**点「悬浮播放」才浮**（store 里的显式意图）—— 离开视频页不自动弹窗，
 *     没点过就只是接着出声、画面随视频页待在后台；点过则同一个元素改为固定定位的
 *     悬浮窗浮在界面上。传送只是把同一个元素在两处之间搬，元素不重建，**播放因此一秒不断**。
 *
 * 悬浮窗带一条拖动手柄（视频名 / 速率 / 回视频页 / 关闭）与右下角的缩放手柄；
 * 位置与尺寸落 theme.json（videoFloatX/Y/W/H，两段式跟手 / 落盘与视频树宽同一套）。
 * 「回到视频页」= 收回悬浮 + 把当前页切回去 —— 小窗内容原地传送进画布；「关闭」是停止播放。
 *
 * **独立窗口是另一条路**（不在这个组件里播）：点视频页头部的「在独立窗口播放」后，
 * 这里把当前秒数与播放态交给 `video.html` 那扇顶层窗口，然后把自己的 `<video>` 卸掉
 * （`store.detached`）；两边的 active / 速率 / 收回 / 关闭经 Rust 的两条事件同步。
 * 收回时按 `store.resume` 在 `loadedmetadata` 里 seek 回同一秒，**播放一秒不重复、不跳**。
 *
 * 快捷键跟着播放器走而不是跟着页面走：视频页内仍是整套（空格 / 方向键 / 速率），
 * 悬浮时只拦空格 —— 笔记页的树还要用方向键导航，而 Vditor 里打字由 typingOn 挡住。
 * **独立播放时主窗口一个键都不拦**（窗口自己有整套）。拦截规则照旧：捕获阶段拦下并
 * stopPropagation（媒体控件自己也会拿这几个键），没有正播的视频时一个键都不拦。
 *
 * **原生控件不许留住焦点**（见 releaseScreenFocus）：Chromium 的媒体控件在 `<video>`
 * 自己的 UA shadow DOM 里，焦点落进去之后 keydown 连 window 捕获阶段都收不到 ——
 * 按过原生播放键 / 拖过进度条，空格就会「失效」，直到点别处把焦点挪走。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import VideoPlayerBar from '@/components/VideoPlayerBar.vue'
import VideoUpNext from '@/components/VideoUpNext.vue'
import { startPointerDrag } from '@/composables/use-pointer-drag'
import { useVideoStageHost } from '@/composables/use-video-stage'
import { notifyError } from '@/notify'
import { useNavStore } from '@/stores/nav'
import { useSettingsStore } from '@/stores/settings'
import { useVideoStore } from '@/stores/video'

const store = useVideoStore()
const settings = useSettingsStore()
const nav = useNavStore()

const stageHost = useVideoStageHost()

/** 独立窗口发回来的事件取消函数（挂载后才有） */
let offWindowEvents: (() => void) | null = null

/** 在视频页：内嵌（传送进画布）；不在：宿主随视频页一起脱离文档，接着出声 */
const inline = computed(() => nav.activeView === 'video')
/**
 * 小窗显示没有：手上还有视频、且用户点过「悬浮播放」（store 的显式意图 —— 离开
 * 视频页**不**自动浮）。播的、暂停的都算：小窗是遥控器也是画面。
 * 独立窗口播着时不算：那时主窗口里没有可浮的元素。
 */
const floating = computed(() => !!store.active && store.floatRequested && !store.detached)

// 进视频页就收回悬浮：画布才是视频在那一页的正位（与悬浮窗上「回到视频页」同一语义）
watch(inline, (value) => {
  if (value)
    store.dockFloat()
})

// ---------- 播放器 ----------

const playerRef = ref<HTMLVideoElement | null>(null)

function applyRate(): void {
  const video = playerRef.value
  if (!video)
    return
  // defaultPlaybackRate 一起设：换视频重载后浏览器会把它复位回默认值
  video.defaultPlaybackRate = store.rate
  video.playbackRate = store.rate
}

function stepRate(direction: 1 | -1): void {
  store.rate = nextVideoRate(store.rate, direction)
}

watch(
  () => store.rate,
  () => applyRate(),
)

/** 从独立窗口收回时带来、还没落下去的那一秒（见下面的 detached watcher 与 onLoadedMetadata） */
const resumeSeek = ref<{ time: number, play: boolean } | null>(null)

/**
 * 元数据到位：先贴速率，再把收回时要落的那一秒落下去。
 *
 * seek 必须等元数据 —— 刚挂上的 `<video>` duration 还是 NaN，直接写 currentTime
 * 要么被忽略、要么报错。收回时主窗口的 `<video>` 是重新挂的（独立播放期间它被卸掉了），
 * 所以这条是「从独立窗口接着播」的唯一入口；`play` 为 false 就停在那一秒。
 */
function onLoadedMetadata(): void {
  applyRate()
  const video = playerRef.value
  const seek = resumeSeek.value
  if (!video || !seek)
    return
  resumeSeek.value = null
  if (Number.isFinite(seek.time) && seek.time > 0) {
    try {
      video.currentTime = seek.time
    }
    catch {
      // 可 seek 区间还没出来：停在首帧，用户按空格即可
    }
  }
  if (seek.play)
    void video.play().catch(() => {})
}

/** 新视频挂上来（元素随 :key 整个换新）：把速率贴上去；播不播看 store 的意图 ——
 * 点树上的直接开播，恢复上次的那个只加载、停在首帧（空格或播放键在这儿等着） */
watch(
  () => store.active?.rel,
  async () => {
    // 换了视频，上一部播完时摆出的「即将播放」就算数了：无论是自动接过去的还是用户自己挑的
    clearUpNext()
    if (!store.active)
      return
    await nextTick()
    applyRate()
    if (!store.autoplayNext)
      return
    // 播不出来（还没缓冲完、或浏览器拦了自动播放）就停在原处，用户按空格再来
    void playerRef.value?.play().catch(() => {})
  },
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
  if (target)
    store.select(target.rel)
}

function onEnded(): void {
  const current = store.active
  if (!current)
    return
  const next = nextVideoNode(store.nodes, current.rel)
  if (!next)
    return

  clearUpNext()
  upNext.value = next
  upNextLeft.value = VIDEO_NEXT_SECONDS
  upNextTimer = setInterval(() => {
    upNextLeft.value -= 1
    if (upNextLeft.value > 0)
      return
    goUpNext()
  }, 1000)
}

/** 倒计时里用户反悔了：留在当前这一个（播完了就停在最后一帧，接不接由用户再定） */
function cancelUpNext(): void {
  clearUpNext()
}

// ---------- 独立窗口：交出播放权 / 收回 ----------

/**
 * 点「在独立窗口播放」：store 只置了一个意图，真正读秒数得在这里（只有这个组件拿着
 * `<video>`）。先暂停再开窗，窗口从同一秒接上；开不起来就按原来的播放态接着播。
 */
watch(
  () => store.detachedRequest,
  async (wanted) => {
    if (!wanted)
      return
    const source = store.active
    const video = playerRef.value
    if (!source || !video) {
      store.detachFailed()
      notifyError('没有正在播放的视频')
      return
    }

    const time = Number.isFinite(video.currentTime) ? video.currentTime : 0
    const playing = !video.paused
    video.pause()
    clearUpNext()

    const result = await window.workbench.openVideoWindow({
      root: store.root,
      source,
      rate: store.rate,
      time,
      playing,
      playlist: store.playlist,
    })
    if (!result.ok) {
      store.detachFailed()
      notifyError(result.error ?? '打开独立视频窗口失败')
      if (playing)
        void video.play().catch(() => {})
      return
    }
    store.detachOpened()
  },
)

/** 收回：等主窗口的 `<video>` 重新挂上、元数据到位后 seek 回同一秒 */
watch(
  () => store.detached,
  async (value, previous) => {
    if (!previous || value)
      return
    const seek = store.consumeResume()
    if (!seek)
      return
    await nextTick()
    if (!playerRef.value) {
      resumeSeek.value = null
      return
    }
    resumeSeek.value = { time: seek.time, play: seek.playing }
    // 本地文件可能快得在 nextTick 之前就 loadedmetadata 了：补一次
    if (playerRef.value.readyState >= 1)
      onLoadedMetadata()
  },
)

onMounted(() => {
  // 浏览器预览里没有 window.workbench（见 workbench/index.ts 的 installTauriWorkbench）：
  // 这条订阅只在 Tauri 里挂得上，别的功能照旧
  offWindowEvents = window.workbench?.onVideoWindowEvent((event) => {
    switch (event.kind) {
      case 'active':
        // 独立窗口自动接下一部：视频页的标题、选中项与「上次打开」都跟着它
        store.detachedActive(event.source, event.rate)
        break
      case 'rate':
        store.detachedRate(event.rate)
        break
      case 'dock':
        store.detachedDocked(event)
        void nav.setActiveView('video')
        break
      case 'closed':
        // 收回触发的关闭已经由 dock 交回播放权了，别把刚恢复的画面又清掉
        if (!event.docked)
          store.detachedClosed()
        break
    }
  }) ?? null
})

function togglePlay(): void {
  const video = playerRef.value
  if (!video)
    return
  if (video.paused)
    void video.play().catch(() => {})
  else video.pause()
}

/** 快进 / 快退：夹在 [0, 时长] 里，元数据还没到位（duration 是 NaN）就不动 */
function seekBy(delta: number): void {
  const video = playerRef.value
  if (!video || !Number.isFinite(video.duration))
    return
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta))
}

/**
 * **原生媒体控件一拿到焦点，整页就收不到键盘了** —— 这是 Chromium 的坑：
 * 控件在 `<video>` 自己的 UA shadow DOM 里，焦点落在那些按钮 / 进度条上的这段时间，
 * keydown 连 window 捕获阶段都到不了（不是被谁拦下，是压根不进页面），按空格要么被
 * 控件自己吃掉、要么毫无反应；点一下画面把焦点挪走才恢复。点过原生播放键、拖过进度条
 * 之后「空格暂停 / 播放失效」就是它 —— 焦点还留在控件里。
 *
 * 快捷键整套归我们管（原生控件的键盘操作本来也用不上），所以焦点一贴上来就 blur 掉。
 * 鼠标操作照常：播放键 / 音量 / 全屏走 click，进度条拖动走 pointer capture，都不依赖焦点
 * （试过 mousedown 上 preventDefault 想不让它聚焦 —— 控件是脚本里自己 focus 的，挡不住）。
 * `focusin` 一起挂：焦点落进 shadow DOM 时 `focus` 不一定再发一次。
 */
function releaseScreenFocus(): void {
  playerRef.value?.blur()
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
  if (!store.active || event.isComposing || typingOn(event))
    return

  if (floating.value) {
    if (event.code !== 'Space')
      return
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat)
      togglePlay()
    return
  }

  if (!HANDLED_KEYS.has(event.code))
    return
  event.preventDefault()
  event.stopPropagation()

  switch (event.code) {
    case 'Space':
      if (!event.repeat)
        togglePlay()
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
  if (!store.active || event.code !== 'Space' || event.isComposing || typingOn(event))
    return

  event.preventDefault()
  event.stopPropagation()
}

/** 内嵌 / 悬浮时挂键；独立播放、不在视频页也没悬浮（背景音接着播）都摘掉 —— 捕获监听成对摘挂 */
function bindKeys(bind: boolean): void {
  if (bind) {
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('keyup', onKeyup, true)
  }
  else {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keyup', onKeyup, true)
  }
}

watch(
  [inline, floating, () => store.detached],
  ([nextInline, nextFloating, nextDetached]) =>
    bindKeys(!nextDetached && (nextInline || nextFloating)),
  { immediate: true },
)

onBeforeUnmount(() => {
  bindKeys(false)
  offWindowEvents?.()
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
  h: settings.themeConfig.videoFloatH,
}))

const floatStyle = computed(() => {
  const { x, y, w, h } = floatGeometry.value
  const fit = fitVideoFloatGeometry({ x, y, w, h }, viewport.value)
  return {
    left: `${fit.left}px`,
    top: `${fit.top}px`,
    width: `${fit.width}px`,
    height: `${fit.height}px`,
  }
})

/** 把视口内的像素落点折回百分比落盘值（拖动跟手走 settings 的 set，边界它自己再收一遍） */
function geometryOf(left: number, top: number, width: number, height: number): { x: number, y: number, w: number, h: number } {
  const { w: vw, h: vh } = viewport.value
  return {
    x: (left / vw) * 100,
    y: (top / vh) * 100,
    w: width,
    h: height,
  }
}

/** 拖手柄挪窗：起点是窗当前的像素落点，位移直接加上去，全程压在视口内 */
function onBarDown(event: PointerEvent): void {
  if (event.button !== 0)
    return
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
    onEnd: () => void settings.commitVideoFloatGeometry(),
  })
}

/**
 * 抓角落缩放小窗：右下 / 左下两枚手柄共用这一份（口径在 packages/video/src/video.ts 的 resizeVideoFloat）。
 * 右下角：左上角钉住，宽高随位移长；左下角：**右上角钉住** —— 往左拖是长大，
 * 宽度的变化全部折进左缘（左缘不得越过视口左缘）。抓哪一角、对角就钉住不动；
 * 拖动期间只改本地，松手才落盘（与视频树宽同一套两段式）。
 */
function onGripDown(event: PointerEvent, edge: 'left' | 'right'): void {
  if (event.button !== 0)
    return
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
          moveEvent.clientY - dragStart.y,
        ),
      )
    },
    onEnd: () => void settings.commitVideoFloatGeometry(),
  })
}

/** 悬浮窗上的「回到视频页」：收回悬浮并切回去，小窗内容原地传送进画布 */
function backToVideoView(): void {
  store.dockFloat()
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
    <div v-if="store.active && !store.detached" class="vplayer" :class="{ 'is-floating': floating }" :style="floating ? floatStyle : undefined">
      <!--
        悬浮窗的手柄条：整条都能拖（父级挂的 pointerdown 落到组件根上），
        标题截断给原生 title，速率与图标按钮各自带 tooltip。独立窗口里用的是同一枚。
      -->
      <VideoPlayerBar
        v-if="floating"
        :name="store.active.name"
        :rate="store.rate"
        @rate="(value: number) => (store.rate = value)"
        @dock="backToVideoView"
        @close="closePlayer"
        @pointerdown="onBarDown"
      />

      <!-- 播放画布：始终深色（--term-* 那一族，与终端面板同一口径），视频按比例缩进画布里 -->
      <div class="vplayer__canvas">
        <!--
          :key 让每个视频都是一只新元素：旧视频的缓冲、进度与事件监听一起随它销毁。
          不放 autoplay 属性 —— 开播只由上面的 watch 按 store 的意图调 play()。
          play / seeking 是「用户接手了」的信号：倒计时摆着的时候用户重新播放或拖回
          进度条，说明他想重看这一部，自动接下去就得撤。
          focus / focusin 一律 blur 掉（见 releaseScreenFocus）：焦点留在原生控件里时
          整页收不到键盘，空格快捷键会静默失效。
          原生控件右下角 ⋮ 菜单整份关掉（controlslist + disablepictureinpicture）：
          下载对本地播放器没意义，原生速率会与 store 的 rate 脱钩，系统级画中画会把
          视频搬出应用自己的传送小窗 —— 三项各有应用内的一套，留原生那份只会两处打架
        -->
        <video
          ref="playerRef"
          class="vplayer__screen"
          :src="store.active.url"
          controls
          controlslist="nodownload noplaybackrate"
          disablepictureinpicture
          preload="metadata"
          @focus="releaseScreenFocus"
          @focusin="releaseScreenFocus"
          @loadedmetadata="onLoadedMetadata"
          @play="cancelUpNext"
          @seeking="cancelUpNext"
          @ended="onEnded"
        />

        <!--
          播完接下去的倒计时浮层（压暗层 + 卡片）：与视频同进退（传送时跟着元素一起搬），
          到点与卡片上的「立即播放」都走 goUpNext 切过去 —— 与点树上的视频是同一条路。
          悬浮时它照常出现在小窗里；独立窗口里用的是同一枚组件。
        -->
        <VideoUpNext
          v-if="upNext"
          :name="upNext.name"
          :seconds="upNextLeft"
          @play="goUpNext"
          @cancel="cancelUpNext"
        />
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

/* ---------- 播放画布 ---------- */

/**
 * 画布同时是倒计时卡片的**尺寸容器**（见下面 @container）：卡片要按「内嵌页的大画布」
 * 与「悬浮小窗」两种尺寸换疏密，能回答这个问题的只有画布自己 —— 窗口宽度不算数
 * （同一只小窗可以拖得很宽，也可以压到 240×135）。
 */
.vplayer__canvas {
  flex: 1 1 auto;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  background: var(--term-bg);
  container-type: size;
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
</style>
