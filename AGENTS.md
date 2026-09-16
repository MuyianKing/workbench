# AGENTS.md

本文件是 Workbench 的 AI Coding Agent 约束：只写跨模块的硬约束，一行一条，不写解释。按模块的细则在
[docs/constraints/](docs/constraints/) 下（索引见第 5 节），功能与架构事实见 [features-and-architecture.md](docs/features-and-architecture.md)
（唯一真源，本文件不重复），动手方法与踩坑见 [docs/dev-notes/](docs/dev-notes/)。第 0 节为跨项目通用约束，
第 1 节起为本项目专属，冲突时以后者为准。

## 0. 通用约束

跨项目模板；与本文件后文重复的条目只保留后文那一份。

### 修改原则

- 改文件前先读懂现有实现，沿用所在模块的风格、命名与技术模式，不凭文件名或框架习惯猜。
- 只做需求所需的最小修改，不做无关重构；一次改动涉及多个文件时保持接口、命名、数据结构和调用链一致。
- 新增依赖前先查项目已有的依赖、组件、插件与工具，能复用就不引同类库。
- 不主动新建 README、CI、Docker、测试配置、类型声明等非用户要求的文件（更新既有文档不算新建）。

### 组件设计

- 一个组件只担一类职责；父组件负责编排与取数，子组件用 props 收输入、经事件或双向绑定回传，不直接改父级状态。
- 不用 DOM 查询、隐式全局变量或事件总线传业务数据；子组件不依赖父组件内部状态与宿主页面实现。
- 弹窗、表单、列表与复杂交互按职责拆子组件；接口调用归实际负责该动作的组件或 API 模块。

### UI 与样式

- 复用顺序：项目既有业务组件 → 项目基础公共组件 → UI 库原生组件 → 新增局部组件。
- 改响应式布局要同时检查模板、局部样式与媒体查询，避免同一属性多个来源打架。

### 验证与 Git

- 较大改动后跑项目已有的静态检查或测试命令；没有对应脚本时不自行引入测试框架。
- 禁止 `git reset --hard`、`git clean -f`、强制推送等破坏性操作，除非用户明确要求。
- 文件引用：对话回复用可跳转的绝对路径链接；写进仓库文档的用相对当前文件的相对路径。

## 1. 项目边界

- 定位：Windows 桌面应用（Tauri 2 + WebView2），一个窗口里管项目、记工作、写笔记、看 AI 用量；包管理器固定 npm，`Cargo.lock` 要提交。
- **联网边界：默认不联网、不上报任何数据；出口只有五个，且都由用户显式开启**：用户自己填的三个 git 仓库（用量同步、笔记图片、
  笔记本身，留空即关闭）、账号登录（点登录才打 GitHub / Gitee 的 OAuth 接口）、命令执行本身。不要新增网络出口、不往任何第三方
  服务发数据；笔记里的外链图片不算新出口；登录内嵌的 client_id/secret 是这条边界唯一一次放宽。
- 引新前端依赖先看它会不会在**运行时**去取外面的资源（Vditor 就是这类：资源按 `options.cdn` 取，默认指 unpkg）—— 这类要么把资源
  随包带一份、要么别引。
- Rust 依赖的判据是**不新增编译单元**，不是「不新增 crate 名」：先 `cargo tree -e normal -i <crate>` 确认它已经在图里；不要引
  `reqwest`、`git2`、`sysinfo` 这类会拉进整套栈的 native / 运行时依赖。
- 唯一需要用户预装的外部程序是 **git**，只在 `sync.rs` 的三处同步用：直启 `git.exe`（`proc::run_direct`），**不要**经 `cmd /C`；
  子进程一律带 `GIT_TERMINAL_PROMPT=0`；超时与失败收敛成给用户看的提示。别处不新增这类外部依赖。
- 测试用 Vitest（渲染层与 `src/shared`）+ `cargo test`（写在同文件的 `#[cfg(test)] mod tests`）。**TypeScript 与 vue-tsc 的版本不要动**：
  升到 TS 7 会让 `npm run typecheck` 直接不可用。
- 仅 Windows，不做 macOS / Linux 适配。

## 2. 文件落位

- 总览：Rust 在 `src-tauri/src/`；渲染层在 `src/renderer/src/`（组件 `components/`、store `stores/`、交互骨架 `composables/`、适配层
  `workbench/`、设计令牌与全局样式 `styles/`）；两端共用的类型 / 契约 / 纯逻辑在 `src/shared/`。逐文件分工见架构文档的「目录结构」。
- 别名 `@` → `src/renderer/src`、`@shared` → `src/shared`；单测与被测模块同目录，命名 `*.test.ts`。`src/shared/` 里禁止 import
  node、Rust 或渲染层代码。
- 需要文件系统的逻辑把 fs 抽成参数注入（见 [scanner.ts](src/shared/scanner.ts) 的 `ScanFs`）：生产侧走 Rust 命令、测试侧走 `node:fs`。
- 跨组件复用的拖拽与浮层收起一律用 `composables/` 已有的 `use-pointer-drag` / `use-floating-dismiss`，不要再手写 pointer 事件监听。
- 随包带的第三方静态资源放 `src/renderer/public/`；引用用相对基址（`import.meta.env.BASE_URL`），不写死 `/xxx`。
- OAuth 凭据来自 `src-tauri/oauth.local.json`（`build.rs` 注入后 `include_str!`）：**不入库**（模板 `oauth.example.json`），
  缺它照样能编译，只是登录按钮显示「未内置凭据」。
- 文档分工：[README.md](README.md) 给概览与上手；架构文档是功能与架构事实的唯一真源；本文件写跨模块约束；
  [docs/constraints/](docs/constraints/) 写模块细则；`docs/dev-notes/` 写动手方法与踩坑。

## 3. 编码规范

- 全量 TypeScript（`strict: true`）；Vue SFC 一律 `<script setup lang="ts">`，不写 Options API；接口用 `defineProps` / `defineEmits`，props 只读。
- 命名：文件 kebab-case、类型与接口 PascalCase、函数与变量 camelCase；注释与界面文案用中文。纯逻辑下沉 `src/shared/` 并补单测。
- 通道契约、新增通道的步骤、落盘字段的收敛（sanitize / `editableOf` 等）见
  [docs/constraints/ipc-and-state.md](docs/constraints/ipc-and-state.md)。

## 4. UI 与样式

- 手写 CSS，不用原子化 CSS；颜色、间距、圆角、字号一律取 [tokens.css](src/renderer/src/styles/tokens.css) 的
  `--bg-*` `--ink-*` `--st-*` `--sp-*` `--r-*` `--fs-*`。暗色只在 `:root[data-theme='dark']` 覆盖令牌。
- 界面主体灰度，彩色只表达运行状态（`--st-run` / `--st-ok` / `--st-fail`）与项目标识色；终端面板始终深色（`--term-*`）。
- **项目标识色**（[project-color.ts](src/shared/project-color.ts)）：预设色存名字不存色值，自定义色 `#rrggbb` 一律经
  `sanitizeProjectColor()` 收敛；颜色怎么分配只在那一个文件里定义，界面别自己另拍一个。
- 项目标签统一走 [ProjectTag.vue](src/renderer/src/components/ProjectTag.vue)（`el-tag` + `effect="dark"`），**别自绘浅底同色字标签**；
  调用方只负责限宽、给 `.el-tag__content` 加 `overflow: hidden`，行盒高度由它兜着。
- 组件样式写 `<style scoped>`；要穿透 Element Plus 或供多页共用的外壳（`.panel`、`.facts`、`.filter`、`.sort` 等）写进
  [global.css](src/renderer/src/styles/global.css)。
- **Element Plus 是全量引入的**（`main.ts` 的 `app.use(ElementPlus)` + 整包 CSS），不要手搓 EP 已有的控件。已定下来的用法：
  分段选择 `el-segmented`；弹窗字段 `el-form` + `el-form-item`（`label-position="top"`，校验失败就地显示，不弹 `ElMessage`）；
  弹层 `el-dialog` / `el-drawer`（`append-to-body`，**不要自己写遮罩**，`.el-overlay` 统一处理）；图标按钮与关键操作用 `el-tooltip`，
  纯截断文字的全名用原生 `title`。
- 明暗切换经 `theme-transition.ts` 驱动，`<html>` 上同时维护 `data-theme` 与 `.dark`；切换守卫用
  [stores/settings.ts](src/renderer/src/stores/settings.ts) 里的 `appliedTheme` 变量，不读 DOM。
- 拖动窗口用 `data-tauri-drag-region`：裸属性只认直接按在带属性的那个元素上（子元素要再标一遍），`"deep"` 才是整棵子树；
  **不要再写 `@dblclick` 自己 toggle 一次**；`start_dragging` 必须在
  [capabilities/default.json](src-tauri/capabilities/default.json) 放行（被 ACL 拦下是静默失效），改完重启应用。

## 5. 请求 / 状态 / 配置

跨模块的硬约定只有四类（完整规则见下表的对应文档）：**宿主能力一律经 `window.workbench`**（唯一例外是工作区背景图走 asset 协议、
读取权限在 Rust 侧按单个文件授予）、**通道一律返回 `Result<T>` 不 reject**、**业务语义（合并 / 排序 / 修剪 / 状态机 / 命令构造）
留在 TS 适配层**、**数据文件与数据目录固定在 `%APPDATA%\Workbench`**。其余模块没有额外的硬约束。

| 要动的模块 | 先看 |
| --- | --- |
| 通道契约 / store / 持久化 / 数据目录 / 首屏快照 | [constraints/ipc-and-state.md](docs/constraints/ipc-and-state.md) |
| 终端、子进程会话与日志 | [constraints/terminal.md](docs/constraints/terminal.md) |
| 工作日志 | [constraints/work-log.md](docs/constraints/work-log.md) |
| 笔记（正文 / 图片 / 素材 / 笔记同步） | [constraints/notes.md](docs/constraints/notes.md) |
| 用量与外观同步、账号登录 | [constraints/sync-and-auth.md](docs/constraints/sync-and-auth.md) |

## 6. Agent 操作与验证

- 脚本：`npm run typecheck`、`npm test`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run dev`、`npm run build`、
  `npm run build:renderer`、`npm run dev:renderer`、`npm run preview:renderer`（渲染层单独构建到 `.preview/`）、`npm run icons`；
  其余以 `package.json` 为准，不新增 lint / format 工具。
- 改了 Rust 要跑 `cargo test` **与 `cargo build`**：`cargo test` 编译的是开着 `cfg(test)` 的那个 bin，被 `#[cfg(test)]` 关起来的东西
  在那边是可见的，拿它当生产代码用时 test 一片绿、build 才报「not found, an item that was configured out」。
- **改 Rust 前先关掉正在运行的应用**：exe 被占用会链接失败，而构建失败后跑起来的仍是旧二进制，结论会完全跑偏。
  `tauri build` 与 `tauri dev` 也别同时跑（抢同一个 `target/` 构建锁）。
- **停掉 `npm run dev` 之后要确认那一串子进程真的都没了**：Windows 上杀掉外层命令不会带走它的子孙。按端口与进程名各查一遍
  （`netstat -ano | grep LISTENING | grep -E ":(5274|9222)"`、`tasklist | grep -i workbench`），清理用 `taskkill /F /T /PID <pid>`。
- `cargo test` 卡在链接或执行上时，两种绕法见 [browser-preview-verification.md](docs/dev-notes/browser-preview-verification.md)。
- 排查 WebView2 里的运行时问题（未捕获异常、控制台警告、接口实际返回值）：用远程调试端口接 CDP 进页面求值，配方同上那份文档。
- 功能新增或调整后更新 [features-and-architecture.md](docs/features-and-architecture.md)；碰了某个模块的硬约束，就同时更新
  [docs/constraints/](docs/constraints/) 下对应的那一份。
- 不提交构建产物与缓存（`out/`、`dist/`、`.preview/`、`*.tsbuildinfo`、`src-tauri/target/`）；
  **绝不提交 `src-tauri/oauth.local.json`**（client_id / client_secret）。
- **视觉验证只在用户明确要求时做**：要做就把渲染层单独跑在浏览器里截图比对，用 `.preview/` 作工作区，
  **做完删掉整个 `.preview/` 目录**；根目录 `vite.preview.config.ts` 是常驻入口，不要删。
- 默认不执行 git 提交；用户要求时先看 `git status` / `git diff`，沿用中文提交风格。不硬编码用户数据目录与进程记录；
  不输出或提交任何密钥 / token。
