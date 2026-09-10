import { BrowserWindow } from 'electron'

/**
 * 主进程 → 所有渲染窗口的单向事件广播。
 *
 * 退出流程里子进程的收尾事件可能晚于窗口销毁，这里统一挡掉已销毁的窗口，
 * 避免各处重复写同样的防御代码。
 */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}
