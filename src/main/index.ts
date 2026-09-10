import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { data, flushSync, loadData, save } from './store'
import { manager, flushLogBatches, registerIpc } from './ipc'
import { reapOrphanSessions } from './orphan'
import {
  currentSettings,
  disposeAppSettings,
  effectiveTheme,
  initAppSettings,
  notifyHiddenToTray
} from './app-settings'

let mainWindow: BrowserWindow | null = null
/** before-quit 里已经拦过一次退出，避免二次进入 */
let quitting = false
/** 任何来源的退出请求一旦开始，close 事件就不再拦截（否则退出会被「隐藏到托盘」吃掉） */
let appQuitting = false
/** 「已收进托盘」的提示每次运行只弹一次，避免每次关窗口都打扰 */
let trayHintShown = false

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
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
}

function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideMainWindow()
  else showMainWindow()
}

function hideToTray(): void {
  hideMainWindow()
  if (!trayHintShown) {
    trayHintShown = true
    notifyHiddenToTray()
  }
}

/**
 * 真正的退出入口（托盘的「退出」）。
 * 关闭按钮只是收进托盘，所以退出行为的确认挪到了这里。
 */
function requestQuit(): void {
  const value = currentSettings()
  if (!appQuitting && manager.activeProjectIds().length > 0 && value.closeBehavior === 'confirm') {
    void confirmQuitWithRunning()
    return
  }
  appQuitting = true
  app.quit()
}

/** 隐藏标题栏的窗口按钮叠加层要跟着主题走，否则暗色下右上角是三个黑点 */
function syncTitleBarOverlay(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const dark = effectiveTheme() === 'dark'
  try {
    mainWindow.setTitleBarOverlay({
      color: dark ? '#151a21' : '#edeff2',
      symbolColor: dark ? '#e8edf4' : '#11151b',
      height: 36
    })
  } catch {
    /* 平台不支持叠加层时忽略 */
  }
}

/** 有项目在跑且用户选了「提示确认」时，先问再退（F-8.4） */
async function confirmQuitWithRunning(): Promise<void> {
  const running = manager.activeProjectIds().length
  if (running === 0) {
    appQuitting = true
    app.quit()
    return
  }

  const options = {
    type: 'warning' as const,
    buttons: ['退出并停止', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: '仍有项目在运行',
    message: `还有 ${running} 个项目的进程正在运行`,
    detail: '退出 Workbench 会同时结束这些进程，未保存的命令输出将丢失。'
  }

  const { response } =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)

  // 确认后才真正退出；这里不能回头调用 requestQuit()，否则会再弹一次同样的确认框
  if (response === 0) {
    appQuitting = true
    app.quit()
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

function createWindow(): void {
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
    // Windows 上 ICO 才能拿到最好的缩放效果，多尺寸都在 build/icon.ico 里
    ...(icon ? { icon } : {}),
    backgroundColor: dark ? '#151a21' : '#eef0f3',
    autoHideMenuBar: true,
    // 隐藏原生标题栏，把窗口按钮以叠加层交给系统绘制（右上角仍是原生的最小化/最大化/关闭）
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: dark ? '#151a21' : '#edeff2',
      symbolColor: dark ? '#e8edf4' : '#11151b',
      height: 36
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  const showWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.show()
  }

  mainWindow.on('ready-to-show', showWindow)

  // 兜底：GPU / 磁盘缓存异常时首帧可能迟迟不来，窗口会一直停在 show: false 里，
  // 表现就是「进程起来了但看不见窗口」。
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[workbench] ready-to-show 未触发，强制显示窗口')
    }
    showWindow()
  }, 4000)

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[workbench] 页面加载失败：', code, description, url)
  })

  // 最小化到托盘（F-8.3）：minimize 事件不可取消，收起界面即可
  mainWindow.on('minimize', () => {
    if (currentSettings().minimizeToTray) hideToTray()
  })

  /**
   * 关闭按钮 = 收进托盘。
   * 托盘是常驻的，所以这里永远不真正关窗口；退出只能从托盘菜单（或 Alt 菜单）走。
   */
  mainWindow.on('close', (event) => {
    if (appQuitting || quitting) return
    event.preventDefault()
    hideToTray()
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
  await reapLeftovers()

  // 打包后设置与 electron-builder 的 appId 一致的 AUMID：任务栏归组、托盘通知都靠它
  if (process.platform === 'win32' && app.isPackaged) {
    app.setAppUserModelId('com.muyian.workbench')
  }

  initAppSettings({
    showWindow: showMainWindow,
    toggleWindow: toggleMainWindow,
    requestQuit
  })

  // 主题变化时同步窗口按钮叠加层的配色
  nativeTheme.on('updated', syncTitleBarOverlay)

  registerIpc()
  createWindow()

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

  // 没有子进程在跑，直接落盘退出
  if (manager.activeProjectIds().length === 0) {
    flushSync()
    return
  }

  // 有子进程时先拦住退出，等进程树真正结束再落盘，避免开发服务器残留占用端口
  event.preventDefault()
  quitting = true
  void manager.shutdown().finally(() => {
    flushSync()
    app.quit()
  })
})

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
