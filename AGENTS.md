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

- 定位：Windows 桌面应用（Electron），本地「前端项目控制台」；纯本地工具，不联网、不上报数据。
- 技术栈：Electron ^44.3.0 + Vue ^3.5.13 + TypeScript ^5.9.3；Element Plus ^2.8.8 + @element-plus/icons-vue ^2.3.1；Pinia ^4.0.3。唯一的运行时依赖是 better-sqlite3（读 ZCode 本地 sqlite 用，v13 自带全平台 prebuilds，禁止再引入其他 native / 运行时依赖）。
- 构建 / 打包：Vite ^7.3.6 + electron-vite ^5.0.0；electron-builder ^26.15.3 → Windows x64 NSIS。包管理器固定 npm（`package-lock.json`）。
- 开发依赖里的 `node-gyp`（^13）是刻意钉的：npm 会给 better-sqlite3 排一次源码编译，旧版 node-gyp 认不出新版 Visual Studio，删掉就可能装不上；原因见 [npm-install-native-module.md](docs/dev-notes/npm-install-native-module.md)。
- 测试：Vitest ^5.0.0，`environment: 'node'`，仅 `src/**/*.test.ts`。
- TypeScript 停在 5.x，不要升到 7：vue-tsc 3 要靠 `typescript/lib/tsc` 子路径工作，TS 7（原生编译器）不再暴露它，升上去 `npm run typecheck` 直接报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- Vite 也不要用 8：electron-vite 最新稳定版（5.x）的 peer 只到 vite 7。
- 禁止引入：Tailwind / UnoCSS 等原子化 CSS、Vue Router、axios 或其他请求库、Element Plus 之外的 UI 库、Pinia 之外的状态库、Vitest 之外的测试框架。
- 无 ESLint / Prettier / EditorConfig：不要自行新增 lint 或格式化配置与依赖。
- 平台边界：仅 Windows；不引入 macOS / Linux 适配。

## 2. 文件落位

- 主进程在 `src/main/`；IPC 注册入口 [ipc.ts](src/main/ipc.ts)，按业务拆出的通道处理放 `src/main/handlers/`（现有 `settings.ts` 配置、`quick.ts` 快捷启动、`commands.ts` 自定义命令、`window.ts` 窗口控制）。
- 子进程：`process-manager.ts`（spawn、状态机、按行日志、进程树终止）、`manager.ts`（会话与事件接线）。
- 持久化：`store.ts`（业务数据 + 设置收敛）、`json-store.ts`（通用 JSON 引擎）、`token-usage.ts`（Token 用量快照，实读 ZCode 本地 sqlite 并 max 合并落盘）；三者只在主进程使用。
- 预加载 `src/preload/index.ts` 只做 `contextBridge` 白名单，类型声明在 `index.d.ts`；渲染层经 `window.workbench` 调用。
- 渲染层在 `src/renderer/src/`：公共与页面组件都在 `components/`，Pinia store 在 `stores/`，设计令牌 `styles/tokens.css`，全局样式 `styles/global.css`。
- 两端共用（类型、IPC 契约、纯函数）放 `src/shared/`；禁止在 `shared/` 里 import electron 或渲染层代码。
- 单测与被测模块同目录，命名 `*.test.ts`。路径别名：`@` → `src/renderer/src`，`@shared` → `src/shared`。
- 文档分工：[README.md](README.md) 是当前功能与架构事实的唯一真源，本文件只写约束，`docs/dev-notes/` 放动手方法与踩坑。

## 3. 编码规范

- 全量 TypeScript，`strict: true`；Vue SFC 一律 `<script setup lang="ts">` 组合式 API，不写 Options API。
- 组件接口用 `defineProps<{...}>()` / `defineEmits<...>()`；props 只读，子组件不直接改父级状态，经 store action 或事件回传。
- 主进程 IPC handler 统一返回 `Result<T>`（用 [result.ts](src/shared/result.ts) 的 `ok` / `fail` / `toResult`），不 reject；渲染层判 `result.ok`。
- 新增 IPC 通道：在 [types.ts](src/shared/types.ts) 的 `IPC` 常量与 `WorkbenchApi` 同时登记，再补 preload 暴露与主进程 `ipcMain.handle`；主进程→渲染层的单向事件必须加入 `BroadcastChannel`。
- 数据结构变更要同步落盘的 sanitize（`store.ts` 的 `sanitizeSettings` / `parseData`），老数据文件缺字段须有默认值，不留未收敛的 `undefined`。
- 命名：文件 kebab-case，类型 / 接口 PascalCase，函数与变量 camelCase；注释与界面文案统一用中文。
- 纯逻辑优先下沉到 `src/shared/`（端口解析、Node 版本区间、排序、日志环形缓冲等）并补对应单测。

## 4. UI 与样式

- 样式为手写 CSS，不使用 Tailwind / 原子化 CSS；颜色、间距、圆角、字号一律取 [tokens.css](src/renderer/src/styles/tokens.css) 的 `--bg-*`、`--ink-*`、`--st-*`、`--sp-*`、`--r-*`、`--fs-*`。
- 暗色只在 `:root[data-theme='dark']` 覆盖令牌，不在组件里写 `data-theme` 分支。
- 色彩语义：界面主体灰度，彩色只表达运行状态（`--st-run` / `--st-ok` / `--st-fail`）；终端面板始终深色（`--term-*`）。
- 组件样式写 `<style scoped>`；需要穿透 Element Plus 或需全局共享的外壳（`.panel`、`.facts` 等）写进 [global.css](src/renderer/src/styles/global.css)。
- UI 复用顺序：`components/` 既有业务组件 → Element Plus 原生组件 → 新增局部组件；图标统一用 `@element-plus/icons-vue`。
- 弹层遮罩由 `global.css` 的 `.el-overlay` 统一处理（从标题栏下沿开始、不压暗背景），不要在单个弹窗里另写遮罩。
- 明暗切换经 `theme-transition.ts` 的 View Transitions 驱动，`<html>` 上同时维护 `data-theme` 与 `.dark` 类；主题切换的守卫用 [stores/projects.ts](src/renderer/src/stores/projects.ts) 内的 `appliedTheme` 变量而非读 DOM（原因见该文件里的注释）。

## 5. 请求 / 状态 / 配置

- 渲染层不直接访问 Node / Electron：一切经 `window.workbench`（preload contextBridge），契约见 [types.ts](src/shared/types.ts) 的 `WorkbenchApi`。
- API 约定：`invoke` 结果判 `result.ok`，失败取 `result.error` 提示；`checkPort`、`listProjects`、`checkPackageManagers` 等少数通道按约定直接返回具体结构而非 `Result`。
- 状态管理：跨组件状态集中在 [stores/projects.ts](src/renderer/src/stores/projects.ts) 的 `useProjectsStore`，组件不另建全局状态、不用事件总线传业务数据。
- 持久化只在主进程：走 `JsonStore`（300ms 防抖 + 临时文件 rename + 退出前 `flushSync`）；数据文件 `workbench-data.json` 与 `token-data.json`（Token 用量按天快照），目录指针 `data-location.json` 固定在 `%APPDATA%/Workbench/`。
- 路径取值经 `store.ts` 的 `currentDataDir()` / `currentDataFile()`，不要缓存写死（数据目录可整体迁移）。
- 日志：子进程输出经 `log-batcher` 按帧聚合后推送，渲染层按帧写入 `RingLog`；日志缓冲刻意 `markRaw`、不参与响应式，靠 `logVersion` 触发渲染，读取日志用 `activeLogs`。

## 6. Agent 操作与验证

- 常用脚本：`npm run typecheck`（node + web 双工程，另有 `typecheck:web` / `typecheck:node`）、`npm test`（vitest run）、`npm run build`、`npm run dev`、`npm run dev:renderer`（只起渲染层，供视觉验证用）、`npm run dist:dir`（免安装目录）、`npm run dist`（NSIS 安装包）、`npm run icons`（重新生成应用与托盘图标）；其余脚本以 `package.json` 为准；不新增 lint / format 工具。
- 改代码后至少运行 `npm run typecheck` 与 `npm test`；涉及渲染层时保持 `tsconfig.web.json`、涉及主进程时保持 `tsconfig.node.json` 通过。
- 功能新增或调整后必须同步更新 [README.md](README.md)（分工见第 2 节）：漏更新就会把错误事实传给后来者，包括下一个会话的 Agent。
- 不提交构建产物与缓存：`out/`、`dist/`、`.preview/`、`*.tsbuildinfo`（已在 `.gitignore`）。
- 视觉验证（改布局 / 配色 / 主题时把渲染层单独跑在浏览器里截图比对）统一用 `.preview/` 作临时工作区，
  做法见 [browser-preview-verification.md](docs/dev-notes/browser-preview-verification.md)。
  **任务完成后必须直接删掉整个 `.preview/` 目录**，不留在磁盘上；值得留下的经验写进该文档，不靠保留脚本传递。
  根目录 `vite.preview.config.ts` 是常驻入口（`npm run dev:renderer`），不属于工作区，不要删。
- 除 `npm install` 外不手动改 `node_modules` 或 `package-lock.json`。
- 默认不执行 git 提交；用户要求提交前先看 `git status` / `git diff`，沿用「优化代码结构」这类中文提交风格。
- 用户数据目录路径、进程记录等不要硬编码进仓库；不输出或提交任何密钥 / token。
