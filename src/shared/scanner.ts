/**
 * 项目目录扫描：读 package.json / 锁文件 / 构建配置，得出添加项目预览所需的一切。
 *
 * 与 Electron 版的唯一区别是 **fs 访问被抽成参数**（`ScanFs`）。这么做的原因有两个：
 *  - Tauri 下文件读取在 Rust 侧，逻辑必须留在 TS 才不用重写一遍；
 *  - 测试可以直接注入一份 node:fs 实现，于是既有那批「真实临时目录」的用例
 *    能原样留在 vitest 里跑，不必为了换运行时把测试改成 Rust。
 */
import type { PackageManager, ScanResult } from './types'
import { resolveWithinProject } from './project-path'
import {
  BUILD_TOOLS,
  TOOL_CONFIG_FILES,
  detectBuildTool,
  guessDevPort,
  type BuildTool,
  type DevPortGuess
} from './dev-port'

/** 扫描需要的最小文件系统能力；由宿主提供（生产走 Rust 命令，测试走 node:fs） */
export interface ScanFs {
  /** 读文本文件；不存在或读不出来返回 null */
  readText(path: string): Promise<string | null>
  /** 路径存在且是目录 */
  isDirectory(path: string): Promise<boolean>
  /** 列目录下的条目名；目录不存在返回空数组 */
  listDir(path: string): Promise<string[]>
}

/**
 * 拼接路径。刻意只用正斜杠：Windows 的文件 API 都认它，
 * 于是不必区分宿主用的是哪种分隔符，测试里传进来的 node:path 结果也照样能用。
 */
export function joinPath(base: string, relative: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${relative}`
}

/** 路径最后一段 */
export function baseName(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? target
}

const LOCK_FILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm']
]

/** 按顺序匹配，命中即返回 */
const FRAMEWORK_RULES: Array<[string, string]> = [
  ['@tarojs/taro', 'Taro'],
  ['vitepress', 'VitePress'],
  ['nuxt', 'Nuxt'],
  ['next', 'Next.js'],
  ['@vue/cli-service', 'Vue CLI'],
  ['react-scripts', 'Create React App'],
  ['@umijs/core', 'Umi'],
  ['umi', 'Umi'],
  ['vite', 'Vite'],
  ['rollup', 'Rollup'],
  ['webpack', 'Webpack'],
  ['esbuild', 'esbuild'],
  ['parcel', 'Parcel']
]

const OUTPUT_DIR_CANDIDATES = ['dist', 'dist_electron', 'build', 'out', 'docs/.vitepress/dist']

const SCRIPT_NAME_RE = /^[A-Za-z0-9_:.-]+$/

/** 脚本名必须由调用方校验后再拼进命令行，避免注入 */
export function isValidScriptName(name: string): boolean {
  return SCRIPT_NAME_RE.test(name)
}

/** 目录存在且有内容——产物目录探测要求「非空」，空目录不算命中 */
export async function isNonEmptyDir(scan: ScanFs, target: string): Promise<boolean> {
  const entries = await scan.listDir(target)
  return entries.length > 0
}

/** 启动脚本优先级：serve > dev > start > 含 dev 的变体 > 含 serve 的变体 */
export function pickServe(scripts: Record<string, string>): string | undefined {
  for (const name of ['serve', 'dev', 'start']) {
    if (scripts[name]) return name
  }
  const keys = Object.keys(scripts)
  return (
    keys.find((k) => /(^|[:.])dev([:.]|$)/.test(k)) ??
    keys.find((k) => /(^|[:.])serve([:.]|$)/.test(k))
  )
}

/** build / build:prod / docs:build 都算打包命令 */
export function pickBuild(scripts: Record<string, string>): string[] {
  return Object.keys(scripts).filter((k) => /(^|[:.])build([:.]|$)/.test(k))
}

export function detectFramework(deps: Record<string, string>): string {
  for (const [pkg, label] of FRAMEWORK_RULES) {
    if (deps[pkg]) return label
  }
  return 'Node'
}

export async function detectPackageManager(
  scan: ScanFs,
  root: string
): Promise<{ pm: PackageManager; lockFile?: string }> {
  for (const [file, pm] of LOCK_FILES) {
    const content = await scan.readText(joinPath(root, file))
    if (content !== null) return { pm, lockFile: file }
  }
  return { pm: 'npm' }
}

/**
 * 只读构建配置里声明的产物目录，不看磁盘现状。
 *
 * 配置文件候选直接复用 dev-port 的 TOOL_CONFIG_FILES：以前这里手抄了一份 vite 列表，
 * 漏掉了 .mts / .cts，导致 outDir 只写在 vite.config.mts 里的项目探测不到，
 * 而端口推断却能读到 —— 同一个「读 vite 配置」的动作走两套清单迟早会漂。
 */
export async function detectConfiguredOutputDir(
  scan: ScanFs,
  root: string
): Promise<string | undefined> {
  for (const name of TOOL_CONFIG_FILES.vite) {
    const text = await scan.readText(joinPath(root, name))
    const matched = text?.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/)
    if (matched) return matched[1].replace(/\\/g, '/')
  }

  for (const name of TOOL_CONFIG_FILES['vue-cli']) {
    const text = await scan.readText(joinPath(root, name))
    const matched = text?.match(/outputDir\s*:\s*['"`]([^'"`]+)['"`]/)
    if (matched) return matched[1].replace(/\\/g, '/')
  }

  return undefined
}

/**
 * 配置优先，其次猜常见目录名（要求已存在且非空）。
 * 打包完成后「去哪个目录找产物」也走这里，避免再维护一份候选清单。
 */
export async function detectOutputDir(scan: ScanFs, root: string): Promise<string | undefined> {
  const configured = await detectConfiguredOutputDir(scan, root)
  if (configured) return configured

  for (const candidate of OUTPUT_DIR_CANDIDATES) {
    if (await isNonEmptyDir(scan, joinPath(root, candidate))) return candidate
  }
  return undefined
}

/**
 * 打包成功后该打开哪个目录：手动配置 > 构建配置声明的 outDir > 常见目录名，都没有就回退项目根。
 *
 * 手动配置与探测结果都要求「存在且非空」——产物目录是给用户看结果的，
 * 打开一个空目录（首次打包失败时就是这样）不如让他对着项目根自己找。
 * `detected: false` 表示上面两档都没命中，调用方据此提示用户。
 */
export async function resolveOutputDir(
  scan: ScanFs,
  root: string,
  configured = ''
): Promise<{ dir: string; detected: boolean }> {
  const manual = resolveWithinProject(root, configured)
  if (manual && (await isNonEmptyDir(scan, manual))) return { dir: manual, detected: true }

  const found = await detectOutputDir(scan, root)
  if (found) return { dir: resolveWithinProject(root, found), detected: true }

  return { dir: root, detected: false }
}

/** Node 版本要求：package.json 的 engines.node 优先，其次 .nvmrc */
async function detectNodeRequirement(
  scan: ScanFs,
  root: string,
  enginesNode?: string
): Promise<{ value?: string; from?: 'engines' | 'nvmrc' }> {
  const declared = enginesNode?.trim()
  if (declared) return { value: declared, from: 'engines' }

  const nvmrc = (await scan.readText(joinPath(root, '.nvmrc')))?.trim()
  if (nvmrc) return { value: nvmrc, from: 'nvmrc' }

  return {}
}

/** 读出该工具实际存在的那份配置文件 */
async function readToolConfig(
  scan: ScanFs,
  root: string,
  tool: BuildTool
): Promise<{ name: string; text: string } | undefined> {
  for (const name of TOOL_CONFIG_FILES[tool]) {
    const text = await scan.readText(joinPath(root, name))
    if (text !== null) return { name, text }
  }
  return undefined
}

/** 依赖里看不出工具时，退一步看项目里放着哪家的配置文件 */
async function detectToolByConfigFile(
  scan: ScanFs,
  root: string
): Promise<{ tool: BuildTool; file: { name: string; text: string } } | undefined> {
  for (const tool of BUILD_TOOLS) {
    const file = await readToolConfig(scan, root, tool)
    if (file) return { tool, file }
  }
  return undefined
}

/**
 * 监听端口推断：配置文件 → 启动脚本参数 → 工具默认值。
 * 工具本身也在这里定下来（依赖优先，配置文件兜底），界面据此解释端口是怎么来的。
 */
async function detectDevPort(
  scan: ScanFs,
  root: string,
  deps: Record<string, string | undefined>,
  serveCommand?: string
): Promise<{ tool?: BuildTool; guess?: DevPortGuess }> {
  let tool = detectBuildTool(deps)
  let configFile = tool ? await readToolConfig(scan, root, tool) : undefined

  if (!tool) {
    const byFile = await detectToolByConfigFile(scan, root)
    if (byFile) {
      tool = byFile.tool
      configFile = byFile.file
    }
  }

  return { tool, guess: guessDevPort({ tool, configFile, serveCommand }) }
}

/** 读取并分析一个项目目录，得到可用于添加项目预览的结果 */
export async function scanProject(scan: ScanFs, dirPath: string): Promise<ScanResult> {
  const empty: ScanResult = {
    ok: false,
    name: '',
    version: '',
    framework: '',
    detectedPackageManager: 'npm',
    build: [],
    allScripts: []
  }

  if (!(await scan.isDirectory(dirPath))) {
    return { ...empty, error: '目录不存在或不是文件夹' }
  }

  const raw = await scan.readText(joinPath(dirPath, 'package.json'))
  if (raw === null) {
    return { ...empty, error: '该目录下没有 package.json，不是有效的 Node 项目' }
  }

  let pkg: {
    name?: string
    version?: string
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    engines?: { node?: string }
  }
  try {
    pkg = JSON.parse(raw)
  } catch {
    // 解析失败不直接拒绝：允许以「仅管理目录」的方式加入（设计文档 §7）
    return {
      ...empty,
      parseError: true,
      name: baseName(dirPath),
      error: 'package.json 解析失败，文件格式可能已损坏'
    }
  }

  const scripts = pkg.scripts ?? {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const { pm, lockFile } = await detectPackageManager(scan, dirPath)
  const outputDir = await detectOutputDir(scan, dirPath)
  const serve = pickServe(scripts)
  const nodeRequirement = await detectNodeRequirement(scan, dirPath, pkg.engines?.node)
  const { tool, guess } = await detectDevPort(scan, dirPath, deps, serve ? scripts[serve] : undefined)

  return {
    ok: true,
    name: pkg.name || baseName(dirPath),
    version: pkg.version || '0.0.0',
    framework: detectFramework(deps),
    detectedPackageManager: pm,
    lockFile,
    serve,
    build: pickBuild(scripts),
    allScripts: Object.keys(scripts),
    outputDir,
    enginesNode: nodeRequirement.value,
    nodeRequirementFrom: nodeRequirement.from,
    buildTool: tool,
    port: guess?.port,
    portFrom: guess?.from,
    portFile: guess?.file
  }
}
