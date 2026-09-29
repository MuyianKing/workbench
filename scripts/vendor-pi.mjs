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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
/** Pi 自带的模型目录（models.dev 那份快照，按厂商一个 JSON）；预填表从这儿剪出来 */
const CATALOG_SOURCE = join(
  TARGET,
  'node_modules',
  '@earendil-works',
  'pi-ai',
  'dist',
  'providers',
  'data'
)
/** 预填表的落点：添加模型时认能力默认值（shared/ai.ts 的 builtinModelMeta），进版本库 */
const CATALOG_TARGET = join(root, 'src', 'shared', 'ai-builtin-models.generated.ts')

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

/**
 * Pi 自带的模型目录 → 预填表（`AI_BUILTIN_MODELS`）：每家一份、按模型 id 收**添加模型时
 * 要认默认值的那四样**（上下文 / 最大输出 / 思考 / 能不能看图），其余（价格、图片尺寸
 * 上限、各家 API 形态）都不带。这份表进版本库 —— 版本钉死所以内容确定，应用不连
 * models.dev、也不把目录当「模型清单」（清单仍然由端点自己报，它只管预填字段）。
 */
function emitCatalog() {
  const files = existsSync(CATALOG_SOURCE)
    ? readdirSync(CATALOG_SOURCE).filter((name) => name.endsWith('.json')).sort()
    : []
  if (!files.length) {
    console.error('[vendor-pi] 找不到 Pi 的内置模型数据（dist/providers/data），目录生成失败')
    process.exit(1)
  }
  const providers = {}
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(CATALOG_SOURCE, file), 'utf8'))
    const models = {}
    for (const api of Object.keys(raw).sort()) {
      for (const id of Object.keys(raw[api] ?? {}).sort()) {
        const model = raw[api][id] ?? {}
        models[id] = {
          ...(Number.isFinite(model.contextWindow) && model.contextWindow > 0
            ? { contextWindow: model.contextWindow }
            : {}),
          ...(Number.isFinite(model.maxTokens) && model.maxTokens > 0
            ? { maxTokens: model.maxTokens }
            : {}),
          ...(model.reasoning === true ? { reasoning: true } : {}),
          ...(Array.isArray(model.input) && model.input.includes('image') ? { image: true } : {})
        }
      }
    }
    const provider = file.replace(/\.json$/, '')
    if (Object.keys(models).length) providers[provider] = models
  }
  const header =
    `/* 由 scripts/vendor-pi.mjs 从内置 Pi（${PI_VERSION}）自带的模型目录生成 —— 勿手改，` +
    `重跑 npm run vendor:pi 再生。添加模型时的默认值就从这份表认（shared/ai.ts 的 builtinModelMeta）。 */\n`
  const body =
    'export interface AiBuiltinModelEntry {\n' +
    '  contextWindow?: number\n' +
    '  maxTokens?: number\n' +
    '  reasoning?: boolean\n' +
    '  image?: boolean\n' +
    '}\n\n' +
    'export const AI_BUILTIN_MODELS: Record<string, Record<string, AiBuiltinModelEntry>> = ' +
    JSON.stringify(providers) +
    '\n'
  // 内容没变就不动文件：每次 dev 启动都重写会让 mtime 一跳、vite 白推一轮 HMR 更新
  const next = header + body
  if (existsSync(CATALOG_TARGET) && readFileSync(CATALOG_TARGET, 'utf8') === next) {
    console.log('[vendor-pi] 内置模型目录没有变化，跳过生成')
    return
  }
  writeFileSync(CATALOG_TARGET, next)
  console.log(
    `[vendor-pi] 内置模型目录已生成：${CATALOG_TARGET}（${Object.keys(providers).length} 家）`
  )
}

if (existsSync(CLI) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === PI_VERSION) {
  emitCatalog()
  console.log(`[vendor-pi] Pi ${PI_VERSION} 已内置，跳过安装`)
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
emitCatalog()
console.log(`[vendor-pi] 完成：Pi ${PI_VERSION} 已内置到 resources/pi/`)
