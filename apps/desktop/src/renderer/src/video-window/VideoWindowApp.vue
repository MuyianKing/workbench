<script setup lang="ts">
import type { VideoSource, VideoWindowCommand, VideoWindowItem } from '@/types'
import { clampVideoRate, nextVideoRate, VIDEO_NEXT_SECONDS, VIDEO_SEEK_SECONDS } from '@workbench/video'
/**
 * 独立视频窗口：一扇自己的顶层窗口里放 `<video>`，与主窗口的播放器分工。
 *
 * 它**不装 store、不 initState**（见 main.ts）：开窗时那份上下文由主窗口经 Rust
 * 交过来（`videoWindowContext`），之后的换视频 / 速率 / 收回 / 关闭都走两条事件通道。
 * 与主窗口的「悬浮小窗」不是一回事 —— 那边是同一个 `<video>` 元素在应用内 Teleport，
 * 这边是第二个播放宿主，元素是新的，所以开窗 / 收回都按秒数交接。
 *
 * 播放语义与主窗口那份保持一致：
 *   - 开播只有一个来源（`loadedmetadata` 里按 `pending.play` 调 `play()`，没有 autoplay 属性）；
 *   - 播完按 `playlist`（视频树摊平的展示顺序）接下一个，倒计时卡片与主窗口共用 VideoUpNext；
 *   - 原生 ⋮ 菜单整份关掉（下载 / 原生速率 / 系统画中画三项各有应用内的一套）；
 *   - 快捷键整套挂 window 捕获阶段（这扇窗口里没有别的东西要键盘）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import VideoPlayerBar from '@/components/VideoPlayerBar.vue'
import VideoUpNext from '@/components/VideoUpNext.vue'
import { notifyError } from '@/notify'

const root = ref('')
const playlist = ref<VideoWindowItem[]>([])
const source = ref<VideoSource | null>(null)
const rate = ref(1)
const onTop = ref(false)
/** 读不出上下文 / 换视频失败的原因；非空时在画布上盖一层 */
const failure = ref('')
/** 上下文问回来了没有：没回来之前不摆「状态已经过期」那一屏（否则每次开窗先闪一句报错） */
const resolved = ref(false)
/** 每次换源 +1：同一个 URL 也换一只新 `<video>`（旧缓冲与进度一起销毁） */
const loadSeq = ref(0)

const playerRef = ref<HTMLVideoElement | null>(null)
/** 新的 `<video>` 元数据到位后要落的点：seek 到哪、要不要开播 */
const pending = ref<{ time: number, play: boolean } | null>(null)

let offCommand: (() => void) | null = null
/** 已经在收起 / 关闭：异步回来的 loadVideo / 命令一律丢掉，别再往主窗口回报 */
let closing = false

// ---------- 播放器 ----------

function applyRate(): void {
  const video = playerRef.value
  if (!video)
    return
  // defaultPlaybackRate 一起设：换视频重载后浏览器会把它复位回默认值
  video.defaultPlaybackRate = rate.value
  video.playbackRate = rate.value
}

watch(rate, applyRate)

/**
 * 元数据到位：先贴速率，再落开窗 / 换视频时记下的那一秒。
 *
 * seek 必须等元数据 —— 刚挂上的 `<video>` duration 还是 NaN，直接写 currentTime
 * 要么被忽略、要么报错。开播也只在这里发生，`<video>` 上没有 autoplay 属性。
 */
function onLoadedMetadata(): void {
  applyRate()
  const video = playerRef.value
  const seek = pending.value
  if (!video || !seek)
    return
  pending.value = null
  if (Number.isFinite(seek.time) && seek.time > 0) {
    try {
      video.currentTime = seek.time
    }
    catch {
      // 文件头还没给出可 seek 的区间：停在首帧，用户按空格即可
    }
  }
  if (seek.play)
    void video.play().catch(() => {})
}

/** 换一只新 `<video>`（换视频 / 自动接续 / 主窗口发来的 load 都走这里） */
function playSource(next: VideoSource, time: number, play: boolean): void {
  pending.value = { time, play }
  source.value = next
  loadSeq.value += 1
  failure.value = ''
}

function togglePlay(): void {
  const video = playerRef.value
  if (!video)
    return
  if (video.paused)
    void video.play().catch(() => {})
  else video.pause()
}

function seekBy(delta: number): void {
  const video = playerRef.value
  if (!video || !Number.isFinite(video.duration))
    return
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta))
}

/**
 * 原生媒体控件一拿到焦点，整页就收不到键盘（与主窗口 VideoPlayer 的 releaseScreenFocus
 * 同一条坑）：焦点落在 `<video>` 的 UA shadow 控件里时 keydown 连捕获阶段都到不了。
 * 这扇窗口的快捷键整套归我们管，所以焦点一贴上来就 blur 掉。
 */
function releaseScreenFocus(): void {
  playerRef.value?.blur()
}

function setRate(value: number): void {
  const next = clampVideoRate(value)
  if (next === rate.value)
    return
  rate.value = next
  void window.workbench.reportVideoWindow({ kind: 'rate', rate: next })
}

function stepRate(direction: 1 | -1): void {
  setRate(nextVideoRate(rate.value, direction))
}

// ---------- 播完自动接下去 ----------

const upNext = ref<VideoWindowItem | null>(null)
const upNextLeft = ref(0)
let upNextTimer: ReturnType<typeof setInterval> | null = null

function clearUpNext(): void {
  if (upNextTimer !== null) {
    clearInterval(upNextTimer)
    upNextTimer = null
  }
  upNext.value = null
  upNextLeft.value = 0
}

function onEnded(): void {
  const current = source.value
  if (!current)
    return
  const at = playlist.value.findIndex(item => item.rel === current.rel)
  if (at === -1)
    return
  const next = playlist.value[at + 1]
  if (!next)
    return

  clearUpNext()
  upNext.value = next
  upNextLeft.value = VIDEO_NEXT_SECONDS
  upNextTimer = setInterval(() => {
    upNextLeft.value -= 1
    if (upNextLeft.value > 0)
      return
    void goUpNext()
  }, 1000)
}

/** 倒计时到点与卡片上的「立即播放」共用：先收浮层，再授权并换源 */
async function goUpNext(): Promise<void> {
  const target = upNext.value
  clearUpNext()
  if (!target || closing)
    return

  const result = await window.workbench.loadVideo(root.value, target.rel)
  if (closing)
    return
  if (!result.ok || !result.data) {
    failure.value = result.error ?? '打开视频失败'
    return
  }
  playSource(result.data, 0, true)
  // 自动接过去的这一部要让主窗口知道：视频页的标题、选中项与「上次打开」都跟着它
  void window.workbench.reportVideoWindow({
    kind: 'active',
    source: result.data,
    rate: rate.value,
  })
}

function cancelUpNext(): void {
  clearUpNext()
}

// ---------- 与主窗口的交接 ----------

function onCommand(command: VideoWindowCommand): void {
  if (closing)
    return
  if (command.action === 'load') {
    clearUpNext()
    rate.value = clampVideoRate(command.rate)
    if (command.playlist.length)
      playlist.value = command.playlist
    playSource(command.source, command.time, command.playing)
    return
  }
  if (command.action === 'dock') {
    dock()
    return
  }
  close()
}

/** 收回：把当前这一秒与暂停态交回主窗口，Rust 唤出主窗口后关掉这扇窗口 */
function dock(): void {
  const current = source.value
  const video = playerRef.value
  if (!current || !video) {
    close()
    return
  }
  closing = true
  clearUpNext()
  const time = Number.isFinite(video.currentTime) ? video.currentTime : 0
  const playing = !video.paused
  video.pause()
  void window.workbench.reportVideoWindow({
    kind: 'dock',
    source: current,
    rate: rate.value,
    time,
    playing,
  })
}

/** 关闭 = 停止播放：主窗口收到 closed 后清空 active */
function close(): void {
  closing = true
  clearUpNext()
  playerRef.value?.pause()
  void window.workbench.reportVideoWindow({ kind: 'close' })
}

async function toggleTop(): Promise<void> {
  const next = !onTop.value
  const result = await window.workbench.setVideoWindowOnTop(next)
  if (!result.ok) {
    notifyError(result.error ?? '切换置顶失败')
    return
  }
  onTop.value = next
}

// ---------- 快捷键 ----------

const HANDLED_KEYS = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

/** 焦点落在文本框里时一个键都不拦（这扇窗里目前没有输入框，留着同一道闸） */
function typingOn(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  return Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || typingOn(event))
    return
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

/** 空格 keyup 一起拦：媒体控件在 keyup 上还留着半只手 */
function onKeyup(event: KeyboardEvent): void {
  if (event.code !== 'Space' || event.isComposing || typingOn(event))
    return
  event.preventDefault()
  event.stopPropagation()
}

// ---------- 生命周期 ----------

onMounted(async () => {
  // 先挂命令监听再问上下文：主窗口可能在这两步之间点「换一个」
  offCommand = window.workbench.onVideoWindowCommand(onCommand)
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)

  const result = await window.workbench.videoWindowContext()
  resolved.value = true
  if (!result.ok || !result.data) {
    failure.value = result.error ?? '独立视频窗口的状态已经过期'
    return
  }
  const context = result.data
  root.value = context.root
  playlist.value = context.playlist
  rate.value = clampVideoRate(context.rate)
  onTop.value = context.onTop
  playSource(context.source, context.time, context.playing)
})

onBeforeUnmount(() => {
  closing = true
  offCommand?.()
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('keyup', onKeyup, true)
  clearUpNext()
})
</script>

<template>
  <div class="vwin">
    <template v-if="source">
      <VideoPlayerBar
        native-drag
        show-pin
        :name="source.name"
        :rate="rate"
        :pinned="onTop"
        @rate="setRate"
        @toggle-pin="toggleTop"
        @dock="dock"
        @close="close"
      />

      <!-- 播放画布：始终深色（--term-* 同一族，与主窗口的悬浮画布一致） -->
      <div class="vwin__canvas">
        <video
          :key="loadSeq"
          ref="playerRef"
          class="vwin__screen"
          :src="source.url"
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

        <VideoUpNext
          v-if="upNext"
          :name="upNext.name"
          :seconds="upNextLeft"
          @play="goUpNext"
          @cancel="cancelUpNext"
        />

        <!-- 换视频失败（文件被删 / 不是 MP4）：把原因说出来，不让人对着黑屏猜 -->
        <div v-if="failure" class="vwin__error" role="alert">
          <p class="vwin__error-text">
            {{ failure }}
          </p>
        </div>
      </div>
    </template>

    <!-- 连上下文都没拿到（窗口已经过期 / 会话被清掉）：只留一句原因与关闭 -->
    <div v-else-if="resolved" class="vwin__error is-standalone" role="alert">
      <p class="vwin__error-text">
        {{ failure || '独立视频窗口的状态已经过期。' }}
      </p>
      <el-button size="small" @click="close">
        关闭窗口
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.vwin {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--term-bg);
  color: var(--term-ink);
}

/**
 * 画布同时是倒计时卡片的**尺寸容器**（VideoUpNext 里的 @container 以它为界）：
 * 与主窗口的 `.vplayer__canvas` 同一条口径，窗口拖窄时卡片自动换紧凑那档。
 */
.vwin__canvas {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  background: var(--term-bg);
  container-type: size;
}

.vwin__screen {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  outline: none;
}

/* 出错时的压暗层：盖在画面上，但不拦手柄栏（栏在画布外面） */
.vwin__error {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  padding: var(--sp-5);
  background: color-mix(in srgb, var(--term-bg) 82%, transparent);
  text-align: center;
}

/* 没有视频可盖时它自己占满窗口的正文区 */
.vwin__error.is-standalone {
  position: static;
  flex: 1 1 auto;
  background: none;
}

.vwin__error-text {
  margin: 0;
  max-width: 420px;
  overflow-wrap: anywhere;
  font-size: var(--fs-body);
  line-height: 1.5;
  color: var(--term-ink);
}
</style>
