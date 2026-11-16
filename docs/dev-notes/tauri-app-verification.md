# 在真应用里验证（Tauri + WebView2）

界面 → 适配层 → Rust 这一整串只有在真应用里才通得起来；假数据覆盖不到。CDP 驱动、无头截图与探针的配方都在这里。
工作区与浏览器预览那一套见 [browser-preview-verification.md](browser-preview-verification.md)。

浏览器预览里 `window.workbench` 是假的，因此「新加的通道到底通没通」它是验不了的 ——
明明只是命令名拼错、参数名没对上，预览里照样一片正常。这时直接连真应用：

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" pnpm run dev
```

起来之后 `/json` 里就有页面 target，连它的 `webSocketDebuggerUrl` 发 `Runtime.evaluate`
即可（就是前面的无头配方，只是不用自己起浏览器）。几件顺手的事：

- **要验 CSP / asset 协议这类只在生产态成立的东西，别用上面那条**（dev 下页面来自 Vite，
  CSP 根本不生效，见 modules/ipc-and-state.md）。手搓一个生产态二进制来验：
  `pnpm run build:renderer` 之后 `cargo build --release --features tauri/custom-protocol`
  （在 `apps/desktop/src-tauri` 下跑），再照上式起 `target/release/workbench.exe`。
  **`--features tauri/custom-protocol` 不能漏**：`tauri` 没带这个 feature 编出来就是 dev 语义
  （`generate_context!` 走 `devUrl`，exe 一起来就去连 `localhost:5274`，界面是空白 —— 而现象会指向
  完全无关的地方）。装着的那份与 `target/release` 那份算同一个应用（单实例按 identifier 认名），
  验之前先把装着的关掉。
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
- **`pnpm dev` 起来的开发版不注册单实例，可以和装着的那份同时开**（正式版之间、以及
  `target/release` 那份与安装版之间仍按 identifier 互斥）。两边的数据目录按环境分开：安装版在
  `%APPDATA%\Workbench\data`，开发版在 `%APPDATA%\Workbench-dev\data`（见 `paths.rs` 的 `APP_DIR`）——
  设置、项目列表、同步克隆、设备 id 各一份，开发时改截图开关 / 快捷键不会盖掉装着的那份。
  邮件 / 禅道的后台轮询与通知仍会各跑一遍。开发版首次启动是空数据目录；要把现有配置带过去，
  **先停掉开发版**（它按整份文件落盘，运行中复制会被内存里那份盖回去），再把安装版 `data\` 下的
  `workbench-data.json` 与 `theme.json` 复制到 `Workbench-dev\data\` 即可。AI 会话的正文在
  `pi\sessions\`（不复制的话左栏那些会话点不开，要带就连目录一起带）；钉图与网关流水这类本机状态
  建议不要带。**别复制 `device.json`**（两个环境用同一个设备 id 会往同步仓库的同一个分片里写）。
  复制过去的 `workbench-data.json` 也带着同步仓库地址与邮件 / 禅道账号：开发版会把它们再轮询一遍、
  并作为一个新设备往同步仓库推；不想这样就在开发版设置里把仓库地址清空、把轮询周期设成 0。
  **凭据管理器里的密钥仍然共用**（AI / 邮箱 / 保险库，按 Windows 用户存、不分环境）：开发版不用重新配密钥，
  但在开发版里改密钥、或重新导入保险库密钥，会同时影响安装版。
- **要动设置又不想污染自己的配置，就把整个 `APPDATA` 指到临时目录再起应用**：
  `APPDATA='C:\Users\...\Temp\wb-smoke' pnpm run dev`。数据目录是 `%APPDATA%\Workbench-dev\data`
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
  `<meta name="referrer" content="no-referrer">`（见 `apps/desktop/src/renderer/index.html`）。

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
| 怀疑是毛玻璃（`backdrop-filter`）导致的合成问题 | 把那一处的 `backdrop-filter` 关掉再截一张，对比（现在面板 / 卡片 / 弹层 / 下拉都有这一层，逐个关） |
| 怀疑弹层被 `backdrop-filter` 子树拖累 | 把 `.el-overlay` 从 `.app` 子树挪到 `body`（Element Plus 的 `el-dialog` 默认不 Teleport 到 body），再截 |
| 想截弹窗里某一栏 | 先注入脚本滚到那一行，再截 |
