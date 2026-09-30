/**
 * 把 Pi（`@earendil-works/pi-coding-agent`，AI 助手页用的那个开源编码 Agent）按**瘦身方案**
 * 随包内置到 `resources/pi/`：构建 / 开发前跑一次，装好并删掉运行时用不到的云厂商 SDK。
 *
 * 为什么瘦身：完整依赖树 385MB，其中 284MB 是 `@esbuild` 的 26 份平台二进制、其余是各家云厂商
 * 的 SDK（AWS Bedrock、Google Gemini、`@anthropic-ai/sdk`、`openai`、web-streams-polyfill）。
 * **这些 SDK 运行时不需要**：应用跑的是 `dist/bundle/cli.js` 那份 bundle（提供方实现按形态内联
 * 在它自己的 chunks 里、SDK 也一并内联），树里 `pi-ai/dist/api/*.js` 那几份静态 import SDK 的
 * 副本谁也加载不到 —— 删掉之后两条提供方路径照常发出真实请求（2026-09-29 用假端点验过
 * `openai-completions` 与 `anthropic-messages`，见 constraints/ai.md）。瘦身后 59MB。
 *
 * 版本**钉死**在下面这个常量：Pi 迭代很快，CLI 与事件协议要当成外部契约对待（与 AGENTS.md
 * 「TypeScript 版本不要动」同一条思路）。升级 = 改这里 + 重跑 `pnpm run vendor:pi` + 把
 * constraints/ai.md 里那份瘦身验证重新做一遍（假 key 打一轮每家要用的提供方）。
 *
 * 落点 `resources/pi/` 不进版本库（见 .gitignore），由这份脚本在构建 / 开发前生成；
 * 运行时的解析规则见 src-tauri/src/ai.rs 的 `resolve_cli`（打包走 resource_dir，
 * 开发态读仓库目录 —— 与内置壁纸同一条路子）。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 钉死的 Pi 版本；升级要连着 constraints/ai.md 的瘦身验证一起重做 */
const PI_VERSION = '0.87.1'
const TARGET = join(root, 'resources', 'pi')
const STAMP = join(TARGET, '.pi-version')
/** Pi 的 CLI 入口（与模型目录一起，当作「这份树是好的」的判据） */
const CLI = join(
  TARGET,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'bundle',
  'cli.js'
)
/** 预填表的落点：添加模型时认能力默认值（@workbench/ai 的 builtinModelMeta），进版本库 */
const CATALOG_TARGET = join(root, '..', '..', 'packages', 'ai', 'src', 'ai-builtin-models.generated.ts')

/**
 * 删掉的包（`node_modules/<这里这一项>`，落在哪一层都删——见 findDeps）。判据见文件头：
 * 只删「运行时已验证不需要」的 —— 每一项都拿假端点打过真实请求；实际跑的是 `cli.js` 那份
 * 自带的 bundle（`dist/bundle/chunks`，提供方实现已内联），它真正要的外部包只有
 * `@earendil-works/chord`、`typebox`、`undici`、`@silvia-odwyer/photon-node` 这几个。
 * 别顺手多删。
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
 * 找一个依赖在 `resources/pi` 里的落点 —— **不假定它在哪一层**。pi-coding-agent 带着自己的
 * `npm-shrinkwrap.json`，npm 会把它整棵依赖树嵌进它自己的 `node_modules` 下（顶层只剩
 * `@earendil-works` 一项，`pi-ai`、`openai` 这些都在里面）；换个版本也可能又提升到顶层。
 * 所以按「任意深度的 node_modules」找，同一份包在不同分支各存一份时全都拿到。
 */
function findDeps(name, dir = TARGET) {
  const modules = join(dir, 'node_modules')
  if (!existsSync(modules)) return []
  const found = existsSync(join(modules, name)) ? [join(modules, name)] : []
  for (const entry of readdirSync(modules)) {
    if (entry === '.bin') continue
    const children = entry.startsWith('@')
      ? readdirSync(join(modules, entry)).map((sub) => `${entry}/${sub}`)
      : [entry]
    for (const child of children) {
      found.push(...findDeps(name, join(modules, child)))
    }
  }
  return found
}

/** Pi 自带的模型目录（models.dev 那份快照，按厂商一个 JSON）；预填表从这儿剪出来 */
function catalogSource() {
  return findDeps('@earendil-works/pi-ai')
    .map((dir) => join(dir, 'dist', 'providers', 'data'))
    .find((dir) => existsSync(dir))
}

function dirSize(dir) {
  const info = statSync(dir, { throwIfNoEntry: false })
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  return readdirSync(dir).reduce((sum, entry) => sum + dirSize(join(dir, entry)), 0)
}

const mb = (bytes) => (bytes / 1048576).toFixed(1)

/**
 * Pi 自带的模型目录 → 预填表（`AI_BUILTIN_MODELS`）：每家一份、按模型 id 收**添加模型时
 * 要认默认值的那四样**（上下文 / 最大输出 / 思考 / 能不能看图），其余（价格、图片尺寸
 * 上限、各家 API 形态）都不带。这份表进版本库 —— 版本钉死所以内容确定，应用不连
 * models.dev、也不把目录当「模型清单」（清单仍然由端点自己报，它只管预填字段）。
 */
function emitCatalog() {
  const source = catalogSource()
  const files = source
    ? readdirSync(source).filter((name) => name.endsWith('.json')).sort()
    : []
  if (!source || !files.length) {
    console.error('[vendor-pi] 找不到 Pi 的内置模型数据（dist/providers/data），目录生成失败')
    process.exit(1)
  }
  const providers = {}
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(source, file), 'utf8'))
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
    `重跑 pnpm run vendor:pi 再生。添加模型时的默认值就从这份表认（@workbench/ai 的 builtinModelMeta）。 */\n`
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

const hasCli =
  existsSync(CLI) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === PI_VERSION
const catalog = catalogSource()
/** 该瘦掉的还在 = 这份树不是本脚本产出的（比如旧版脚本删错了地方）—— 也重装 */
const leftover = PRUNE.filter((name) => findDeps(name).length)
if (hasCli && catalog && !leftover.length) {
  emitCatalog()
  console.log(`[vendor-pi] Pi ${PI_VERSION} 已内置，跳过安装`)
  process.exit(0)
}
if (hasCli) {
  const why = catalog ? `还有没瘦掉的：${leftover.join('、')}` : '里面没有模型目录'
  console.warn(`[vendor-pi] 内置的这套 Pi 不对（${why}），重装一遍`)
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

// 删到的与没删到的都要看得见：这些包不在顶层是常态（见 findDeps），落点一旦又变，
// 静态的路径列表会一声不响地整个空转 —— 那正是「以为瘦了、其实一兆没少」
let freed = 0
for (const name of PRUNE) {
  const dirs = findDeps(name)
  if (!dirs.length) {
    console.warn(
      `[vendor-pi] 警告：${name} 没找到，这一项没有瘦掉（新版可能不再随包，别处要求过就改这里）`
    )
    continue
  }
  const size = dirs.reduce((sum, dir) => sum + dirSize(dir), 0)
  freed += size
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  console.log(`[vendor-pi] 删掉 ${name}（${mb(size)} MB）`)
}
console.log(`[vendor-pi] 瘦身省下 ${mb(freed)} MB，resources/pi 现有 ${mb(dirSize(TARGET))} MB`)

if (!existsSync(CLI)) {
  console.error('[vendor-pi] 安装结果里找不到 CLI 入口，内置失败')
  process.exit(1)
}
writeFileSync(STAMP, PI_VERSION)
emitCatalog()
console.log(`[vendor-pi] 完成：Pi ${PI_VERSION} 已内置到 resources/pi/`)
