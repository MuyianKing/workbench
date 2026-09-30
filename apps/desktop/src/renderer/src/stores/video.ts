/**
 * 视频：一个**用户自己挑的文件夹**，以及它里面的目录树与正在播放的那一个。
 *
 * 与笔记 store 同一条骨架：这里没有内存副本，树是扫出来的、视频是按文件交给
 * webview 自己读的（asset 协议），落盘的只有四样「行为记忆」——选的哪个目录、
 * 打开过哪几个、树摊开了哪几层、**上次打开的是哪个视频**（进页面直接接上，都在设置里，
 * 见 shared/video.ts 的文件头）。这一层只负责编排：谁被选中、什么时候读盘、
 * 换了目录把旧的那份收起来。
 *
 * 两条不能破：
 *   - **没选文件夹就什么都不做**：`root` 空串时界面上是一句引导（VideoView）；
 *   - **打开的那一个只有一个来源**：选中与打开是同一件事 —— 点树上的视频就是
 *     立刻播它，点文件夹只是选中并切换展开态；恢复上次的那个是唯一的例外
 *     （只加载不播，见 `autoplayNext`）。
 *
 * 播放本身的状态（进度、暂停、速率的实际值）只活在 VideoView 里：它不跨页共享，
 * 页面被 KeepAlive 包着，切走再回来播放还在原地，不需要一份全局状态。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  countVideos,
  findVideoNode,
  pushVideoHistory,
  removeFromVideoHistory,
  sanitizeVideoRoot,
  videoChain,
  videoRootName,
  type VideoNode,
  type VideoSource
} from '@workbench/video'
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

  const videoCount = computed(() => countVideos(nodes.value))
  /** 选中项从最外层到自身的链；界面拿它写「它在哪一层」 */
  const activeChain = computed(() =>
    activeRel.value ? videoChain(nodes.value, activeRel.value) : []
  )

  function reset(): void {
    nodes.value = []
    activeRel.value = ''
    active.value = null
    loaded.value = false
    loadError.value = ''
    openError.value = ''
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
    if (job !== scanJob) return
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
    if (ready) return
    if (!pending) {
      pending = reload().finally(() => {
        pending = null
      })
    }
    await pending

    // 首次进页面且扫成功了：把「上次打开的那个」接上（首次扫描失败时不清记录，下次进来还能接）
    if (ready) void restoreLast()
  }

  /**
   * 恢复上一次打开的视频：树里还有它才接上，没有（被删 / 改名 / 记录是旧目录的）
   * 就把记录清掉 —— 留着只会每次进页面都空找一遍。
   * 它所在的那几层文件夹一起撑开，否则视频在播、树里却找不到它高亮在哪。
   */
  async function restoreLast(): Promise<void> {
    if (active.value) return

    const rel = settings.settings.videoLastRel
    if (!rel) return

    const node = findVideoNode(nodes.value, rel)
    if (!node || node.kind !== 'video') {
      void settings.updateSettings({ videoLastRel: '' })
      return
    }

    const folders = videoChain(nodes.value, rel)
      .slice(0, -1)
      .map((item) => item.id)
    if (folders.length) {
      await settings.updateSettings({
        videoTreeExpanded: [...new Set([...settings.settings.videoTreeExpanded, ...folders])]
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
    if (!target) return false

    return settings.updateSettings({
      videoDir: target,
      videoDirs: pushVideoHistory(settings.settings.videoDirs, target),
      // 展开态与「上次打开的文件」都只对上一个目录成立：存的是相对路径，
      // 换到另一个目录就指向完全不同的东西了。一起清掉，新目录从收起状态开始
      videoTreeExpanded: [],
      videoLastRel: ''
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
      videoDirs: removeFromVideoHistory(settings.settings.videoDirs, dir)
    })
  }

  // 设置里的视频文件夹一改就重新扫（首次选的目录、换一个目录、清空都走这里）；
  // 选中的与正播的都收起来 —— 它们的相对路径与授权都属于上一个目录，留着只会让人困惑
  watch(root, () => {
    if (!started) return
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

    if (!node || node.kind === 'folder') return
    void open(node)
  }

  /** 授权并打开一个视频（快一步回来的旧结果直接丢掉：连点两个视频时只有最后一个算数） */
  async function open(node: VideoNode, autoplay = true): Promise<void> {
    const job = (openJob += 1)
    const result = await window.workbench.loadVideo(root.value, node.rel)
    if (job !== openJob) return

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

  /** 换视频 / 清空时把播放器那份收起来（重试打开同一个文件走 open） */
  function closeVideo(): void {
    active.value = null
    openError.value = ''
  }

  return {
    root,
    rootName,
    recentRoots,
    rate,
    nodes,
    activeRel,
    active,
    autoplayNext,
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
    closeVideo
  }
})
