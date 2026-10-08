/**
 * 把**应用版本号**真正写进仓库的那个工具（发版流程两半里的前半）。
 *
 * 用法：
 *   pnpm run bump 0.2.1          写入：把版本写进下面 TARGETS 那几处
 *   pnpm run bump --check 0.2.1  校验：只读，任何一处对不上就退出码 1（流水线里跑这个）
 *
 * 为什么要有它：发版流水线（.github/workflows/release.yml）只认 tag，而 tag 不住在源码里 ——
 * 版本号必须在**打 tag 之前**就真的写进仓库并提交，这样 clone 那个 tag 出来就是那个版本，
 * 本地 `pnpm run dist` 打出的包名 / 安装器版本 / 关于页版本都与发布包一致。以前是构建时在
 * runner 的工作区里写、不提交，结果是 v0.2.0 发出来了，仓库里 16 个 package.json 还写着 0.1.0：
 * 本地重打同一个 tag 得到的是 `Workbench_0.1.0_x64-setup.exe`，与发布包同名同版本、分不清谁是谁。
 *
 * 两条约定：
 * - **TARGETS**：跟着 tag 走的那几处。每一处必须**恰好命中一次** —— 将来谁挪了这些字段的位置，
 *   要在这里炸掉，而不是一声不响地不写、打出一个版本号不对的包。
 * - **packages/\*：私有子包不参与版本**（统一钉 0.0.0）。它们 private: true 且互相 workspace:*，
 *   版本号本来就不参与解析；跟着应用版本一起涨只会把「要同步的地方」从 4 处变成 18 处。
 *   这里按 glob 发现，将来新建的包自动纳入，不用改这份清单。
 *
 * 只替换那一行，不整份 parse + stringify 重写（那会把 ["nsis"] 这类数组展开、顺带把 CRLF
 * 翻成 LF）；内容没变就不写文件，免得 mtime 一跳白推一轮 HMR（与 vendor-pi.mjs 同一个考虑）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 私有子包的固定版本：表示「这个包不参与版本」，不是「它是 0.0.0 版」 */
const PLACEHOLDER = '0.0.0'
/** 与流水线认的 tag 形式一致（tag 去掉开头的 v 就是它） */
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Z.]+)?$/i

/** package.json 里那行顶层 version（两份应用清单 + 子包共用） */
const JSON_VERSION = /^ {2}"version": "[^"]*"(,?\r?)$/m
const jsonLine = v => `  "version": "${v}"$1`

/**
 * 跟着 tag 走的几处：文件 → 认版本的写法 → 怎么替换。
 * Cargo.lock 那条别写成「找 version = "x.y.z"」：那份锁文件里 byteorder-lite、vswhom 这些
 * 第三方 crate 恰好也是 0.1.0，必须连 [[package]] + name = "workbench" 一起认。
 */
const TARGETS = [
  { file: 'package.json', pattern: JSON_VERSION, replace: jsonLine },
  { file: 'apps/desktop/package.json', pattern: JSON_VERSION, replace: jsonLine },
  { file: 'apps/desktop/src-tauri/tauri.conf.json', pattern: JSON_VERSION, replace: jsonLine },
  {
    file: 'apps/desktop/src-tauri/Cargo.toml',
    pattern: /^version = "[^"]*"(,?\r?)$/m,
    replace: v => `version = "${v}"$1`,
  },
  {
    file: 'apps/desktop/src-tauri/Cargo.lock',
    pattern: /(\[\[package\]\]\r?\nname = "workbench"\r?\nversion = ")[^"]*(")/,
    replace: v => `$1${v}$2`,
  },
]

function fail(message) {
  console.error(`[bump] ${message}`)
  process.exit(1)
}

const checkOnly = process.argv.includes('--check')
const version = process.argv.slice(2).find(arg => !arg.startsWith('--'))
if (!version)
  fail('要给出目标版本，例如 `pnpm run bump 0.2.1`（只校验加 --check）')
if (!VERSION_RE.test(version))
  fail(`版本号要写成 X.Y.Z（可带 -rc.1 这类后缀），收到「${version}」`)

/** packages/ 下的全部子包清单（不用手写包名，加包自动纳入） */
function privatePackages() {
  const dir = join(root, 'packages')
  return readdirSync(dir)
    .filter(name => existsSync(join(dir, name, 'package.json')))
    .sort()
    .map(name => `packages/${name}/package.json`)
}

/**
 * 把一处改成 value；返回这一处对不对得上 —— 只读、不写的时候就是校验。
 * `ok` 表示「本来就是 value」（写入模式：没动文件；校验模式：通过）。
 */
function patch({ file, pattern, replace }, value) {
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  const found = before.match(new RegExp(pattern.source, 'gm'))
  if (found?.length !== 1) {
    fail(`${file} 里的版本字段不是恰好一处（找到 ${found?.length ?? 0} 处），没动它`)
  }
  const after = before.replace(pattern, replace(value))
  const ok = after === before
  if (!ok && !checkOnly)
    writeFileSync(path, after)
  // 报错信息里把命中的原文压成一行：Cargo.lock 那条是跨三行的块，原样打出来会散成三行
  return { file, ok, line: found[0].replace(/\s+/g, ' ').trim() }
}

const app = TARGETS.map(target => patch(target, version))
const sub = privatePackages().map(file => patch({ file, pattern: JSON_VERSION, replace: jsonLine }, PLACEHOLDER))
const rows = [...app, ...sub]

const seen = r => `${r.ok ? '✓' : checkOnly ? '✗' : '✎'} ${r.file}${r.ok ? '' : `（原来是 ${r.line}）`}`
console.log(`[bump] 应用版本 ${version}：`)
for (const row of app) console.log(`  ${seen(row)}`)
console.log(`[bump] 私有子包（钉 ${PLACEHOLDER}，不参与版本）：`)
for (const row of sub) console.log(`  ${seen(row)}`)

const bad = rows.filter(row => !row.ok)
if (checkOnly) {
  if (bad.length) {
    console.error(`[bump] 上面 ${bad.length} 处与 tag 要的 ${version} 对不上`)
    console.error(`[bump] 先在仓库里跑 \`pnpm run bump ${version}\`，把那一笔提交，再打 tag`)
    process.exit(1)
  }
  console.log(`[bump] 应用版本那 ${app.length} 处与 ${sub.length} 个私有子包都对得上，可以打这个 tag`)
}
else if (bad.length) {
  // 把「该提交哪几处」直接给出来：版本这一笔最好只带这几处（仓库里常有别的在改）
  console.log(`[bump] 写了 ${bad.length} 处；下一步：`)
  console.log(`  git add ${bad.map(row => row.file).join(' ')}`)
  console.log(`  git commit -m "chore: 版本号 ${version}"`)
  console.log(`  git tag v${version} && git push origin main v${version}`)
}
else {
  console.log(`[bump] 本来就是 ${version}，没动文件`)
}
