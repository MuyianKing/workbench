# 浏览器预览验证工作区

改 UI 时不必每次都把整个 Tauri 应用拉起来：把渲染层单独跑在浏览器里、喂一份假数据、截图比对，
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
| Rust 侧逻辑：图像解码缩放、路径解析、端口判定、进程树终止 | `cargo test`（单测写在同文件的 `#[cfg(test)] mod tests`） | 这些逻辑不经过界面，浏览器预览覆盖不到 |

新加一条通道、或者要确认「界面 → 适配层 → Rust」这一整串真的通了（假数据验证不了这一段），
见最后一节「在真应用里验证」。

### 一、把渲染层单独跑起来

`vite.preview.config.ts` 只起 renderer（端口 5274），与构建无关：

```bash
npx vite build --config vite.preview.config.ts
# 产物在 .preview/dist
```

开发态用 `npm run dev:renderer`。注意 vite 7 只监听 IPv6 的 `localhost`，脚本里访问 `127.0.0.1:5274`
会被拒（浏览器里打开 http://localhost:5274/ 正常）。

### 二、喂假数据：顶替 `window.workbench`

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
  缩略图按 Rust 侧 `imaging.rs` 的做法压到 360 宽，别拿几兆的原图铺设置面板

#### 只验一个组件

整页跑起来要喂十来个通道的假数据；改某一块面板时不必这么麻烦 —— 在工作区里再放一份
vite 配置，把 `root` 指到工作区内的一个小目录，只挂那一个组件：

```ts
// .preview/vite.harness.config.ts
root: resolve(__dirname, 'harness'),          // 工作区里的 index.html + main.ts
resolve: { alias: { '@': '…/src/renderer/src', '@shared': '…/src/shared' } }
```

`main.ts` 里照旧 import `element-plus/dist/index.css`、`theme-chalk/dark/css-vars.css`、
`@/styles/tokens.css`、`@/styles/global.css`（少了这几样配色与令牌就不是线上的样子），
把组件挂进一个**尺寸等于真实卡片**的盒子里（卡片内边距由组件自己带，外面别再补一圈，
否则量出来的宽度会比线上窄一截），`window.workbench` 只实现这一个组件用到的通道。
暗色靠 `document.documentElement.dataset.theme` 加 `.dark` 类切。

这样一次 build 一两秒，也不用碰仓库里的任何文件。

### 三、Rust 侧逻辑走 `cargo test`

图像解码缩放、路径解析、端口判定、进程树终止这些逻辑现在都在 `src-tauri/src/` 里，
浏览器预览够不到，也不该为了验它们去拉整个应用：测试就写在与实现同文件的 `#[cfg(test)] mod tests` 中。

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

改 Rust 前先关掉正在运行的应用，否则链接会因 exe 被占用而报「拒绝访问」。另外 `cargo test`
偶尔会卡在链接或执行上（旧二进制被残留句柄锁住、环境拦了刚链接出的 exe），两种绕法见
[AGENTS.md](../../AGENTS.md) 第 6 节。

**要顺手看一眼真数据时**，别改成临时 `main`：把待验的入参做成测试用例，用 `-- --nocapture`
打印中间值，或者按下一节「在真应用里验证」连真应用的 CDP 求值。

## 在真应用里验证（Tauri + WebView2）

浏览器预览里 `window.workbench` 是假的，因此「新加的通道到底通没通」它是验不了的 ——
明明只是命令名拼错、参数名没对上，预览里照样一片正常。这时直接连真应用：

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run dev
```

起来之后 `/json` 里就有页面 target，连它的 `webSocketDebuggerUrl` 发 `Runtime.evaluate`
即可（就是前面的无头配方，只是不用自己起浏览器）。几件顺手的事：

- 通道直接求值最省事：`await window.workbench.getNrmStatus()`，把返回值原样打出来看形状对不对
- **要驱动界面就去拿 Pinia store**：
  `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('projects')`，
  然后 `store.openDrawer(id)` / `store.refreshNrm()` 想调哪个调哪个，比在界面上找按钮稳
- **原生对话框（选目录 / 选文件）必须换成桩**：真点会弹一个 CDP 关不掉的系统弹窗，
  把 `window.workbench.pickDirectory` 临时改成返回固定路径，就能把「选完之后的处理」整条验完；
  测完记得把桩换回去，别留在页面里
- 改 `store` 里的数据会被去抖落盘（400ms），所以验证时**动过的字段要还原**，
  还原后再等一个防抖周期，否则把测试值写进了用户的数据文件
- `Runtime.evaluate` 里的字符串常量小心被 shell 吃转义：Windows 路径用正斜杠最省事
  （项目里的路径工具本来就会归一方向），`\\` 在两层引号之后很可能变成别的字符，
  那时量到的「相对路径没生效」其实是路径串本身就不是你想的那样

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

- **Element Plus 的弹层不信 `offsetParent`**：popper 是 `position: fixed`，可见时
  `offsetParent` 照样是 `null`，拿它当「面板打开了吗」的判据会一直判成没打开。
  用 `getComputedStyle(popper).display !== 'none'`（或 `aria-hidden`）来判断。
- **展开的日历 / 下拉会盖住旁边的控件**：popper 按输入框左缘定位、宽 300+，
  很容易压住同一行右边那个输入框，这时点右边的框其实点在面板上。
  换控件前先发一次 `Input.dispatchKeyEvent` 的 Esc 关掉它。
- **指针停在图表柱子上会弹出一块深色提示，它会吃掉那一带的合成点击**：`el-tooltip` 挂在柱子上，
  指针停够 `show-after` 就弹出；此时若指针不动、只让数据变（例如切「天/周/月」页签），
  提示会原地留着不走 —— 在这套无头环境里它还被摆到 `x=0`，正好压住卡片标题行。
  症状是「点某个控件毫无反应」，很容易误判成新写的控件坏了。
  定位办法：`document.elementFromPoint(控件中心)` 看命中的是谁（我这边命中 `DIV.tip`，
  就是柱子提示的正文）。规避办法：每次点击前先把指针挪到卡片外的空白处再移回来
  （`Input.dispatchMouseEvent` 的 `mouseMoved`），别让它停在图表上。
  这是柱子提示本来就有的毛病（跟改动无关，指针一移开就散），别顺着新控件的代码找。
- **`el-popover` 的 `width` 默认值是 150，而且写成内联 `style="width:150px"`**：
  内联样式压过样式表，面板内容会直接溢出那 150px 的盒子，画到边框与阴影外面。
  要按内容自适应，得用 `popper-style="width: auto"` 覆盖（`min-width` 另配样式表改），
  别只在 CSS 里写 `width` / `min-width`。
- **注入 HTML 必须用 Node 读写，不要用 PowerShell 的 `Get-Content` / `Set-Content`**：
  它按本地代码页解码，会把中文注释的字节连同换行一起吃掉，注入后的脚本直接语法错误。
- **浏览器预览只覆盖渲染层一半**：涉及文件系统、子进程、图像解码的都在 Rust 侧，回 `cargo test` 或真应用里验。
- **截图按"当时在调什么"命名，成对的用 `-before` / `-after`**。这是给当时的自己看的，
  反正是用完即删，别花心思整理成体系。
