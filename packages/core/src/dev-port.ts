/**
 * 认出开发服务的监听端口。
 *
 * 目前只覆盖三家构建工具：
 *   - Vite：vite.config.* 里的 server.port，默认 5173
 *   - Vue CLI：vue.config.* 里的 devServer.port，默认 8080
 *   - Rsbuild：rsbuild.config.* 里的 server.port，默认 3000
 *
 * 只做静态解析，不执行项目的配置代码：配置是 TS、是函数、是变量拼出来的，
 * 认得出字面量就认，认不出就退回启动脚本参数和工具默认值。
 * 为了一个端口去跑别人的配置，代价和风险都不值当。
 */

import { parsePort } from './port'

export type BuildTool = 'vite' | 'vue-cli' | 'rsbuild'

/** 展示用名称；与 scanner 的 framework 标签保持同一套写法 */
export const BUILD_TOOL_LABEL: Record<BuildTool, string> = {
  vite: 'Vite',
  'vue-cli': 'Vue CLI',
  rsbuild: 'Rsbuild'
}

/** 工具没显式配置端口时的默认值 */
export const DEFAULT_DEV_PORT: Record<BuildTool, number> = {
  vite: 5173,
  'vue-cli': 8080,
  rsbuild: 3000
}

/** 各工具的配置文件，按优先级排列（.ts 在前，实际项目里最常见） */
export const TOOL_CONFIG_FILES: Record<BuildTool, string[]> = {
  vite: [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mts',
    'vite.config.mjs',
    'vite.config.cts',
    'vite.config.cjs'
  ],
  'vue-cli': ['vue.config.ts', 'vue.config.js'],
  rsbuild: [
    'rsbuild.config.ts',
    'rsbuild.config.js',
    'rsbuild.config.mts',
    'rsbuild.config.mjs',
    'rsbuild.config.cts',
    'rsbuild.config.cjs'
  ]
}

/** 配置里端口所在的键：Vue CLI 在 devServer，另外两家在 server */
export const TOOL_PORT_KEY: Record<BuildTool, string> = {
  vite: 'server',
  'vue-cli': 'devServer',
  rsbuild: 'server'
}

/** 工具在 package.json 里的标志性依赖；vite 最通用，排在最后免得误判 */
const TOOL_DEPENDENCIES: Array<[string, BuildTool]> = [
  ['@rsbuild/core', 'rsbuild'],
  ['@vue/cli-service', 'vue-cli'],
  ['vite', 'vite']
]

export const BUILD_TOOLS: BuildTool[] = ['vite', 'vue-cli', 'rsbuild']

/** 只按依赖判断，不看配置文件；配置文件的探测要读磁盘，交给主进程 */
export function detectBuildTool(deps: Record<string, string | undefined>): BuildTool | undefined {
  for (const [dependency, tool] of TOOL_DEPENDENCIES) {
    if (deps[dependency]) return tool
  }
  return undefined
}

export type PortSource = 'config' | 'script' | 'default'

export interface DevPortGuess {
  port: number
  /** 端口是怎么来的，界面按它组织提示文案 */
  from: PortSource
  /** from === 'config' 时的配置文件名 */
  file?: string
}

/**
 * 依次尝试：配置文件 → 启动脚本参数 → 工具默认值。
 * 三样都给不出结果（既认不出工具、脚本里也没有参数）时返回 undefined。
 */
export function guessDevPort(input: {
  tool?: BuildTool
  configFile?: { name: string; text: string }
  serveCommand?: string
}): DevPortGuess | undefined {
  const { tool, configFile, serveCommand } = input

  if (tool && configFile) {
    const fromConfig = parsePortFromConfig(configFile.text, tool)
    if (fromConfig) return { port: fromConfig, from: 'config', file: configFile.name }
  }

  if (serveCommand) {
    const fromScript = parsePortFromScript(serveCommand, tool)
    if (fromScript) return { port: fromScript, from: 'script' }
  }

  if (tool) return { port: DEFAULT_DEV_PORT[tool], from: 'default' }
  return undefined
}

/** 从配置文本里读 server.port / devServer.port 的字面量 */
export function parsePortFromConfig(text: string, tool: BuildTool): number | undefined {
  const body = objectBodyAfter(stripComments(text), TOOL_PORT_KEY[tool])
  if (body === null) return undefined
  return readPortLiteral(body)
}

/**
 * 从启动命令里读端口参数：--port 9000 / --port=9000 / PORT=9000。
 * -p 只有 Vite 有明确定义（-p, --port），别的工具上可能另有含义，不猜。
 */
export function parsePortFromScript(command: string, tool?: BuildTool): number | undefined {
  const long = command.match(/--port[=\s]+(\d{1,5})/)
  if (long) return parsePort(long[1])

  const env = command.match(/\bPORT\s*=\s*(\d{1,5})/)
  if (env) return parsePort(env[1])

  if (tool === 'vite') {
    const short = command.match(/(?:^|\s)-p\s+(\d{1,5})(?=\s|$)/)
    if (short) return parsePort(short[1])
  }
  return undefined
}

/** 取 `key: { ... }` 里那对大括号之间的内容；不是对象字面量时返回 null */
function objectBodyAfter(code: string, key: string): string | null {
  const matched = new RegExp(`(?:^|[^\\w$])${key}\\s*:\\s*\\{`).exec(code)
  if (!matched) return null

  const start = matched.index + matched[0].length
  let depth = 1
  for (let i = start; i < code.length; i += 1) {
    const char = code[i]
    if (char === '"' || char === "'" || char === '`') {
      i = skipString(code, i)
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return code.slice(start, i)
    }
  }
  return null
}

/** 在一段对象字面量里找 port: 5173 这样的字面量 */
function readPortLiteral(text: string): number | undefined {
  const matched = text.match(/\bport\s*:\s*['"`]?(\d{1,5})['"`]?/)
  return matched ? parsePort(matched[1]) : undefined
}

/** 跳过一段字符串（'..' / ".." / `..`），返回结束引号的下标 */
function skipString(code: string, start: number): number {
  const quote = code[start]
  for (let i = start + 1; i < code.length; i += 1) {
    if (code[i] === '\\') {
      i += 1
      continue
    }
    if (code[i] === quote) return i
  }
  return code.length - 1
}

/** 去掉注释：注释掉的端口不是配置，别让它盖过真实值 */
function stripComments(code: string): string {
  let out = ''
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i]

    if (char === '"' || char === "'" || char === '`') {
      const end = skipString(code, i)
      out += code.slice(i, end + 1)
      i = end
      continue
    }

    if (char === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      i = end === -1 ? code.length : end
      continue
    }

    if (char === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end === -1 ? code.length : end + 1
      continue
    }

    out += char
  }
  return out
}

/**
 * 从 dev server 的启动输出里认出监听端口。
 *
 * 只有项目配置里手填了 port 时才走配置；没填的时候，日志里的 `localhost:5173` 这类
 * 输出就是唯一的线索 —— 卡片上显示的端口、以及「端口被占用」的检查都靠它。
 * 认不出的返回 undefined，调用方据此跳过占用检查。
 */
const LOG_PORT_RE = /(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)[:/](\d{2,5})/i

export function parsePortFromLog(text: string): number | undefined {
  const matched = LOG_PORT_RE.exec(text)
  if (!matched) return undefined

  const port = Number(matched[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}
