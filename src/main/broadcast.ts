import { BrowserWindow } from 'electron'
import type { BroadcastChannel } from '../shared/types'

/**
 * 主进程 → 所有渲染窗口的单向事件广播。
 *
 * 退出流程里子进程的收尾事件可能晚于窗口销毁，这里统一挡掉已销毁的窗口，
 * 避免各处重复写同样的防御代码。
 *
 * channel 收紧到 BroadcastChannel：以前是任意 string，通道名打错也能编译通过、
 * 然后事件被静默丢掉，排查起来只能靠肉眼比对常量。
 */
export function broadcast(channel: BroadcastChannel, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}
