/**
 * 首页布局配置（theme.json）的读写。
 *
 * 单独一个文件、放在 userData 下，不跟 workbench-data.json（项目数据 / 应用设置）
 * 混在一起：布局是纯展示偏好，改坏了不该有伤到项目列表的风险。
 */
import { join } from 'node:path'
import { app } from 'electron'
import { IPC } from '../shared/types'
import { DEFAULT_THEME, sanitizeTheme, type ThemeConfig } from '../shared/theme'
import { broadcast } from './broadcast'
import { JsonStore } from './json-store'

const THEME_FILE = 'theme.json'

/** 空布局：每次从默认值深拷一份，避免调用方不小心改到 DEFAULT_THEME 本身 */
function defaultTheme(): ThemeConfig {
  return sanitizeTheme(DEFAULT_THEME)
}

export function themeFilePath(): string {
  return join(app.getPath('userData'), THEME_FILE)
}

const persistent = new JsonStore<ThemeConfig>(themeFilePath, defaultTheme, '保存首页布局')

export function themeConfig(): ThemeConfig {
  return persistent.get()
}

export async function loadTheme(): Promise<ThemeConfig> {
  // 首次运行或文件损坏时 load 内部会回到默认布局，不影响启动
  return persistent.load(sanitizeTheme)
}

/** 合并并落盘；改完立刻广播，界面据此同步（也可能是被设置窗口改的） */
export function updateTheme(patch: Partial<ThemeConfig>): ThemeConfig {
  const current = persistent.get()
  const next = sanitizeTheme({
    ...current,
    ...patch,
    cards: { ...current.cards, ...(patch.cards ?? {}) }
  })
  persistent.set(next)
  save()
  broadcast(IPC.eventThemeConfig, next)
  return next
}

/** 变更即写，防抖 300ms；先写临时文件再重命名，避免写坏原文件 */
export function save(): void {
  persistent.schedule()
}

/** 退出前同步落盘，防止防抖窗口内的改动丢失 */
export function flushThemeSync(): void {
  persistent.flushSync()
}
