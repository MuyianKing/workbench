# AGENTS.md

本文件是 Workbench 项目的 AI Coding Agent 约束。第 0 节为跨项目通用约束（已并入，
原模板见 [AGENT_COMMON.md](.agents/skills/generate-project-constraints/AGENT_COMMON.md)），
第 1 节起为本项目专属事实与强约束；规则冲突时以项目专属章节为准。

## 0. 通用约束

### 修改原则

- 修改文件前先读取并理解现有实现，沿用所在模块的代码风格、命名和技术模式。
- 只做完成用户需求所需的最小修改，不进行无关重构。
- 新增依赖前先检查项目已有依赖、组件、插件和工具；能复用则不引入同类库。
- 不主动新建 README、CI、Docker、测试配置、类型声明或其他非用户要求文件（更新既有文档不算新建，不违反本条）。
- 修改多个关联文件时，保持接口、命名、数据结构和调用链一致。
- 先检查相关文件和既有调用方式，不仅凭文件名或常见框架习惯猜测实现。

### 组件设计

- 组件保持高内聚、低耦合，每个组件只承担清晰的展示、交互或领域职责。
- 父组件负责页面编排、数据准备和跨组件协作；子组件通过 props 接收输入，通过事件、双向绑定或项目既有模式返回结果。
- 避免使用 DOM 查询、隐式全局变量或事件总线传递核心业务数据。
- 子组件不直接依赖父组件内部状态、无关全局状态或宿主页面实现。
- 多个可独立理解的弹窗、表单、列表或复杂交互流程，应按职责拆分为子组件。
- 接口调用归属于实际负责该业务动作的组件或 API 模块，展示组件不承担无关业务流程。

### UI 与样式

- UI 组件优先复用顺序为：项目已有业务全局组件、项目基础公共组件、当前 UI 库原生组件；现有能力无法满足需求时才新增局部组件。
- 主题颜色必须优先使用项目中已有的主题变量；仅在没有对应主题变量时，才允许定义新的颜色值。
- 修改响应式布局时，同时检查模板、工具类、局部样式、媒体查询和样式加载顺序，避免同一属性存在多个冲突来源。
- 注释和界面文案遵循项目既有语言风格；格式化遵循项目现有配置。
- 本项目不使用 Tailwind CSS / 原子化 CSS，故通用约束中两条 Tailwind 专属条目在本项目不适用。

### 验证与 Git

- 较大代码修改后运行项目已有的静态检查或测试命令；没有对应脚本时，不假设或自行引入测试框架。
- 默认不执行 Git 提交，除非用户明确要求。
- 用户要求提交时，先检查 `git status`、`git diff` 和近期提交风格。
- 不泄露、输出或提交密钥、令牌、内部地址及其他敏感配置。
- 禁止执行 `git reset --hard`、`git clean -f`、强制推送等破坏性 Git 操作，除非用户明确要求。
- 项目文件引用分两种场合：对话回复里用可跳转的绝对路径链接；写进仓库文档（本文件、README、`docs/`）的链接一律用相对路径（相对仓库根），保证可移植。

## 1. 项目边界

- 定位：Windows 桌面应用（Tauri 2 + WebView2），本地「前端项目控制台」；纯本地工具，不联网、不上报数据。
- 技术栈：Rust 后端（Tauri ^2）+ Vue ^3.5.13 + TypeScript ^5.9.3；Element Plus ^2.8.8 + @element-plus/icons-vue ^2.3.1；Pinia ^4.0.3。
- Rust 侧依赖（`src-tauri/Cargo.toml`）：`tauri`（`tray-icon`）、`tauri-plugin-dialog` / `opener` / `single-instance`、`rusqlite`（`bundled`，读 ZCode 本地 sqlite）、`zstd`（DSH 会话多帧解压）、`serde` / `serde_json` / `uuid`。**不要**再引入其他 native / 运行时依赖。
- 构建 / 打包：Vite ^7.3.6（渲染层）+ cargo / Tauri CLI → Windows x64 NSIS。包管理器固定 npm（`package-lock.json`）；Rust 依赖的锁文件 `src-tauri/Cargo.lock` 要提交。
- 工具链前置：Rust stable（`x86_64-pc-windows-msvc`）+ MSVC 生成工具 + Windows SDK。rustc 自己经注册表定位 MSVC，不依赖 PATH 上的 `cl.exe`（所以 Git 自带的 `link.exe` 不会被误用）。
- 测试：Vitest ^5.0.0（前端，`environment: 'node'`）+ `cargo test`（Rust，测试写在同文件的 `#[cfg(test)] mod tests`）。
- 渲染层与后端都不再需要 native 模块编译：`better-sqlite3`、`node-gyp`、`electron-builder` 之类的历史依赖已全部移除。
- TypeScript 停在 5.x，不要升到 7：vue-tsc 3 要靠 `typescript/lib/tsc` 子路径工作，TS 7（原生编译器）不再暴露它，升上去 `npm run typecheck` 直接报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- `tsconfig.web.json` 里**不要**加 `ignoreDeprecations`（TS 5.x 只接受 `"5.0"`，写别的值会让整个 typecheck 报 TS5103）。
- 禁止引入：Tailwind / UnoCSS 等原子化 CSS、Vue Router、axios 或其他请求库、Element Plus 之外的 UI 库、Pinia 之外的状态库、Vitest 之外的测试框架。
- 无 ESLint / Prettier / EditorConfig：不要自行新增 lint 或格式化配置与依赖。
- 平台边界：仅 Windows；不引入 macOS / Linux 适配。

## 2. 文件落位

- Rust 后端在 `src-tauri/src/`：
  - [main.rs](src-tauri/src/main.rs)：入口、窗口、托盘、单实例、生命周期（退出落盘 + 收掉子进程）。
  - [commands.rs](src-tauri/src/commands.rs)：IPC 命令层，只做「取原始数据 / 落盘 / 调系统能力」，不做业务语义。
  - `paths.rs`（数据目录与指针）、`store.rs`（去抖 JSON 落盘）、`encoding.rs`（base64 / UTF-16LE）。
  - `session.rs`（子进程会话：起命令、按批回传输出、按进程树终止）、`proc.rs`（带超时的子进程原语与进程树终止）。
  - `system.rs`（端口检测 / 资源管理器 / ShellExecute）、`nvm.rs`（nvm 只读探测）、`token.rs`（ZCode sqlite + zstd）、`icon.rs`（程序图标抽取）。
- 配置：`src-tauri/tauri.conf.json`（窗口、打包、资源映射）、`src-tauri/capabilities/default.json`（能力白名单）。
- 渲染层在 `src/renderer/src/`：公共与页面组件在 `components/`，Pinia store 在 `stores/`，设计令牌 `styles/tokens.css`，全局样式 `styles/global.css`。
- **适配层**在 `src/renderer/src/workbench/` —— 它是原 preload + 主进程逻辑的替代品，实现 `window.workbench` 契约：
  `bridge.ts`（invoke / 事件 / 未移植兜底）、`events.ts`（适配层内部广播）、`state.ts`（持久化状态与增删改）、`session.ts`（进程会话与事件翻译）、`scanner.ts` / `nvm.ts` / `token.ts` / `system.ts` / `quick-launch.ts`，全局类型声明在 `global.d.ts`。
- 两端共用（类型、契约、纯逻辑）放 `src/shared/`；`shared/` 里禁止 import node、Rust 或渲染层代码。
- 单测与被测模块同目录，命名 `*.test.ts`。路径别名：`@` → `src/renderer/src`，`@shared` → `src/shared`。
- 文档分工：[README.md](README.md) 是当前功能与架构事实的唯一真源，本文件只写约束，`docs/dev-notes/` 放动手方法与踩坑。

## 3. 编码规范

- 全量 TypeScript，`strict: true`；Vue SFC 一律 `<script setup lang="ts">` 组合式 API，不写 Options API。
- 组件接口用 `defineProps<{...}>()` / `defineEmits<...>()`；props 只读，子组件不直接改父级状态，经 store action 或事件回传。
- 契约以 [types.ts](src/shared/types.ts) 的 `WorkbenchApi` 为准：Tauri 命令名用 snake_case，camelCase 方法名到命令名的映射只出现在适配层。
- 通道一律返回 `Result<T>`（用 [result.ts](src/shared/result.ts) 的 `ok` / `fail` / `toResult`），不 reject。Rust 的 `Err(String)` 会被 Tauri 直接 reject，所以适配层用 `guard()` 收敛（它同时兼容字符串与 Error，不能直接套 shared 的 `toResult`）。
- 新增通道的三步：在 `WorkbenchApi` 登记 → 在适配层实现 → 需要后端时在 `commands.rs` 写命令并在 `main.rs` 的 `generate_handler!` 注册。渲染层→主进程的单向事件走适配层的 `events.ts` 广播。
- **数组 / 对象形状的取值接口必须真实现，绝不能落到「尚未移植」兜底**：兜底返回的是 `Result` 对象，store 会把它当数组遍历，直接抛错并把整条 `init()` 打断——表现成完全无关的功能失灵（踩过一次：`listQuickApps` / `listCommands` 让「系统状态」一直没数据）。
- 数据结构变更要同步落盘的 sanitize（[persisted-data.ts](src/shared/persisted-data.ts) 的 `sanitizeSettings` / `parseData`），老数据文件缺字段须有默认值，不留未收敛的 `undefined`。
- 命名：文件 kebab-case，类型 / 接口 PascalCase，函数与变量 camelCase；注释与界面文案统一用中文。
- 纯逻辑优先下沉到 `src/shared/` 并补对应单测。
- **需要文件系统的逻辑，把 fs 抽成参数注入**（参考 [scanner.ts](src/shared/scanner.ts) 的 `ScanFs`）：生产实现走 Rust 命令，测试实现走 `node:fs`。这样逻辑与既有测试都留在 TS / vitest，不必为了换运行时重写一遍——`nvm.ts`、`scanner.ts` 就是这么落的。

## 4. UI 与样式

- 样式为手写 CSS，不使用 Tailwind / 原子化 CSS；颜色、间距、圆角、字号一律取 [tokens.css](src/renderer/src/styles/tokens.css) 的 `--bg-*`、`--ink-*`、`--st-*`、`--sp-*`、`--r-*`、`--fs-*`。
- 暗色只在 `:root[data-theme='dark']` 覆盖令牌，不在组件里写 `data-theme` 分支。
- 色彩语义：界面主体灰度，彩色只表达运行状态（`--st-run` / `--st-ok` / `--st-fail`）；终端面板始终深色（`--term-*`）。
- 组件样式写 `<style scoped>`；需要穿透 Element Plus 或需全局共享的外壳（`.panel`、`.facts` 等）写进 [global.css](src/renderer/src/styles/global.css)。
- UI 复用顺序：`components/` 既有业务组件 → Element Plus 原生组件 → 新增局部组件；图标统一用 `@element-plus/icons-vue`。
- 弹层遮罩由 `global.css` 的 `.el-overlay` 统一处理（从标题栏下沿开始、不压暗背景），不要在单个弹窗里另写遮罩。
- 明暗切换经 `theme-transition.ts` 的 View Transitions 驱动，`<html>` 上同时维护 `data-theme` 与 `.dark` 类；主题切换的守卫用 [stores/projects.ts](src/renderer/src/stores/projects.ts) 内的 `appliedTheme` 变量而非读 DOM（原因见该文件里的注释）。
- 拖动窗口要用 `data-tauri-drag-region`（WebView2 不认 `-webkit-app-region`），见 [TitleBar.vue](src/renderer/src/components/TitleBar.vue)：
  裸属性（无值 / `"true"`）只认「直接按在带属性那个元素上」，子元素要自己在模板上再标一遍，`"deep"` 才是整棵子树。
  框架注入的脚本在 mousedown 里按 `e.detail` 分流：1 走 `start_dragging`、2 走 `internal_toggle_maximize`（源码 `tauri/src/window/scripts/drag.js`），
  即拖动与双击最大化都是它做的 —— **不要再写 `@dblclick` 自己 toggle 一次**，两边各切一次正好抵消，表现成「双击标题栏毫无反应」（踩过一次）。
  `start_dragging` **不在** `core:default` 里，必须在 [capabilities/default.json](src-tauri/capabilities/default.json) 额外放行 `core:window:allow-start-dragging`；
  被 ACL 拦下的 invoke 是静默失效，症状是「按住标题栏毫无反应、控制台也不报错」，别去 DOM 里找原因。
  能力文件编译期才生效：改完必须重启应用（`tauri dev` 会自己重建，`cargo build` 也行）。

## 5. 请求 / 状态 / 配置

- 渲染层不直接访问 Node / 文件系统 / WebView 宿主能力：一切经 `window.workbench`，实现见 `src/renderer/src/workbench/`，契约见 [types.ts](src/shared/types.ts) 的 `WorkbenchApi`。
- **唯一的例外是工作区背景图**：它不经后端解码回传，而是让 webview 按文件直接加载（asset 协议），URL 由适配层的 `assetUrl()` 转出（见第 4 节）。读取权限**一律在 Rust 侧按单个文件授予**（[commands.rs](src-tauri/src/commands.rs) 的 `allow_background`），`tauri.conf.json` 里 `assetProtocol.scope` 必须保持为空 —— 往里写 `**` 等于把整块磁盘敞开给渲染层读。
- 后端只负责「取原始数据 / 落盘 / 调系统能力」；合并、排序、修剪、状态机、命令构造这些业务语义留在 TS 适配层。好处是绝大多数改动仍是 Vite 的秒级热更新，不必重编 Rust——这也是选它而不是把逻辑写进 Rust 的原因。
- API 约定：判 `result.ok`，失败取 `result.error` 提示；`checkPort`、`listProjects`、`getNvmStatus`、`listWallpapers`、`checkPackageManagers` 等少数通道按约定直接返回具体结构而非 `Result`。
- 状态管理：跨组件状态集中在 [stores/projects.ts](src/renderer/src/stores/projects.ts) 的 `useProjectsStore`，组件不另建全局状态、不用事件总线传业务数据。
- 持久化在 Rust 侧：走 `store.rs`（300ms 防抖 + 临时文件 rename + 退出前同步落盘）。数据文件 `workbench-data.json`、`theme.json`（首页布局）、`token-data.json`（Token 按天快照），目录指针 `data-location.json` 固定在 `%APPDATA%/Workbench/`。
- **数据目录必须与 Electron 版保持一致**（`%APPDATA%\Workbench`）：不要图省事改用 Tauri 的 `app_config_dir()`，它按 identifier 生成 `%APPDATA%\com.muyian.workbench`，换位置用户就等于丢了项目列表。路径一律经 `paths.rs` 的 `data_dir()` / `data_file()` 现取，不要缓存写死。
- 首屏快照：Tauri 没有同步 IPC（原 `ipcRenderer.sendSync` 那套行不通），改为建窗口时用 `initialization_script` 注入 `window.__WB_BOOTSTRAP__`（见 [main.rs](src-tauri/src/main.rs) 的 `bootstrap_script`），渲染层同步读它，第一帧就是用户设置的样子。
- 日志：子进程输出由 `session.rs` 按批（200 行 / 50ms）回推 `session:lines`，`session:exit` 单独回退出码；适配层翻译成 `ProcessLogEvent` / `ProcessStatusEvent` 后广播，store 按帧写入 `RingLog`。日志缓冲刻意 `markRaw`、不参与响应式，靠 `logVersion` 触发渲染，读取日志用 `activeLogs`。
- 子进程一律按**进程树**终止（`taskkill /T`）：`cmd /C npm run dev` 之下才是真正的 dev server，只杀 cmd 会留下占着端口的孙进程，表现为「已停止」但端口仍被占。超时清理也要走同一条路，否则超时形同虚设。

## 6. Agent 操作与验证

- 常用脚本：`npm run typecheck`（渲染层 + 测试两个 tsconfig）、`npm test`（vitest run）、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run dev`（tauri dev）、`npm run build`（tauri build）、`npm run build:renderer`（只编渲染层）、`npm run dev:renderer`（只起渲染层开发服务器，tauri dev 的 devUrl）、`npm run preview:renderer`（在浏览器里看布局，产物落 `.preview/`）、`npm run icons`（重新生成应用与托盘图标）；其余脚本以 `package.json` 为准；不新增 lint / format 工具。
- `npm run typecheck` 与 `npm test` 覆盖渲染层与 `src/shared`；改了 Rust 还要跑 `cargo test` 与 `cargo build`。
- **改 Rust 前先关掉正在运行的应用**：链接会因 exe 被占用而报「拒绝访问（os error 5）」，而**构建失败后你跑起来的仍是旧二进制**，据此得出的结论会完全跑偏（踩过一次，白追了两轮）。打包同理：`tauri build` 与 `tauri dev` 会抢同一个 `target/` 的构建锁，并行只会互相拖慢，量构建耗时还会得出错值（见 [docs/dev-notes/build-performance.md](docs/dev-notes/build-performance.md)）。
- `cargo test` 有时会卡在链接或执行上，两种都能绕：
  `LNK1104 / failed to remove ...exe` 是旧的测试二进制被残留句柄锁住（进程早退了，句柄还在），
  给测试换个产物名即可（`RUSTFLAGS="--cfg wb_verify" cargo test`）；
  `could not execute ... (never executed) + 拒绝访问` 是环境拦了刚链接出的可执行文件，
  把 `target/debug/deps/workbench-*.exe` 复制一份再直接运行，副本能跑（踩过，两个都遇到过）。
- 排查 WebView2 里的运行时问题（未捕获异常、控制台警告、接口实际返回值）：用
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动应用，再用 CDP
  进页面求值或读控制台。比看截图猜、比加日志重编都可靠得多。
- 功能新增或调整后必须同步更新 [README.md](README.md)（分工见第 2 节）：漏更新就会把错误事实传给后来者，包括下一个会话的 Agent。
- 不提交构建产物与缓存：`out/`、`dist/`、`.preview/`、`*.tsbuildinfo`、`src-tauri/target/`（已在 `.gitignore`）。
- 视觉验证（改布局 / 配色 / 主题时把渲染层单独跑在浏览器里截图比对）统一用 `.preview/` 作临时工作区，
  做法见 [browser-preview-verification.md](docs/dev-notes/browser-preview-verification.md)。
  **任务完成后必须直接删掉整个 `.preview/` 目录**，不留在磁盘上；值得留下的经验写进该文档，不靠保留脚本传递。
  根目录 `vite.preview.config.ts` 是常驻入口（`npm run preview:renderer`），不属于工作区，不要删。
- 除 `npm install` 外不手动改 `node_modules` 或 `package-lock.json`；Rust 依赖只经 `src-tauri/Cargo.toml` 增删。
- 默认不执行 git 提交；用户要求提交前先看 `git status` / `git diff`，沿用「优化代码结构」这类中文提交风格。
- 用户数据目录路径、进程记录等不要硬编码进仓库；不输出或提交任何密钥 / token。
