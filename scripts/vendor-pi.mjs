/**
 * 把 Pi（`@earendil-works/pi-coding-agent`，AI 助手页用的那个开源编码 Agent）按**瘦身方案**
 * 随包内置到 `resources/pi/`：构建 / 开发前跑一次，装好并删掉运行时用不到的云厂商 SDK。
 *
 * 为什么瘦身：完整依赖树 143MB，其中约一半是各家云厂商的 SDK（AWS Bedrock、Google Gemini、
 * `@anthropic-ai/sdk`、`openai`、esbuild、web-streams-polyfill）。Pi 的提供方层走它自己的
 * HTTP 客户端，这些 SDK **运行时不需要** —— 实测删掉之后 Anthropic / OpenAI / DeepSeek 三条
 * 提供方路径都照常发出真实请求（Anthropic / DeepSeek 拿到了真实的 401/403 回包）。
 * 瘦身后 75MB，经 NSIS 的 LZMA 压缩只给安装包增加约 10MB。
 *
 * 版本**钉死**在下面这个常量：Pi 迭代很快，CLI 与事件协议要当成外部契约对待（与 AGENTS.md
 * 「TypeScript 版本不要动」同一条思路）。升级 = 改这里 + 重跑 `npm run vendor:pi` + 把
 * constraints/ai.md 里那份瘦身验证重新做一遍（假 key 打一轮每家要用的提供方）。
 *
 * 落点 `resources/pi/` 不进版本库（见 .gitignore），由这份脚本在构建 / 开发前生成；
 * 运行时的解析规则见 src-tauri/src/ai.rs 的 `resolve_cli`（打包走 resource_dir，
 * 开发态读仓库目录 —— 与内置壁纸同一条路子）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 钉死的 Pi 版本；升级要连着 constraints/ai.md 的瘦身验证一起重做 */
const PI_VERSION = '0.87.1'
const TARGET = join(root, 'resources', 'pi')
const STAMP = join(TARGET, '.pi-version')
/** Pi 的 CLI 入口（存在即认为这份树是好的） */
const CLI = join(
  TARGET,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'bundle',
  'cli.js'
)

/**
 * 删掉的目录（相对 node_modules）。判据见文件头：只删「运行时已验证不需要」的 ——
 * 每一项都拿假 key 打过真实请求。别顺手多删：`undici`、`typebox`、`photon-node`
 * 这些是 Pi 自己的运行时依赖。
 */
const PRUNE = [
  '@aws-sdk',
  '@smithy',
  '@google',
  '@esbuild',
  'openai',
  '@anthropic-ai',
  'web-streams-polyfill'
]

if (existsSync(CLI) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === PI_VERSION) {
  console.log(`[vendor-pi] Pi ${PI_VERSION} 已内置，跳过`)
  process.exit(0)
}

console.log(`[vendor-pi] 安装 @earendil-works/pi-coding-agent@${PI_VERSION} …`)
rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })
writeFileSync(join(TARGET, 'package.json'), JSON.stringify({ private: true }, null, 2))

execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `@earendil-works/pi-coding-agent@${PI_VERSION}`], {
  cwd: TARGET,
  stdio: 'inherit',
  shell: true
})

for (const dir of PRUNE) {
  rmSync(join(TARGET, 'node_modules', dir), { recursive: true, force: true })
}

if (!existsSync(CLI)) {
  console.error('[vendor-pi] 安装结果里找不到 CLI 入口，内置失败')
  process.exit(1)
}
writeFileSync(STAMP, PI_VERSION)
console.log(`[vendor-pi] 完成：Pi ${PI_VERSION} 已内置到 resources/pi/`)
