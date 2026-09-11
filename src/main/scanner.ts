import { promises as fs, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { PackageManager, ScanResult } from '../shared/types'
import {
  BUILD_TOOLS,
  TOOL_CONFIG_FILES,
  detectBuildTool,
  guessDevPort,
  type BuildTool,
  type DevPortGuess
} from '../shared/dev-port'

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

const OUTPUT_DIR_CANDIDATES = [
  'dist',
  'dist_electron',
  'build',
  'out',
  join('docs', '.vitepress', 'dist')
]

const SCRIPT_NAME_RE = /^[A-Za-z0-9_:.-]+$/

/** 脚本名必须由调用方校验后再拼进命令行，避免注入 */
export function isValidScriptName(name: string): boolean {
  return SCRIPT_NAME_RE.test(name)
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

function existsDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 目录存在且有内容——产物目录探测要求「非空」，空目录不算命中（F-5.2） */
export async function isNonEmptyDir(target: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(target)
    return entries.length > 0
  } catch {
    return false
  }
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
  root: string
): Promise<{ pm: PackageManager; lockFile?: string }> {
  for (const [file, pm] of LOCK_FILES) {
    const content = await readIfExists(join(root, file))
    if (content !== null) return { pm, lockFile: file }
  }
  return { pm: 'npm' }
}

/** 只读构建配置里声明的产物目录，不看磁盘现状 */
export async function detectConfiguredOutputDir(root: string): Promise<string | undefined> {
  const viteConfigs = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs']
  for (const name of viteConfigs) {
    const text = await readIfExists(join(root, name))
    const matched = text?.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/)
    if (matched) return matched[1].replace(/\\/g, '/')
  }

  const vueConfig = await readIfExists(join(root, 'vue.config.js'))
  const vueMatched = vueConfig?.match(/outputDir\s*:\s*['"`]([^'"`]+)['"`]/)
  if (vueMatched) return vueMatched[1].replace(/\\/g, '/')

  return undefined
}

/** 配置优先，其次猜常见目录名（要求已存在且非空） */
async function detectOutputDir(root: string): Promise<string | undefined> {
  const configured = await detectConfiguredOutputDir(root)
  if (configured) return configured

  for (const candidate of OUTPUT_DIR_CANDIDATES) {
    if (await isNonEmptyDir(join(root, candidate))) return candidate.replace(/\\/g, '/')
  }
  return undefined
}

/** Node 版本要求：package.json 的 engines.node 优先，其次 .nvmrc */
async function detectNodeRequirement(
  root: string,
  enginesNode?: string
): Promise<{ value?: string; from?: 'engines' | 'nvmrc' }> {
  const declared = enginesNode?.trim()
  if (declared) return { value: declared, from: 'engines' }

  const nvmrc = (await readIfExists(join(root, '.nvmrc')))?.trim()
  if (nvmrc) return { value: nvmrc, from: 'nvmrc' }

  return {}
}

/** 读出该工具实际存在的那份配置文件 */
async function readToolConfig(
  root: string,
  tool: BuildTool
): Promise<{ name: string; text: string } | undefined> {
  for (const name of TOOL_CONFIG_FILES[tool]) {
    const text = await readIfExists(join(root, name))
    if (text !== null) return { name, text }
  }
  return undefined
}

/** 依赖里看不出工具时，退一步看项目里放着哪家的配置文件 */
async function detectToolByConfigFile(
  root: string
): Promise<{ tool: BuildTool; file: { name: string; text: string } } | undefined> {
  for (const tool of BUILD_TOOLS) {
    const file = await readToolConfig(root, tool)
    if (file) return { tool, file }
  }
  return undefined
}

/**
 * 监听端口推断：配置文件 → 启动脚本参数 → 工具默认值。
 * 工具本身也在这里定下来（依赖优先，配置文件兜底），界面据此解释端口是怎么来的。
 */
async function detectDevPort(
  root: string,
  deps: Record<string, string | undefined>,
  serveCommand?: string
): Promise<{ tool?: BuildTool; guess?: DevPortGuess }> {
  let tool = detectBuildTool(deps)
  let configFile = tool ? await readToolConfig(root, tool) : undefined

  if (!tool) {
    const byFile = await detectToolByConfigFile(root)
    if (byFile) {
      tool = byFile.tool
      configFile = byFile.file
    }
  }

  return { tool, guess: guessDevPort({ tool, configFile, serveCommand }) }
}

/** 读取并分析一个项目目录，得到可用于添加项目预览的结果 */
export async function scanProject(dirPath: string): Promise<ScanResult> {
  const empty: ScanResult = {
    ok: false,
    name: '',
    version: '',
    framework: '',
    detectedPackageManager: 'npm',
    build: [],
    allScripts: []
  }

  if (!existsDir(dirPath)) {
    return { ...empty, error: '目录不存在或不是文件夹' }
  }

  const raw = await readIfExists(join(dirPath, 'package.json'))
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
      name: basename(dirPath),
      error: 'package.json 解析失败，文件格式可能已损坏'
    }
  }

  const scripts = pkg.scripts ?? {}
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const { pm, lockFile } = await detectPackageManager(dirPath)
  const outputDir = await detectOutputDir(dirPath)
  const serve = pickServe(scripts)
  const nodeRequirement = await detectNodeRequirement(dirPath, pkg.engines?.node)
  const { tool, guess } = await detectDevPort(dirPath, deps, serve ? scripts[serve] : undefined)

  return {
    ok: true,
    name: pkg.name || basename(dirPath),
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
