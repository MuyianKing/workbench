import { BrowserWindow, ipcMain } from 'electron'
import { toResult } from '../../shared/result'
import {
  IPC,
  type QuickApp,
  type QuickAppInput,
  type QuickAppPatch,
  type Result
} from '../../shared/types'
import {
  addQuickApp,
  launchQuickApp,
  pickApplication,
  quickAppIcon,
  quickAppList,
  removeQuickApp,
  reorderQuickApps,
  updateQuickApp
} from '../quick-launch'

/**
 * 快捷启动（常用软件）相关的 IPC。
 *
 * 与项目命令是两套独立模型（不接管进程、没有日志与停止），逻辑集中在 quick-launch.ts，
 * 这里只做通道注册，从 ipc.ts 的单体里分出来。
 */
export function registerQuickIpc(): void {
  ipcMain.handle(IPC.quickList, () => quickAppList())

  ipcMain.handle(IPC.quickPick, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return pickApplication(win)
  })

  ipcMain.handle(IPC.quickAdd, async (_event, input: QuickAppInput): Promise<Result<QuickApp>> =>
    addQuickApp(input)
  )

  ipcMain.handle(
    IPC.quickUpdate,
    async (_event, id: string, patch: QuickAppPatch): Promise<Result<QuickApp>> =>
      updateQuickApp(id, patch)
  )

  ipcMain.handle(IPC.quickRemove, async (_event, id: string): Promise<Result<null>> =>
    removeQuickApp(id)
  )

  ipcMain.handle(IPC.quickReorder, async (_event, ids: string[]): Promise<Result<QuickApp[]>> =>
    reorderQuickApps(ids)
  )

  ipcMain.handle(IPC.quickLaunch, async (_event, id: string): Promise<Result<null>> =>
    toResult(async () => {
      await launchQuickApp(id)
      return null
    })
  )

  ipcMain.handle(IPC.quickIcon, async (_event, target: string): Promise<Result<string>> =>
    quickAppIcon(target)
  )
}
