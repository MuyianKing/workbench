/**
 * 项目与分组：列表、筛选排序、搜索、抽屉与「添加项目」，以及项目的启停打包。
 *
 * 这个 store 曾经有 2600 行、装下十来个不相干的领域。现在按领域拆开之后，
 * 这里只剩「项目」本身，其余各归各家：
 *   - 终端 / 运行态 / 日志 → `terminal.ts`
 *   - 设置 / 外观 / 首页布局 → `settings.ts`
 *   - 包管理器 / nvm / nrm / 数据目录 → `environment.ts`
 *   - 快捷启动 / 命令 → `catalog.ts`
 *   - 账号 → `auth.ts`
 *
 * 它同时是**启动编排的落点**（`init`）：各 store 的事件订阅、首屏取数与几项后台探测
 * 都在这里按顺序发起，因为它们之间的先后顺序是有讲究的（外观必须先落地）。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { backfillProjectColors as backfillColors } from '@shared/project-color'
import {
  PROJECT_HIT_LIMIT,
  searchProjects,
  projectMatchesKeyword,
  type SearchGroup
} from '@shared/search'
import { fallbackView, sanitizeViewId, type ViewId } from '@shared/views'
import { sanitizeProjectSort, type ProjectSort } from '@shared/project-sort'
import type {
  ActivityCounts,
  AddProjectInput,
  PackageManager,
  Project,
  ProjectGroup,
  ProjectPatch
} from '@/types'
import { statusLabel } from '@/status'
import { notifyError, notifySuccess, notifyWarning, confirmAction } from '@/notify'
import { useSettingsStore } from './settings'
import { useTerminalStore, RUNNING_STATUS, type ProcessTarget } from './terminal'
import { useCatalogStore } from './catalog'
import { useEnvironmentStore } from './environment'
import { useAuthStore } from './auth'

/** 未分组项目在筛选栏里的伪分组 id */
export const UNGROUPED = 'ungrouped'

/** 今天 00:00 的时间戳（本地时区） */
function startOfToday(): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export const useProjectsStore = defineStore('projects', () => {
  const settingsStore = useSettingsStore()
  const terminal = useTerminalStore()
  const catalog = useCatalogStore()
  const environment = useEnvironmentStore()

  const projects = ref<Project[]>([])
  const groups = ref<ProjectGroup[]>([])
  const ready = ref(false)
  /** 项目目录是否仍然存在；尚未检查过的项目按有效处理 */
  const pathValidity = ref<Record<string, boolean>>({})
  /** 按天聚合的命令执行次数，首页活跃度图的数据源；每次执行结束后由主进程推着刷新 */
  const activity = ref<ActivityCounts>({})

  const keyword = ref('')
  const groupFilter = ref<string>('all')

  /**
   * 排序方式（行为记忆）：初值来自设置，之后跟着设置走。
   *
   * 设置是异步载入的、数据目录还可能被整份换掉，所以这里要核一遍 ——
   * 与下面 activeView 是同一条路。它**不是**「这台机器长什么样」的配置，
   * 所以住在数据文件里、不进 theme.json（见 shared/types.ts 的那一段）。
   */
  const sortBy = ref<ProjectSort>(sanitizeProjectSort(settingsStore.settings.projectSort))

  watch(
    () => settingsStore.settings.projectSort,
    (value) => {
      sortBy.value = sanitizeProjectSort(value)
    },
    { immediate: true }
  )

  /**
   * 从搜索结果跳过来时要点名的那张项目卡（画一圈定位环、滚到它）。
   *
   * 一次性提示：筛选条件一变就作废 —— 用户已经在自己筛了，还留着上一轮的环
   * 只会让人以为「这张卡有什么特别」。sync 是必须的：jumpToProject 会在同一次
   * 同步流程里先复位分组、再写这个值，异步的 watcher 会把刚写进去的值又清掉。
   */
  const focusProjectId = ref<string | null>(null)

  watch(
    [keyword, groupFilter],
    () => {
      focusProjectId.value = null
    },
    { flush: 'sync' }
  )

  /** 筛选/排序状态只经 action 变更，模板里不再直接赋值，非法值也无从写进来 */
  function setGroupFilter(value: string): void {
    groupFilter.value = value
  }

  /**
   * 换排序方式：就地生效并落盘（下次打开还停在这一档）。
   *
   * 与切页写 activeView 同一条路 —— 顺序会立刻重排，写入在后台跑，
   * 失败由 updateSettings 统一提示。相同值直接返回：不值得为一次没变化的点击写一次文件。
   */
  function setSortBy(value: ProjectSort): void {
    if (value === sortBy.value) return
    sortBy.value = value
    void settingsStore.updateSettings({ projectSort: value })
  }

  const drawerProjectId = ref<string | null>(null)
  const addDialogVisible = ref(false)

  function openAddDialog(): void {
    addDialogVisible.value = true
  }

  function closeAddDialog(): void {
    addDialogVisible.value = false
  }

  /**
   * 当前页（左侧导航栏的当前项）。
   *
   * 不引入 Vue Router：换页就是换这个 id，App.vue 用 <KeepAlive><component :is> 渲染，
   * 各页的滚动位置由 KeepAlive 保住。值会落盘，重启后回到上次那一页。
   */
  const activeView = ref<ViewId>(sanitizeViewId(settingsStore.settings.activeView))

  // 设置是异步载入的，跟着它核一遍
  watch(
    () => settingsStore.settings.activeView,
    (value) => {
      activeView.value = sanitizeViewId(value)
    },
    { immediate: true }
  )

  /**
   * 当前页被设置里关掉之后退到第一页可见的。
   *
   * 盯的是「关掉了哪几页」这个字符串而不是那个数组本身：设置在别处每改一项都会换掉整个
   * settings 对象（数组也是新的），按引用比会每次都被唤起来 —— 那样连搜索跳转
   * （jumpToProject 会把当前页设成项目页）也会被立刻弹回去，看起来像点了没反应。
   * 只在**关掉的那几页真的变了**、且当前页正好在其中时才换页，这才是用户刚做完的那个动作。
   */
  watch(
    () => settingsStore.settings.hiddenViews.join(','),
    () => {
      const hidden = settingsStore.settings.hiddenViews
      if (!hidden.includes(activeView.value)) return

      const next = fallbackView(hidden)
      applyView(next)
      void settingsStore.updateSettings({ activeView: next })
    },
    { immediate: true }
  )

  /** 是否处于首页布局编辑态：由首页顶栏那颗「编辑布局」进入，画布上的「完成」退出 */
  const layoutEditing = ref(false)

  function setLayoutEditing(value: boolean): void {
    layoutEditing.value = value
    // 布局只有首页有得编辑（入口在首页顶栏，但键盘 / 以后别的入口不一定，这里统一兜住），
    // 进编辑态先切回首页，免得顶栏变成了编辑条、面前却没有画布
    if (value && activeView.value !== 'home') {
      applyView('home')
      void settingsStore.updateSettings({ activeView: 'home' })
    }
  }

  /** 切页的共同部分：布局编辑只对首页画布有意义，切走时收掉 */
  function applyView(value: ViewId): void {
    activeView.value = value
    if (value !== 'home') layoutEditing.value = false
  }

  async function setActiveView(value: ViewId): Promise<void> {
    if (value === activeView.value) return

    applyView(value)
    focusProjectId.value = null
    await settingsStore.updateSettings({ activeView: value })
  }

  /**
   * 从搜索结果跳到一个项目：切到项目页、把那张卡圈出来并滚进视野，**不带筛选**。
   *
   * 跳过去看到的是一份完整列表 + 一个定位环，而不是「按刚才那个词筛过一遍」的列表，
   * 所以两处筛选都要复位：
   *  - 关键词：搜索框与项目页的筛选是同一个值，不清掉的话页面照样是按它筛过的；
   *  - 分组：matchesFilter 在非「全部」的分组下会直接忽略关键词（先按分组 return），
   *    不清掉的话用户停在某个分组上时，目标项目可能根本不在列表里 —— 环就没地方可挂。
   * `focusProjectId` 要在两者之后写：它被这两个值的同步 watcher 清掉（见它的注释）。
   */
  function jumpToProject(id: string): void {
    if (!findProject(id)) return

    keyword.value = ''
    groupFilter.value = 'all'
    focusProjectId.value = id

    if (activeView.value !== 'projects') {
      applyView('projects')
      void settingsStore.updateSettings({ activeView: 'projects' })
    }
  }

  /**
   * 驱动运行时长的时钟，以及「今天 00:00」。
   *
   * dayStart 只在跨天时变一次 —— 活跃度图的横轴末端是今天，
   * 每秒重铺 371 个格子没必要，跨过零点重算一次就够。
   */
  const clock = ref(Date.now())
  const dayStart = ref(startOfToday())
  window.setInterval(() => {
    const now = Date.now()
    clock.value = now
    const today = startOfToday()
    if (today !== dayStart.value) dayStart.value = today
  }, 1000)

  // ---------- 初始化 ----------

  let initialized = false

  async function init(): Promise<void> {
    if (initialized) return
    initialized = true

    await loadData()
    installListeners()

    // 系统状态卡片要的这几项探测不挡首屏：它们各自要起子进程（npm / yarn / pnpm --version）
    // 与扫一遍 nvm 目录，加起来几百毫秒到几秒，而首屏只关心项目列表。让它们自己跑，
    // 回来再填进卡片就行 —— 挡在这里纯属白等。
    environment.refreshAll()
    ready.value = true
    snapshotProjects()
    // 老数据文件里的项目还没有标识色，补齐（顺序有讲究，见函数注释）
    backfillProjectColors()

    void refreshPaths()
    // 项目可能在上次关闭后、或在 Workbench 之外已经跑起来了，进应用先按端口认一遍
    void detectAll()
    // 命令卡片同理：它连日志都可能没有（在外面启动的），只能靠端口认
    void catalog.detectAllCommands()
    // 账号状态只读凭据管理器，很快；顶栏的头像要靠它才会在首帧之后补上
    void useAuthStore().refreshAuth()
    // 目录与程序都可能在应用之外被移动/删除，窗口重新获得焦点时复查一次
    window.addEventListener('focus', () => {
      void refreshPaths()
      void catalog.refreshQuickApps()
    })
  }

  /** 各 store 自己关心的事件各自订阅，这里只挂两条跨领域的 */
  function installListeners(): void {
    terminal.installListeners()
    settingsStore.installListeners()
    catalog.installListeners()
    environment.installListeners()

    // 主进程更新了项目（执行记录、最近使用时间），同步回本地列表
    window.workbench.onProjectChanged(onProjectChanged)
    // 数据目录切换后整份重新加载：项目 ID 可能整套换掉，旧终端与选中态都不再成立
    window.workbench.onDataReload(() => void reloadAfterDataMove())
  }

  /** 拉一次项目 / 分组 / 设置 / 数据位置 */
  async function loadData(): Promise<void> {
    const data = await window.workbench.listProjects()
    projects.value = data.projects
    groups.value = data.groups
    for (const project of data.projects) terminal.runtimeOf(project.id)

    // 外观先落地。主题与首页布局决定界面长什么样，必须排在一串与外观无关的调用前面 ——
    // 排到后面的话，用户会先看见默认外观、几十到几百毫秒后才被换成自己的设置。
    // 首屏快照是启动那一瞬的值（数据目录可能在启动后被换过），所以这里仍照当前值核一遍。
    await settingsStore.loadAppearance()

    // 其余与外观无关，并行拉完即可。
    const [, counts] = await Promise.all([
      environment.loadLocation(),
      window.workbench.getActivity(),
      catalog.refreshQuickApps(),
      catalog.refreshCommands()
    ])
    activity.value = counts
    for (const item of catalog.commands) terminal.runtimeOf(item.id)
  }

  /** 重新拉一次活跃度计数（命令跑完、数据目录切换后调用） */
  async function refreshActivity(): Promise<void> {
    activity.value = await window.workbench.getActivity()
  }

  async function reloadAfterDataMove(): Promise<void> {
    terminal.resetAll()
    drawerProjectId.value = null
    catalog.reset()

    await loadData()
    for (const project of projects.value) terminal.runtimeOf(project.id)
    snapshotProjects()
    // 换过来的数据目录里可能是一份没有标识色的老数据（与 init 同一条顺序）
    backfillProjectColors()
    await refreshPaths()
    await detectAll()
    await catalog.detectAllCommands()
  }

  /** 主进程更新了项目（执行记录、最近使用时间），同步回本地列表 */
  function onProjectChanged(updated: Project): void {
    const index = projects.value.findIndex((p) => p.id === updated.id)
    if (index === -1) return

    // 先更新落盘快照，避免这次同步又被 watcher 推回主进程
    pushedSnapshot.set(updated.id, JSON.stringify(editableOf(updated)))
    projects.value[index] = updated
    // 这条推送也意味着刚有一条命令跑完，活跃度计数随之 +1
    void refreshActivity()
  }

  // ---------- 项目与分组 ----------

  function findProject(id: string): Project | undefined {
    return projects.value.find((p) => p.id === id)
  }

  /** 同一分组内是否已有同名项目（规则：允许重复，但要给提示） */
  function hasDuplicateName(
    name: string,
    groupId: string | undefined,
    excludeId?: string
  ): boolean {
    const target = name.trim().toLowerCase()
    if (!target) return false
    return projects.value.some(
      (p) =>
        p.id !== excludeId &&
        p.name.trim().toLowerCase() === target &&
        (p.groupId ?? undefined) === (groupId ?? undefined)
    )
  }

  /** 改完显示名后调用，重复时只提示不阻断 */
  function warnIfDuplicateName(project: Project): void {
    if (hasDuplicateName(project.name, project.groupId, project.id)) {
      notifyWarning('同一分组下已有同名项目，建议改用更易区分的显示名')
    }
  }

  /** 拖拽 / 下拉改分组：真正的落盘交给 projects 的深度 watch */
  function assignGroup(id: string, groupId: string | undefined): void {
    const project = findProject(id)
    if (!project) return
    if ((project.groupId ?? undefined) === (groupId ?? undefined)) return

    project.groupId = groupId
    notifySuccess(groupId ? `已移入「${groupName(groupId)}」` : '已移出分组')
  }

  async function addProject(input: AddProjectInput): Promise<boolean> {
    // IPC 走结构化克隆，reactive 代理无法被克隆，跨进程前先转成普通对象
    const payload: AddProjectInput = {
      path: input.path,
      name: input.name,
      groupId: input.groupId,
      serve: input.serve,
      build: [...input.build],
      defaultBuild: input.defaultBuild,
      port: input.port,
      // 「仅管理目录」的放行标志，漏掉它会让勾选项静默失效
      allowInvalid: input.allowInvalid
    }

    const result = await window.workbench.addProject(payload)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '添加项目失败')
      return false
    }
    projects.value.push(result.data)
    terminal.runtimeOf(result.data.id)
    pathValidity.value[result.data.id] = true
    notifySuccess(`已添加 ${result.data.name}`)
    if (hasDuplicateName(result.data.name, result.data.groupId, result.data.id)) {
      notifyWarning('同一分组下已有同名项目，建议改用更易区分的显示名')
    }
    return true
  }

  /**
   * 移除项目。确认框在这里而不是调用方：项目卡与详情抽屉两个入口共用同一句话，
   * 各写一遍迟早会分叉（原先就是两份逐字重复的确认框）。
   */
  async function removeProject(id: string): Promise<void> {
    const project = findProject(id)
    const agreed = await confirmAction(
      `确定把「${project?.name ?? '该项目'}」从列表中移除？磁盘上的项目文件不会被删除。`,
      '移除项目',
      { confirmButtonText: '移除' }
    )
    if (!agreed) return

    const result = await window.workbench.removeProject(id)
    if (!result.ok) {
      notifyError(result.error ?? '移除失败')
      return
    }
    const index = projects.value.findIndex((p) => p.id === id)
    if (index !== -1) projects.value.splice(index, 1)
    delete terminal.runtimes[id]
    delete pathValidity.value[id]
    terminal.dropTerminalsOf(id)
    if (drawerProjectId.value === id) drawerProjectId.value = null
    if (focusProjectId.value === id) focusProjectId.value = null
    notifySuccess('已从列表移除')
  }

  /** 按 order 排好的分组；筛选栏、抽屉下拉、管理弹窗都用这一份 */
  const sortedGroups = computed(() =>
    [...groups.value].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  )

  /** 拖动排序：先本地生效再落盘，失败则整份回滚 */
  async function reorderGroups(ids: string[]): Promise<void> {
    const snapshot = groups.value.slice()
    const byId = new Map(groups.value.map((group) => [group.id, group]))
    groups.value = ids
      .map((id) => byId.get(id))
      .filter((group): group is ProjectGroup => !!group)
      .map((group, index) => ({ ...group, order: index }))

    const result = await window.workbench.reorderGroups(ids)
    if (!result.ok || !result.data) {
      groups.value = snapshot
      notifyError(result.error ?? '保存分组顺序失败')
      return
    }
    groups.value = result.data
  }

  /** 创建分组，成功时返回新分组，便于调用方直接选中 */
  async function createGroup(name: string): Promise<ProjectGroup | null> {
    const result = await window.workbench.createGroup(name)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '创建分组失败')
      return null
    }
    groups.value.push(result.data)
    return result.data
  }

  /** 重命名分组，成功返回 true */
  async function renameGroup(id: string, name: string): Promise<boolean> {
    const result = await window.workbench.renameGroup(id, name)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '重命名分组失败')
      return false
    }
    const index = groups.value.findIndex((g) => g.id === id)
    if (index !== -1) groups.value[index] = result.data
    return true
  }

  async function removeGroup(id: string): Promise<void> {
    const result = await window.workbench.removeGroup(id)
    if (!result.ok) {
      notifyError(result.error ?? '删除分组失败')
      return
    }
    groups.value = groups.value.filter((g) => g.id !== id)
    for (const project of projects.value) {
      if (project.groupId === id) project.groupId = undefined
    }
    if (groupFilter.value === id) groupFilter.value = 'all'
  }

  // ---------- 配置变更自动落盘 ----------

  /** 同 addProject：patch 会经 IPC 传输，必须转成普通对象 */
  function editableOf(project: Project): ProjectPatch {
    return {
      name: project.name,
      packageManager: project.packageManager,
      scripts: {
        serve: project.scripts.serve,
        build: [...project.scripts.build],
        defaultBuild: project.scripts.defaultBuild,
        custom: project.scripts.custom?.map((item) => ({
          name: item.name,
          command: item.command
        }))
      },
      outputDir: project.outputDir ?? '',
      autoOpenExplorer: project.autoOpenExplorer,
      // 未选择时送空串而不是 undefined：结构化克隆后键仍在，主进程才能识别「清空」
      nodeVersion: project.nodeVersion ?? '',
      port: project.port ?? null,
      groupId: project.groupId,
      color: project.color
    }
  }

  /**
   * 给还没有标识色的项目补一个（老数据文件里没有这个字段）。
   *
   * **必须排在 snapshotProjects() 之后调用**：补出来的颜色要靠下面那条「配置变更自动落盘」的
   * watch 推给后端，而它只推「与快照不同」的项目 —— 顺序反过来的话，快照里记的已经是补好的值，
   * 这批颜色就永远写不进磁盘了（下次启动又补一遍，界面上看不出问题，但一直白补）。
   *
   * 是就地改 `projects.value`：这条路径本来就是这个 store 改项目的写法（见 editableOf 上面那段）。
   */
  function backfillProjectColors(): void {
    const patch = backfillColors(projects.value)
    for (const project of projects.value) {
      const color = patch[project.id]
      if (color) project.color = color
    }
  }

  const pushedSnapshot = new Map<string, string>()

  function snapshotProjects(): void {
    pushedSnapshot.clear()
    for (const project of projects.value) {
      pushedSnapshot.set(project.id, JSON.stringify(editableOf(project)))
    }
  }

  let pushTimer: number | null = null

  watch(
    projects,
    () => {
      if (!ready.value) return
      if (pushTimer) window.clearTimeout(pushTimer)
      pushTimer = window.setTimeout(() => {
        pushTimer = null
        for (const project of projects.value) {
          const next = JSON.stringify(editableOf(project))
          if (pushedSnapshot.get(project.id) === next) continue
          pushedSnapshot.set(project.id, next)
          void window.workbench.updateProject(project.id, editableOf(project))
        }
      }, 400)
    },
    { deep: true }
  )

  // ---------- 操作 ----------

  async function guardProject(id: string): Promise<Project | null> {
    const project = findProject(id)
    if (!project) return null

    if (!isPathValid(id)) {
      notifyError('项目目录不存在，请先重新定位')
      return null
    }

    if (project.manageOnly) {
      notifyError('该项目是「仅管理目录」，package.json 不可用，无法执行命令')
      return null
    }

    // 选了 nvm 版本就必须真的装了，否则命令会悄悄跑在系统 node 上
    const wantedNode = project.nodeVersion?.trim()
    if (wantedNode && environment.nvm && !environment.installedNodeVersion(wantedNode)) {
      notifyError(`未在 nvm 中找到 Node v${wantedNode}，请在项目详情「环境」里重新选择`)
      return null
    }

    const pm = resolvedPm(project)
    if (environment.packageManagers && !environment.packageManagers[pm]) {
      notifyError(`未检测到 ${pm}，请先安装并确保它在系统 PATH 中`)
      return null
    }
    return project
  }

  /**
   * 一个项目在「检测 / 停止」眼里的样子。
   *
   * 与命令的差别只有这四句文案 —— 检测与停止的实现是同一份（见 terminal store 的
   * detectTarget / stopTarget），拆开之前两边是两段各 45 行的镜像代码。
   */
  function targetOf(project: Project): ProcessTarget {
    return {
      id: project.id,
      name: project.name,
      subject: '项目',
      noPortHint: '未配置监听端口，请先在项目详情里填写',
      busyHint: '项目正在执行 Workbench 启动的命令，无需检测'
    }
  }

  async function install(id: string): Promise<void> {
    const project = await guardProject(id)
    if (!project) return
    terminal.focusTerminal(id, 'install')
    const result = await window.workbench.install(id)
    if (!result.ok) notifyError(result.error ?? '安装依赖失败')
  }

  async function start(id: string): Promise<void> {
    const project = await guardProject(id)
    if (!project) return

    // Node 版本不满足只提示不阻断（F-9.3）
    const node = await window.workbench.checkNodeVersion(id)
    if (!node.ok) {
      notifyWarning(`项目要求 Node ${node.required}，当前为 ${node.actual}，启动可能失败`)
    }

    // 先看项目配置的监听端口，其次用本次会话里从启动日志识别到的那个。
    // 两个都没有就静默跳过 —— 不知道端口就无从检测占用。
    const rt = terminal.runtimeOf(id)
    if (!(await terminal.ensurePortFree(project.port ?? rt.port, rt))) return

    terminal.focusTerminal(id, 'start')
    const result = await window.workbench.start(id)
    if (!result.ok) notifyError(result.error ?? '启动失败')
  }

  async function build(id: string, script?: string): Promise<void> {
    const project = await guardProject(id)
    if (!project) return

    const target = script ?? project.scripts.defaultBuild ?? project.scripts.build[0]
    if (!target) {
      notifyWarning('未配置打包命令，请在项目详情中选择')
      return
    }

    terminal.focusTerminal(id, 'build')
    const result = await window.workbench.build(id, target)
    if (!result.ok) notifyError(result.error ?? '打包失败')
  }

  /** 停止项目；外部启动的那种按端口结束，先确认一次（实现见 terminal store） */
  function stop(id: string): Promise<boolean> {
    const project = findProject(id)
    if (!project) return Promise.resolve(false)

    // 卡片显示的是哪一类操作就停哪一类：一个项目可以同时挂着 dev server 和一次打包
    const kind = terminal.runtimeOf(id).kind
    return terminal.stopTarget(targetOf(project), () => window.workbench.stop(id, kind))
  }

  /** 检测项目是否已经在运行（判据是端口占用，实现见 terminal store） */
  function detect(id: string, options: { silent?: boolean } = {}): Promise<boolean> {
    const project = findProject(id)
    if (!project) return Promise.resolve(false)

    return terminal.detectTarget({ ...targetOf(project), port: project.port }, options)
  }

  /** 启动应用后做一次全量检测：项目可能是在 Workbench 之外启动、至今还跑着的 */
  async function detectAll(): Promise<void> {
    const targets = projects.value.filter((project) => project.port)
    await Promise.all(targets.map((project) => detect(project.id, { silent: true })))
  }

  /** 执行项目配置里的第 index 条自定义命令（F-2.6） */
  async function runCustom(id: string, index: number): Promise<void> {
    const project = await guardProject(id)
    if (!project) return

    const command = project.scripts.custom?.[index]
    if (!command) {
      notifyWarning('该自定义命令已不存在')
      return
    }

    terminal.focusTerminal(id, `custom:${index}`)
    const result = await window.workbench.runCustom(id, index)
    if (!result.ok) notifyError(result.error ?? `执行「${command.name}」失败`)
  }

  /** 重启：停止并等进程真正退出后再启动，不再靠固定延时赌时序 */
  async function restart(id: string): Promise<void> {
    const rt = terminal.runtimes[id]
    if (rt && RUNNING_STATUS.includes(rt.status)) {
      if (rt.external) {
        // 外部进程没有退出事件可等，结束成功与否看 stop 的返回值
        if (!(await stop(id))) return
      } else {
        await window.workbench.stop(id, rt.kind)
        if (!(await terminal.waitForIdle(id))) {
          notifyError('停止超时，请稍后再试')
          return
        }
      }
    }
    await start(id)
  }

  async function reveal(targetPath: string): Promise<void> {
    const result = await window.workbench.reveal(targetPath)
    if (!result.ok) notifyError(result.error ?? '打开目录失败')
  }

  async function openInVSCode(targetPath: string): Promise<void> {
    const result = await window.workbench.openInVSCode(targetPath)
    if (!result.ok) notifyError(result.error ?? '打开 VS Code 失败')
  }

  // ---------- 路径有效性 ----------

  /** 未检查过的项目按有效处理，避免首帧误禁用 */
  function isPathValid(id: string): boolean {
    return pathValidity.value[id] !== false
  }

  async function refreshPaths(): Promise<void> {
    if (!projects.value.length) {
      pathValidity.value = {}
      return
    }
    pathValidity.value = await window.workbench.checkProjectPaths()
  }

  /** 目录被移动或删除后重新选择位置，并重新识别命令/包管理器 */
  async function relocate(id: string): Promise<void> {
    const project = findProject(id)
    if (!project) return

    const picked = await window.workbench.pickDirectory()
    if (!picked) return

    const result = await window.workbench.relocateProject(id, picked)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '重新定位失败')
      return
    }

    const index = projects.value.findIndex((p) => p.id === id)
    if (index !== -1) {
      // 同 onProjectChanged：先登记快照，避免这次替换被 watch 当成用户编辑推回主进程
      pushedSnapshot.set(id, JSON.stringify(editableOf(result.data)))
      projects.value[index] = result.data
    }
    pathValidity.value[id] = true
    notifySuccess(`已重新定位到 ${result.data.path}`)
  }

  function openDrawer(id: string): void {
    drawerProjectId.value = id
  }

  function closeDrawer(): void {
    drawerProjectId.value = null
  }

  // ---------- 派生数据 ----------

  function resolvedPm(project: Project): PackageManager {
    return project.packageManager === 'auto'
      ? project.detectedPackageManager
      : project.packageManager
  }

  function groupName(groupId?: string): string {
    if (!groupId) return '未分组'
    return groups.value.find((g) => g.id === groupId)?.name ?? '未分组'
  }

  /** 「运行中」筛选标签上的计数：只数项目，不含独立命令（那是命令卡片的事） */
  const runningCount = computed(
    () => projects.value.filter((p) => terminal.runtimes[p.id]?.status === 'running').length
  )

  /** 关键词口径与搜索结果共用一份实现（见 shared/search.ts），两边各写一套就会对不上 */
  function matchesFilter(project: Project): boolean {
    if (groupFilter.value === 'running') return terminal.runtimes[project.id]?.status === 'running'
    if (groupFilter.value === UNGROUPED) return !project.groupId
    if (groupFilter.value !== 'all') return project.groupId === groupFilter.value
    return projectMatchesKeyword(project, keyword.value)
  }

  /**
   * 展示顺序的快照键：项目集合 + 排序方式。
   *
   * 故意不含 lastUsedAt —— 否则点一下「启动」，那张卡片立刻跳到第一位，看着像列表被改动了。
   * 只有切换排序方式、增删项目、或重启应用时，才按最新的最近使用时间重排。
   */
  const orderKey = computed(() => `${sortBy.value}|${projects.value.map((p) => p.id).join(',')}`)

  const displayOrder = ref<string[]>([])

  watch(
    orderKey,
    () => {
      const list = projects.value.slice()
      if (sortBy.value === 'recent') {
        list.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      } else if (sortBy.value === 'name') {
        list.sort((a, b) => a.name.localeCompare(b.name))
      } else {
        list.sort((a, b) => a.createdAt - b.createdAt)
      }
      displayOrder.value = list.map((p) => p.id)
    },
    // sync：避免筛选条件变化后出现一帧旧顺序
    { immediate: true, flush: 'sync' }
  )

  /** 按展示顺序排好的全部项目（不筛）；搜索结果与筛选列表都从它出发 */
  const orderedProjects = computed(() => {
    const byId = new Map(projects.value.map((p) => [p.id, p]))
    const list: Project[] = []
    for (const id of displayOrder.value) {
      const project = byId.get(id)
      if (project) list.push(project)
    }
    return list
  })

  /** 顺序取快照，筛选仍然实时生效（运行状态、关键词、分组都是即时反映的） */
  const filteredProjects = computed(() => orderedProjects.value.filter(matchesFilter))

  /** 搜索结果那行尾部的小字：与卡片上的状态标签同一口径（目录失效优先） */
  function searchDetailOf(project: Project): string {
    if (!isPathValid(project.id)) return '路径无效'
    const rt = terminal.runtimes[project.id]
    return statusLabel(rt?.status ?? 'idle', rt?.kind)
  }

  /**
   * 顶部搜索框的结果，按来源分组。
   *
   * 今天只有「项目」一个来源（面板此时不画分组标题，画了像半成品）；
   * 以后接进命令 / 快捷启动，就是往这个数组里多塞一组，面板本身不用改。
   * 没有命中就不返回任何组 —— 面板据此判断「弹不弹」。
   */
  const searchGroups = computed<SearchGroup[]>(() => {
    const group = searchProjects(
      orderedProjects.value,
      keyword.value,
      PROJECT_HIT_LIMIT,
      searchDetailOf
    )
    return group.hits.length ? [group] : []
  })

  const drawerProject = computed(() =>
    drawerProjectId.value ? findProject(drawerProjectId.value) ?? null : null
  )

  return {
    projects,
    groups,
    sortedGroups,
    ready,
    activity,
    clock,
    dayStart,
    keyword,
    groupFilter,
    sortBy,
    setGroupFilter,
    setSortBy,
    focusProjectId,
    searchGroups,
    filteredProjects,
    runningCount,
    drawerProjectId,
    drawerProject,
    addDialogVisible,
    openAddDialog,
    closeAddDialog,
    activeView,
    setActiveView,
    applyView,
    jumpToProject,
    layoutEditing,
    setLayoutEditing,
    init,
    findProject,
    addProject,
    removeProject,
    assignGroup,
    reorderGroups,
    createGroup,
    renameGroup,
    removeGroup,
    warnIfDuplicateName,
    install,
    start,
    build,
    stop,
    restart,
    detect,
    runCustom,
    reveal,
    openInVSCode,
    isPathValid,
    refreshPaths,
    relocate,
    openDrawer,
    closeDrawer,
    resolvedPm,
    groupName,
    refreshActivity
  }
})
