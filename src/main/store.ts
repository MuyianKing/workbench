import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { type AppSettings, type DataLocation, type PersistedData } from '../shared/types'
import { type ActivityCounts } from '../shared/activity'
import { TOKEN_DATA_FILE_NAME } from '../shared/token-usage'
import { emptyData, parseData, sanitizeSettings } from '../shared/persisted-data'
import { JsonStore } from './json-store'

export { sanitizeSettings }

const DATA_FILE = 'workbench-data.json'
/**
 * 数据文件位置指针，固定放在 userData。
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

const persistent = new JsonStore<PersistedData>(currentDataFile, emptyData, '保存项目数据')

/**
 * 把数据搬到新目录并切过去。
 * 写的是内存里的当前数据，所以调用前必须已经 loadData 过。
 */
export async function migrateDataDir(target: string): Promise<void> {
  const dir = target.trim()
  if (!dir) throw new Error('目录为空')

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, DATA_FILE), JSON.stringify(persistent.get(), null, 2), 'utf-8')

  // token 用量快照与主数据同目录,迁移时一并带走(还没有就跳过)
  try {
    await fs.copyFile(join(currentDataDir(), TOKEN_DATA_FILE_NAME), join(dir, TOKEN_DATA_FILE_NAME))
  } catch {
    // 快照尚不存在,不算迁移失败
  }

  customDir = dir
  writeFileSync(pointerPath(), JSON.stringify({ dir }, null, 2), 'utf-8')
}

export function data(): PersistedData {
  return persistent.get()
}


export function settings(): AppSettings {
  return persistent.get().settings
}

export function activity(): ActivityCounts {
  return persistent.get().activity ?? {}
}

export async function loadData(): Promise<PersistedData> {
  customDir = readPointer()
  return persistent.load(parseData)
}

/** 变更即写，防抖 300ms；先写临时文件再重命名，避免写坏原文件 */
export function save(): void {
  persistent.schedule()
}

/** 退出前同步落盘，防止防抖窗口内的改动丢失 */
export function flushSync(): void {
  persistent.flushSync()
}
