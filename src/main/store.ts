import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type DataLocation,
  type PersistedData
} from '../shared/types'
import { clampTerminalHeight } from '../shared/terminal-height'
import { pruneDays, sanitizeActivity, type ActivityCounts } from '../shared/activity'

const DATA_FILE = 'workbench-data.json'
/**
 * 数据文件位置指针，固定放在 userData。
 *
 * 不能把「数据目录」存进 workbench-data.json 自己 —— 那样就得先知道文件在哪才能知道文件在哪。
 * 指针文件很小，只放一个路径。
 */
const POINTER_FILE = 'data-location.json'

function pointerPath(): string {
  return join(app.getPath('userData'), POINTER_FILE)
}

function defaultDir(): string {
  return app.getPath('userData')
}

/** 用户指定的数据目录；null 表示用默认的 userData */
let customDir: string | null = null

let cache: PersistedData = emptyData()
let writeTimer: NodeJS.Timeout | null = null
/** 数据载入前禁止写盘，否则会用空数据覆盖磁盘上的真实文件 */
let loaded = false

function emptyData(): PersistedData {
  return {
    projects: [],
    groups: [],
    settings: { ...DEFAULT_SETTINGS },
    activeSessions: [],
    activity: {}
  }
}

export function currentDataDir(): string {
  return customDir ?? defaultDir()
}

export function currentDataFile(): string {
  return join(currentDataDir(), DATA_FILE)
}

export function getDataLocation(): DataLocation {
  return {
    dir: currentDataDir(),
    file: currentDataFile(),
    isDefault: customDir === null
  }
}

/** 目标目录里是否已经有数据文件（迁移前要拦一下，避免覆盖别人的数据） */
export function dataFileExistsIn(dir: string): boolean {
  try {
    return existsSync(join(dir, DATA_FILE))
  } catch {
    return false
  }
}

function readPointer(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(pointerPath(), 'utf-8')) as { dir?: unknown }
    const dir = typeof parsed.dir === 'string' ? parsed.dir.trim() : ''
    return dir || null
  } catch {
    // 指针缺失或损坏：回落到默认目录，不影响启动
    return null
  }
}

/**
 * 把数据搬到新目录并切过去。
 * 写的是内存里的当前数据，所以调用前必须已经 loadData 过。
 */
export async function migrateDataDir(target: string): Promise<void> {
  const dir = target.trim()
  if (!dir) throw new Error('目录为空')

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, DATA_FILE), JSON.stringify(cache, null, 2), 'utf-8')

  customDir = dir
  writeFileSync(pointerPath(), JSON.stringify({ dir }, null, 2), 'utf-8')
}

/**
 * 设置项来自磁盘，可能是旧版本写的或是被手工改过的，逐项收敛到合法取值。
 * 缺失的字段（老版本数据文件没有 settings）直接落到默认值。
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  const input = (raw ?? {}) as Partial<AppSettings>
  const value: AppSettings = { ...DEFAULT_SETTINGS, ...input }

  if (value.closeBehavior !== 'confirm' && value.closeBehavior !== 'stopAll') {
    value.closeBehavior = DEFAULT_SETTINGS.closeBehavior
  }
  if (value.theme !== 'system' && value.theme !== 'light' && value.theme !== 'dark') {
    value.theme = DEFAULT_SETTINGS.theme
  }
  if (typeof value.hotkey !== 'string' || !value.hotkey.trim()) {
    value.hotkey = DEFAULT_SETTINGS.hotkey
  }
  value.launchAtLogin = value.launchAtLogin === true
  value.hotkeyEnabled = value.hotkeyEnabled !== false
  value.minimizeToTray = value.minimizeToTray === true
  // 终端高度是拖出来的像素值，老数据文件里没有；非法值落回默认高度
  value.terminalHeight = clampTerminalHeight(value.terminalHeight)

  return value
}

export function data(): PersistedData {
  return cache
}

export function settings(): AppSettings {
  return cache.settings
}

export function activity(): ActivityCounts {
  return cache.activity ?? {}
}

export async function loadData(): Promise<PersistedData> {
  customDir = readPointer()

  try {
    const raw = await fs.readFile(currentDataFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistedData>
    cache = {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      settings: sanitizeSettings(parsed.settings),
      // 上次被强杀时留下的子进程记录，启动清理要用（漏掉这个字段清理就成了空转）
      activeSessions: Array.isArray(parsed.activeSessions) ? parsed.activeSessions : [],
      // 老数据文件没有这个字段；顺手裁掉图已经画不到的旧计数
      activity: pruneDays(sanitizeActivity(parsed.activity), Date.now())
    }
  } catch {
    // 首次运行、文件损坏，或指针指向了一个还没有数据的目录
    cache = emptyData()
  }
  loaded = true
  return cache
}

/** 变更即写，防抖 300ms；先写临时文件再重命名，避免写坏原文件 */
export function save(): void {
  if (!loaded) return
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    void flush()
  }, 300)
}

async function flush(): Promise<void> {
  const target = currentDataFile()
  const tmp = `${target}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8')
    await fs.rename(tmp, target)
  } catch (err) {
    console.error('[workbench] 保存项目数据失败:', err)
  }
}

/** 退出前同步落盘，防止防抖窗口内的改动丢失 */
export function flushSync(): void {
  if (!loaded) return
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  try {
    writeFileSync(currentDataFile(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch (err) {
    console.error('[workbench] 退出前保存失败:', err)
  }
}
