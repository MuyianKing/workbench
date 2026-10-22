/**
 * 把 Pi（`@earendil-works/pi-coding-agent`，AI 助手页用的那个开源编码 Agent）按**瘦身方案**
 * 随包内置到 `resources/pi/`：构建 / 开发前跑一次，装好之后裁到「运行时真的会加载的那些」。
 *
 * 为什么瘦身：`npm install` 那套完整依赖树约 108MB、7000 多个文件，运行时碰都碰不到 ——
 * 源码映射、类型声明、`pi-coding-agent/dist` 里除 `bundle/` 之外的那几兆
 * （实际跑的是 `dist/bundle/cli.js` 这份自带全部提供方实现的 bundle）、文档配图 / 示例 /
 * CHANGELOG，以及云厂商 SDK、protobuf、google-auth、highlight.js、quickjs-wasi 这些整包。
 * 裁完 **12.8MB / 147 个文件**（固定压缩后进安装包约 2.3MB；没裁之前那套 55.6MB 的树是 9.7MB）。
 *
 * 连「装什么」也一起省了：**不再 `npm install` 整棵树**（那等于把 108MB 下下来再删九成），
 * 改成 `npm pack` 只取 Pi 自己的 tarball、再装 `jiti` 与 `photon-node` 两个小包 ——
 * 冷构建的下载量从几十兆降到十来兆，见 `extractPackage`。预填表的数据源（`pi-ai`）
 * 也是单下一份、读完就删。
 *
 * 判据不是「看着没用」，而是**运行时真的会加载它**：KEEP 里每一项都在裁完的树上用假端点
 * 探针验过（RPC 一轮：模型请求 → 权限确认 → 命令真跑 → `agent_settled`；两种 API 形态、
 * read/write/edit、`-ns --skill` 各一遍），见 docs/dev-notes/pi-session-probe.md。
 * 裁完还会跑一次 `node cli.js --version` 自检 —— 裁错了当场失败，不会等用户点开 AI 助手页
 * 才发现「权限确认没了」。
 *
 * 版本**钉死**在下面这个常量：Pi 迭代很快，CLI 与事件协议要当成外部契约对待（与 AGENTS.md
 * 「TypeScript 版本不要动」同一条思路）。升级 = 改这里 + 重跑 `pnpm run vendor:pi` +
 * 把 docs/dev-notes/pi-session-probe.md 那份验证重新做一遍（假端点打一轮每家要用的提供方）。
 * **改裁剪规则要连 `PRUNE_REVISION` 一起改**，否则已经装好的那棵树会被跳过判据放过。
 *
 * 落点 `resources/pi/` 不进版本库（见 .gitignore），由这份脚本在构建 / 开发前生成；
 * 运行时的解析规则见 src-tauri/src/ai.rs 的 `resolve_cli`（打包走 resource_dir，
 * 开发态读仓库目录 —— 与内置壁纸同一条路子）。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 钉死的 Pi 版本；升级要连着 docs/dev-notes/pi-session-probe.md 的验证一起重做 */
const PI_VERSION = '1.0.4'
/**
 * 裁剪方案的版本号。**动了 KEEP 或下面那几条文件级规则就必须 +1**：
 * 跳过判据比的是 stamp 文件内容，对不上才会重装重裁。
 */
const PRUNE_REVISION = '5'
/**
 * 预填表的数据源版本：`@earendil-works/pi-ai` 里那份 models.dev 快照（`dist/providers/data`）。
 * 它只被 `npm pack` 下来读一次、生成完就删 —— **不进树**，也不用跟着 pi-coding-agent 的
 * `^1.0.4` 范围漂。**升级 Pi 时这个版本要一起看**（数据变了，预填表的内容就会变）。
 */
const CATALOG_VERSION = '1.4.0'
/**
 * 树里除 Pi 本体之外真正需要的两个外部包。版本照 pi-coding-agent 自己 package.json 里钉的抄：
 * `jiti`（扩展加载器）与 `@silvia-odwyer/photon-node`（贴图缩放的 wasm）。
 * **不再整棵 `npm install`**：那样会把 AWS / Google / openai 这些 SDK 全下下来（约 108MB）
 * 再删掉 —— 这里只下载 Pi 的 tarball + 这两个小包，冷构建的等待从分钟级降到十几秒。
 */
const EXTRA_DEPS = {
  '@silvia-odwyer/photon-node': '0.3.4',
  'jiti': '2.7.0',
}
const TARGET = join(root, 'resources', 'pi')
const STAMP = join(TARGET, '.pi-version')
const STAMP_VALUE = `${PI_VERSION}+prune${PRUNE_REVISION}`
/** Pi 的 CLI 入口（与模型目录一起，当作「这份树是好的」的判据） */
const CLI = join(
  TARGET,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'bundle',
  'cli.js',
)
/** 预填表的落点：添加模型时认能力默认值（@workbench/ai 的 builtinModelMeta），进版本库 */
const CATALOG_TARGET = join(
  root,
  '..',
  '..',
  'packages',
  'ai',
  'src',
  'ai-builtin-models.generated.ts',
)

/**
 * 要留下的包（`node_modules/` 下的名字，`@scope/name` 与树里写法一致）。**清单外的一律删掉。**
 *
 * 判据只有一条：**运行时真的会加载**。这一版缩到三样（2026-10-22 逐包删掉跑探针验过）：
 *
 *  - `@earendil-works/pi-coding-agent`：CLI 本体。只留 `dist/bundle/` —— 应用跑的是它自带的
 *    `cli.js`，提供方实现、typebox 之类都已经内联在 `dist/bundle/chunks` 里；其余 `dist/`
 *    （core / modes / extensions / cli）是给「从源码 import 这个包」的调用方用的，我们不走那条路。
 *  - `jiti`：扩展加载器。**删了 Pi 照常起得来，但 `-e` 那份扩展会静默不加载** ——
 *    表现就是权限确认整条消失、模型直接跑命令，属于最危险的那种「看起来没事」。
 *  - `@silvia-odwyer/photon-node`：贴图缩放（image-resize worker 里 require 它的 wasm）。
 *
 * **不再留 `typebox` / `pi-ai` / `pi-tui` / `pi-agent-core` / `chord`**：它们是「扩展里 import
 * Pi SDK」时的别名目标，只有 `getAliases()` 被调到时才用得上 —— 当前那份 permission.js
 * 一个 import 都没有，删掉之后 RPC 一轮、两种 API 形态、read/write/edit、`--skill` 全照旧
 * （2026-10-22 实测）。这五样加起来 4.4MB（压缩后约 1.1MB），为「以后可能写的扩展」付不划算。
 * **加回条件**：哪天应用自己开始带会 import Pi SDK 的扩展，把对应的包名放回 KEEP 并重跑探针；
 * 只加 `typebox` 不够 —— `getAliases()` 里对 `pi-ai` / `pi-tui` / `pi-agent-core` 也会 resolve。
 *
 * 清单外的（云厂商 SDK、protobufjs、gaxios、google-auth-library、highlight.js、quickjs-wasi、
 * undici、ws、yaml、diff、lru-cache…）要么已经内联进 bundle，要么只服务 interactive /
 * codemode / MCP 这些应用不用的形态。
 */
const KEEP = [
  '@earendil-works/pi-coding-agent',
  '@silvia-odwyer/photon-node',
  'jiti',
]

/** 文件级的裁剪规则（路径都相对 `resources/pi`） */
const DROP_EXTENSIONS = ['.map', '.d.ts']
/**
 * 文档只留 `docs/*.md`：Pi 的系统提示词与 codemode 描述会把 `docs/` 指给模型，那是它的
 * 参考手册。`docs/images` 是给 GitHub 渲染的配图（2.4MB）；`examples/`（1.0MB）与
 * `CHANGELOG.md`（0.6MB）只有 interactive 模式与 `/changelog` 会读 —— RPC 模式下走不到。
 */
const DOC_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']

/**
 * 下载一个包的 tarball 并解到 `dest`。
 *
 * 用 `npm pack` 而不是 `npm install`：后者会把 pi-coding-agent 声明的整棵依赖树
 * （AWS / Google / openai 那些 SDK，约 108MB、7000 多个文件）装出来 —— 裁完九成都要删，
 * 冷构建的时间全花在「装完再删」上。`npm pack` 只下这一个包（约 8MB），解包即用。
 * 解包交给系统自带的 `tar`（Windows 10 1803+ 与 Git 都带），不经 shell。
 */
function extractPackage(spec, dest) {
  const work = mkdtempSync(join(tmpdir(), 'workbench-pi-'))
  try {
    const name = execFileSync(
      'npm',
      ['pack', spec, '--silent'],
      { cwd: work, encoding: 'utf8', shell: true },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop()
    const tarball = join(work, name)
    if (!name || !existsSync(tarball)) {
      throw new Error(`npm pack ${spec} 没有产出 tarball`)
    }
    mkdirSync(dest, { recursive: true })
    // `-f` 传**文件名**、cwd 设在 tarball 那一层：GNU tar 会把 `C:\...` 里的冒号当成
    // 「远程主机:路径」（报 Cannot connect to C:）；`-C` 的盘符路径换成正斜杠，
    // MSYS 版 tar 对反斜杠的参数会再转义一次（E\:\\muyian\\… → 找不到目录）
    execFileSync('tar', ['-xzf', name, '-C', dest.replaceAll('\\', '/'), '--strip-components=1'], {
      cwd: work,
      stdio: 'inherit',
    })
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Pi 自带的模型目录（models.dev 那份快照，按厂商一个 JSON）；预填表从这儿剪出来 */
function catalogSource(piAiPackageDir) {
  return join(piAiPackageDir, 'dist', 'providers', 'data')
}

function dirSize(dir) {
  const info = statSync(dir, { throwIfNoEntry: false })
  if (!info)
    return 0
  if (!info.isDirectory())
    return info.size
  return readdirSync(dir).reduce((sum, entry) => sum + dirSize(join(dir, entry)), 0)
}

const mb = bytes => (bytes / 1048576).toFixed(1)

/** 递归遍历，回调拿到绝对路径与 dirent（目录也会回调一次，便于整棵删） */
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    visit(path, entry)
    if (entry.isDirectory())
      walk(path, visit)
  }
}

/** 删一个路径并返回省下的字节数（日志要说得出「这一刀砍掉了多少」） */
function drop(path) {
  const size = dirSize(path)
  rmSync(path, { recursive: true, force: true })
  return size
}

/**
 * 瘦身本体：先删清单外的包，再按文件类型裁（映射 / 类型声明 / 文档配图 / bundle 之外的 dist）。
 * 包必须排在文件之前 —— 否则会去遍历马上就要删掉的东西。
 */
function prune() {
  const modules = join(TARGET, 'node_modules')
  let freed = 0

  // 1) 清单之外的包
  for (const entry of readdirSync(modules)) {
    if (entry === '.bin' || entry === '.package-lock.json')
      continue
    const path = join(modules, entry)
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory())
      continue
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(path)) {
        const name = `${entry}/${sub}`
        if (KEEP.includes(name))
          continue
        const size = drop(join(path, sub))
        freed += size
        console.log(`[vendor-pi] 删掉 ${name}（${mb(size)} MB）`)
      }
      // 删空了的 scope 目录也走掉（npm 不会自己清理）
      if (!readdirSync(path).length)
        rmSync(path, { recursive: true, force: true })
      continue
    }
    if (KEEP.includes(entry))
      continue
    const size = drop(path)
    freed += size
    console.log(`[vendor-pi] 删掉 ${entry}（${mb(size)} MB）`)
  }

  // 2) 源码映射与类型声明：运行时一个字节都不读
  let stripped = 0
  walk(modules, (path, entry) => {
    if (!entry.isFile() || !DROP_EXTENSIONS.includes(extname(entry.name)))
      return
    stripped += dirSize(path)
    rmSync(path, { force: true })
  })
  freed += stripped
  console.log(`[vendor-pi] 删掉源码映射与类型声明（${mb(stripped)} MB）`)

  // 3) 文档：只留 docs/*.md（配图、examples/、CHANGELOG.md 都走掉，见 DOC_IMAGE_EXTENSIONS 的注释）
  const packageDir = join(modules, '@earendil-works', 'pi-coding-agent')
  let docs = 0
  docs += drop(join(packageDir, 'examples'))
  docs += drop(join(packageDir, 'CHANGELOG.md'))
  const docsDir = join(packageDir, 'docs')
  if (existsSync(docsDir)) {
    walk(docsDir, (path, entry) => {
      if (!entry.isFile() || !DOC_IMAGE_EXTENSIONS.includes(extname(entry.name).toLowerCase()))
        return
      docs += dirSize(path)
      rmSync(path, { force: true })
    })
  }
  freed += docs
  console.log(`[vendor-pi] 删掉文档配图 / 示例 / CHANGELOG（${mb(docs)} MB）`)

  // 4) pi-coding-agent 的 dist 只留 bundle（其余是给源码调用方的入口，实际不加载）
  const dist = join(modules, '@earendil-works', 'pi-coding-agent', 'dist')
  if (existsSync(dist)) {
    let extra = 0
    for (const entry of readdirSync(dist)) {
      if (entry === 'bundle')
        continue
      extra += drop(join(dist, entry))
    }
    freed += extra
    console.log(`[vendor-pi] 删掉 bundle 之外的 dist（${mb(extra)} MB）`)
  }

  return freed
}

/**
 * 裁完的自检：CLI 必须真的跑得起来。**这一步不能省** —— 裁错包时 Pi 往往还能启动，
 * 要到加载扩展 / 真发请求才失败，只检查文件存在拦不住。
 */
function selfCheck() {
  let out = ''
  try {
    out = execFileSync(process.execPath, [CLI, '--version'], {
      cwd: TARGET,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  }
  catch (err) {
    console.error('[vendor-pi] 自检失败：裁剪后的 cli.js 跑不起来')
    console.error(String(err.stderr ?? err.message).slice(0, 2000))
    process.exit(1)
  }
  if (!/^\d+\.\d+\.\d+/.test(out)) {
    console.error(`[vendor-pi] 自检失败：--version 的输出不像版本号（${out.slice(0, 200)}）`)
    process.exit(1)
  }
  console.log(`[vendor-pi] 自检通过：cli.js --version → ${out.split('\n')[0]}`)
}

/**
 * Pi 自带的模型目录 → 预填表（`AI_BUILTIN_MODELS`）：每家一份、按模型 id 收**添加模型时
 * 要认默认值的那四样**（上下文 / 最大输出 / 思考 / 能不能看图），其余（价格、图片尺寸
 * 上限、各家 API 形态）都不带。这份表进版本库 —— 版本钉死所以内容确定，应用不连
 * models.dev、也不把目录当「模型清单」（清单仍然由端点自己报，它只管预填字段）。
 */
function emitCatalog(piAiPackageDir) {
  const source = catalogSource(piAiPackageDir)
  // `.manifest.json` 是这批数据的清单（schemaVersion / 各文件哈希），不是厂商 ——
  // 它也是 .json 结尾，不过滤掉的话会多出一家叫 `.manifest`、模型全是空对象的假厂商。
  const files = source
    ? readdirSync(source).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()
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
          ...(Array.isArray(model.input) && model.input.includes('image') ? { image: true } : {}),
        }
      }
    }
    const provider = file.replace(/\.json$/, '')
    if (Object.keys(models).length)
      providers[provider] = models
  }
  const header
    = `/* 由 scripts/vendor-pi.mjs 从内置 Pi（${PI_VERSION}）自带的模型目录生成 —— 勿手改，`
      + `重跑 pnpm run vendor:pi 再生。添加模型时的默认值就从这份表认（@workbench/ai 的 builtinModelMeta）。 */\n`
  const body
    = `export interface AiBuiltinModelEntry {\n`
      + `  contextWindow?: number\n`
      + `  maxTokens?: number\n`
      + `  reasoning?: boolean\n`
      + `  image?: boolean\n`
      + `}\n\n`
      + `export const AI_BUILTIN_MODELS: Record<string, Record<string, AiBuiltinModelEntry>> = ${
        JSON.stringify(providers)
      }\n`
  // 内容没变就不动文件：每次 dev 启动都重写会让 mtime 一跳、vite 白推一轮 HMR 更新
  const next = header + body
  if (existsSync(CATALOG_TARGET) && readFileSync(CATALOG_TARGET, 'utf8') === next) {
    console.log('[vendor-pi] 内置模型目录没有变化，跳过生成')
    return
  }
  writeFileSync(CATALOG_TARGET, next)
  console.log(
    `[vendor-pi] 内置模型目录已生成：${CATALOG_TARGET}（${Object.keys(providers).length} 家）`,
  )
}

const hasCli
  = existsSync(CLI) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === STAMP_VALUE
/**
 * 该裁掉的还在 = 这份树不是当前裁剪规则产出的（比如旧脚本只删了几个包，stamp 却是当初那版）。
 * stamp 与 KEEP 两道判据都留着：改规则忘了 +1 时，这一道能兜住最常见的那种漏网。
 *
 * **跳过判据不再看模型目录**：预填表的源（`pi-ai/dist/providers/data`）这一版裁剪后不在了，
 * 拿它当判据会让每次启动都重装。表是提交在仓库里的生成物（`pnpm run vendor:pi` 装完先出它、
 * 再裁树），与这份树无关。
 */
const stale = existsSync(join(TARGET, 'node_modules', '@earendil-works'))
  && readdirSync(join(TARGET, 'node_modules', '@earendil-works')).some(
    name => !KEEP.includes(`@earendil-works/${name}`),
  )
if (hasCli && !stale) {
  console.log(`[vendor-pi] Pi ${PI_VERSION}（裁剪版 ${PRUNE_REVISION}）已内置，跳过安装`)
  process.exit(0)
}
if (hasCli) {
  console.warn('[vendor-pi] 内置的这套 Pi 不对（不是当前裁剪规则产出的），重装一遍')
}

console.log(`[vendor-pi] 下载 @earendil-works/pi-coding-agent@${PI_VERSION} + 两个运行期依赖 …`)
rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })
writeFileSync(
  join(TARGET, 'package.json'),
  JSON.stringify(
    {
      private: true,
      // 只列这两个：它们是运行时真要加载的第三方包，交给 npm 装（连同它们自己的依赖）。
      // **Pi 本体不写在这里** —— 写了 npm 就会去解析它那棵 108MB 的依赖树（云厂商 SDK 全下），
      // 而这套树裁完只剩 dist/bundle 那一份；它的版本记在 `.pi-version` 里。
      dependencies: EXTRA_DEPS,
    },
    null,
    2,
  ),
)

execFileSync('npm', ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: TARGET,
  stdio: 'inherit',
  shell: true,
})

// 依赖装完再解 Pi：反过来 npm 会把它当成「package.json 里没有的包」清掉
extractPackage(
  `@earendil-works/pi-coding-agent@${PI_VERSION}`,
  join(TARGET, 'node_modules', '@earendil-works', 'pi-coding-agent'),
)
if (!existsSync(CLI)) {
  console.error('[vendor-pi] 解包结果里找不到 CLI 入口，内置失败')
  process.exit(1)
}

// 预填表：单独下一份 pi-ai 的数据快照，读完就删（它不进树）
const catalogDir = mkdtempSync(join(tmpdir(), 'workbench-pi-ai-'))
try {
  extractPackage(`@earendil-works/pi-ai@${CATALOG_VERSION}`, catalogDir)
  emitCatalog(catalogDir)
}
finally {
  rmSync(catalogDir, { recursive: true, force: true })
}

const freed = prune()
console.log(`[vendor-pi] 瘦身省下 ${mb(freed)} MB，resources/pi 现有 ${mb(dirSize(TARGET))} MB`)
selfCheck()
writeFileSync(STAMP, `${STAMP_VALUE}\n`)
console.log(`[vendor-pi] 完成：Pi ${PI_VERSION}（裁剪版 ${PRUNE_REVISION}）已内置到 resources/pi/`)
