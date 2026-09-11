import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, win32 } from 'node:path'
import type { NvmStatus } from '../shared/types'
import { isDirectorySync } from './fs-util'

/**
 * 读取 nvm-windows 已安装的 Node 版本，并按项目给子进程注入 PATH。
 *
 * 为什么不直接调用 nvm.exe：
 *   1. nvm-windows 启动时会用 kernel32!GetConsoleMode 判断 stdout 是不是真控制台，
 *      从 Electron 这类 GUI 进程 spawn 出去只会得到
 *      「NVM for Windows should be run from a terminal such as CMD or PowerShell.」然后静默退出；
 *   2. 就算给了它控制台，`nvm use` 还要管理员权限去改 NVM_SYMLINK 软链，会弹 UAC；
 *   3. 全局切换会影响所有终端和其它正在跑的项目。
 *
 * 所以这里只做只读探测（读 nvm 根目录 + 软链），切换的落点是「给这个项目的子进程
 * 前置版本目录到 PATH」——免管理员，还能让多个项目同时用不同的 Node。
 */

/** nvm 的版本目录名固定是 vX.Y.Z */
const VERSION_DIR_RE = /^v(\d+)\.(\d+)\.(\d+)$/

/** 一个版本目录必须真的有 node.exe，nvm 自己也会把这种目录判为损坏 */
function isNodeInstall(dir: string): boolean {
  return existsSync(join(dir, 'node.exe'))
}

/** 读 nvm 的 settings.txt（root / path 两行），拿不到就返回空 */
export function readNvmSettings(root: string): { root?: string; path?: string } {
  let text: string
  try {
    text = readFileSync(join(root, 'settings.txt'), 'utf-8')
  } catch {
    return {}
  }

  const result: { root?: string; path?: string } = {}
  for (const line of text.split(/\r?\n/)) {
    const matched = /^\s*(root|path)\s*:\s*(.+?)\s*$/i.exec(line)
    if (!matched) continue
    const value = matched[2].replace(/^"|"$/g, '')
    if (!value) continue
    if (matched[1].toLowerCase() === 'root') result.root = value
    else result.path = value
  }
  return result
}

/**
 * 列出 root 下所有可用的版本，从高到低。
 * 只认 vX.Y.Z 且带 node.exe 的目录，nvm 自己的下载缓存（.zip / tmp）会被自然排除。
 */
export function listInstalledVersions(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }

  const versions: string[] = []
  for (const name of entries) {
    if (!VERSION_DIR_RE.test(name)) continue
    if (!isNodeInstall(join(root, name))) continue
    versions.push(name.slice(1))
  }
  return sortVersions(versions)
}

/** 版本号从高到低；纯数字比较，避免 9 > 10 的字符串坑 */
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    for (let i = 0; i < 3; i += 1) {
      const diff = (right[i] ?? 0) - (left[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  })
}

/** nvm 根目录的候选位置：环境变量 > nvm-windows 默认安装位置 > PATH 上的 nvm.exe */
function rootCandidates(): string[] {
  const list: string[] = []

  const home = process.env.NVM_HOME?.trim()
  if (home) list.push(home)

  const appData = process.env.APPDATA?.trim()
  if (appData) list.push(join(appData, 'nvm'))

  for (const entry of (process.env.PATH ?? '').split(win32.delimiter)) {
    const dir = entry.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    if (existsSync(join(dir, 'nvm.exe'))) list.push(dir)
  }

  return [...new Set(list)]
}

/** 定位 nvm 根目录：候选目录里的 settings.txt 会给出真正的 root */
export function resolveNvmRoot(): string | null {
  for (const candidate of rootCandidates()) {
    if (!isDirectorySync(candidate)) continue

    const configured = readNvmSettings(candidate).root
    if (configured && isDirectorySync(configured)) return configured

    if (existsSync(join(candidate, 'nvm.exe')) || listInstalledVersions(candidate).length > 0) {
      return candidate
    }
  }
  return null
}

/** NVM_SYMLINK：环境变量优先，其次 settings.txt 里的 path */
function resolveSymlink(root: string): string | undefined {
  const fromEnv = process.env.NVM_SYMLINK?.trim()
  if (fromEnv) return fromEnv

  const configured = readNvmSettings(root).path
  if (configured) return configured

  return undefined
}

/** 软链指向哪个版本（junction 与 symlink 都能被 realpath 解析） */
function versionOfSymlink(symlink?: string): string | undefined {
  if (!symlink) return undefined
  try {
    const target = basename(realpathSync(symlink))
    return VERSION_DIR_RE.test(target) ? target.slice(1) : undefined
  } catch {
    return undefined
  }
}

/** 去掉 v 前缀和空白，统一成 nvm 目录用的写法 */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/**
 * 把声明里的版本映射到具体已安装版本：
 * 先精确匹配，「20」/「20.20」这种段前缀再匹配到该段内最高的版本（.nvmrc 里很常见）。
 */
export function matchInstalledVersion(version: string, installed: string[]): string | null {
  const wanted = normalizeVersion(version)
  if (!wanted) return null

  if (installed.includes(wanted)) return wanted

  const wantedParts = wanted.split('.').filter(Boolean)
  if (wantedParts.some((part) => !/^\d+$/.test(part))) return null

  for (const candidate of sortVersions(installed)) {
    const parts = candidate.split('.')
    if (wantedParts.every((part, index) => parts[index] === part)) return candidate
  }
  return null
}

/** 某个版本对应的安装目录，找不到返回 null */
export function findNodeDir(version: string): string | null {
  const root = resolveNvmRoot()
  if (!root) return null

  const installed = listInstalledVersions(root)
  const matched = matchInstalledVersion(version, installed)
  if (!matched) return null

  const dir = join(root, `v${matched}`)
  return isNodeInstall(dir) ? dir : null
}

/** 当前系统在用的 node 版本（即 nvm 软链指向的版本） */
export function getNvmStatus(): NvmStatus {
  const root = resolveNvmRoot()
  if (!root) {
    return {
      available: false,
      versions: [],
      error: '未找到 nvm：NVM_HOME、%APPDATA%\\nvm 与 PATH 里都没有它的安装目录'
    }
  }

  const versions = listInstalledVersions(root)
  const symlink = resolveSymlink(root)

  return {
    available: true,
    root,
    symlink,
    current: versionOfSymlink(symlink),
    versions,
    error: versions.length ? undefined : '这个 nvm 目录下还没有已安装的 Node 版本'
  }
}

/** 环境变量里 PATH 的实际键名（Windows 上可能是 Path / PATH） */
function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

export interface NodeRuntime {
  /** 实际生效的完整版本号 */
  version: string
  /** 版本安装目录 */
  dir: string
  /** 在基础环境上注入好 PATH 的环境变量 */
  env: NodeJS.ProcessEnv
}

/**
 * 为指定版本准备子进程环境：把版本目录前置到 PATH，
 * 这样 shell 里的 node / npm / npx 都会解析到该版本。
 * 版本为空或没装则返回 null，由调用方决定是拦截还是照常执行。
 */
export function nodeEnvFor(
  version: string | undefined,
  base: NodeJS.ProcessEnv = process.env
): NodeRuntime | null {
  const wanted = version?.trim()
  if (!wanted) return null

  const dir = findNodeDir(wanted)
  if (!dir) return null

  const key = pathKeyOf(base)
  const inherited = base[key] ?? ''
  const env: NodeJS.ProcessEnv = { ...base, [key]: inherited ? `${dir}${win32.delimiter}${inherited}` : dir }

  return { version: basename(dir).slice(1), dir, env }
}
