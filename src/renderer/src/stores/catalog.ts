/**
 * 两样「点一下就跑」的东西：快捷启动（常用软件）与独立命令。
 *
 * 它们放在一起，是因为对界面而言它们是同一类条目（首页上并排的两块卡片：增删改 + 拖排序 +
 * 弹窗编辑），只是「跑了之后归不归 Workbench 管」不同 —— 快捷启动走 ShellExecute，
 * 进程不归我们；命令由 Workbench 接管，所以它有自己的运行态、终端与日志。
 *
 * 命令的启停与检测走 terminal store 里的统一实现（项目与命令在那三件事上是一回事）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  CommandEntry,
  CommandInput,
  CommandPatch,
  QuickApp,
  QuickAppInput,
  QuickAppList,
  QuickAppPatch
} from '@/types'
import { notifyError, notifySuccess } from '@/notify'
import { useTerminalStore, type ProcessTarget } from './terminal'

export const useCatalogStore = defineStore('catalog', () => {
  const terminal = useTerminalStore()

  // ---------- 快捷启动（常用软件） ----------

  /** 首页那排常用软件；顺序就是用户拖出来的顺序 */
  const quickApps = ref<QuickApp[]>([])
  /** 启动项 id -> 程序是否已经不在原路径上（主进程每次列表现算，不落盘） */
  const quickMissing = ref<Record<string, boolean>>({})
  /** 程序路径 -> 图标 data URL；只在内存里留一份，重开应用由系统重新取 */
  const quickIcons = ref<Record<string, string>>({})
  const quickDialogVisible = ref(false)
  /** 正在编辑的启动项 id；null 表示「新增」 */
  const quickDialogId = ref<string | null>(null)

  const quickEditing = computed(() =>
    quickDialogId.value
      ? quickApps.value.find((item) => item.id === quickDialogId.value) ?? null
      : null
  )

  function openQuickDialog(id?: string): void {
    quickDialogId.value = id ?? null
    quickDialogVisible.value = true
  }

  function closeQuickDialog(): void {
    quickDialogVisible.value = false
  }

  function setQuickDialogVisible(value: boolean): void {
    quickDialogVisible.value = value
  }

  /**
   * 清掉「上次没取到图标」的空位。
   *
   * 取不到图标时会在表里留一个空串占位，免得每帧都重问一遍；但那个失败可能只是一时的
   * （程序刚装好、快捷方式刚被修好）。列表一旦重新拉取就丢掉这些空位，
   * 让图标在下一帧自己长回来，不用重启应用。
   */
  function dropFailedIcons(): void {
    const next: Record<string, string> = {}
    for (const [target, dataUrl] of Object.entries(quickIcons.value)) {
      if (dataUrl) next[target] = dataUrl
    }
    quickIcons.value = next
  }

  async function refreshQuickApps(): Promise<void> {
    const list: QuickAppList = await window.workbench.listQuickApps()
    dropFailedIcons()
    quickApps.value = list.apps
    quickMissing.value = list.missing
  }

  function applyQuickApps(list: QuickAppList): void {
    dropFailedIcons()
    quickApps.value = list.apps
    quickMissing.value = list.missing
  }

  /** 图标请求只发一次：同一个程序被加两次也只取一张 */
  const iconPending = new Set<string>()

  async function loadQuickIcon(target: string): Promise<void> {
    if (quickIcons.value[target] !== undefined || iconPending.has(target)) return
    iconPending.add(target)
    try {
      const result = await window.workbench.quickAppIcon(target)
      // 取不到图标不算错误（有些文件本来就没有图标，程序也可能刚被删）：
      // 界面用首字母兜底，不值得为它弹一个提示。空串表示「问过了，别再问」
      quickIcons.value = {
        ...quickIcons.value,
        [target]: result.ok && result.data ? result.data : ''
      }
    } finally {
      iconPending.delete(target)
    }
  }

  /** 组件取图标：第一次问的时候顺手去取，取回来之前先用首字母顶着 */
  function quickIconOf(target: string): string {
    const cached = quickIcons.value[target]
    if (cached === undefined) {
      void loadQuickIcon(target)
      return ''
    }
    return cached
  }

  function isQuickAppMissing(id: string): boolean {
    return quickMissing.value[id] === true
  }

  async function addQuickApp(input: QuickAppInput): Promise<boolean> {
    const result = await window.workbench.addQuickApp(input)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '添加失败')
      return false
    }

    quickApps.value = [...quickApps.value, result.data]
    quickMissing.value[result.data.id] = false
    notifySuccess(`已添加 ${result.data.name}`)
    return true
  }

  async function updateQuickApp(id: string, patch: QuickAppPatch): Promise<boolean> {
    const result = await window.workbench.updateQuickApp(id, patch)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '保存失败')
      return false
    }

    const index = quickApps.value.findIndex((item) => item.id === id)
    if (index !== -1) quickApps.value[index] = result.data
    // 路径可能被换成了另一个程序，失效标记得重算
    void refreshQuickApps()
    return true
  }

  async function removeQuickApp(id: string): Promise<void> {
    const entry = quickApps.value.find((item) => item.id === id)
    const result = await window.workbench.removeQuickApp(id)
    if (!result.ok) {
      notifyError(result.error ?? '移除失败')
      return
    }

    quickApps.value = quickApps.value.filter((item) => item.id !== id)
    notifySuccess(entry ? `已移除 ${entry.name}` : '已移除')
  }

  /** 拖动排序：先本地生效再落盘，失败整份回滚（与分组排序同一套） */
  async function reorderQuickApps(ids: string[]): Promise<void> {
    const snapshot = quickApps.value.slice()
    const byId = new Map(quickApps.value.map((item) => [item.id, item]))
    quickApps.value = ids
      .map((id) => byId.get(id))
      .filter((item): item is QuickApp => !!item)
      .map((item, index) => ({ ...item, order: index }))

    const result = await window.workbench.reorderQuickApps(ids)
    if (!result.ok || !result.data) {
      quickApps.value = snapshot
      notifyError(result.error ?? '保存顺序失败')
      return
    }
    quickApps.value = result.data
  }

  /**
   * 启动一个常用软件。
   *
   * 成功后主进程会把整个列表推回来（最近使用时间变了），界面只需给一句反馈；
   * 失败多半是程序被移动或删除，顺手刷新失效标记。
   */
  async function launchQuickApp(id: string): Promise<void> {
    const entry = quickApps.value.find((item) => item.id === id)
    const result = await window.workbench.launchQuickApp(id)
    if (!result.ok) {
      notifyError(result.error ?? '启动失败')
      void refreshQuickApps()
      return
    }
    notifySuccess(`已启动 ${entry?.name ?? '程序'}`)
  }

  // ---------- 首页「命令」卡片 ----------

  /**
   * 命令列表；顺序就是创建顺序（这块只有增删改，不做拖动排序）。
   * 每条命令的进程由 Workbench 接管，所以它的运行态照样记在 runtimes 里、日志照样进终端面板。
   */
  const commands = ref<CommandEntry[]>([])
  const commandDialogVisible = ref(false)
  /** 正在编辑的命令 id；null 表示「新增」 */
  const commandDialogId = ref<string | null>(null)

  const commandEditing = computed(() =>
    commandDialogId.value
      ? commands.value.find((item) => item.id === commandDialogId.value) ?? null
      : null
  )

  function openCommandDialog(id?: string): void {
    commandDialogId.value = id ?? null
    commandDialogVisible.value = true
  }

  function closeCommandDialog(): void {
    commandDialogVisible.value = false
  }

  function setCommandDialogVisible(value: boolean): void {
    commandDialogVisible.value = value
  }

  function findCommand(id: string): CommandEntry | undefined {
    return commands.value.find((item) => item.id === id)
  }

  async function refreshCommands(): Promise<void> {
    commands.value = await window.workbench.listCommands()
  }

  /** 同 addProject：会经 IPC 传输，必须转成普通对象 */
  async function addCommand(input: CommandInput): Promise<boolean> {
    const result = await window.workbench.addCommand({
      name: input.name,
      command: input.command,
      port: input.port
    })
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '添加失败')
      return false
    }

    commands.value = [...commands.value, result.data]
    terminal.runtimeOf(result.data.id)
    notifySuccess(`已添加 ${result.data.name}`)
    return true
  }

  async function updateCommand(id: string, patch: CommandPatch): Promise<boolean> {
    const result = await window.workbench.updateCommand(id, { ...patch })
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '保存失败')
      return false
    }

    const index = commands.value.findIndex((item) => item.id === id)
    if (index !== -1) commands.value[index] = result.data
    return true
  }

  /**
   * 删除一条命令。
   * 主进程会先停掉还在跑的进程 —— 条目一删，它的终端与停止入口就都没了。
   */
  async function removeCommand(id: string): Promise<void> {
    const entry = findCommand(id)
    const result = await window.workbench.removeCommand(id)
    if (!result.ok) {
      notifyError(result.error ?? '删除失败')
      return
    }

    commands.value = commands.value.filter((item) => item.id !== id)
    delete terminal.runtimes[id]
    terminal.dropTerminalsOf(id)
    notifySuccess(entry ? `已删除 ${entry.name}` : '已删除')
  }

  /** 一条命令在「检测 / 停止」眼里的样子（与项目的差别只有这四句文案） */
  function targetOf(entry: CommandEntry): ProcessTarget {
    return {
      id: entry.id,
      name: entry.name,
      subject: '命令',
      noPortHint: '这条命令没有配置监听端口，无法检测运行状态',
      busyHint: '命令正在运行，无需检测'
    }
  }

  /** 启动一条命令：端口占用按项目那套先处理掉，再交给主进程拉起进程 */
  async function startCommand(id: string): Promise<void> {
    const entry = findCommand(id)
    if (!entry) return

    const rt = terminal.runtimeOf(id)
    if (!(await terminal.ensurePortFree(entry.port ?? rt.port, rt))) return

    terminal.focusTerminal(id, 'command')
    const result = await window.workbench.startCommand(id)
    if (!result.ok) notifyError(result.error ?? '启动失败')
  }

  /** 停止一条命令；外部启动的那种按端口结束，先确认一次 */
  function stopCommand(id: string): Promise<boolean> {
    const entry = findCommand(id)
    if (!entry) return Promise.resolve(false)

    return terminal.stopTarget(targetOf(entry), () => window.workbench.stopCommand(id))
  }

  /** 检测一条命令是否已经在运行（判据是端口占用，实现见 terminal store） */
  function detectCommand(id: string, options: { silent?: boolean } = {}): Promise<boolean> {
    const entry = findCommand(id)
    if (!entry) return Promise.resolve(false)

    return terminal.detectTarget({ ...targetOf(entry), port: entry.port }, options)
  }

  /** 启动应用后做一次全量检测：命令可能是在 Workbench 之外启动、至今还跑着的 */
  async function detectAllCommands(): Promise<void> {
    const targets = commands.value.filter((item) => item.port)
    await Promise.all(targets.map((item) => detectCommand(item.id, { silent: true })))
  }

  /** 清空（数据目录被整份换掉时用） */
  function reset(): void {
    commands.value = []
  }

  /** 启动常用软件后主进程会推整份列表（最近使用时间变了），失效标记也一并刷新 */
  function installListeners(): void {
    window.workbench.onQuickApps(applyQuickApps)
  }

  return {
    // 快捷启动
    quickApps,
    quickDialogVisible,
    closeQuickDialog,
    setQuickDialogVisible,
    quickEditing,
    openQuickDialog,
    refreshQuickApps,
    quickIconOf,
    isQuickAppMissing,
    addQuickApp,
    updateQuickApp,
    removeQuickApp,
    reorderQuickApps,
    launchQuickApp,
    // 命令
    commands,
    commandDialogVisible,
    closeCommandDialog,
    setCommandDialogVisible,
    commandEditing,
    openCommandDialog,
    refreshCommands,
    findCommand,
    addCommand,
    updateCommand,
    removeCommand,
    startCommand,
    stopCommand,
    detectCommand,
    detectAllCommands,
    reset,
    installListeners
  }
})
