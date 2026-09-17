/**
 * `window.workbench` 的 Tauri 实现。
 *
 * 这一层替代了 Electron 主进程 + preload：preload 已随 Electron 一起删除，
 * 而渲染层仍然只认同一个契约，所以 78 处调用一行都不用改。
 *
 * 尚未移植的通道由 `createApi` 的兜底接管：返回 `Result` 形状的失败值并打一次警告，
 * 界面降级成空态而不是崩掉 —— 迁移期间的缺口因此可见、可控。
 * 通道补齐后应当去掉兜底（那时 `as` 断言也就不需要了）。
 */
import { parsePort } from '@shared/port'
import { nextProjectColor } from '@shared/project-color'
import { samePath } from '@shared/project-path'
import { fail, ok } from '@shared/result'
import type {
  AddProjectInput,
  AppSettings,
  AuthProvider,
  BackgroundImage,
  BuiltinWallpaper,
  CommandEntry,
  DataLocation,
  DataLocationPick,
  EffectiveTheme,
  InstallablePackageManager,
  Project,
  Result,
  ThemeConfig,
  WindowState,
  WorkbenchApi
} from '@shared/types'
import { assetUrl, guard, hasTauri, invoke, listen, notPorted } from './bridge'
import { emit } from './events'
import * as events from './events'
import * as auth from './auth'
import * as note from './note'
import * as nrm from './nrm'
import * as nvm from './nvm'
import * as orphan from './orphan'
import * as quick from './quick-launch'
import * as scanner from './scanner'
import * as session from './session'
import * as state from './state'
import * as system from './system'
import * as workLog from './work-log'
import { getTokenUsage, getTokenUsageSnapshot, listSyncDevices, syncTokenUsage } from './token'

/**
 * 把设置里的 system 解析成实际明暗
 */
function resolveTheme(theme: AppSettings['theme']): EffectiveTheme {
  if (theme === 'light' || theme === 'dark') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/**
 * 当前该用的同步仓库地址：**没登录一律当没填**。
 *
 * 同步的凭据来自账号，所以未登录时既不推也不拉，界面上的数字全部出自本机（别人机器上
 * 读回来的分片也一并撤掉，见 token.ts 的 syncLocalShards）。设置里的地址不动它 ——
 * 登录回来接着用，不必重填一遍。
 */
function syncRepo(): string {
  return state.account() ? state.settings().tokenSyncRepo : ''
}

/**
 * 文件对话框：直接调插件命令，不引 @tauri-apps/plugin-dialog 包
 * （tauri.conf.json 里开了 withGlobalTauri，走 __TAURI__ 即可）。
 */
async function openDialog(options: Record<string, unknown>): Promise<string | null> {
  const selected = await invoke<string | string[] | null>('plugin:dialog|open', { options })
  if (typeof selected === 'string') return selected
  if (Array.isArray(selected)) return selected[0] ?? null
  return null
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']

/** 设置里内置壁纸的引用前缀，与 shared 侧的约定一致 */
const BUILTIN_PREFIX = 'builtin:'

/** 内置壁纸的缩略图：面板里就那么点大 */
const THUMBNAIL_MAX_EDGE = 320
const THUMBNAIL_QUALITY = 75

/** 内置壁纸的 id 就是文件名主干；写进设置的引用串为 builtin:<id> */
function wallpaperFrom(filePath: string): BuiltinWallpaper {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const id = name.replace(/\.[^.]+$/, '')
  return { id, name, reference: `${BUILTIN_PREFIX}${id}`, thumbnail: '' }
}

/** 内置壁纸引用 → 真实文件路径；清单由 Rust 提供（打包后走 resource_dir，开发态读仓库） */
async function resolveBuiltin(id: string): Promise<string | null> {
  const files = await invoke<string[]>('list_wallpapers')
  return files.find((file) => wallpaperFrom(file).id === id) ?? null
}

const noop = (): void => {}

/**
 * 把设置里的系统集成项落到系统上：开机自启、全局快捷键。
 *
 * 失败只记一笔就够：设置已经存下了，注册不上（被占用、被策略拦）不该连带让改设置这件事失败。
 */
async function syncSystemIntegration(settings: AppSettings): Promise<void> {
  try {
    await invoke('set_autostart', { enabled: settings.launchAtLogin })
  } catch (error) {
    console.warn('[workbench] 设置开机自启失败', error)
  }

  try {
    await invoke('set_hotkey', { accelerator: settings.hotkeyEnabled ? settings.hotkey : null })
  } catch (error) {
    console.warn('[workbench] 注册全局快捷键失败', error)
  }
}

/** 起命令要先找到对象：命令构造在这一层，后端拿不到项目/命令数据 */
function withProject(
  id: string,
  task: (project: Project) => Promise<Result<null>>
): Promise<Result<null>> {
  const project = state.projects().find((item) => item.id === id)
  return project ? task(project) : Promise.resolve(fail('找不到该项目'))
}

function withCommand(
  id: string,
  task: (entry: CommandEntry) => Promise<Result<null>>
): Promise<Result<null>> {
  const entry = state.commandList().find((item) => item.id === id)
  return entry ? task(entry) : Promise.resolve(fail('找不到该命令'))
}

function createApi(): WorkbenchApi {
  const implemented = {
    // Tauri 下没有 Node 版本；Chromium 版本取 WebView2 的 UA。
    versions: {
      node: '—',
      chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '—'
    },

    getBootstrap: () => ({
      theme: resolveTheme(state.initialSettings().theme),
      settings: state.initialSettings(),
      themeConfig: state.initialTheme()
    }),

    // ---------- 项目 ----------
    scanProject: (dirPath: string) =>
      guard(Promise.resolve(scanner.scan(dirPath)), '扫描项目失败'),

    /**
     * 新增项目：校验目录 → 扫描 package.json → 组装并落盘。
     * 组装规则照着 Electron 版 ipc.ts 的 addProject 搬过来（含「仅管理目录」那条分支）。
     */
    addProject: async (input: AddProjectInput): Promise<Result<Project>> => {
      if (!input || typeof input.path !== 'string') return fail('参数不合法')

      const dirPath = input.path.trim()
      if (!(await invoke<boolean>('fs_is_dir', { path: dirPath }))) {
        return fail('目录不存在或不是文件夹')
      }

      // 界面已经拦过一次，这里是兜底：路径写法不同（盘符大小写、斜杠方向）也算同一个目录
      const existing = state.projects().find((project) => samePath(project.path, dirPath))
      if (existing) return fail(`该目录已经添加过了（「${existing.name}」）`)

      const scan = await scanner.scan(dirPath)

      // 解析失败的 package.json 允许以「仅管理目录」的方式加入（设计文档 §7）
      if (!scan.ok && !scan.parseError) return fail(scan.error ?? '项目扫描失败')
      if (scan.parseError && input.allowInvalid !== true) {
        return fail(scan.error ?? 'package.json 解析失败')
      }

      const manageOnly = !scan.ok
      const buildList = Array.isArray(input.build) ? input.build : scan.build
      // 界面上传了端口就用它（用户可能改过或清空），没传才回退到自动识别的结果
      const port = 'port' in input ? parsePort(input.port) : parsePort(scan.port)

      const project: Project = {
        id: crypto.randomUUID(),
        name: input.name?.trim() || scan.name,
        path: dirPath,
        // 标识色：自动取一个当前用得最少的颜色，前五个项目因此两两不同（见 shared/project-color.ts）
        color: nextProjectColor(state.projects().map((item) => item.color)),
        packageManager: 'auto',
        detectedPackageManager: scan.detectedPackageManager,
        framework: scan.framework || 'Node',
        version: scan.version || '0.0.0',
        scripts: {
          serve: input.serve || scan.serve,
          build: manageOnly ? [] : buildList,
          defaultBuild: manageOnly ? undefined : input.defaultBuild || buildList[0]
        },
        outputDir: scan.outputDir ?? '',
        nodeRequirement: scan.enginesNode,
        port,
        autoOpenExplorer: true,
        manageOnly: manageOnly || undefined,
        groupId: input.groupId,
        order: state.projects().length,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      }

      state.addProject(project)
      emit('projectChanged', project)
      return ok(project)
    },

    listProjects: () => Promise.resolve(state.listProjects()),
    updateProject: (id: string, patch: Parameters<WorkbenchApi['updateProject']>[1]) =>
      guard(Promise.resolve(state.updateProject(id, patch)), '更新项目失败'),
    removeProject: (id: string) => {
      state.removeProject(id)
      return Promise.resolve(ok(null))
    },
    relocateProject: (id: string, newPath: string) =>
      guard(Promise.resolve(state.relocateProject(id, newPath)), '重新绑定路径失败'),
    checkProjectPaths: () => state.checkProjectPaths(),

    // ---------- 分组 ----------
    createGroup: (name: string) =>
      guard(Promise.resolve(state.createGroup(name)), '创建分组失败'),
    renameGroup: (id: string, name: string) =>
      guard(Promise.resolve(state.renameGroup(id, name)), '重命名分组失败'),
    removeGroup: (id: string) => {
      state.removeGroup(id)
      return Promise.resolve(ok(null))
    },
    reorderGroups: (ids: string[]) =>
      guard(Promise.resolve(state.reorderGroups(ids)), '重排分组失败'),

    // ---------- 快捷启动 ----------
    // 这几个是数组 / 对象形状的取值接口，必须真实现：落到「未移植」兜底会返回 Result 对象，
    // 而 store 会当数组遍历，直接抛错并把整条 init() 打断（系统状态探测就因此一直没跑起来）。
    listQuickApps: () => state.quickAppList(),
    pickQuickTarget: () =>
      openDialog({
        directory: false,
        multiple: false,
        title: '选择要启动的程序',
        filters: [
          { name: '程序', extensions: ['exe', 'lnk', 'bat', 'cmd'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }),
    addQuickApp: (input: Parameters<WorkbenchApi['addQuickApp']>[0]) =>
      guard(Promise.resolve(state.addQuickApp(input)), '添加快捷启动失败'),
    updateQuickApp: (id: string, patch: Parameters<WorkbenchApi['updateQuickApp']>[1]) =>
      guard(Promise.resolve(state.updateQuickApp(id, patch)), '更新快捷启动失败'),
    removeQuickApp: (id: string) => {
      state.removeQuickApp(id)
      return Promise.resolve(ok(null))
    },
    reorderQuickApps: (ids: string[]) =>
      guard(Promise.resolve(state.reorderQuickApps(ids)), '重排快捷启动失败'),

    /** 启动：走 ShellExecute，进程不归 Workbench 管 */
    launchQuickApp: (id: string) => quick.launch(id),

    /** 取程序图标（data URL）；取不到就失败，界面用首字母兜底 */
    quickAppIcon: (target: string) => quick.icon(target),

    // ---------- 独立命令 ----------
    listCommands: () => Promise.resolve(state.commandList()),
    addCommand: (input: Parameters<WorkbenchApi['addCommand']>[0]) =>
      guard(Promise.resolve(state.addCommand(input)), '添加命令失败'),
    updateCommand: (id: string, patch: Parameters<WorkbenchApi['updateCommand']>[1]) =>
      guard(Promise.resolve(state.updateCommand(id, patch)), '更新命令失败'),
    removeCommand: (id: string) => {
      state.removeCommand(id)
      return Promise.resolve(ok(null))
    },

    // ---------- 工作日志（本地文件，不进同步仓库） ----------
    listWorkLogs: () => workLog.listWorkLogs(),
    addWorkLog: (input: Parameters<WorkbenchApi['addWorkLog']>[0]) => workLog.addWorkLog(input),
    updateWorkLog: (id: string, patch: Parameters<WorkbenchApi['updateWorkLog']>[1]) =>
      workLog.updateWorkLog(id, patch),
    removeWorkLog: (id: string) => workLog.removeWorkLog(id),

    // ---------- 笔记（用户自己挑的一个文件夹里的 markdown 文件） ----------
    listNotes: (root: string) => note.listNotes(root),
    readNote: (root: string, rel: string) => note.readNote(root, rel),
    writeNote: (root: string, rel: string, content: string) => note.writeNote(root, rel, content),
    createNote: (root: string, input: Parameters<WorkbenchApi['createNote']>[1]) =>
      note.createNote(root, input),
    renameNote: (root: string, rel: string, name: string) => note.renameNote(root, rel, name),
    removeNote: (root: string, rel: string) => note.removeNote(root, rel),
    moveNote: (root: string, rel: string, targetDir: string) =>
      note.moveNote(root, rel, targetDir),
    syncNotes: (input: Parameters<WorkbenchApi['syncNotes']>[0]) => note.syncNotes(input),
    uploadNoteImage: (input: Parameters<WorkbenchApi['uploadNoteImage']>[0]) =>
      note.uploadNoteImage(input),
    listNoteImages: (input: Parameters<WorkbenchApi['listNoteImages']>[0]) =>
      note.listNoteImages(input),
    deleteNoteImages: (input: Parameters<WorkbenchApi['deleteNoteImages']>[0]) =>
      note.deleteNoteImages(input),
    scanNoteTexts: (root: string) => note.scanNoteTexts(root),

    // ---------- 统计 ----------
    getActivity: () => Promise.resolve(state.activityCounts()),
    /**
     * Token 用量：实读 + 合并 + 按需同步。
     * 同步仓库地址从设置里现取 —— 用户刚在设置里填完，下一次刷新就该用上新地址。
     */
    getTokenUsage: () => guard(getTokenUsage({ repo: syncRepo() }), '读取 token 用量失败'),
    /** 首屏先手：只读本地那份快照，实读结果随后覆盖它（见 shared/types.ts 的说明） */
    getTokenUsageSnapshot: () =>
      guard(getTokenUsageSnapshot({ repo: syncRepo() }), '读取 token 快照失败'),
    /** 手动同步：绕过自动同步的节流（面板上的同步按钮） */
    syncTokenUsage: () => guard(syncTokenUsage(syncRepo()), '同步 token 用量失败'),
    /**
     * 仓库里的其它机器（含各自的外观配置），设置界面「从别的机器取外观」用。
     * 与上面两个同理，地址从设置现取：用户刚填完就该看到新仓库里的机器。
     */
    listSyncDevices: () => listSyncDevices(syncRepo()),

    // ---------- 设置与布局 ----------
    getSettings: () => Promise.resolve(state.settings()),
    updateSettings: (patch: Partial<AppSettings>) => {
      const next = state.updateSettings(patch)
      // 开机自启与全局快捷键是「设置即系统状态」：改完要立刻落到系统上
      void syncSystemIntegration(next)
      return Promise.resolve(ok(next))
    },
    getThemeConfig: () => Promise.resolve(state.themeConfig()),
    /**
     * 首页布局与外观同一个文件（theme.json），所以改主题也可能改了设置 ——
     * 把合并后的那份推一遍，渲染层的 settings 才会跟着刷新（应用别的机器的配置就走这条路）。
     */
    updateThemeConfig: (patch: Partial<ThemeConfig>) => {
      const next = state.updateThemeConfig(patch)
      emit('settingsChanged', state.settings())
      return Promise.resolve(ok(next))
    },

    // ---------- 背景图 ----------
    pickBackground: () =>
      openDialog({
        directory: false,
        multiple: false,
        title: '选择工作区背景图',
        filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }]
      }),

    /**
     * 取工作区背景图。
     *
     * 只做两件事：把 `builtin:<id>` 解析成真实路径，再让后端把这张图的读取权限授给 asset 协议。
     * 图片本身交给 webview 按文件加载，我们这边不解码、不缩放、不编码，也不生成 base64 字符串。
     *
     * 之前是后端解码 → 缩到 2560 → 编成 JPEG → base64 回传：实测一张 3824×2400 的壁纸要 249ms、
     * 产物 270KB，而且**每次启动都重算一遍**，那 249ms 正好落在首屏之后，表现成「背景图晚一步才出来」。
     * 现在这条路只剩一次「读文件头校验 + 授权」，1ms 量级。
     *
     * 失败原因依旧照实带回去：坏图 / 不存在的图在设置面板里会被提示，而不是静默地什么都不显示。
     */
    loadBackground: async (path: string): Promise<Result<BackgroundImage>> => {
      try {
        const target = path.startsWith(BUILTIN_PREFIX)
          ? await resolveBuiltin(path.slice(BUILTIN_PREFIX.length))
          : path
        if (!target) return fail(`内置壁纸已不存在：${path}`)

        await invoke('allow_background', { path: target })
        return ok({ path, name: target.split(/[\\/]/).pop() ?? target, url: assetUrl(target) })
      } catch (error) {
        return fail(reasonOf(error, '读取背景图失败'))
      }
    },

    /** 内置壁纸清单（含缩略图）：缩略图压到 320 就够面板里看了 */
    listWallpapers: async (): Promise<BuiltinWallpaper[]> => {
      const files = await invoke<string[]>('list_wallpapers')
      const items = await Promise.all(
        files.map(async (file) => {
          const item = wallpaperFrom(file)
          try {
            return {
              ...item,
              thumbnail: await invoke<string>('image_data_url', {
                path: file,
                maxEdge: THUMBNAIL_MAX_EDGE,
                quality: THUMBNAIL_QUALITY
              })
            }
          } catch {
            return item
          }
        })
      )
      return items
    },

    // ---------- 数据目录 ----------
    getDataLocation: () => state.dataLocation(),
    pickDataDir: async (): Promise<DataLocationPick> => {
      const dir = await openDialog({ directory: true, multiple: false, title: '选择数据目录' })
      if (!dir) return { dir: null, conflict: false }
      // 目标目录已有数据文件时返回冲突而不是直接覆盖
      const conflict = await invoke<boolean>('data_file_exists_in', { dir })
      return { dir, conflict }
    },
    migrateDataDir: (dir: string) =>
      guard(state.migrateDataDir(dir).then(() => state.dataLocation()), '迁移数据目录失败'),

    // ---------- 进程：项目十件事 ----------
    // 起什么命令由这里决定（后端只认整行命令），所以项目查找也要在这一层做
    install: (id: string) => withProject(id, (project) => session.installProject(project)),
    start: (id: string) => withProject(id, (project) => session.startProject(project)),
    build: (id: string, script: string) =>
      withProject(id, (project) => session.buildProject(project, script)),
    runCustom: (id: string, index: number) =>
      withProject(id, (project) => session.runCustom(project, index)),
    stop: (id: string) => session.stopOwner(id),
    startCommand: (id: string) => withCommand(id, (entry) => session.startCommand(entry)),
    stopCommand: (id: string) => session.stopCommand(id),

    // ---------- 系统 ----------
    checkPackageManagers: () => system.checkPackageManagers(),
    installPackageManager: (pm: InstallablePackageManager) => system.installPackageManager(pm),

    checkNodeVersion: (id: string) => nvm.checkNodeVersion(id),

    /** nvm 只读探测：目录、settings.txt、软链都由 Rust 扫，形状与 NvmStatus 一致 */
    getNvmStatus: () => nvm.status(),

    /** nrm：镜像清单与「当前是哪个」都问 nrm 自己（见 src-tauri/src/nrm.rs） */
    getNrmStatus: () => nrm.status(),
    installNrm: () => nrm.install(),
    useNrmRegistry: (name: string) => nrm.useRegistry(name),

    pickDirectory: (title?: string) =>
      openDialog({ directory: true, multiple: false, title: title ?? '选择项目目录' }),
    checkPort: (port: number) => invoke('check_port', { port }),
    killPortProcess: (port: number) =>
      guard(invoke<null>('kill_port_process', { port }), '结束进程失败'),
    reveal: (targetPath: string) => {
      void invoke('reveal', { path: targetPath })
      return Promise.resolve(ok(null))
    },
    openExternal: (url: string) =>
      guard(invoke<null>('open_external', { url }), '打开链接失败'),

    // ---------- 窗口 ----------
    minimizeWindow: () => {
      void invoke('window_minimize')
    },
    toggleMaximizeWindow: () => {
      void invoke('window_toggle_maximize')
    },
    closeWindow: () => {
      void invoke('window_close')
    },
    getWindowState: () =>
      invoke<boolean>('window_is_maximized').then((maximized): WindowState => ({ maximized })),
    // 窗口标题与托盘提示归系统，只能在 Rust 侧设；失败无处可报（它不影响任何功能），
    // 名字的收敛已经在上游做过了
    setAppName: (name: string) => {
      void invoke('set_app_name', { name })
    },
    getAppVersion: () => invoke<string>('app_version').catch(() => '—'),

    // ---------- 账号 ----------
    // 换 token、回环监听、凭据落盘都在 Rust 侧；这里只驱动轮询并落显示资料，
    // 全程不会有 token 回到渲染层（见 workbench/auth.ts）
    authStatus: () => auth.authStatus(),
    authRefreshAccount: (provider: AuthProvider) => auth.refreshAccount(provider),
    authLogin: (provider: AuthProvider, onAuthUrl?: (authUrl: string, opened: boolean) => void) =>
      auth.login(provider, onAuthUrl),
    authLoginSubmit: (url: string) => auth.submit(url),
    authLoginCancel: () => auth.cancel(),
    authLogout: (provider: AuthProvider) => auth.logout(provider),

    // ---------- 事件订阅 ----------
    // 窗口状态来自 Tauri 事件；其余来自适配层内部的广播（见 events.ts），
    // 契约与 preload 版完全一致，组件不需要知道底下换了实现。
    onWindowState: (handler: (value: WindowState) => void) =>
      listen<WindowState>('window:state-changed', handler),
    onLog: (handler: Parameters<WorkbenchApi['onLog']>[0]) => events.subscribe('log', handler),
    onStatus: (handler: Parameters<WorkbenchApi['onStatus']>[0]) =>
      events.subscribe('status', handler),
    onTerminalOpen: (handler: Parameters<WorkbenchApi['onTerminalOpen']>[0]) =>
      events.subscribe('terminalOpen', handler),
    onClear: (handler: (event: { terminal: string }) => void) =>
      events.subscribe('clear', handler),
    onPmInstallLog: (handler: Parameters<WorkbenchApi['onPmInstallLog']>[0]) =>
      events.subscribe('pmInstallLog', handler),
    onProjectChanged: (handler: Parameters<WorkbenchApi['onProjectChanged']>[0]) =>
      events.subscribe('projectChanged', handler),
    onSettingsChanged: (handler: Parameters<WorkbenchApi['onSettingsChanged']>[0]) =>
      events.subscribe('settingsChanged', handler),
    onTheme: (handler: Parameters<WorkbenchApi['onTheme']>[0]) =>
      events.subscribe('theme', handler),
    onDataReload: (handler: () => void) => events.subscribe('dataReload', handler),

    onQuickApps: (handler: Parameters<WorkbenchApi['onQuickApps']>[0]) =>
      events.subscribe('quickApps', handler),

    /** 后台自动同步跑完一轮（见 token.ts 的 getTokenUsage）：Token 面板据此立刻重取 */
    onTokenSynced: (handler: () => void) => events.subscribe('tokenSynced', handler),

    onQuitConfirm: (handler: Parameters<WorkbenchApi['onQuitConfirm']>[0]) =>
      events.subscribe('quitConfirm', handler),

    /** 把用户的选择回传后端：后端在另一个线程里等着它决定「停进程还是留着」 */
    respondQuitConfirm: (choice: Parameters<WorkbenchApi['respondQuitConfirm']>[0]) => {
      void invoke('resolve_quit_choice', { choice })
    },

    // 尚未有人推的一个：首页布局（本地改动的推送方还没补）
    onThemeConfig: () => noop
  } as unknown as WorkbenchApi

  /**
   * 未实现的通道统一兜底。`versions` 这类属性值已在上面给出，所以这里只会接住「方法」；
   * `on*` 订阅也已显式列出，不会被当成 Promise 返回。
   */
  return new Proxy(implemented, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (value !== undefined || typeof prop !== 'string') return value
      return () => notPorted(prop)
    }
  })
}

/** 只在 Tauri 里接管；浏览器预览（vite.preview）下没有后端，保持 undefined 让调用方走退化路径 */
export function installTauriWorkbench(): void {
  if (!hasTauri()) return
  // 先接上后端的原始事件（日志 / 退出），再暴露 API：否则第一帧产生的日志会丢
  session.installSessionListeners()
  // 退出确认：后端问「还有项目在跑，要不要先停掉」，转成渲染层认识的事件
  listen<{ count: number }>('app:quit-confirm', (payload) => events.emit('quitConfirm', payload))
  window.workbench = createApi()
}

export { initState } from './state'

/**
 * 启动收尾：收掉上次被强杀后留下的 dev server。
 *
 * 放在界面挂载之后调用 —— 它要挨个问进程的创建时间，不该挡首屏。
 * 只在 Tauri 里做：浏览器预览下没有后端。
 */
export async function reapOrphansOnStart(): Promise<void> {
  if (!hasTauri()) return

  // 顺带把系统集成项对齐一次（开机自启 / 快捷键可能在应用之外被改过）
  void syncSystemIntegration(state.settings())

  try {
    const result = await orphan.reap()
    for (const note of result.notes) console.warn(`[workbench] ${note}`)
  } catch (error) {
    // 清理是尽力而为：失败不能让应用起不来
    console.warn('[workbench] 清理残留进程失败', error)
  }
}
