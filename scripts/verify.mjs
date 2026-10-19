/**
 * 前端验证链：一次改完跑一遍（AGENTS.md 第 6 节那条「一次改完再一次跑齐」）。
 *
 * 形状 —— 为什么不写成一条 `&&` 串：
 *
 *   lint:fix              串行：它会写文件，必须最先跑完、且独自跑
 *   ├─ lint               ┐
 *   ├─ typecheck          ├ 并行：三条互不写同一批文件，串起来是它们的「和」、并行是它们的「最慢那条」
 *   └─ build:renderer     ┘
 *   test                  串行：它要独占 CPU（既有那几条基于真实 git 的用例撞 5 秒超时就是假失败）
 *
 * 实测（2026-10-19，热盘、全绿）：原来那条串行链约 70s，这里约 30s。明细见
 * docs/dev-notes/build-performance.md 的「验证链的耗时」。
 *
 * `build:renderer` 只有 3s 出头，塞在并行组里等于免费，所以不再需要人工判断「这轮动没动过 `.vue` 模板」；
 * 而它那件非跑不可的事没变：模板标签不配平只有真的编译一遍才发现得了（见 AGENTS.md 第 6 节）。
 *
 * 不碰 cargo：Rust 那条链是另一条命令（feature 集不同），而且不能与本脚本的 `test` 同时跑。
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

/** 并行组：三条互不依赖，谁先完谁先报 */
const PARALLEL = ['lint', 'typecheck', 'build:renderer']

/**
 * 跑一个 pnpm 脚本，回传耗时与退出码。
 *
 * 输出先攒着、等这一步结束再整段吐：并行时几个进程的 stdout 会互相插花，
 * 报错那一段被切碎就没法读了。成功的那几段不吐（全绿时那几行没人看）。
 */
function run(script) {
  return new Promise((resolve) => {
    const started = Date.now()
    // Windows 上 pnpm 是 pnpm.cmd，不经 shell 起不来；命令拼成一条字符串而不是传 args 数组
    // （shell: true 配 args 数组在 node 24 上会报 DEP0190，脚本名来自上面的常量、没有注入面）
    const child = spawn(`pnpm run ${script}`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => out += chunk)
    child.stderr.on('data', chunk => out += chunk)
    child.on('close', code => resolve({ script, code, out, ms: Date.now() - started }))
  })
}

function report(step) {
  const secs = `${(step.ms / 1000).toFixed(1)}s`
  console.log(`${step.code === 0 ? '✅' : '❌'} ${step.script.padEnd(15)} ${secs.padStart(7)}`)
  if (step.code !== 0 && step.out.trim())
    console.log(`\n${step.out.trim()}\n`)
}

async function main() {
  const total = Date.now()
  const done = []

  console.log('▶ lint:fix')
  const fix = await run('lint:fix')
  done.push(fix)
  report(fix)
  // 格式没收敛就先停：这一条挂了，后面几条查的是同一批文件，先看它报什么
  if (fix.code !== 0)
    return finish(done, total)

  console.log(`\n▶ ${PARALLEL.join(' / ')}（并行）`)
  done.push(...await Promise.all(PARALLEL.map(run)))
  done.slice(1).forEach(report)
  // 静态检查没过就别再花 17s 跑测试了
  if (done.some(step => step.code !== 0))
    return finish(done, total)

  console.log('\n▶ test')
  const test = await run('test')
  done.push(test)
  report(test)

  return finish(done, total)
}

function finish(done, total) {
  const failed = done.filter(step => step.code !== 0)
  const wall = ((Date.now() - total) / 1000).toFixed(1)
  const sum = (done.reduce((acc, step) => acc + step.ms, 0) / 1000).toFixed(1)
  console.log(`\n——— ${wall}s（各步相加 ${sum}s）`)
  if (failed.length) {
    console.log(`❌ 未通过：${failed.map(step => step.script).join('、')}`)
    return 1
  }
  console.log('✅ 全绿')
  return 0
}

process.exit(await main())
