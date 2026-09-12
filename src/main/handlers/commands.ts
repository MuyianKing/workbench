import { ipcMain } from 'electron'
import { IPC, type CommandInput, type CommandPatch, type Result } from '../../shared/types'
import {
  addCommand,
  listCommands,
  removeCommand,
  startCommand,
  stopCommand,
  updateCommand
} from '../commands'

/**
 * 首页「命令」卡片相关的 IPC。
 *
 * 与项目命令是两套独立模型（没有目录 / 包管理器 / 脚本，只有一行命令与一个可选端口），
 * 逻辑集中在 commands.ts，这里只做通道注册，从 ipc.ts 的单体里分出来。
 */
export function registerCommandsIpc(): void {
  ipcMain.handle(IPC.commandList, () => listCommands())

  ipcMain.handle(IPC.commandAdd, (_event, input: CommandInput) => addCommand(input))

  ipcMain.handle(IPC.commandUpdate, (_event, id: string, patch: CommandPatch) =>
    updateCommand(id, patch)
  )

  ipcMain.handle(IPC.commandRemove, (_event, id: string): Result<null> => removeCommand(id))

  ipcMain.handle(IPC.commandStart, (_event, id: string): Result<null> => startCommand(id))

  ipcMain.handle(IPC.commandStop, (_event, id: string): Result<null> => stopCommand(id))
}
