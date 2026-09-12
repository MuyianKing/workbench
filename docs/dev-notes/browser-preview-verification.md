# 浏览器预览验证工作区

改 UI 时不必每次都把整个 Electron 应用拉起来：把渲染层单独跑在浏览器里、喂一份假数据、截图比对，
一轮只要几秒。这套工作区**用完即删**（见「清理约定」），所以要复现时照本文重建。

## 清理约定

`.preview/` 是临时工作区，不是项目资产：

- `.gitignore` 里的 `.preview/**` 会忽略它的全部内容，任何东西都不进版本库
- **任务完成后直接删掉整个目录**（`rm -rf .preview`）——截图、日志、临时脚本一律不留
- 值得留下的经验写进本文件，不靠保留脚本传递

根目录的 `vite.preview.config.ts` 是常驻入口（挂在 `npm run dev:renderer` 上），不属于工作区，不要删。

## 两条验证链路

要先判断「要验的东西跑在哪一侧」，选错了会白忙：

| 要验的东西 | 用什么 | 为什么 |
|---|---|---|
| 组件布局 / 间距、配色、明暗主题、hover / focus 态 | 浏览器（无头 Edge + CDP） | 快、可脚本化、能放大到像素 |
| 主进程逻辑：读图与 `nativeImage` 解码缩放、内置壁纸目录发现、路径解析 | esbuild 打成 cjs + 真 `electron.exe` | 浏览器里没有这些 API，预览覆盖不到 |

### 一、把渲染层单独跑起来

`vite.preview.config.ts` 只起 renderer（端口 5274），与构建无关：

```bash
npm run build:renderer   # 或直接 vite build --config vite.preview.config.ts
# 产物在 .preview/dist
```

### 二、喂假数据：顶替 preload

渲染层不直接碰 Node，一切经 `window.workbench`。所以只要在页面里造一个假的 `window.workbench`
就能让它跑起来，不需要真实项目数据：

```ts
// 注入到 .preview/dist/index.html 的 <head> 里
window.workbench = new Proxy(
  { /* 各通道的假实现：listProjects 返回几条假项目，getSettings 返回默认设置…… */ },
  { get: (t, k) => t[k] ?? (() => Promise.resolve({ ok: true, data: null })) }
)
```

两个细节：

- 把错误也暴露到标题上（`document.title = 'MOCK-ERR: ' + err.message`），
  这样截图里就能看见 mock 本身挂了，不会误判成界面问题
- 假的内置壁纸清单要和 `resources/backgrounds/` 保持一致，并把原图拷进 `dist`；
  缩略图按主进程的做法压到 360 宽，别拿几兆的原图铺设置面板

### 三、主进程逻辑必须在真 Electron 里跑

先把主进程模块打成 cjs，再丢进真的 electron 可执行文件：

```powershell
node_modules\.bin\esbuild src/main/wallpapers.ts --bundle --platform=node --format=cjs `
  --external:electron --outfile=.preview/wallpapers.cjs
node_modules\electron\dist\electron.exe .preview/check-wallpapers.cjs
```

**坑**：这样直接起 electron 时，`app` 认为的根目录不是仓库根，相对路径取值会和 `electron-vite dev`
下不一致。脚本里要显式把根目录固定成仓库根，否则 `builtinDir()` 一类函数找不到
`resources/backgrounds`，你会以为功能坏了，其实只是路径不对。

## 无头截图配方

用无头 Edge 走 CDP。`--headless=new` 起进程，轮询 `/json/list` 拿到页面，再连 WebSocket 发指令：

```js
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profile = mkdtempSync(join(tmpdir(), 'wb-edge-'))
const port = 9334
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, 'about:blank'
], { stdio: 'ignore', detached: true })

// 轮询等端口起来（最多 ~15s），再取 list.find(t => t.type === 'page')
// 连 page.webSocketDebuggerUrl，自己维护 id -> pending 的 promise map
```

拿到连接后按顺序发：

```js
await send('Page.enable')
// 宽高是逻辑像素；deviceScaleFactor 只负责清晰度，不改变布局比例
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await sleep(waitMs)
// 可选：注入一段页面脚本改样式 / 点按钮
await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
// 可选：真移指针，:hover 只有这样才能触发（合成事件不算）
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: 0 })
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'))
```

几个必须注意的点：

- **`Runtime.evaluate` 要检查 `exceptionDetails`**。不检查的话，注入脚本报错会静悄悄地量到一个
  `undefined`，你会对着错误的结论调半天
- **`:hover` 必须用 `Input.dispatchMouseEvent` 真的移指针**，只改 DOM 不算数
- **`Page.captureScreenshot` 支持 `clip`**，配 `scale: 4` 能把一个按钮放大到看清配色
- **结束时要杀整个进程组**（`process.kill(-child.pid)`，配合 `detached: true`），
  否则无头 Edge 会残留

## 调试探针：一次只改一个变量

"画不出来 / 看不清"这类问题，与其读代码猜，不如在无头渲染里改一个变量再截一张图。
`Runtime.evaluate` 注入的脚本就是探针，按假设写：

| 症状 | 探针怎么问 |
|---|---|
| DOM 有内容但画不出来 | 读它的 `getBoundingClientRect()` 与 `getComputedStyle` 的 `visibility` / `opacity`，先确认盒子算成了什么 |
| 怀疑是毛玻璃（`backdrop-filter`）导致的合成问题 | 把顶部几条栏的 `backdrop-filter` 统一关掉再截一张，对比 |
| 怀疑弹层被 `backdrop-filter` 子树拖累 | 把 `.el-overlay` 从 `.app` 子树挪到 `body`（Element Plus 的 `el-dialog` 默认不 Teleport 到 body），再截 |
| 想截弹窗里某一栏 | 先注入脚本滚到那一行，再截 |

## 量对比度，别靠肉眼

判断"暗色主题下悬停时文字变黑、到底看不看得清"，肉眼不可靠。
读 `getComputedStyle` 拿到实际颜色，按 WCAG 算相对亮度与对比度，给出数字：

```js
const lum = (rgb) => rgb.map((c) => {
  const x = c / 255
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}).reduce((acc, cur, i) => acc + [0.2126, 0.7152, 0.0722][i] * cur, 0)
// 对比度 = (亮 + 0.05) / (暗 + 0.05)，低于 3:1 就可以判定"看不清"
```

把场景做成矩阵（暗 / 亮 × 有无主题色 × 文字取色模式），一次跑完输出一张对照表。

**关键**：探针里复算主题色的算法（`mix` 混色、`inkOf` 取字色）必须和
[`src/shared/accent-color.ts`](../../src/shared/accent-color.ts) 里真实实现**同源照抄**，
并且切场景的方式要和 `bootstrap.ts` 的 `writeAccentColor` 一致（空值就是逐个摘掉内联属性）。
算法不一致的话，量出来的是一份假象。

## 为什么有些页要手写静态 HTML

组件的 `<style scoped>` 平时很难单独观察。要精确量间距时，可以写一个独立静态页，
把组件的结构和它的 scoped 样式**原样复制**进去，在浏览器里量准了再回头改组件。
这样做的前提是"原样复制"——复制时偷懒改了两行，量出来的结论也就不作数了。

## 已知的坑

- **注入 HTML 必须用 Node 读写，不要用 PowerShell 的 `Get-Content` / `Set-Content`**：
  它按本地代码页解码，会把中文注释的字节连同换行一起吃掉，注入后的脚本直接语法错误。
- **直接跑 electron 脚本时根目录不是仓库根**，相对路径要显式固定（见上）。
- **浏览器预览只覆盖渲染层一半**，涉及 `nativeImage`、文件系统、子进程的都要回真 Electron 验。
- **截图按"当时在调什么"命名，成对的用 `-before` / `-after`**。这是给当时的自己看的，
  反正是用完即删，别花心思整理成体系。
