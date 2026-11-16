# 浏览器预览验证工作区

**这套只在用户明确要求做视觉验证时才用**（见 [AGENTS.md](../../AGENTS.md) 第 6 节：用户没提就不做）。把渲染层单独跑在浏览器里、
喂一份假数据、截图比对，不必每次把整个 Tauri 应用拉起来，一轮只要几秒。这套工作区**用完即删**（见「清理约定」），所以要复现时
照本文重建。

## 清理约定

`.preview/` 是临时工作区，不是项目资产：

- `.gitignore` 里的 `apps/desktop/.preview/**` 会忽略它的全部内容，任何东西都不进版本库
- **任务完成后直接删掉整个目录**（`rm -rf apps/desktop/.preview`）——截图、日志、临时脚本一律不留
- 值得留下的经验写进本文件，不靠保留脚本传递
- **同时有别的会话在改 UI 时，各用各的子目录**（`apps/desktop/.preview/<这次在验什么>/` 里放 `harness/`、
  `dist/`、`shot.mjs`、`out/`，配一份自己的 vite 配置）：`harness/main.ts`、`dist`、`shot.mjs`
  这些路径是共享的，另一个会话一 build 就把你的换掉 —— 症状是「脚本跑完什么都没量到、
  或者量到的是别人那个组件」，别顺着自己的组件找

`apps/desktop/vite.preview.config.ts` 是常驻入口（挂在 `pnpm run dev:renderer` 上），不属于工作区，不要删。

## 两条验证链路

要先判断「要验的东西跑在哪一侧」，选错了会白忙：

| 要验的东西 | 用什么 | 为什么 |
|---|---|---|
| 组件布局 / 间距、配色、明暗主题、hover / focus 态 | 浏览器（无头 Edge + CDP） | 快、可脚本化、能放大到像素 |
| Rust 侧逻辑：图像解码缩放、路径解析、端口判定、进程树终止 | `cargo test`（单测写在同文件的 `#[cfg(test)] mod tests`） | 这些逻辑不经过界面，浏览器预览覆盖不到 |

新加一条通道、或者要确认「界面 → 适配层 → Rust」这一整串真的通了（假数据验证不了这一段），
见 [tauri-app-verification.md](tauri-app-verification.md)。

### 一、把渲染层单独跑起来

`vite.preview.config.ts` 只起 renderer（端口 5274），与构建无关：

```bash
cd apps/desktop && npx vite build --config vite.preview.config.ts
# 产物在 apps/desktop/.preview/dist
```

开发态用 `pnpm run dev:renderer`。注意 vite（7 / 8 都一样）只监听 IPv6 的 `localhost`，脚本里访问 `127.0.0.1:5274`
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
  （见 [verification-pitfalls.md](verification-pitfalls.md) 的「已知的坑」），把它当成 mock 出错会让每一张截图都判失败；
- 假的桩**必须落在 `dist` 里**、而且要在 `<title>` 之后、所有脚本之前，以**经典脚本**引入：
  - 放在工作区根目录（而不是 dist）是个很隐蔽的错：静态服务只服务 dist，页面加载它是 404，
    而现象是「页面正常出来了、外观全是默认值」，很容易顺着 `getBootstrap` 找；
  - 只靠「经典脚本先于 deferred 模块执行」也能成立，但那是个藏在规范里的前提 ——
    写在模块脚本前面谁都看得出来，而且 `dist/index.html` 是每次 build 重新生成的，
    注入脚本必须**幂等**（带 `<head>` 里那句判断，别重复插）；
- 起浏览器之前先自己 `fetch` 一遍 `/` 与桩文件、断言 200：页面 404 时无头那边只会得到一张空白，
  而现象会指向完全无关的地方。判据还是那条老的 —— `document.documentElement.dataset.theme` 是空的
  就说明 `getBootstrap` 没生效（HTML 里有那行标签不代表文件真的在）；
- 假的内置壁纸清单要和 `apps/desktop/resources/backgrounds/` 保持一致，并把原图拷进 `dist`；
  缩略图按 Rust 侧 `imaging.rs` 的做法压到 360 宽，别拿几兆的原图铺设置面板

#### 只验一个组件

整页跑起来要喂十来个通道的假数据；改某一块面板时不必这么麻烦 —— 在工作区里再放一份
vite 配置，把 `root` 指到工作区内的一个小目录，只挂那一个组件：

```ts
// apps/desktop/.preview/vite.harness.config.ts
root: resolve(__dirname, 'harness'),                       // 工作区里的 index.html + main.ts
publicDir: resolve(__dirname, '../apps/desktop/src/renderer/public'),   // 见下面那条：Vditor 要靠它
resolve: { alias: { '@': '…/apps/desktop/src/renderer/src' } },   // 域包（@workbench/*）按包名解析，不配别名
plugins: [
  vue(),
  // Element Plus 是按需的：少了这层，<el-*> 只会渲染成空标签（主构建同款配置见 vite.config.ts）
  Components({ resolvers: [ElementPlusResolver({ importStyle: 'css' })], dirs: [], dts: false }),
  vditorAssets(),                                          // sync-vditor-assets.mjs 导出的那个插件
]
```

`main.ts` 里照旧 import `@/element-plus-styles`（命令式 API 与 v-loading 的样式）、
`element-plus/theme-chalk/dark/css-vars.css`、`@/styles/tokens.css`、`@/styles/global.css`
（少了这几样配色与令牌就不是线上的样子；**整包 `element-plus/dist/index.css` 已经不用了**），
把组件挂进一个**尺寸等于真实卡片**的盒子里（卡片内边距由组件自己带，外面别再补一圈，
否则量出来的宽度会比线上窄一截），`window.workbench` 只实现这一个组件用到的通道。
暗色靠 `document.documentElement.dataset.theme` 加 `.dark` 类切。

这样一次 build 一两秒，也不用碰仓库里的任何文件。

**挂到跟 Vditor 有关的组件时，`publicDir` 与 `vditorAssets()` 两样都要**：编辑器本体打在 JS 里，
但图标 sprite、语言包、lute 是运行时按 `cdn` 取的，它们住在 `apps/desktop/src/renderer/public/vditor/dist/`
（由那个插件在 dev / build 前同步）。`root` 指到工作区之后 `public/` 默认变成工作区自己的目录，
少了这两样会一路 404 —— 症状是「编辑器起不来 / 图标全空」，别顺着组件代码找。

### 三、Rust 侧逻辑走 `cargo test`

图像解码缩放、路径解析、端口判定、进程树终止这些逻辑现在都在 `apps/desktop/src-tauri/src/` 里，
浏览器预览够不到，也不该为了验它们去拉整个应用：测试就写在与实现同文件的 `#[cfg(test)] mod tests` 中。

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

改 Rust 前先关掉正在运行的应用，否则链接会因 exe 被占用而报「拒绝访问」。另外 `cargo test`
偶尔会卡在链接或执行上，两种绕法：

- `LNK1104 / failed to remove ...exe`：旧的测试二进制被残留句柄锁住（进程早退了，句柄还在），
  给测试换个产物名即可 —— `RUSTFLAGS="--cfg wb_verify" cargo test`；
- `could not execute ... (never executed) + 拒绝访问`：环境拦了刚链接出的可执行文件，
  把 `target/debug/deps/workbench-*.exe` 复制一份再直接运行，副本能跑。

**要顺手看一眼真数据时**，别改成临时 `main`：把待验的入参做成测试用例，用 `-- --nocapture`
打印中间值，或者按 [tauri-app-verification.md](tauri-app-verification.md) 连真应用的 CDP 求值。

## 真应用里那一套

- 拉起真应用、CDP 驱动、无头截图、调试探针：[tauri-app-verification.md](tauri-app-verification.md)
- 量对比度、手写静态 HTML 的理由、历次踩过的坑：[verification-pitfalls.md](verification-pitfalls.md)

新加一条通道、或要确认「界面 → 适配层 → Rust」整串通了，先读第一份。
