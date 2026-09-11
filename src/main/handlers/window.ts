import { BrowserWindow, ipcMain } from 'electron'
import { currentSettings, hideWindowToTray } from '../app-settings'
import { IPC, type WindowState } from '../../shared/types'

/**
 * 自绘标题栏的窗口控制。
 *
 * 窗口用 titleBarStyle: 'hidden' 且不再让系统画叠加层（见 index.ts 的 createWindow），
 * 右上角的最小化 / 最大化 / 关闭由渲染层自己画，这里只把动作接到真正的窗口上。
 *
 * 一律用 fromWebContents 找发命令的那个窗口，而不是模块级的 mainWindow：
 * 命令本来就是窗口自己的事，多窗口时也不会打错对象。
 */
export function registerWindowIpc(): void {
  /**
   * 开了「最小化到托盘」就完全不走系统最小化，直接收进托盘。
   *
   * 先最小化再隐藏会留下「已最小化 + 已隐藏」的窗口：任务栏那个按钮变成点了没反应的残影
   * （窗口其实已经隐藏），从托盘唤回来时窗口也还是最小化的样子，再点最小化自然没效果。
   * 直接隐藏既没有这个状态，也不会有先最小化再消失的那段动画。
   */
  ipcMain.on(IPC.windowMinimize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (currentSettings().minimizeToTray) hideWindowToTray(win)
    else win.minimize()
  })

  ipcMain.on(IPC.windowToggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  /**
   * 走 close() 而不是 destroy()：关闭按钮「收进托盘 / 有项目在跑时先确认」那套逻辑
   * 挂在窗口的 close 事件上，destroy 会把它整个绕过去。
   */
  ipcMain.on(IPC.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(
    IPC.windowState,
    (event): WindowState => ({
      maximized: BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
    })
  )
}
