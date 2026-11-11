import type { VideoNode, VideoSource } from '@workbench/video'
import type { VideoWindowCommand, VideoWindowItem } from '@/types'
import { clampVideoRate, countVideos, findVideoNode, flattenVideoNodes, pushVideoHistory, removeFromVideoHistory, sanitizeVideoRoot, videoChain, videoRootName } from '@workbench/video'
import { defineStore } from 'pinia'
/**
 * 视频：一个**用户自己挑的文件夹**，以及它里面的目录树与正在播放的那一个。
 *
 * 与笔记 store 同一条骨架：这里没有内存副本，树是扫出来的、视频是按文件交给
 * webview 自己读的（asset 协议），落盘的只有四样「行为记忆」——选的哪个目录、
 * 打开过哪几个、树摊开了哪几层、**上次打开的是哪个视频**（进页面直接接上，都在设置里，
 * 见 packages/video/src/video.ts 的文件头）。这一层只负责编排：谁被选中、什么时候读盘、
 * 换了目录把旧的那份收起来。
 *
 * 两条不能破：
 *   - **没选文件夹就什么都不做**：`root` 空串时界面上是一句引导（VideoView）；
 *   - **打开的那一个只有一个来源**：选中与打开是同一件事 —— 点树上的视频就是
 *     立刻播它，点文件夹只是选中并切换展开态；恢复上次的那个是唯一的例外
 *     （只加载不播，见 `autoplayNext`）。
 *
 * 播放本身的状态里，只有**要跨组件共享的那部分**住在这里（速率、悬浮与独立窗口的意图 ——
 * 播放器本体、视频页头部与独立窗口各要读一份）；进度与暂停的实际值活在 `<video>` 元素上，
 * 不另立全局状态。
 *
 * **独立窗口**（第五个 HTML 入口 `video.html`）是第二份播放宿主：这里的 `detached` 只是
 * 主窗口这边的镜像（真正的窗口在 Rust 手里），`detachedRequest` 是「点过在独立窗口播放」
 * 的意图，`resume` 是收回时带来、还没落到主窗口 `<video>` 上的那一秒。两边的 active /
 * 速率 / 收回 / 关闭走 VideoPlayer 里的两条事件（见 `video-window:event`），不在这里监听。
 */
import { computed, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'

export const useVideoStore = defineStore('video', () => {
  const settings = useSettingsStore()

  /** 视频文件夹；空串表示还没选过（第一次进视频页时就是这个状态） */
  const root = computed(() => settings.settings.videoDir)
  const rootName = computed(() => videoRootName(root.value))
  /** 打开过的视频目录（最近打开的在最前面）；左栏底部那段「最近打开」就是它 */
  const recentRoots = computed(() => settings.settings.videoDirs)

  /**
   * 播放速率（倍）：会话里记住，不落盘 —— 它不是「这台机器长什么样」。
   * 住在 store 里是因为播放器本体（VideoPlayer）与视频页头部的速率菜单是两个组件，
   * 一份速率两处读：悬浮小窗里改了，回视频页还得是同一个值（换视频沿用这一份）。
   */
  const rate = ref(1)

  /**
   * 悬浮播放的显式意图（会话里的记忆，不落盘）：离开视频页**不**自动浮窗 ——
   * 没点过「悬浮播放」就只是接着出声（画面随视频页待在后台）；点过才浮，
   * 回到视频页或停播时收回。住在 store 里是因为发起方（视频页头部）与执行方
   * （全局单例播放器）是两个组件，一份意图两边读写。
   */
  const floatRequested = ref(false)

  /** 目录树的顶层（文件夹与视频，已按「文件夹在前、同层按名字」排好） */
  const nodes = ref<VideoNode[]>([])
  /** 当前选中的路径（可能是文件夹，也可能是视频）；树上的高亮就是它 */
  const activeRel = ref('')
  /** 正在播放的那一个（拿它给 `<video>` 的 src）；选中的是文件夹时是 null */
  const active = ref<VideoSource | null>(null)
  /**
   * 接下来挂上来的那个视频要不要直接开播：点树上的算「现在就要看」，恢复上次的那次
   * 只加载、停在首帧（出声是件打扰人的事，恢复不该替用户按下播放键）。
   * 播放器（VideoView 的 watch）照它决定调不调 `play()` —— 开播只有一个来源。
   */
  const autoplayNext = ref(true)

  /**
   * 独立窗口正在播（主窗口这边不再渲染 `<video>`）：它只是 Rust 那扇窗口的镜像，
   * 窗口被关掉时由 `video-window:event` 的 closed 回来清掉。
   */
  const detached = ref(false)
  /** 点过「在独立窗口播放」的意图：真正读秒数并开窗的是播放器（它拿着 `<video>`） */
  const detachedRequest = ref(false)
  /** 从独立窗口收回时带来、还没落到主窗口 `<video>` 上的那一秒 */
  const resume = ref<{ time: number, playing: boolean } | null>(null)

  /** 独立窗口的播放列表：视频树按展示顺序摊平（与 nextVideoNode 同一份顺序） */
  const playlist = computed<VideoWindowItem[]>(() =>
    flattenVideoNodes(nodes.value).map(node => ({ rel: node.rel, name: node.name })),
  )

  const loading = ref(false)
  /** 至少成功读过一次盘：空态提示据此决定要不要说「这里还没有视频」 */
  const loaded = ref(false)
  /** 读盘失败与「这个文件夹里什么都没有」是两回事，不能都显示成空态 */
  const loadError = ref('')
  /** 打开某个视频失败的原因（文件被删了、不是完整的 MP4） */
  const openError = ref('')

  /** 进过页面没有：没进过页面就不必跟着扫（与笔记 store 同一个开关） */
  let started = false
  let ready = false
  let pending: Promise<void> | null = null
  /** 扫描与打开各自的令牌：慢一步回来的结果直接丢掉 */
  let scanJob = 0
  let openJob = 0
  /** 独立窗口换视频的令牌：连点两个时只让最后那个发 load 命令 */
  let detachJob = 0

  const videoCount = computed(() => countVideos(nodes.value))
  /** 选中项从最外层到自身的链；界面拿它写「它在哪一层」 */
  const activeChain = computed(() =>
    activeRel.value ? videoChain(nodes.value, activeRel.value) : [],
  )

  function reset(): void {
    nodes.value = []
    activeRel.value = ''
    active.value = null
    loaded.value = false
    loadError.value = ''
    openError.value = ''
    detached.value = false
    detachedRequest.value = false
    resume.value = null
  }

  /**
   * 重新扫一遍文件夹。
   *
   * 扫完顺手核一遍「选中的那个还在不在」：在应用外面把它删掉 / 改名之后，
   * 树上不该继续高亮一个不存在的路径（正播着的那一个不受影响 —— 文件被删
   * webview 自己会停，这里管的是树的显示）。
   */
  async function reload(): Promise<void> {
    const current = root.value
    if (!current) {
      reset()
      return
    }

    const job = (scanJob += 1)
    loading.value = true
    loadError.value = ''

    const result = await window.workbench.listVideos(current)
    if (job !== scanJob)
      return
    loading.value = false

    if (!result.ok || !result.data) {
      loadError.value = result.error ?? '读取视频文件夹失败'
      return
    }

    nodes.value = result.data
    loaded.value = true
    ready = true

    if (activeRel.value && !findVideoNode(nodes.value, activeRel.value)) {
      activeRel.value = ''
    }
  }

  /**
   * 首次进页面时扫一次。
   *
   * 页面被 KeepAlive 包着，来回切页不会重挂载，所以这里挡住并发调用，
   * 并且只在读成功之后才算「就绪」（失败时下次进来还能重试）。
   */
  async function init(): Promise<void> {
    started = true
    if (ready)
      return
    if (!pending) {
      pending = reload().finally(() => {
        pending = null
      })
    }
    await pending

    // 首次进页面且扫成功了：把「上次打开的那个」接上（首次扫描失败时不清记录，下次进来还能接）
    if (ready)
      void restoreLast()
  }

  /**
   * 恢复上一次打开的视频：树里还有它才接上，没有（被删 / 改名 / 记录是旧目录的）
   * 就把记录清掉 —— 留着只会每次进页面都空找一遍。
   * 它所在的那几层文件夹一起撑开，否则视频在播、树里却找不到它高亮在哪。
   */
  async function restoreLast(): Promise<void> {
    if (active.value)
      return

    const rel = settings.settings.videoLastRel
    if (!rel)
      return

    const node = findVideoNode(nodes.value, rel)
    if (!node || node.kind !== 'video') {
      void settings.updateSettings({ videoLastRel: '' })
      return
    }

    const folders = videoChain(nodes.value, rel)
      .slice(0, -1)
      .map(item => item.id)
    if (folders.length) {
      await settings.updateSettings({
        videoTreeExpanded: [...new Set([...settings.settings.videoTreeExpanded, ...folders])],
      })
    }

    activeRel.value = rel
    // 只加载不自动播：出声是件打扰人的事，恢复不该替用户按下播放键（空格在这儿等着）
    void open(node, false)
  }

  /**
   * 记下用户挑的文件夹，并把它排到「最近打开」的最前面。
   *
   * 落盘走设置（`videoDir` + `videoDirs`），随后的扫描由下面那条 watch 触发 ——
   * 两条路各扫一次的话，慢的那次会把快的覆盖掉。
   * 展开态只对上一个目录成立，换目录时一起清掉（与笔记树同一条口径）。
   */
  async function setRoot(dir: string): Promise<boolean> {
    const target = sanitizeVideoRoot(dir)
    if (!target)
      return false

    return settings.updateSettings({
      videoDir: target,
      videoDirs: pushVideoHistory(settings.settings.videoDirs, target),
      // 展开态与「上次打开的文件」都只对上一个目录成立：存的是相对路径，
      // 换到另一个目录就指向完全不同的东西了。一起清掉，新目录从收起状态开始
      videoTreeExpanded: [],
      videoLastRel: '',
    })
  }

  /**
   * 从「最近打开」里删掉一条。
   *
   * 只是不再列出来 —— 删的若是当前打开的那个，目录不跟着换（那得由用户另挑一个），
   * 所以这里只动 `videoDirs`，不碰 `videoDir`。
   */
  async function forgetRoot(dir: string): Promise<boolean> {
    return settings.updateSettings({
      videoDirs: removeFromVideoHistory(settings.settings.videoDirs, dir),
    })
  }

  // 设置里的视频文件夹一改就重新扫（首次选的目录、换一个目录、清空都走这里）；
  // 选中的与正播的都收起来 —— 它们的相对路径与授权都属于上一个目录，留着只会让人困惑
  watch(root, () => {
    if (!started)
      return
    ready = false
    activeRel.value = ''
    closeVideo()
    void reload()
  })

  /**
   * 选中一个节点。
   *
   * 点文件夹：选中并把它那层撑开 / 收起（展开态归界面的 expandedKeys 管，
   * 这里只动选中）；点视频：选中并立刻打开播放。
   */
  function select(rel: string): void {
    const node = findVideoNode(nodes.value, rel)
    activeRel.value = rel
    openError.value = ''

    if (!node || node.kind === 'folder')
      return
    // 独立窗口播着时，树上挑别的只切那扇窗口：主窗口这边不再起第二个播放器
    if (detached.value) {
      void openInDetached(node)
      return
    }
    void open(node)
  }

  /** 授权并打开一个视频（快一步回来的旧结果直接丢掉：连点两个视频时只有最后一个算数） */
  async function open(node: VideoNode, autoplay = true): Promise<void> {
    const job = (openJob += 1)
    const result = await window.workbench.loadVideo(root.value, node.rel)
    if (job !== openJob)
      return

    if (!result.ok || !result.data) {
      active.value = null
      openError.value = result.error ?? '打开视频失败'
      return
    }

    openError.value = ''
    autoplayNext.value = autoplay
    active.value = result.data
    // 记下「上次打开的文件」：进页面时直接接上（与树展开态同一批行为记忆，落盘走设置）
    void settings.updateSettings({ videoLastRel: node.rel })
  }

  /**
   * 独立窗口播着时在树上挑别的：先授权并转出 URL，再让窗口换过去。
   * 主窗口这边同步 active / 选中项 / 上次打开，但不渲染 `<video>` —— 播放权在窗口那边。
   */
  async function openInDetached(node: VideoNode): Promise<void> {
    const job = (detachJob += 1)
    const result = await window.workbench.loadVideo(root.value, node.rel)
    if (job !== detachJob)
      return
    if (!result.ok || !result.data) {
      openError.value = result.error ?? '打开视频失败'
      // 树上的高亮退回还在播的那一个：换失败不该让选中项指向一个没在播的视频
      activeRel.value = active.value?.rel ?? ''
      return
    }

    active.value = result.data
    void settings.updateSettings({ videoLastRel: node.rel })
    const command: VideoWindowCommand = {
      action: 'load',
      source: result.data,
      rate: rate.value,
      time: 0,
      playing: true,
      playlist: playlist.value,
    }
    const sent = await window.workbench.sendVideoWindowCommand(command)
    if (job !== detachJob)
      return
    if (!sent.ok) {
      detachedClosed()
      openError.value = sent.error ?? '独立视频窗口没有响应'
    }
  }

  /** 点「在独立窗口播放」：只置意图 —— 真正读当前秒数并开窗的是播放器（它拿着 `<video>`） */
  function requestDetach(): void {
    if (!active.value || detached.value)
      return
    floatRequested.value = false
    openError.value = ''
    detachedRequest.value = true
  }

  /** 播放器开窗失败：撤掉意图（提示由它自己说，不进 openError —— 视频还在正常播） */
  function detachFailed(): void {
    detachedRequest.value = false
  }

  /** 窗口开起来了：主窗口卸掉自己的 `<video>`，播放权交给独立窗口 */
  function detachOpened(): void {
    detachedRequest.value = false
    detached.value = true
    floatRequested.value = false
    resume.value = null
  }

  /** 独立窗口自动接下一部：跟着它更新当前视频 / 速率 / 「上次打开」 */
  function detachedActive(source: VideoSource, rateValue: number): void {
    active.value = source
    activeRel.value = source.rel
    rate.value = clampVideoRate(rateValue)
    void settings.updateSettings({ videoLastRel: source.rel })
  }

  function detachedRate(value: number): void {
    rate.value = clampVideoRate(value)
  }

  /** 窗口收回：播放权交回主窗口，等它按 resume 落回同一秒 */
  function detachedDocked(payload: { source: VideoSource, rate: number, time: number, playing: boolean }): void {
    detachJob += 1
    rate.value = clampVideoRate(payload.rate)
    active.value = payload.source
    activeRel.value = payload.source.rel
    detached.value = false
    floatRequested.value = false
    resume.value = { time: payload.time, playing: payload.playing }
    void settings.updateSettings({ videoLastRel: payload.source.rel })
  }

  /** 窗口被关掉（不是收回）：停止播放，主窗口清空 */
  function detachedClosed(): void {
    if (!detached.value && !detachedRequest.value)
      return
    detachJob += 1
    detached.value = false
    detachedRequest.value = false
    resume.value = null
    active.value = null
    openError.value = ''
    floatRequested.value = false
  }

  /** 收回后播放器来取要落的那一秒（取完即清，避免下一次换视频误用） */
  function consumeResume(): { time: number, playing: boolean } | null {
    const value = resume.value
    resume.value = null
    return value
  }

  /** 主窗口主动收回：让窗口自己报告时间并关掉；窗口已经没了就按已关闭处理 */
  async function dockDetached(): Promise<void> {
    const result = await window.workbench.sendVideoWindowCommand({ action: 'dock' })
    if (!result.ok)
      detachedClosed()
  }

  /** 主窗口主动停掉独立窗口（换目录等）；窗口已经没了就按已关闭处理 */
  async function closeDetached(): Promise<void> {
    const result = await window.workbench.sendVideoWindowCommand({ action: 'close' })
    if (!result.ok)
      detachedClosed()
  }

  /**
   * 换视频 / 清空时把播放器那份收起来（重试打开同一个文件走 open）。
   * 独立窗口开着时连它一起关掉 —— 换了目录 / 停了播放，窗口继续播旧文件只会让人困惑。
   */
  function closeVideo(): void {
    detachJob += 1
    if (detached.value)
      void closeDetached()
    detached.value = false
    detachedRequest.value = false
    resume.value = null
    active.value = null
    openError.value = ''
    floatRequested.value = false
  }

  /** 点「悬浮播放」：把手上的视频浮成小窗带走（没有正播的视频时那颗按钮不在） */
  function requestFloat(): void {
    // 两件事互相排斥：从别处点悬浮时，别再让播放器去开独立窗口
    detachedRequest.value = false
    floatRequested.value = true
  }

  /** 收回悬浮：进视频页、小窗上点「回到视频页」、停播都走这里 */
  function dockFloat(): void {
    floatRequested.value = false
  }

  return {
    root,
    rootName,
    recentRoots,
    rate,
    floatRequested,
    nodes,
    activeRel,
    active,
    autoplayNext,
    detached,
    detachedRequest,
    playlist,
    activeChain,
    videoCount,
    loading,
    loaded,
    loadError,
    openError,
    init,
    reload,
    setRoot,
    forgetRoot,
    select,
    closeVideo,
    requestFloat,
    dockFloat,
    requestDetach,
    detachFailed,
    detachOpened,
    detachedActive,
    detachedRate,
    detachedDocked,
    detachedClosed,
    consumeResume,
    dockDetached,
  }
})
