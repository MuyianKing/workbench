import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC, type QuitChoice, type WindowState } from '../shared/types'
import { broadcast } from './broadcast'
import { data, flushSync, loadData, save } from './store'
import { flushTokenSync, loadTokenData } from './token-usage'
import { flushThemeSync, loadTheme } from './theme'
import { registerIpc } from './ipc'
import { flushLogBatches, manager } from './manager'
import { checkPort, killPortProcess } from './system'
import { reapOrphanSessions } from './orphan'
import {
  currentSettings,
  disposeAppSettings,
  effectiveTheme,
  hideWindowToTray,
  initAppSettings,
  launchedHidden
} from './app-settings'

let mainWindow: BrowserWindow | null = null
/** before-quit 里已经拦过一次退出，避免二次进入 */
let quitting = false
/** 任何来源的退出请求一旦开始，close 事件就不再拦截（否则退出会被「隐藏到托盘」吃掉） */
let appQuitting = false
/**
 * 退出时是否要停止运行中的项目。
 * 退出弹窗里选「直接退出」会置为 false，此时跳过 shutdown，
 * 把进程留给下次启动的残留清理（reapOrphanSessions）。
 */
let stopProjectsOnQuit = true
/** 退出确认框同时只允许一个，避免连点托盘「退出」弹出多个 */
let quitPromptOpen = false
/**
 * 退出时要按端口结束的「外部运行中」项目（启动检测发现、进程不归 Workbench 管）。
 * 这些不在 manager 里，只能按端口 kill；选「直接退出」时留空表示不动它们。
 */
let externalPortsToStop: number[] = []

// 单实例：两个进程各持一份内存数据，后写的一次会把前一次的改动整个覆盖掉。
// 只在打包后启用——开发模式下 electron-vite 重启时若被上一个实例挡住，窗口会「起不来」。
const hasLock = !app.isPackaged || app.requestSingleInstanceLock()
if (hasLock) {
  app.on('second-instance', () => {
    showMainWindow()
  })
} else {
  console.warn('[workbench] 已有实例在运行，本次启动退出')
  app.quit()
}

// ---------- 窗口控制（供托盘 / 快捷键调用） ----------

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  // 隐藏期间任务栏按钮被摘掉了（见 hideWindowToTray），重新显示时先装回来
  mainWindow.setSkipTaskbar(false)
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function hideMainWindow(): void {
  hideWindowToTray(mainWindow)
}

function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideMainWindow()
  else showMainWindow()
}

/**
 * 探测「不归 Workbench 管、但端口被占」的运行中项目。
 * 判据与渲染层启动时的 detectAll 一致：项目配了监听端口，且端口连得上。
 * 排除 manager 正在管的项目，免得同一个项目被算两次。
 * 命令卡片的外部运行态不在这里算：那类进程更可能只是「顺手占着这个端口」的其他程序，
 * 退出时按它去杀进程太危险，交给卡片上的「检测 / 停止」由用户自己决定。
 */
async function detectExternalRunning(managedIds: Set<string>): Promise<number[]> {
  const ports = [
    ...new Set(
      (data().projects ?? [])
        .filter((project) => project.port && !managedIds.has(project.id))
        .map((project) => project.port as number)
    )
  ]

  const hits: number[] = []
  for (const port of ports) {
    const result = await checkPort(port)
    if (result.inUse) hits.push(port)
  }
  return hits
}

/**
 * 真正的退出入口（托盘的「退出」）。
 * 关闭按钮只是收进托盘，所以退出确认挪到了这里：只要还有项目在跑就先问一次。
 */
function requestQuit(): void {
  if (appQuitting) return
  void promptQuitIfRunning()
}

/** 退出确认框正在等待渲染层回传的选择（渲染层挂掉时由兜底逻辑接管） */
let pendingQuitChoice: ((choice: QuitChoice) => void) | null = null

/** 渲染层 / 兜底弹窗回传退出选择，只认第一次 */
function resolveQuitChoice(choice: QuitChoice): void {
  const resolve = pendingQuitChoice
  pendingQuitChoice = null
  resolve?.(choice)
}

/** 渲染层不可用时的兜底：走系统原生确认框 */
async function nativeQuitChoice(count: number): Promise<QuitChoice> {
  const options = {
    type: 'warning' as const,
    buttons: ['结束全部进程并退出', '直接退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: '仍有进程在运行',
    message: `还有 ${count} 个进程正在运行`,
    detail:
      '「结束全部进程并退出」会结束这些进程，未保存的命令输出将丢失；' +
      '「直接退出」会让它们继续在后台运行，下次启动 Workbench 时会自动检测并清理。'
  }

  const { response } =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
  return response === 0 ? 'stop' : response === 1 ? 'direct' : 'cancel'
}

/**
 * 询问用户退出方式：优先让渲染层弹应用内确认框（样式与界面统一），
 * 窗口不可用或渲染进程崩溃时退回系统原生确认框，别把退出卡死。
 */
function askQuitChoice(count: number): Promise<QuitChoice> {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (!contents || contents.isDestroyed()) return nativeQuitChoice(count)

  showMainWindow()
  return new Promise<QuitChoice>((resolve) => {
    pendingQuitChoice = resolve
    contents.once('render-process-gone', () => {
      void nativeQuitChoice(count).then(resolveQuitChoice)
    })
    contents.send(IPC.eventQuitConfirm, { count })
  })
}

/**
 * 有项目在跑时先问一次再退（F-8.4）：
 *   ① 关闭所有项目并退出 —— 停掉进程树再退，不留残留；
 *   ② 直接退出 —— 保留进程，交给下次启动时的残留清理（reapOrphanSessions）。
 * 「在跑」既包括本次会话启动的进程，也包括启动检测认出、端口被占的外部服务。
 * 关闭按钮 / Esc 是「取消」：关掉弹窗，什么都不做，应用继续运行。
 */
async function promptQuitIfRunning(): Promise<void> {
  if (quitPromptOpen) return
  quitPromptOpen = true

  try {
    const managedIds = manager.activeProjectIds()
    const externalPorts = await detectExternalRunning(new Set(managedIds))
    const running = managedIds.length + externalPorts.length

    if (running === 0) {
      appQuitting = true
      app.quit()
      return
    }

    // 这里不能回头调用 requestQuit()，否则会再弹一次同样的确认框
    const choice = await askQuitChoice(running)
    if (choice === 'cancel') return

    stopProjectsOnQuit = choice === 'stop'
    externalPortsToStop = choice === 'stop' ? externalPorts : []
    appQuitting = true
    app.quit()
  } finally {
    quitPromptOpen = false
  }
}

/**
 * 窗口（以及任务栏按钮）的图标。
 *
 * 开发态跑的是 node_modules/electron/dist/electron.exe，它的内置图标是 Electron 自己的；
 * electron-builder 只在打包时用 rcedit 把 build/icon.ico 写进 Workbench.exe，所以不打这个补丁的话，
 * `npm run dev` 的任务栏图标永远是 Electron 默认那个。打包后 exe 已经带图标，这里就不必再指定。
 */
function devWindowIcon(): string | undefined {
  if (app.isPackaged) return undefined

  const candidates = [
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(__dirname, '..', '..', 'build', 'icon.ico')
  ]
  return candidates.find((file) => existsSync(file))
}

/**
 * 创建主窗口。
 *
 * launchHidden 只在开机自启那一次为 true（见 app-settings.ts 的 applyAutoLaunch）：
 * 窗口照常建好、渲染层照常准备数据，只是不显示 —— 用户点托盘图标时能立刻出来。
 * 之后从托盘唤起的创建都走默认的 false，否则窗口会永远出不来。
 */
function createWindow(launchHidden = false): void {
  const dark = effectiveTheme() === 'dark'
  const icon = devWindowIcon()

  if (!app.isPackaged && !icon) {
    console.warn('[workbench] 未找到 build/icon.ico，任务栏将回退为 Electron 默认图标（可执行 npm run icons 生成）')
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    // 隐藏标题栏后标题栏本身看不见，但任务栏 / Alt+Tab 仍用窗口标题
    title: currentSettings().appName,
    // Windows 上 ICO 才能拿到最好的缩放效果，多尺寸都在 build/icon.ico 里
    ...(icon ? { icon } : {}),
    backgroundColor: dark ? '#151a21' : '#eef0f3',
    autoHideMenuBar: true,
    /**
     * 隐藏原生标题栏，但不挂 titleBarOverlay：叠加层那 138×36 是系统独占的，
     * DOM 既进不去、也模糊不到，壁纸铺到顶时右上角会留下一块对不上的实色。
     * 右上角的最小化 / 最大化 / 关闭改由渲染层自绘（components/TitleBar.vue），
     * 代价是失去 Windows 11 最大化按钮上的贴靠布局，换来顶栏层次可以随便做。
     * 拖动依然由 -webkit-app-region: drag 交给系统，双击最大化与贴靠不受影响。
     */
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  /**
   * 首帧是否已经就绪（ready-to-show 触发过）。
   * 触发过就说明渲染没问题，之后的「窗口不可见」只可能是用户自己最小化或收进了托盘，
   * 兜底逻辑不能再插手。
   */
  let firstFrameReady = false

  const showWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.show()
  }

  // 标题由设置里的程序名称决定，别让 index.html 的 <title> 把它覆盖回默认值
  mainWindow.on('page-title-updated', (event) => event.preventDefault())

  mainWindow.on('ready-to-show', () => {
    firstFrameReady = true
    if (!launchHidden) showWindow()
  })

  // 兜底：GPU / 磁盘缓存异常时首帧可能迟迟不来，窗口会一直停在 show: false 里，
  // 表现就是「进程起来了但看不见窗口」。
  // 只救「首帧没来、窗口也没露过面」这一种。最小化后的窗口 isVisible() 同样是 false，
  // 光看可见性的话，用户在这 4 秒里自己最小化 / 收进托盘反而会被顶出来。
  setTimeout(() => {
    // 开机自启拉起的实例本来就该待在托盘里，不能到点又把它顶到前台
    if (launchHidden || firstFrameReady) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isVisible() || mainWindow.isMinimized()) return
    console.warn('[workbench] ready-to-show 未触发，强制显示窗口')
    showWindow()
  }, 4000)

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[workbench] 页面加载失败：', code, description, url)
  })

  // 自绘标题栏的第三个按钮要跟着换图标：最大化画方框、还原画叠框。
  // 拖窗口边缘、双击标题栏、系统快捷键都能最大化，所以状态从窗口事件推，不由按钮自己记。
  const pushWindowState = (maximized: boolean): void => {
    broadcast(IPC.eventWindowState, { maximized } satisfies WindowState)
  }
  mainWindow.on('maximize', () => pushWindowState(true))
  mainWindow.on('unmaximize', () => pushWindowState(false))

  /**
   * 关闭按钮 = 收进托盘。
   * 托盘是常驻的，所以这里永远不真正关窗口；退出只能从托盘菜单（或 Alt 菜单）走。
   */
  mainWindow.on('close', (event) => {
    if (appQuitting || quitting) return
    event.preventDefault()
    hideMainWindow()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 清理上次被强杀时残留的子进程（设计文档 §7）。
 * 记录里带着 ownerPid：如果那个实例还在跑，说明这些进程有主，reapOrphanSessions 会原样保留。
 */
async function reapLeftovers(): Promise<void> {
  const recorded = data().activeSessions ?? []
  if (recorded.length === 0) return

  try {
    const { killed, kept, notes } = await reapOrphanSessions(recorded)
    for (const note of notes) console.warn(`[workbench] ${note}`)
    if (killed > 0) console.warn(`[workbench] 已清理 ${killed} 个上次残留的进程`)

    data().activeSessions = kept
    save()
  } catch (err) {
    console.warn('[workbench] 清理残留进程失败:', err)
    data().activeSessions = []
    save()
  }
}

app.whenReady().then(async () => {
  if (!hasLock) return

  await loadData()
  await loadTheme()
  // token 快照与主数据同目录,指针文件已就位后才能算出正确路径
  await loadTokenData()
  await reapLeftovers()

  // 打包后设置与 electron-builder 的 appId 一致的 AUMID：任务栏归组、托盘通知都靠它
  if (process.platform === 'win32' && app.isPackaged) {
    app.setAppUserModelId('com.muyian.workbench')
  }

  initAppSettings({
    showWindow: showMainWindow,
    toggleWindow: toggleMainWindow,
    requestQuit,
    setWindowTitle: (name) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(name)
    }
  })

  registerIpc()
  // 退出确认框的用户选择由渲染层回传；认不出的值当「取消」，别让它触发一次退出
  ipcMain.on(IPC.quitConfirmRespond, (_event, choice: QuitChoice) => {
    resolveQuitChoice(choice === 'stop' || choice === 'direct' ? choice : 'cancel')
  })
  createWindow(launchedHidden())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

app.on('before-quit', (event) => {
  // 任何来源的退出请求（托盘菜单、Alt 菜单、系统注销）都从这里开始：
  // 标记之后 close 事件不再拦截，否则退出会被「收进托盘」吃掉
  appQuitting = true
  if (quitting) return

  const hasManaged = manager.activeProjectIds().length > 0

  // 用户选了「直接退出」，或根本没有要收尾的进程：落盘后直接走
  if (!stopProjectsOnQuit || (!hasManaged && externalPortsToStop.length === 0)) {
    flushSync()
    flushThemeSync()
    flushTokenSync()
    return
  }

  // 有进程要收尾时先拦住退出，等它们真正结束再落盘，避免开发服务器残留占用端口
  event.preventDefault()
  quitting = true
  void stopRunningAndQuit()
})

/** 结束本次会话启动的进程与启动检测认出的外部服务，然后退出 */
async function stopRunningAndQuit(): Promise<void> {
  const externalPorts = externalPortsToStop
  try {
    await Promise.all([
      manager.shutdown(),
      ...externalPorts.map((port) =>
        killPortProcess(port).catch((err) => {
          // 进程可能已经自己退出，或端口被别的程序接管；不拦退出，只记一笔
          console.warn(`[workbench] 结束端口 ${port} 上的进程失败:`, err)
        })
      )
    ])
  } finally {
    externalPortsToStop = []
    flushSync()
    flushThemeSync()
    flushTokenSync()
    app.quit()
  }
}

app.on('will-quit', () => {
  // 还在聚合窗口里的最后几行日志先排空，再让窗口消失
  flushLogBatches()
  disposeAppSettings()
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  // 关闭按钮已经被拦成「隐藏」，所以走到这里只可能是退出流程；托盘常驻，不主动退出
  if (appQuitting) app.quit()
})
