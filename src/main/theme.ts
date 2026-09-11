/**
 * 首页布局配置（theme.json）的读写。
 *
 * 单独一个文件、放在 userData 下，不跟 workbench-data.json（项目数据 / 应用设置）
 * 混在一起：布局是纯展示偏好，改坏了不该有伤到项目列表的风险。
 */
import { promises as fs, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { IPC } from '../shared/types'
import { DEFAULT_THEME, sanitizeTheme, type ThemeConfig } from '../shared/theme'
import { broadcast } from './broadcast'

const THEME_FILE = 'theme.json'

/** 空布局：每次从默认值深拷一份，避免调用方不小心改到 DEFAULT_THEME 本身 */
function defaultTheme(): ThemeConfig {
  return sanitizeTheme(DEFAULT_THEME)
}

let cache: ThemeConfig = defaultTheme()
/** 载入前禁止写盘，否则会拿空布局覆盖磁盘上的真实配置 */
let loaded = false
let writeTimer: NodeJS.Timeout | null = null

export function themeFilePath(): string {
  return join(app.getPath('userData'), THEME_FILE)
}

export function themeConfig(): ThemeConfig {
  return cache
}

export async function loadTheme(): Promise<ThemeConfig> {
  try {
    const raw = await fs.readFile(themeFilePath(), 'utf-8')
    cache = sanitizeTheme(JSON.parse(raw))
  } catch {
    // 首次运行或文件损坏：回到默认布局，不影响启动
    cache = defaultTheme()
  }
  loaded = true
  return cache
}

/** 合并并落盘；改完立刻广播，界面据此同步（也可能是被设置窗口改的） */
export function updateTheme(patch: Partial<ThemeConfig>): ThemeConfig {
  cache = sanitizeTheme({
    ...cache,
    ...patch,
    cards: { ...cache.cards, ...(patch.cards ?? {}) }
  })
  save()
  broadcast(IPC.eventThemeConfig, cache)
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
  const target = themeFilePath()
  const tmp = `${target}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8')
    await fs.rename(tmp, target)
  } catch (err) {
    console.error('[workbench] 保存首页布局失败:', err)
  }
}

/** 退出前同步落盘，防止防抖窗口内的改动丢失 */
export function flushThemeSync(): void {
  if (!loaded) return
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  try {
    writeFileSync(themeFilePath(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch (err) {
    console.error('[workbench] 退出前保存首页布局失败:', err)
  }
}
