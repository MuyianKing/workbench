import { BrowserWindow, ipcMain } from 'electron'
import { fail, ok, toResult } from '../../shared/result'
import {
  IPC,
  type AppSettings,
  type BackgroundImage,
  type BuiltinWallpaper,
  type DataLocation,
  type DataLocationPick,
  type Result,
  type ThemeConfig
} from '../../shared/types'
import { updateAppSettings } from '../app-settings'
import { pickBackgroundImage, readBackgroundImage } from '../background'
import { broadcast } from '../broadcast'
import { manager } from '../manager'
import { settings, dataFileExistsIn, getDataLocation, migrateDataDir } from '../store'
import { pickDirectory } from '../system'
import { themeConfig, updateTheme } from '../theme'
import { listWallpapers } from '../wallpapers'

/**
 * 应用设置、首页布局（theme.json）、内置壁纸与数据存储位置的 IPC。
 * 这一组只碰 store / theme / app-settings 等配置层，与项目、进程无关，故从 ipc.ts 拆出。
 */
export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.getSettings, () => settings())

  ipcMain.handle(
    IPC.updateSettings,
    async (_event, patch: Partial<AppSettings>): Promise<Result<AppSettings>> => {
      if (!patch || typeof patch !== 'object') return fail('参数不合法')
      return ok(updateAppSettings(patch))
    }
  )

  // 选背景图只返回路径（落盘走 updateSettings），读图则统一由主进程解码成 data URL
  ipcMain.handle(IPC.pickBackground, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return pickBackgroundImage(win)
  })

  ipcMain.handle(
    IPC.loadBackground,
    async (_event, path: string): Promise<Result<BackgroundImage>> => readBackgroundImage(path)
  )

  // 内置壁纸清单：目录里有什么就列什么，没有则返回空数组（设置里那一栏自动收起）
  ipcMain.handle(IPC.listWallpapers, (): Promise<BuiltinWallpaper[]> => listWallpapers())

  ipcMain.handle(IPC.getThemeConfig, () => themeConfig())

  ipcMain.handle(
    IPC.updateThemeConfig,
    async (_event, patch: Partial<ThemeConfig>): Promise<Result<ThemeConfig>> => {
      if (!patch || typeof patch !== 'object') return fail('参数不合法')
      return ok(updateTheme(patch))
    }
  )

  ipcMain.handle(IPC.getDataLocation, () => getDataLocation())

  ipcMain.handle(IPC.pickDataDir, async (event): Promise<DataLocationPick> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dir = await pickDirectory(win, '选择 Workbench 数据目录')
    if (!dir) return { dir: null, conflict: false }
    return { dir, conflict: dataFileExistsIn(dir) }
  })

  ipcMain.handle(IPC.migrateDataDir, async (_event, dir: string): Promise<Result<DataLocation>> => {
    if (typeof dir !== 'string' || !dir.trim()) return fail('目录为空')
    if (manager.activeProjectIds().length > 0) {
      return fail('还有项目在运行，请先全部停止再迁移数据')
    }

    return toResult(async () => {
      await migrateDataDir(dir)
      // 数据文件换了位置，渲染层需要整份重新加载
      broadcast(IPC.eventDataReload, null)
      return getDataLocation()
    })
  })
}
