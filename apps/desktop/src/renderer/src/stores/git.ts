import type { GitChangedFile, GitCommit } from '@workbench/git'
import type { GitCommitDetail, GitCompare, GitPatch, GitRepoInfo, GitTreePage, Result } from '@/types'
import { pushRepoHistory, sanitizeGitRepoRoot } from '@workbench/git'
import { defineStore } from 'pinia'
/**
 * Git 页：一个用户自己打开的仓库、它的提交历史、目录树与差异。
 *
 * 与视频 / 笔记 store 同一条骨架：这里没有仓库内容的内存副本 —— 提交、文件、补丁
 * 都是**按需现问 git**（打开仓库时读第一页提交与分支清单，选文件时读文件历史，选提交时读
 * 改动清单，选文件时读补丁）。落盘的只有「上次打开的那个文件夹」与「最近打开的文件夹清单」
 * （设置里的 `gitRepo` / `gitRepos`，可能只是仓库里的子目录），都是本机路径、不参与外观同步。
 *
 * 三条不能破：
 *  - **只读**：这里调用的通道全部是读命令（见 workbench/git.ts 与 repo_git.rs），
 *    没有任何暂存 / 提交 / 切工作区的入口；「切换分支」只是换 `log` / `ls-tree` 的 ref，
 *    `viewBranch` 为空串时仍跟着 HEAD；
 *  - **一次只认一个来源**：右侧差异要么是「某个提交」，要么是「两个提交的对比」，
 *    两者不会同时显示；选中新的提交 / 开始新的对比时旧的那份立刻清掉；
 *  - **慢一步回来的结果丢掉**：每个异步动作带自己的令牌，连点两个文件 / 提交时
 *    只有最后一个算数（与视频 store 同一条）。
 */
import { computed, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'

/** 一页提交多少条：50 条足够铺满一屏，滚动到底再要下一页 */
const PAGE_SIZE = 50

export const useGitStore = defineStore('git', () => {
  const settings = useSettingsStore()

  /** 当前打开的仓库；null = 还没打开 */
  const repo = ref<GitRepoInfo | null>(null)
  /** 用户打开的那个文件夹：可能是仓库里的子目录，最近打开清单存它，进页面也按它恢复 */
  const openPath = ref('')
  const opening = ref(false)
  /** 打开失败的原因：仓库被移动 / 不是一个 git 仓库 / 没装 git */
  const openError = ref('')

  /** 本地分支清单（只用于换「看哪条分支」，不切工作区） */
  const branches = ref<string[]>([])
  const branchesLoading = ref(false)

  /** 正在看的分支短名：空串 = 跟着 HEAD（仓库当前分支） */
  const viewBranch = ref('')

  /**
   * 当前提交列表属于谁：空串 = 整个仓库（HEAD），否则是某个文件的路径。
   * 它同时决定中间那栏的标题与「返回仓库历史」那颗按钮出不出来。
   */
  const historyPath = ref('')

  /**
   * 提交列表的时间范围（`YYYY-MM-DD`，本地日历上的两天，任一端可以是空串 = 那一侧不限）：
   * null = 完全没筛。只给 `git log --since/--until` 用；换仓库时清空，换文件 / 换分支 / 刷新都保留。
   */
  const historyRange = ref<{ since: string, until: string } | null>(null)

  const commits = ref<GitCommit[]>([])
  const commitsLoading = ref(false)
  const commitsError = ref('')
  const commitsHasMore = ref(false)
  /** 至少成功取过一页：空态据此决定要不要说「还没有提交」 */
  const commitsLoaded = ref(false)

  /** 右侧：单个提交 + 它改动的文件 */
  const detail = ref<GitCommitDetail | null>(null)
  const detailLoading = ref(false)
  const detailError = ref('')

  /** 右侧：任意两个提交的对比 */
  const compareBase = ref<GitCommit | null>(null)
  const compareTarget = ref<GitCommit | null>(null)
  const compare = ref<GitCompare | null>(null)
  const compareLoading = ref(false)
  const compareError = ref('')

  /** 当前正在看的那个改动文件（右侧文件清单里选中的） */
  const selectedFile = ref('')
  const patch = ref<GitPatch | null>(null)
  const patchLoading = ref(false)
  const patchError = ref('')

  /**
   * 补丁视图：并排（默认）/ 统一。它住在页面状态里而不是补丁组件内部 ——
   * 切提交时右栏文件清单会短暂清空、补丁组件被卸载重建，状态放在组件里就会弹回默认。
   * 换仓库 / 换页也保持用户刚选的那一档；重启应用回到默认。
   */
  const patchView = ref<'unified' | 'split'>('split')

  let openJob = 0
  let branchJob = 0
  let historyJob = 0
  let detailJob = 0
  let compareJob = 0
  let patchJob = 0

  const root = computed(() => repo.value?.root ?? '')
  /** 用户选中的目录相对仓库根的位置（空串 = 仓库根）；左栏目录树只展开这个子树 */
  const scope = computed(() => repo.value?.scope ?? '')
  const hasRepo = computed(() => repo.value !== null)
  const isFileHistory = computed(() => historyPath.value !== '')
  /** 头部那颗分支 chip 显示的名字：正在看的分支，没单独选过就是仓库当前分支 */
  const shownBranch = computed(() => viewBranch.value || repo.value?.branch || '')
  /** 正在看的分支不是仓库当前分支（只读浏览，工作区没被切换） */
  const viewingOtherBranch = computed(() =>
    Boolean(viewBranch.value) && viewBranch.value !== repo.value?.branch,
  )
  /** 头部下拉里的「最近打开的仓库」：最近打开的在前 */
  const recentRepos = computed(() => settings.settings.gitRepos)

  /** 右侧当前的改动清单：对比优先（两者不会同时有值） */
  const activeFiles = computed(() => compare.value?.files ?? detail.value?.files ?? [])
  const activeBase = computed(() => compare.value?.base ?? detail.value?.base ?? '')
  const activeTarget = computed(() => compare.value?.target ?? detail.value?.hash ?? '')
  const activeLoading = computed(() => compareLoading.value || detailLoading.value)
  const activeError = computed(() => compareError.value || detailError.value)
  const activeTruncated = computed(() =>
    compare.value?.filesTruncated ?? detail.value?.filesTruncated ?? false,
  )
  /** 右侧标题：对比时写两头的短号，单个提交时写标题 */
  const activeTitle = computed(() => {
    if (compare.value) {
      return `${compare.value.base.slice(0, 7)} → ${compare.value.target.slice(0, 7)}`
    }
    return detail.value?.subject || ''
  })

  /**
   * 三个 reset 都把自己的令牌推一格：清掉数据的同时，也让**已经发出去、还没回来**的那一次
   * 作废（否则切走之后旧结果仍会写进新视图）。调用方随后发起的新请求再推一格，两次都无害。
   */
  function resetHistory(): void {
    historyJob += 1
    commits.value = []
    commitsError.value = ''
    commitsHasMore.value = false
    commitsLoaded.value = false
    commitsLoading.value = false
  }

  function resetDetail(): void {
    detailJob += 1
    patchJob += 1
    detail.value = null
    detailError.value = ''
    detailLoading.value = false
    selectedFile.value = ''
    patch.value = null
    patchError.value = ''
    patchLoading.value = false
  }

  function resetCompare(): void {
    compareJob += 1
    compareBase.value = null
    compareTarget.value = null
    compare.value = null
    compareError.value = ''
    compareLoading.value = false
  }

  function resetAll(): void {
    historyPath.value = ''
    resetHistory()
    resetDetail()
    resetCompare()
  }

  /**
   * 右侧默认打开哪个改动文件：优先「当前正在看的历史来源」（左栏点开的那个文件），
   * 它不在这笔改动里时才退回第一个。左栏选的是 bump-version.mjs、右侧却打开
   * CHANGELOG.md，会让人以为点错了。
   */
  function preferredFile(files: GitChangedFile[]): string {
    if (!files.length)
      return ''
    if (historyPath.value && files.some(file => file.path === historyPath.value))
      return historyPath.value
    return files[0].path
  }

  /**
   * 打开一个仓库（选中的可以是仓库里的子目录，宿主会回仓库根）。
   * 成功之后把仓库根写回设置并排进「最近打开」，下次进页面直接接上。
   * `rev` 只给刷新用：刷新时尽量保住原来正在看的那条分支。
   */
  async function open(path: string, rev = ''): Promise<void> {
    const value = path.trim()
    if (!value)
      return

    const job = (openJob += 1)
    const previousPath = openPath.value
    opening.value = true
    openError.value = ''

    const result = await window.workbench.openGitRepo(value)
    if (job !== openJob)
      return
    opening.value = false

    if (!result.ok || !result.data) {
      openError.value = result.error ?? '打开仓库失败'
      return
    }

    repo.value = result.data
    openPath.value = sanitizeGitRepoRoot(value)
    // 换了一个文件夹才清掉时间范围；刷新同一个仓库时保留筛选
    if (openPath.value.toLowerCase() !== previousPath.toLowerCase())
      historyRange.value = null
    branchJob += 1
    branches.value = []
    viewBranch.value = ''
    // 落盘的是**用户选中的那个文件夹**（可能只是仓库里的一个子目录），不是仓库根：
    // 下次从这里恢复时目录树还按同一个子树展开；顺手排到最近打开的最前面
    void settings.updateSettings({
      gitRepo: openPath.value,
      gitRepos: pushRepoHistory(settings.settings.gitRepos, openPath.value),
    })
    resetAll()
    await loadBranches()
    // 刷新时原来那支还在就继续看它；已经被删掉就退回 HEAD
    if (rev && branches.value.includes(rev))
      viewBranch.value = rev
    // 空仓库也走一次：loadHistory 会把它当成「已加载、零条」，中间那栏因此显示空态，
    // 而不是停在「还没开始加载」的空白上。
    await loadHistory(true)
  }

  /** 读一遍本地分支清单；失败只让下拉空着，不影响看历史 */
  async function loadBranches(): Promise<void> {
    if (!repo.value) {
      branches.value = []
      return
    }
    const job = (branchJob += 1)
    branchesLoading.value = true
    const result = await window.workbench.listGitBranches(root.value)
    if (job !== branchJob)
      return
    branchesLoading.value = false
    branches.value = result.ok && result.data ? result.data.branches : []
  }

  /**
   * 换「看哪条分支」：只换中间与右侧的数据来源，**不切工作区**。
   * `historyPath` 保留 —— 从文件历史切过去时继续看同一个文件（新分支上没有它，
   * 历史列表照实回空）。
   */
  async function switchBranch(name: string): Promise<void> {
    if (!repo.value)
      return
    if (name && !branches.value.includes(name))
      return
    if (name === viewBranch.value)
      return
    viewBranch.value = name
    resetHistory()
    resetDetail()
    resetCompare()
    await loadHistory(true)
  }

  /** 文件夹选择器 → 打开。取消返回 null，不是失败。 */
  async function choose(): Promise<void> {
    const path = await window.workbench.pickDirectory('选择 Git 仓库', settings.settings.gitRepo || undefined)
    if (path)
      await open(path)
  }

  /** 进页面时接上上次打开的仓库；打不开只记一句，不把设置里的路径清掉 */
  async function restore(): Promise<void> {
    if (repo.value || opening.value)
      return
    const saved = settings.settings.gitRepo || settings.settings.gitRepos[0] || ''
    if (saved)
      await open(saved)
  }

  /** 重新读一遍当前仓库（新提交、别的窗口改了仓库之后用）；保住正在看的分支与子树 */
  async function refresh(): Promise<void> {
    const current = repo.value
    if (!current)
      return
    await open(openPath.value || current.root, viewBranch.value)
  }

  /**
   * 取一页提交。`reset` 为真时从第一条开始（切仓库 / 切文件），否则接着当前列表往后翻。
   * 空仓库、还没打开仓库时直接回空，不起 git。
   */
  async function loadHistory(reset: boolean): Promise<void> {
    if (!repo.value || repo.value.empty) {
      resetHistory()
      commitsLoaded.value = true
      return
    }

    const job = (historyJob += 1)
    const skip = reset ? 0 : commits.value.length
    commitsLoading.value = true
    commitsError.value = ''

    const since = historyRange.value?.since ?? ''
    const until = historyRange.value?.until ?? ''
    const result = historyPath.value
      ? await window.workbench.listGitFileCommits(root.value, historyPath.value, viewBranch.value, since, until, skip, PAGE_SIZE)
      : await window.workbench.listGitCommits(root.value, viewBranch.value, since, until, skip, PAGE_SIZE)

    if (job !== historyJob)
      return
    commitsLoading.value = false

    if (!result.ok || !result.data) {
      commitsError.value = result.error ?? '读取提交记录失败'
      return
    }

    commits.value = reset ? result.data.commits : [...commits.value, ...result.data.commits]
    commitsHasMore.value = result.data.hasMore
    commitsLoaded.value = true
  }

  async function loadMore(): Promise<void> {
    if (!commitsHasMore.value || commitsLoading.value)
      return
    await loadHistory(false)
  }

  /** 重新拉当前这一页（出错后的「重试」用） */
  async function reloadHistory(): Promise<void> {
    await loadHistory(true)
  }

  /**
   * 设 / 清提交列表的时间范围（`YYYY-MM-DD`，两端都可为空串；两端都空 = 不限）。
   * 换了范围就从头取一页，右侧详情与对比一起收掉（它们不一定落在新范围里）。
   */
  async function setHistoryRange(range: { since: string, until: string } | null): Promise<void> {
    if (!repo.value)
      return
    const next = range && (range.since || range.until) ? range : null
    if (next?.since === historyRange.value?.since && next?.until === historyRange.value?.until)
      return
    historyRange.value = next
    resetHistory()
    resetDetail()
    resetCompare()
    await loadHistory(true)
  }

  /** 中间那栏切回整个仓库的历史 */
  async function showRepoHistory(): Promise<void> {
    if (!historyPath.value)
      return
    historyPath.value = ''
    resetHistory()
    resetDetail()
    resetCompare()
    await loadHistory(true)
  }

  /** 中间那栏只看某个文件的历史 */
  async function showFileHistory(path: string): Promise<void> {
    if (!path || path === historyPath.value)
      return
    historyPath.value = path
    resetHistory()
    resetDetail()
    resetCompare()
    await loadHistory(true)
  }

  /**
   * 选中一个提交：右侧显示它相对第一父提交的改动。
   * 正在对比时选中提交 = 退出对比，进单个提交。
   */
  async function selectCommit(commit: GitCommit): Promise<void> {
    if (!repo.value)
      return
    resetCompare()
    resetDetail()

    const job = (detailJob += 1)
    detailLoading.value = true
    detailError.value = ''

    const result = await window.workbench.loadGitCommit(root.value, commit.hash)
    if (job !== detailJob)
      return
    detailLoading.value = false

    if (!result.ok || !result.data) {
      detailError.value = result.error ?? '读取提交详情失败'
      return
    }

    detail.value = result.data
    const path = preferredFile(result.data.files)
    if (path)
      await selectFile(path)
  }

  /**
   * 对比任意两个提交：
   *  - 还没有基准 → 这一下是选基准；
   *  - 已有基准、还没有目标 → 这一下选目标并立刻取差异；
   *  - 已经比完 → 再点一下从这一条重新开始选基准。
   * 同一个提交再点一次 = 取消基准。
   */
  async function pickCompare(commit: GitCommit): Promise<void> {
    if (compareBase.value?.hash === commit.hash && !compareTarget.value) {
      resetCompare()
      return
    }
    if (!compareBase.value) {
      compareBase.value = commit
      resetDetail()
      return
    }
    if (!compareTarget.value) {
      compareTarget.value = commit
      await loadCompare()
      return
    }
    // 上一轮比完 / 还在加载：整组收掉（resetCompare 会作废在途的那一次），从这一条重新选基准
    resetCompare()
    compareBase.value = commit
    resetDetail()
  }

  async function loadCompare(): Promise<void> {
    const base = compareBase.value
    const target = compareTarget.value
    if (!base || !target || !repo.value)
      return

    const job = (compareJob += 1)
    // 上一轮的对比结果先收掉：新的一轮还没回来时，右侧显示的是「正在读取」，不是旧的两笔
    compare.value = null
    compareLoading.value = true
    compareError.value = ''
    resetDetail()

    const result = await window.workbench.compareGitCommits(root.value, base.hash, target.hash)
    if (job !== compareJob)
      return
    compareLoading.value = false

    if (!result.ok || !result.data) {
      compareError.value = result.error ?? '对比提交失败'
      return
    }

    compare.value = result.data
    const path = preferredFile(result.data.files)
    if (path)
      await selectFile(path)
  }

  function clearCompare(): void {
    resetCompare()
    resetDetail()
  }

  /**
   * 取一个改动文件的补丁。`base` / `target` 在调用时取当前右侧的身份，
   * 不依赖「稍后可能已经变了」的 computed。
   */
  async function selectFile(path: string): Promise<void> {
    const base = activeBase.value
    const target = activeTarget.value
    if (!repo.value || !path || !target)
      return

    selectedFile.value = path
    patch.value = null
    patchError.value = ''
    const job = (patchJob += 1)
    patchLoading.value = true

    const result = await window.workbench.loadGitPatch(root.value, base, target, path)
    if (job !== patchJob)
      return
    patchLoading.value = false

    if (!result.ok || !result.data) {
      patchError.value = result.error ?? '读取文件差异失败'
      return
    }
    patch.value = result.data
  }

  /**
   * 目录树一层的读取。树本身由 `el-tree` 管（展开态、选中态都在组件里），
   * 这里只把「去问 git」这一步收在 store，组件不直接碰通道。
   */
  async function loadTree(dir: string): Promise<Result<GitTreePage>> {
    if (!repo.value)
      return { ok: false, error: '还没有打开仓库' }
    return window.workbench.listGitTree(root.value, dir, viewBranch.value)
  }

  return {
    repo,
    root,
    openPath,
    scope,
    hasRepo,
    opening,
    openError,
    branches,
    branchesLoading,
    viewBranch,
    shownBranch,
    viewingOtherBranch,
    recentRepos,
    historyPath,
    historyRange,
    isFileHistory,
    commits,
    commitsLoading,
    commitsError,
    commitsHasMore,
    commitsLoaded,
    detail,
    detailLoading,
    detailError,
    compareBase,
    compareTarget,
    compare,
    compareLoading,
    compareError,
    selectedFile,
    patch,
    patchLoading,
    patchError,
    patchView,
    activeFiles,
    activeBase,
    activeTarget,
    activeLoading,
    activeError,
    activeTruncated,
    activeTitle,
    open,
    choose,
    restore,
    refresh,
    loadBranches,
    switchBranch,
    loadMore,
    reloadHistory,
    showRepoHistory,
    showFileHistory,
    setHistoryRange,
    selectCommit,
    pickCompare,
    clearCompare,
    selectFile,
    loadTree,
  }
})
