# 浏览器预览验证工作区

**这套只在用户明确要求做视觉验证时才用**（见 [AGENTS.md](../../AGENTS.md) 第 6 节：用户没提就不做）。把渲染层单独跑在浏览器里、
喂一份假数据、截图比对，不必每次把整个 Tauri 应用拉起来，一轮只要几秒。这套工作区**用完即删**（见「清理约定」），所以要复现时
照本文重建。

## 清理约定

`.preview/` 是临时工作区，不是项目资产：

- `.gitignore` 里的 `.preview/**` 会忽略它的全部内容，任何东西都不进版本库
- **任务完成后直接删掉整个目录**（`rm -rf .preview`）——截图、日志、临时脚本一律不留
- 值得留下的经验写进本文件，不靠保留脚本传递
- **同时有别的会话在改 UI 时，各用各的子目录**（`.preview/<这次在验什么>/` 里放 `harness/`、
  `dist/`、`shot.mjs`、`out/`，配一份自己的 vite 配置）：`harness/main.ts`、`dist`、`shot.mjs`
  这些路径是共享的，另一个会话一 build 就把你的换掉 —— 症状是「脚本跑完什么都没量到、
  或者量到的是别人那个组件」，别顺着自己的组件找

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

开发态用 `npm run dev:renderer`。注意 vite（7 / 8 都一样）只监听 IPv6 的 `localhost`，脚本里访问 `127.0.0.1:5274`
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
  这样截图里就能看见 mock 本身挂了，不会误判成界面问题。
  顺手把**那条已知异常**滤掉再判：纯浏览器里 `initState()` 那条 `Tauri 运行时不可用` 必定出现
  （见下面「已知的坑」），把它当成 mock 出错会让每一张截图都判失败；
- 假的桩**必须落在 `dist` 里**、而且要在 `<title>` 之后、所有脚本之前，以**经典脚本**引入：
  - 放在工作区根目录（而不是 dist）是个很隐蔽的错：静态服务只服务 dist，页面加载它是 404，
    而现象是「页面正常出来了、外观全是默认值」，很容易顺着 `getBootstrap` 找；
  - 只靠「经典脚本先于 deferred 模块执行」也能成立，但那是个藏在规范里的前提 ——
    写在模块脚本前面谁都看得出来，而且 `dist/index.html` 是每次 build 重新生成的，
    注入脚本必须**幂等**（带 `<head>` 里那句判断，别重复插）；
- 起浏览器之前先自己 `fetch` 一遍 `/` 与桩文件、断言 200：页面 404 时无头那边只会得到一张空白，
  而现象会指向完全无关的地方。判据还是那条老的 —— `document.documentElement.dataset.theme` 是空的
  就说明 `getBootstrap` 没生效（HTML 里有那行标签不代表文件真的在）；
- 假的内置壁纸清单要和 `resources/backgrounds/` 保持一致，并把原图拷进 `dist`；
  缩略图按 Rust 侧 `imaging.rs` 的做法压到 360 宽，别拿几兆的原图铺设置面板

#### 只验一个组件

整页跑起来要喂十来个通道的假数据；改某一块面板时不必这么麻烦 —— 在工作区里再放一份
vite 配置，把 `root` 指到工作区内的一个小目录，只挂那一个组件：

```ts
// .preview/vite.harness.config.ts
root: resolve(__dirname, 'harness'),                       // 工作区里的 index.html + main.ts
publicDir: resolve(__dirname, '../src/renderer/public'),   // 见下面那条：Vditor 要靠它
resolve: { alias: { '@': '…/src/renderer/src', '@shared': '…/src/shared' } },
plugins: [vue(), vditorAssets()]                           // sync-vditor-assets.mjs 导出的那个插件
```

`main.ts` 里照旧 import `element-plus/dist/index.css`、`theme-chalk/dark/css-vars.css`、
`@/styles/tokens.css`、`@/styles/global.css`（少了这几样配色与令牌就不是线上的样子），
把组件挂进一个**尺寸等于真实卡片**的盒子里（卡片内边距由组件自己带，外面别再补一圈，
否则量出来的宽度会比线上窄一截），`window.workbench` 只实现这一个组件用到的通道。
暗色靠 `document.documentElement.dataset.theme` 加 `.dark` 类切。

这样一次 build 一两秒，也不用碰仓库里的任何文件。

**挂到跟 Vditor 有关的组件时，`publicDir` 与 `vditorAssets()` 两样都要**：编辑器本体打在 JS 里，
但图标 sprite、语言包、lute 是运行时按 `cdn` 取的，它们住在 `src/renderer/public/vditor/dist/`
（由那个插件在 dev / build 前同步）。`root` 指到工作区之后 `public/` 默认变成工作区自己的目录，
少了这两样会一路 404 —— 症状是「编辑器起不来 / 图标全空」，别顺着组件代码找。

### 三、Rust 侧逻辑走 `cargo test`

图像解码缩放、路径解析、端口判定、进程树终止这些逻辑现在都在 `src-tauri/src/` 里，
浏览器预览够不到，也不该为了验它们去拉整个应用：测试就写在与实现同文件的 `#[cfg(test)] mod tests` 中。

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

改 Rust 前先关掉正在运行的应用，否则链接会因 exe 被占用而报「拒绝访问」。另外 `cargo test`
偶尔会卡在链接或执行上，两种绕法：

- `LNK1104 / failed to remove ...exe`：旧的测试二进制被残留句柄锁住（进程早退了，句柄还在），
  给测试换个产物名即可 —— `RUSTFLAGS="--cfg wb_verify" cargo test`；
- `could not execute ... (never executed) + 拒绝访问`：环境拦了刚链接出的可执行文件，
  把 `target/debug/deps/workbench-*.exe` 复制一份再直接运行，副本能跑。

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
- **要动设置又不想污染自己的配置，就把整个 `APPDATA` 指到临时目录再起应用**：
  `APPDATA='C:\Users\...\Temp\wb-smoke' npm run dev`。数据目录是 `%APPDATA%\Workbench`
  （**不是 `%APPDATA%` 本身**），所以这一下连项目列表、设置、笔记文件夹一起隔离了；
  想从某个状态起步（例如「已经选好笔记文件夹」）就先把 `workbench-data.json` 写进去再启动 ——
  比在页面上找入口省事，也不用像上一节那样记着「测完还原」。收尾时连临时目录一起删掉。
- **验证文件系统那一条链（笔记就是磁盘上的 `.md`）只能在真应用里做**：浏览器预览没有后端，
  扫盘 / 写盘全走不了。值得按这个顺序点一遍：进页面看树 → 点一篇看正文 → 打字看盘上文件变了没有 →
  拖动看文件真的换了目录 → 新建 / 改名 / 删除。这套「读一遍、写一遍、挪一遍」跑通，
  才谈得上这条通道是活的。
- **`el-tree` 的拖动可以用合成事件驱动，不必走 CDP 的拖放**：`new DataTransfer()` 造一个
  `dataTransfer`，在源节点的 `.el-tree-node` 上 `dragstart`、在目标节点上 `dragover`
  （`clientY` 取目标行中线）、再在源节点上 `dragend` —— 真挪数据发生在 **`dragend`** 里
  （不是 `drop`），所以最后一下别漏。`data-key` 就是 `node-key`，按它选节点最稳。
  `<script setup>` 里 `document.querySelector('#app').__vue_app__` 那套照样能拿到 store，
  两边的验证互相补：DOM 事件验交互，store 验状态。
- **粘贴图片同样能合成**，不用真去动系统剪切板：造一个 `File` 放进 `DataTransfer`，
  再派发 `new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })` ——
  目标元素是有 `contenteditable="true"` 的那个（Vditor 的 paste 监听挂在它上面，
  而且它会先判 `contenteditable` 是不是 true，挂错了什么都不发生）。用 `atob` 拼几十字节的假 PNG 就够：
  这条链上没人真去解码那张图。上传要跑 git clone / commit / push，等 5~10 秒再看结果。
- **要验「上传到 git」这类功能，把远端换成临时裸仓库**（`git init --bare`），
  再把设置里的仓库地址指过去：不碰网络、不需要凭据，推没推上去直接 `git --git-dir=<裸仓库> ls-tree` 看。
  注意裸仓库的 HEAD 默认指向 `master`，而我们推的是 `main` —— `git log` 会报「还没有提交」，
  按分支名去查才对。
- **「图裂了」先分清是哪一层的问题**，三层用三种办法量，别猜：
  1. 地址本身能不能取到 → 在命令行 `curl -o /dev/null -w "%{http_code}" -L <url>`；
  2. **WebView 能不能取到** → 在页面上量 `img.complete` 与 `img.naturalWidth`
     （`complete: true, naturalWidth: 0` 就是加载失败，比看截图准）；
  3. 两者不一致就逐个 http 头做对照（`curl -H …` 一次只加一个）。
  踩过的例子：Gitee 的 `/raw/` 防盗链只认 `Referer` —— 不带、或者是 gitee 的域名才 200，
  带 `Referer: http://localhost:5274/` 直接 403（UA 与 `Sec-Fetch-*` 都不影响），
  而 WebView 一定带 Referer，于是 curl 全绿、界面全裂。顺手的修法是页面级
  `<meta name="referrer" content="no-referrer">`（见 `src/renderer/index.html`）。

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
- **面板里（iab）交互验一次就好，`reload()` 之后别再点**：重载过的标签页上，
  `locator.click()` 会一直卡在 actionability 超时（"waiting for locator … >> nth=0"），
  `tab.cua.click()` 也不会产生任何页面事件（注入一个捕获阶段的监听，`hits` 是空的）——
  而同一个页面**重开一个标签页**后点一次就正常。所以「点一下看看会怎样」这类验证放在新开的标签页上做；
  已经 reload 过的页面就只用来量数值（`evaluate` 一直好使）
- **量间距用 `getBoundingClientRect` + `getComputedStyle`，别肉眼估截图里的像素**：
  「这里空了一大块」多半能直接归因到某个盒子的 `margin` / 一行隐形的行盒。
  定位到具体元素（连同它的伪元素：`getComputedStyle(el, '::before').content`）之后，
  先注入一条探针 CSS 改一个变量、再量一次数字，比来回改组件重编快得多 ——
  本次就是靠它认出 Vditor 收起态代码块那两行空档来自「零尺寸 inline 标记撑起的行盒」
- **结束时要杀整个进程组**：不建议用 `process.kill(-child.pid)` —— Windows 上它直接 `ESRCH`
  （进程组不是这么用的），而**没杀掉的那个实例会污染下一轮**：调试端口被它占着，
  下一次跑同一个端口的脚本会连上那个**上一轮的**页面（`/json/list` 里照样有 target），
  于是量到的是旧页面的数字、或者像这次一样连到一个 `edge://` 内部页，现象指向完全无关的地方。
  可靠的做法两条一起上：
  1. **收尾用 `taskkill /F /T /PID <pid>`**（`spawn` 一个 taskkill、等它 exit）；
  2. **起浏览器之前先查那一个端口**，被占就按命令行认人清掉 ——
     `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"` 里筛
     `CommandLine -like '*--remote-debugging-port=<端口>*'`，再逐个 `taskkill /F /T`。
     按端口认人只会命中这套流程起的无头实例，不会碰到用户自己的 Edge。清完再验一次端口空了没有。
- **`/json/list` 里挑 target 要挑准**：无头 Edge 起来时会带一串 `background_page`（扩展）和一个
  `about:blank` 页面，`edge://` 内部页也可能混进来。先筛 `type === 'page' && url === 'about:blank'`，
  再退回 `type === 'page' && /^https?:/`；把整张清单打出来，连错了当场就能看见。
- **裁图坐标必须来自 `getBoundingClientRect`，不要手写**：猜的坐标裁到的是顶栏的搜索框，
  对着「新加的那一行不好看」能研究半天。写一个「按选择器实测盒子 + 一圈留白」的辅助函数，
  需要挑「含某个子元素的卡片」时用 `article.panel:has(.graph__stats)` 这类 `:has()` 选择器。

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

**背景不是纯色时，`getComputedStyle` 答不了这个问题** —— 这个应用里这种情况很常见：
画布是「壁纸 + 蒙版」的合成，卡片又是 60% 不透明度的底色叠在上面（设置里的「卡片不透明度」），
背景究竟是多少只能看最终像素。办法是让页面自己解码一张截图：

```js
// 1. 先截一条**没有文字**的窄带（背景）—— 空白的来源可以量，别从文字所在的那一行取
// 2. 把这张 PNG 的 base64 交给页面，用 canvas 取平均色
const cap = await send('Page.captureScreenshot', { format: 'png', clip: strip })
await send('Runtime.evaluate', { expression: `(async () => {
  const img = new Image(); img.src = 'data:image/png;base64,${cap.result.data}'
  await img.decode()
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, img.width, img.height).data
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; n += 1 }
  return [Math.round(r/n), Math.round(g/n), Math.round(b/n)]
})()`, awaitPromise: true, returnByValue: true })
// 3. 文字色仍取 getComputedStyle，两边算 WCAG
```

取「没有文字的那条带」有个现成的落点：容器自己的 `padding`（例如首页那一行与画布上沿之间的
`--card-gap`）或卡片底部那段留白 —— 用 `getBoundingClientRect` 把它的位置算出来交给 `clip`。

顺带一个结论（2026-09 量过，也是这一节的来源）：**「主题极性与壁纸亮度相反」那一组会塌**。
蒙版是「画布色 + `1 - 图片浓淡`」的 alpha（默认浓淡 55 → alpha 0.45），深色壁纸配亮色主题时
画布合成出来是中灰 —— 而**中灰底上没有任何文字色是清楚的**：深色字实测 1.9:1，
要够 4.5:1 得用近白字（那在亮色主题里等于换了套主题）。所以这不是「换个令牌」能修的，
必须让底衬本身回到主题这一侧。两条对它有效的做法，两条都已落地：

- **别让文字直接铺在画布上**：给这类文字一副跟卡片同一套 `--card-alpha` 的底衬
  （首页那一行就是这么做的）。好处是可读性交给用户已经熟悉的那个滑块，和界面上其余文字同一档待遇。
  注意卡片本身也是 60% 底色，所以**卡片上的次要文字同样会塌**（实测 1.86:1）——
  把「卡片不透明度」拉到 100% 就全好了（实测同一处 6:1），这是那个滑块的固有取舍，不是令牌写错。
- **两套主题的 ink 阶梯要用同一条标尺量**：亮色那套原先的 `--ink-3` 在**纯白卡片上**也只有
  3.15:1、在画布上 2.83:1（暗色那套是 4.8~5.3），也就是说不用挂壁纸就已经不到 AA 了。
  修法是把三档一起按对比度重定（只压暗最低那档会让它贴到上一档、三档塌成两档）。
  判据用数字：亮色修完是 17.4 / 10.0 / 5.7，暗色是 15 / 9.4 / 5.1。

**关键**：探针里复算主题色的算法（`mix` 混色、`inkOf` 取字色）必须和
[`src/shared/accent-color.ts`](../../src/shared/accent-color.ts) 里真实实现**同源照抄**，
并且切场景的方式要和 `bootstrap.ts` 的 `writeAccentColor` 一致（空值就是逐个摘掉内联属性）。
算法不一致的话，量出来的是一份假象。

## 为什么有些页要手写静态 HTML

组件的 `<style scoped>` 平时很难单独观察。要精确量间距时，可以写一个独立静态页，
把组件的结构和它的 scoped 样式**原样复制**进去，在浏览器里量准了再回头改组件。
这样做的前提是"原样复制"——复制时偷懒改了两行，量出来的结论也就不作数了。

## 已知的坑

- **`backdrop-filter` 会把元素变成层叠上下文，里面的浮动面板会被后画的卡片盖住**：
  顶栏（`.topbar`）在「毛玻璃」那一档带 `backdrop-filter`，于是顶栏内部那张搜索结果面板的
  `z-index: 30` 只在这个上下文里比大小 —— 而画布里的卡片是定位元素（`position: relative`、
  `z-index: auto`），按**树序**排在顶栏之后，整块盖在面板上面。卡片自己又是半透明的
  （卡片不透明度），两层叠起来就是「面板透底、底下的卡片内容透上来」。
  顶栏显式 `position: relative; z-index` 抬一手即可。**这一档才会露馅**：透明 / 正常两档
  顶栏不构成层叠上下文，面板的 z-index 直接和卡片在同一层比，所以只截那两档是验不出来的 ——
  验证浮动面板时要把顶栏三档都过一遍。
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
- **`el-dialog` 想做成「左菜单 + 右内容」这类分区时要同时拆三层，而且弹窗得给定高**：
  EP 自己在 `.el-dialog` 上留了 16px 内边距、在 `.el-dialog__body` 上留了 30/20 内边距，
  两栏的可用宽度是「弹窗宽 − 32 − 正文内边距 − 滚动条 10」量出来的（按 920 宽的弹窗算只剩 669）；
  `class` 落在 `.el-dialog` 上、`body-class` 落在正文上，正文还是 EP 生成的元素，scoped 样式够不着，
  这两条只能写进 `global.css`。
  正文高度必须由弹窗的 `height` 定死（`min(700px, calc(100vh - var(--h-titlebar) - 48px))`），
  只给 `max-height` 让弹窗按内容定高的话，正文高度成了内容反推的结果，
  右侧内容区拿不到滚动高度、会被 `overflow: hidden` 整块裁掉（滚都滚不到），
  `height: 100%` 也解析不出来 —— 症状是「两栏高过弹窗、下半截直接没了」。
- **去掉页脚的弹窗要自己收紧正文内边距**：上面那个 30/20 是 EP 按「正文下面还有一个按钮行」留的，
  只靠右上角 × 关闭时不放页脚，底部就会空出一大块、内容看着像没对齐 ——
  放大截图里一眼能看见，正常尺寸下只是「说不上来哪里怪」。
  写法是给弹窗挂个 class、在 `global.css` 里把 `.el-dialog__header` / `.el-dialog__body`
  的内边距按实际结构定死（见 `.account-dialog`）。
- **鼠标指针是真的移过去才能量 `:hover`**（`Input.dispatchMouseEvent` 的 `mouseMoved`）：
  量到的 `getComputedStyle(...).backgroundColor` 才是悬停色，只读静态样式会得到「没反应」的错觉。
  **滚动伪元素是例外，它不随 `:hover` 重算**（见下面那条）。
- **滚动条的「悬停态」选择器在这版 Chromium 里已经失效**：`global.css` 一直靠
  `:hover::-webkit-scrollbar-thumb` 表达「滑块平时透明、指针移进滚动区才浮现」，
  但 Edge 152（WebView2 跟着它走）起，**滚动容器自身的 `:hover` 不再带动滚动伪元素重算** ——
  滑块永远停在透明那一档，症状是「所有滚动区都没有滚动条」（`::-webkit-scrollbar-thumb:hover`
  同样失效，且没法用 CSS 找回来）。换成由**父元素**发号（`:hover > ::-webkit-scrollbar-thumb`）
  立刻就好：祖先的 `:hover` 照旧带动子树重算，而指针落在容器里时父元素当然也是 `:hover`。
  探针怎么问：一张最小页，两个 `overflow: auto` 的盒子分别写这两种选择器，
  把指针移进盒子里各截一张 —— 前者空白、后者出滑块，一眼定性。
  判断依据**要用截图、不要用 `getComputedStyle(el, '::-webkit-scrollbar-thumb')`**：
  它压根不随 `:hover` 重算，改前改后返回同一个值（会得出「改不改都一样」的错觉）。
- **共用外壳的类写在某个组件的 scoped 样式里时，第二个用它的页面只会吃到颜色、丢掉排版**：
  项目页那条筛选工具带的 `.filter` 当初只写在 ProjectFilterBar.vue 的 `<style scoped>` 里，
  global.css 里只有 `.app.top-band/glass/clear .filter` 那三档颜色规则。工作页照同名 class 用，
  于是 display 还是 `block`：范围标签与「记一条」各占一整行竖着堆，计数被按钮压住 ——
  截图上像「工具条被挤扁」，其实只是排版没生效。**判据是 `getComputedStyle(el).display` +
  `getBoundingClientRect()`，别照着截图猜**（用探针脚本把工具条各级节点的盒子打出来最快）。
  结论是共用外壳（`.panel`、`.facts`、`.filter` 这类）一律写进 global.css，谁都不当「规矩的出处」。
- **v-html 里的列表看不见圆点**：global.css 的 reset 把 `ul / ol` 的 `list-style` 清成了 none
  （那是给界面自己的布局列表定的），markdown 正文渲染出来后同样吃这条规则 ——
  在展示组件的 `:deep()` 里把 `list-style` 写回来（disc / decimal），否则有序列表看着像没有序号。
- **整页桩漏了某个通道时，症状是「某一块卡片只剩外壳」**：`[data-card-id]` 那层容器在，
  组件自己的根节点（例如快捷启动的 `.launch`）却不在 DOM 里 —— 说明那个组件在首次渲染时抛了
  （Vue 把错误吞进 console.error，所以 `document.title` 上那条错误钩子也接不到，页面看着毫无异常）。
  **先回真实应用确认那一格是不是好的**，再决定要不要查组件：本次就是这样发现是桩的问题
  （换一份数据喂进去照样是空壳，而真实应用里那五个图标都在）。别顺着组件代码找。
- **浏览器预览只覆盖渲染层一半**：涉及文件系统、子进程、图像解码的都在 Rust 侧，回 `cargo test` 或真应用里验。
- **产物要用 http 打开，别用 `file://`**：Chromium 会按 CORS 拦掉 `file://` 下的
  `<script type="module">`，页面一片空白、控制台外没有任何迹象。在截图脚本里起一个十几行的
  静态服务器（`node:http` + `readFileSync`，按后缀给 `Content-Type`）指向 `.preview/dist` 即可。
- **假的 `window.workbench` 必须实现 `getBootstrap`**：`bootstrapSnapshot()` 走的就是它
  （见 [bootstrap.ts](../../src/renderer/src/bootstrap.ts)），缺了它整个 store 退回 `DEFAULT_SETTINGS`
  + 异步加载那条老路 —— 而单独挂一个组件时没人调 `init()`/`loadData()`，于是设置永远是默认值。
  症状是「按设置分支渲染的区块根本不出现」（比如需要先填仓库地址才显示的那几块），
  很容易误判成新写的 `v-if` 写错了。顺手给 `getThemeConfig` 也补上。
- **桩必须拼出真正的源码，别 `JSON.stringify(带方法的对象)`**：`JSON.stringify` 会把值为函数的键整个丢掉，
  于是每个通道都落到 Proxy 兜底、返回 `{ ok: true, data: null }`，页面只剩一片空态 ——
  截图里「有外壳、有标题栏」看着像跑通了，其实一个通道都没验到（踩过一次，A/B 比对差点据此收工）。
  判据是 `document.documentElement.dataset.theme` 有没有被写上：空的就说明 `getBootstrap` 没生效。
- **纯浏览器里必定有一条 `Tauri 运行时不可用，无法调用 data_load` 异常**，这是环境造成的、不是产物的问题：
  `main.ts` 调的 `initState()`（[state.ts](../../src/renderer/src/workbench/state.ts)）**直接** `invoke('data_load')`，
  不经过 `window.workbench`，所以顶替 `window.workbench` 拦不住它。它只让 `initState` 提前 reject
  （`app.mount` 在 `finally` 里，界面照常出），别顺着这条去查产物。
  反过来，`window.workbench` 的桩是有效的：`installTauriWorkbench()` 里 `hasTauri()` 为假就直接 return，不会覆盖它。
- **store 的动作是一参调用，桩别按 `{ patch }` 解包**：`window.workbench.updateSettings(patch)`
  收的就是补丁本身（`{ patch }` 那层是适配层调 Tauri 命令时的写法）。桩里写成 `args?.patch`
  会静默返回未修改的值，看起来就是「点了没反应」。
- **`updateSettings` / `updateThemeConfig` 的桩要回一份新对象**：真适配层给的是拷贝，
  桩里若 `Object.assign(settings, patch)` 之后把同一个对象回出去，store 那边
  `settings.value = data` 等于赋了同一个引用 —— 依赖它的 computed / watch 全都不重算，
  表现成「改是改了（直接读 store 能读到新值），界面纹丝不动」。
  回 `{ ...settings }` 就好。这类「数据对了、界面没动」先怀疑桩，别改组件。
- **设置弹窗的滚动容器是每个 `.pane`，不是 `.settings__body`**：正文（`.settings__body`）只是过道，
  各 pane 自己滚并各留各的位置（见 SettingsDialog 里的注释）。要滚到「账号 / Token 同步」那几块，
  得挑当前可见的那个 pane 滚（`getComputedStyle(p).display !== 'none'`），
  滚 `.settings__body` 只会原地不动，症状是「截来截去都停在半截」。
- **刚打开的弹窗要在下一次求值里才查得到 DOM**：`demo.open(); document.querySelector('button.nav-item').click()`
  写在同一次 `Runtime.evaluate` 里会**点空** —— Vue 还没重新渲染，节点根本不存在，
  而 `querySelector(...)` 返回 null 时 `.click()` 抛错才看得见，写成 `?.click()` 就会静悄悄什么都不发生。
  拆成两次求值（中间 sleep 一下）即可。
- **切场景时注意状态之间的优先级**：组件里 `v-else-if` 的先后就是优先级。
  账号弹窗里「等待授权」排在「已登录」前面，所以只改账号、不清 `authPending`，
  截出来的仍然是等待态 —— 这类「改了没反应」先怀疑场景没切干净，别去改组件。
- **截图按"当时在调什么"命名，成对的用 `-before` / `-after`**。这是给当时的自己看的，
  反正是用完即删，别花心思整理成体系。
- **按约定直接返回结构的通道，桩里不能再套一层 `Result`**：`listProjects` / `getSettings` /
  `getThemeConfig` / `getDataLocation` / `getActivity` / `listQuickApps` / `listCommands` /
  `checkPackageManagers` / `getNvmStatus` / `getNrmStatus` / `authStatus` / `listWallpapers` 都是
  直接给数据（见 types.ts 的 WorkbenchApi），照着别的通道写成 `{ ok: true, data: … }` 的话，
  `loadData()` 里 `data.projects` 就是 `undefined`，报出来的是某个 computed 里的
  `Cannot read properties of undefined (reading 'map')` —— 错在桩上，别顺着组件找。
- **拖拽这类交互可以用合成 PointerEvent 驱动**：`pointerdown` 派给元素本身、
  `pointermove` / `pointerup` 派给 `window`（组件的监听就挂在 window 上），
  不必为了验一次拖动去凑 `Input.dispatchMouseEvent` 的坐标。**但 Vue 是异步渲染**：
  在同一次 `Runtime.evaluate` 里派完事件紧接着读 `getComputedStyle` / `getBoundingClientRect`，
  拿到的还是渲染前的值（会误判成「拖了没反应」），要另发一次求值再读。
- **运行中的终端不让关**：要验「一个终端都没有」那一步，得先按适配层的做法推一条
  `success` / `idle` 的状态事件把它停下来，否则 `closeTerminal` 只会弹一句警告、界面纹丝不动。
- **动画往哪边走，靠逐帧记录判，别靠截图猜**：在 `Runtime.evaluate` 里起一个 rAF 循环，每帧记下
  `getComputedStyle` 的 `transform`（`new DOMMatrix(...).m41` 取横向位移）、`height`、`opacity`，
  跑满几百毫秒后一次性把数组读回来 —— 一眼就能看出「谁先动、往哪边动、哪一段是空转」。
  截图只能证明「某一帧长这样」，判定方向时很容易看成自己希望的那个答案。
  这条也是查「一条 transition 挂多个属性」的顺手工具：同一个元素上高度和位移同时走时，
  观感会被盖成另一个方向（踩过一次），把其中一个挪到 `transition: … 0.16s ease 0.18s` 的延迟里分成两拍就好了。
- **驱动脚本的结果要 `appendFileSync` 写文件，不要 `console.log` 走管道**：排错时最容易顺手敲成
  `node .preview/drive.mjs | tail -40`，而 `tail` 会把输出攒到进程结束才吐 —— 脚本一旦中途挂住（见下一条），
  你会对着一个空日志查半天，还以为脚本没跑。写文件则每一步都落得下。
- **开着 WebSocket 的 node 脚本不会自己结束**：CDP 的 `WebSocket` 会让事件循环一直有活干，
  于是出错退出时后台任务永远停在「运行中」。收尾放在 `finally` 里：关 ws + `process.kill(-child.pid)` 杀无头浏览器，
  最后 `process.exit()` 兜底。CDP 自己也有超时上限，进程组不杀干净会留一堆无头 Edge 在后台。
- **右键菜单用 `Input.dispatchMouseEvent` 的 `mousePressed` + `mouseReleased`（`button: 'right'`）开**：
  走的是真指针，`contextmenu` 会照常发出，也顺带把 Chromium 那套「右键落点」的默认行为带上了 ——
  比在页面里合成一个 `contextmenu` 事件更接近用户按下去的样子。菜单项的点击用 `Runtime.evaluate` 里
  直接 `.click()` 就够（Vditor 那些处理函数不看 `isTrusted`）；要展开子菜单则必须真的移指针
  （子菜单是 CSS `:hover` 开的），`mouseMoved` 之后另发一次求值再读。
