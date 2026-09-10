/**
 * PREVIEW-ONLY：用无头 Edge 量一次静态壳的盒模型。
 * 用法：node .preview/cdp-measure.mjs <url> [outPng] [width] [height] [waitMs]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const url = process.argv[2] || 'http://127.0.0.1:5288/.preview/harmony.html?variant=b'
const outPng = process.argv[3] || ''
const width = Number(process.argv[4] || 761)
const height = Number(process.argv[5] || 324)
/** 等页面稳定 / 等 mock 自己把弹窗点开；截图弹窗时要给得比它那个 1200ms 长 */
const waitMs = Number(process.argv[6] || 1200)
const profile = mkdtempSync(join(tmpdir(), 'dsh-edge-'))
const port = 9333

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank'
  ],
  { stdio: 'ignore', detached: true }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

let page = null
for (let i = 0; i < 60 && !page; i++) {
  try {
    const list = await targets()
    page = list.find((t) => t.type === 'page')
  } catch {
    /* 端口还没起来 */
  }
  if (!page) await sleep(250)
}
if (!page) {
  console.error('edge 没起来')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 2,
  mobile: false
})
await send('Page.navigate', { url })
await sleep(waitMs)

const res = await send('Runtime.evaluate', {
  expression: 'document.getElementById("snap").textContent',
  returnByValue: true
})
console.log(res.result?.result?.value ?? '(no snapshot)')

if (outPng) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'))
  console.log('screenshot ->', outPng)
}

ws.close()
try {
  process.kill(-child.pid)
} catch {
  child.kill()
}
process.exit(0)
