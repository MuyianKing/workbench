import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { sanitizeQuickApps } from '../shared/quick-launch'
import { sanitizeAppName } from '../shared/app-name'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type DataLocation,
  type PersistedData
} from '../shared/types'
import { clampTerminalHeight } from '../shared/terminal-height'
import { clampSidePanelWidth } from '../shared/side-panel-width'
import { sanitizeSidePanelPosition } from '../shared/side-panel-position'
import {
  clampBackgroundOpacity,
  sanitizeBackgroundPath,
  sanitizeVeilColor
} from '../shared/workspace-background'
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
    quickApps: [],
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

  // 「退出行为」设置已废弃：现在从托盘退出时只要还有项目在跑就统一弹窗让用户选，
  // 旧数据文件里可能还留着这个字段，顺手清掉，免得一直写回。
  delete (value as unknown as Record<string, unknown>).closeBehavior
  // 程序名称：老数据文件里没有，空白名会让标题栏空掉，统一收敛
  value.appName = sanitizeAppName(value.appName)
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
  // 侧栏宽度同上：老数据文件里没有这个字段
  value.sidePanelWidth = clampSidePanelWidth(value.sidePanelWidth)
  // 侧栏位置：老数据文件里没有，认不出来的写法一律当「右」
  value.sidePanelPosition = sanitizeSidePanelPosition(value.sidePanelPosition)
  // 背景图：老数据文件里没有。图片被删 / 换了格式读不出来时不在这里拦，
  // 由主进程读图时给出具体原因，界面才好提示用户重新选一张
  value.workspaceBackground = sanitizeBackgroundPath(value.workspaceBackground)
  value.workspaceBackgroundOpacity = clampBackgroundOpacity(value.workspaceBackgroundOpacity)
  // 蒙版色：认不出来的写法一律当「跟随主题」，别让一个手改过的色值把整条 background 拼废
  value.workspaceBackgroundVeil = sanitizeVeilColor(value.workspaceBackgroundVeil)

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
      // 老数据文件没有这一项；手工改坏过的条目在这里被丢掉或补全
      quickApps: sanitizeQuickApps(parsed.quickApps, randomUUID),
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
