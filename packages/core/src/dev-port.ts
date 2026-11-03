/**
 * 开发服务的监听端口。
 *
 * 端口不再由用户手填：项目启动后从日志里认出实际监听的那个写回项目，
 * 停止时清掉（见 docs/modules/projects.md）。这里只剩「从日志认端口」与「拼本地地址」两件事；
 * 各构建工具的配置文件清单仍放在这里，产物目录探测（scanner）复用它。
 */

export type BuildTool = 'vite' | 'vue-cli' | 'rsbuild'

/** 各工具的配置文件，按优先级排列（.ts 在前，实际项目里最常见）；产物目录探测也读这份清单 */
export const TOOL_CONFIG_FILES: Record<BuildTool, string[]> = {
  'vite': [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mts',
    'vite.config.mjs',
    'vite.config.cts',
    'vite.config.cjs',
  ],
  'vue-cli': ['vue.config.ts', 'vue.config.js'],
  'rsbuild': [
    'rsbuild.config.ts',
    'rsbuild.config.js',
    'rsbuild.config.mts',
    'rsbuild.config.mjs',
    'rsbuild.config.cts',
    'rsbuild.config.cjs',
  ],
}

/**
 * 从 dev server 的启动输出里认出监听端口。
 *
 * 日志里的 `localhost:5173` 这类输出是端口唯一的线索：卡片上显示的端口、写回项目的值、
 * 以及「端口被占用」的检查都靠它。认不出的返回 undefined，调用方据此跳过占用检查。
 */
const LOG_PORT_RE = /(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)[:/](\d{2,5})/i

export function parsePortFromLog(text: string): number | undefined {
  const matched = LOG_PORT_RE.exec(text)
  if (!matched)
    return undefined

  const port = Number(matched[1])
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return undefined
  return port
}

/**
 * 开发服务的本地地址。
 *
 * 一律写 `localhost` 而不是 `127.0.0.1`：两者都通，但 Vite / vue-cli 的输出、以及用户
 * 自己敲的地址都是这个名字，卡片上显示什么、点开的就应该是同一个。
 * 结尾的 `/` 不能省 —— 少一节路径时浏览器补的是空路径，某些 dev server 会走一次重定向。
 */
export function devServerUrl(port: number): string {
  return `http://localhost:${port}/`
}
