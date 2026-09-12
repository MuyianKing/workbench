import { BrowserWindow, ipcMain } from 'electron'
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
   * 最小化就是系统最小化：窗口收进任务栏，点任务栏按钮还能把它叫回来。
   *
   * 收进托盘只属于关闭按钮（见 index.ts 的 close 事件）：不做「最小化也收托盘」，
   * 那会让两个按钮变成同一个动作，用户也分不清窗口到底在哪。
   */
  ipcMain.on(IPC.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
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
