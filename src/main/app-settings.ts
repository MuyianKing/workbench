import { app, BrowserWindow, globalShortcut, Menu, nativeImage, nativeTheme, Tray } from 'electron'
import { IPC, type AppSettings, type EffectiveTheme } from '../shared/types'
import { broadcast } from './broadcast'
import { data, sanitizeSettings, save, settings } from './store'
import { TRAY_ICON_DATA_URL } from './tray-icon'

/** 设置模块需要操作窗口，用回调注入，避免和 index.ts 互相 import */
export interface SettingsHost {
  showWindow: () => void
  toggleWindow: () => void
  requestQuit: () => void
  /** 程序名称变化后更新窗口标题（隐藏标题栏时任务栏 / Alt+Tab 仍用它） */
  setWindowTitle: (name: string) => void
}

/**
 * 开机自启拉起时附加的启动参数（见 applyAutoLaunch）：只驻留托盘、不弹窗口。
 * Windows 上读不到「由登录项启动」，只能靠这个参数自己认。
 */
const LAUNCH_HIDDEN_FLAG = '--hidden'

let host: SettingsHost | null = null
let tray: Tray | null = null
/** 「已收进托盘」的提示每次运行只弹一次，避免每次收窗口都打扰 */
let trayHintShown = false

/** 实际生效的主题：system 交给系统解析后，渲染层只需要 light / dark 两种 */
export function effectiveTheme(): EffectiveTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function currentSettings(): AppSettings {
  return settings()
}

/** 本次是不是「开机自启」拉起的实例：是的话窗口建好就藏着，界面交给托盘图标唤起 */
export function launchedHidden(): boolean {
  return process.argv.includes(LAUNCH_HIDDEN_FLAG)
}

export function initAppSettings(nextHost: SettingsHost): void {
  host = nextHost

  // 跟随系统时，系统主题变化要实时同步给渲染层
  nativeTheme.on('updated', () => {
    broadcast(IPC.eventTheme, effectiveTheme())
  })

  applyTheme()
  applyHotkey()
  applyAutoLaunch()
  applyAppName()
  // 托盘常驻：关闭按钮就是「隐藏到托盘」，没有托盘就再也找不回窗口了
  ensureTray()
}

/**
 * 合并并落盘设置。
 * 返回的是「收敛后」的最终值：快捷键注册失败时 hotkeyEnabled 会被改成 false，
 * 渲染层据此就能提示用户，无需额外通道。
 */
export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  data().settings = sanitizeSettings({ ...settings(), ...patch })
  save()

  applyTheme()
  applyHotkey()
  applyAutoLaunch()
  applyAppName()

  broadcast(IPC.eventSettings, settings())
  return settings()
}

/** 窗口收进托盘时给个提示，免得用户以为应用被关掉了 */
export function notifyHiddenToTray(): void {
  if (!tray || tray.isDestroyed()) return
  try {
    tray.displayBalloon({
      title: `${settings().appName} 仍在运行`,
      content: '窗口已收进托盘，点击托盘图标可以重新打开。'
    })
  } catch {
    // 通知中心不可用时忽略：托盘图标本身就是入口
  }
}

/**
 * 把窗口收进托盘：隐藏、摘掉任务栏按钮，并给一次提示（每次运行只提示一遍）。
 *
 * setSkipTaskbar 一起做掉：隐藏的窗口不该再在任务栏留一个点了没反应的按钮，
 * showMainWindow 里再把它装回来。
 */
export function hideWindowToTray(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return

  win.hide()
  win.setSkipTaskbar(true)

  if (trayHintShown) return
  trayHintShown = true
  notifyHiddenToTray()
}

export function disposeAppSettings(): void {
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
}

// ---------- 各项应用 ----------

function applyTheme(): void {
  nativeTheme.themeSource = settings().theme
  broadcast(IPC.eventTheme, effectiveTheme())
}

function applyHotkey(): void {
  globalShortcut.unregisterAll()

  const value = settings()
  if (!value.hotkeyEnabled || !host) return

  try {
    const registered = globalShortcut.register(value.hotkey, () => host?.toggleWindow())
    if (!registered) {
      // 被别的应用占了就自动停用，并把结果推回界面（用户会看到开关自己关掉 + 提示）
      data().settings.hotkeyEnabled = false
      save()
      console.warn(`[workbench] 全局快捷键 ${value.hotkey} 注册失败，已停用`)
    }
  } catch (err) {
    data().settings.hotkeyEnabled = false
    save()
    console.warn(`[workbench] 全局快捷键 ${value.hotkey} 非法：${(err as Error).message}`)
  }
}

function applyAutoLaunch(): void {
  if (!app.isPackaged) {
    // 开发态写到注册表里会指向 electron.exe，没有任何意义
    return
  }
  try {
    // 自启项带上 --hidden：开机的这个实例不该抢走焦点，只在托盘里待命
    app.setLoginItemSettings({
      openAtLogin: settings().launchAtLogin,
      args: [LAUNCH_HIDDEN_FLAG]
    })
  } catch (err) {
    console.warn('[workbench] 设置开机自启失败:', err)
  }
}

/** 程序名称改了之后，窗口标题与托盘提示一起跟上（托盘可能还没建好，跳过即可） */
function applyAppName(): void {
  const name = settings().appName
  host?.setWindowTitle(name)
  if (tray && !tray.isDestroyed()) tray.setToolTip(name)
}

function ensureTray(): void {
  if (tray && !tray.isDestroyed()) return

  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL))
  tray.setToolTip(settings().appName)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => host?.showWindow() },
      { type: 'separator' },
      { label: '退出', click: () => host?.requestQuit() }
    ])
  )
  tray.on('click', () => host?.toggleWindow())
  tray.on('double-click', () => host?.showWindow())
}
