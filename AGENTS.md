# AGENTS.md

本文件是 Workbench 的 AI Coding Agent 约束：只写跨模块的硬约束，一行一条，不写解释、不抄清单。
每个模块一份文档在 [docs/modules/](docs/modules/) 下（开头「约束」一节是不能破的规矩、动手前先读，索引见第 5 节）；
跨模块的通用事实在 [features-and-architecture.md](docs/features-and-architecture.md)（**联网、弹层、目录结构这三块的细则只在
它的「数据与隐私」与「功能」两节，动到再读它**，本文件只留闸门）；动手方法与踩坑见 [docs/dev-notes/](docs/dev-notes/)，
通用知识库的位置见 [AGENT-DOC.md](AGENT-DOC.md)。
第 0 节为跨项目通用约束，第 1 节起为本项目专属，冲突时以后者为准。

## 0. 通用约束

跨项目模板全文在 `.agents/skills/generate-project-constraints/AGENT_COMMON.md`；与本文件后文重复的条目只保留后文那一份。

- 改文件前先读懂现有实现，沿用所在模块的风格、命名与技术模式，不凭文件名或框架习惯猜。
- 只做需求所需的最小修改，不做无关重构；一次改动涉及多个文件时保持接口、命名、数据结构和调用链一致。
- 新增依赖前先查项目已有的依赖、组件、插件与工具，能复用就不引同类库。
- 不主动新建 README、CI、Docker、测试配置、类型声明等非用户要求的文件（更新既有文档不算新建）。
- 一个组件只担一类职责；父组件负责编排与取数，子组件用 props 收输入、经事件或双向绑定回传，不直接改父级状态，
  也不依赖父组件内部状态与宿主页面实现；弹窗、表单、列表与复杂交互按职责拆子组件，接口调用归实际负责该动作的组件或 API 模块，
  不用 DOM 查询、隐式全局变量或事件总线传业务数据。
- 复用顺序：项目既有业务组件 → 项目基础公共组件 → UI 库原生组件 → 新增局部组件；改响应式布局要同时检查模板、局部样式与媒体查询。
- 较大改动后跑项目已有的静态检查或测试命令；没有对应脚本时不自行引入测试框架。
- 禁止 `git reset --hard`、`git clean -f`、强制推送等破坏性操作，除非用户明确要求。
- 文件引用：写进仓库文档的用相对当前文件的相对路径；对话回复用可跳转的绝对路径链接。

## 1. 项目边界

- 定位：Windows 桌面应用（Tauri 2 + WebView2），一个窗口里管项目、记工作、写笔记、看 AI 用量；pnpm workspace monorepo
  （应用在 `apps/desktop/`，纯逻辑按域拆在 `packages/` 的 19 个 `@workbench/*` 包，见第 2 节），`Cargo.lock` 要提交；
  例外：`vendor-pi.mjs` 内部装 Pi 仍走 `npm install`（`resources/pi/` 要整树打进安装包，不能用符号链接布局）。
- **联网边界：默认不联网、不上报任何数据；出口只有十四条，且都由用户显式开启** —— 清单与每条细则见
  [features-and-architecture.md](docs/features-and-architecture.md) 的「数据与隐私」一节，**动联网代码前先读那一节**。
  **不要新增网络出口、不往任何第三方服务发数据**；笔记里的外链图片、密码保险库（推的是用量同步那个仓库的 `vault/vault.json`，
  推上去的只有密文）都**不算**新出口；构建期内嵌 OAuth client_id/secret 与用户指定的禅道个人凭据是明确例外，后者不得随包分发。
- 引新前端依赖先看它会不会在**运行时**去取外面的资源（Vditor 就是这类：资源按 `options.cdn` 取，默认指 unpkg）—— 这类要么把资源
  随包带一份、要么别引。
- webview 有**全局 CSP**（`tauri.conf.json` 的 `csp` / `devCsp`）：引新依赖 / 资源之前先确认它不被拦
  （细则见 [ipc-and-state.md](docs/modules/ipc-and-state.md)）；**改动只能在生产态真应用里验**（dev 与浏览器预览都不生效）。
  `script-src` 上的 `'unsafe-inline'` **只为 HTML 附件那一档**（这份 meta 会被子框架继承，见 [mail.md](docs/modules/mail.md)）——
  **别再往上加任何来源，也别给附件那个 iframe 加 `allow-same-origin`**。
- **Markdown 文件关联只在安装器里登记**（`bundle.fileAssociations`：`.md` / `.markdown`）：开发模式不登记，
  别再加第二套运行时注册表写入（NSIS 把这两个后缀设为默认打开程序、卸载时恢复备份值，是明知的取舍）。
  用「打开方式」打开时只显示一扇独立编辑窗口（`markdown.html`），主窗口留在后台；
  **文件路径只由 Rust 会话持有**，编辑窗口的读写命令不接受渲染层传路径 —— 细则见 [notes.md](docs/modules/notes.md)。
- Rust 依赖的判据是**不新增编译单元**，不是「不新增 crate 名」：先 `cargo tree -e normal -i <crate>` 确认它已经在图里；不要引
  `reqwest`、`git2`、`sysinfo` 这类会拉进整套栈的 native / 运行时依赖。唯一例外是邮箱的 TLS（`schannel`，理由见 `mail.rs`）。
- 唯一需要用户预装的外部程序是 **git**：同步 / 技能版本提交 / 只读探测 / Git 页只读浏览都靠它。
  直启 `git.exe`（`proc::run_direct`），**不要**经 `cmd /C`；子进程一律带 `GIT_TERMINAL_PROMPT=0`、
  `-c core.quotepath=false` 与 `--no-pager`（理由见 [sync-and-auth.md](docs/modules/sync-and-auth.md)）；
  超时与失败收敛成给用户看的提示。**只在用户自己那两个文件夹（笔记本、技能库）所在的仓库、项目目录与 Git 页里用户打开的仓库跑 git**：
  前两处可写（同步提交），**项目仓库与 Git 页的仓库一律只读**（项目仓库只跑 `git log` / `git config user.email`；
  Git 页只读命令清单与三条防注入参数见 [git-client.md](docs/modules/git-client.md)；「切换分支」只把 `log` / `ls-tree` 的
  ref 换成 `refs/heads/<name>`，**不 checkout / switch**），不 add / commit / push / fetch，且从不写它们的远端配置
  （不 `init`、不 `remote add` / `set-url`；只在仓库没配过身份时写一次本地 `user.email` / `user.name` 兜底）。
  别处不新增这类外部依赖。
- **外部依赖与内置组件的边界**：唯一预装的是 git（调用规矩见上一条），VS Code 与微信是仅有的两个
  **可选**外部程序、各只服务一个功能；Pi 是唯一内置的编码 Agent、只服务 AI 助手页 ——
  **别照着再引第二个编辑器 / Agent**。Qoder 网关与 TBuddy 是两套独立实现、**可以同时跑**、
  谁也不碰谁的配置。各自细则在 [projects.md](docs/modules/projects.md)、
  [screenshot.md](docs/modules/screenshot.md)、[ai.md](docs/modules/ai.md)、
  [qoder.md](docs/modules/qoder.md) 与 [gateway.md](docs/modules/gateway.md)，动手前先读。
- 测试用 Vitest（各包子目录里的 `vitest.config.ts` 是配置来源；根目录 `pnpm test` 走根 `vitest.config.ts` 的
  `test.projects`，把 20 个项目收进**一个** vitest 进程跑全量 —— 别退回 `pnpm -r test`；渲染层用例在
  `@workbench/desktop` 包里）+ `cargo test`（写在同文件的 `#[cfg(test)] mod tests`）。
  **TypeScript 锁 6.0.x、vue-tsc 3.3.x**：vue-tsc 还跑不了 TS 7，别升 7。
- 仅 Windows，不做 macOS / Linux 适配。

## 2. 文件落位

- 总览：monorepo。桌面应用自包含在 `apps/desktop/` —— Rust 在 `src-tauri/src/`、渲染层在 `src/renderer/src/`（组件 `components/`、
  store `stores/`、交互骨架 `composables/`、适配层 `workbench/`、设计令牌与全局样式 `styles/`）、随包资源 `resources/`、构建脚本 `scripts/`；
  跨页面复用的类型 / 契约 / 纯逻辑按域拆在 `packages/` 的 19 个 `@workbench/*` 包里（`core` 是平台原语，其余按业务域；
  逐包逐文件分工见 [features-and-architecture.md](docs/features-and-architecture.md) 的「目录结构」）。
- **渲染层有六个 HTML 入口**（`src/renderer/` 下 `vite.config.ts` 的 `rollupOptions.input`；
  清单见 [features-and-architecture.md](docs/features-and-architecture.md) 的「目录结构」）：
  除主界面 `index.html` 外，**后五个是独立窗口、各自的 JS 上下文，只装适配层，不装 store、不 initState**
  —— 装了会与主窗口抢着读 / 写同一批数据文件（各窗口细则见 [screenshot.md](docs/modules/screenshot.md)、
  [float-ball.md](docs/modules/float-ball.md)、[video.md](docs/modules/video.md)、[notes.md](docs/modules/notes.md)）。
- **禅道不在应用里打开**：顶栏右侧那颗图标（通知点击也走它）把配置里的部署根交给系统默认浏览器；
  应用里不做禅道页签、不嵌 iframe，也不再建独立窗口。浏览器里没有应用的登录态：
  **不做自动登录、不把账号密码拼进地址**，网页登录由用户自己登一次；应用发出的请求仍只读，
  细则见 [zentao.md](docs/modules/zentao.md)。
- 域包之间与应用对域包一律**按包名导入**（`@workbench/<包>`，只走各包 `index.ts` 桶）；解析走 pnpm 的 workspace 软链 + 各包
  `exports`（TS 源码直出），TS 检查由根目录唯一的 `tsconfig.json` / `tsconfig.test.json` 的 paths 兜底。渲染层内部别名
  `@` → `apps/desktop/src/renderer/src`（`@shared` 已随拆包删除）。单测与被测模块同目录，命名 `*.test.ts`。
  域包里禁止 import 渲染层代码与 Rust 侧，node 内置模块不进运行时路径（fs 之类一律注入）。
- 需要文件系统的逻辑把 fs 抽成参数注入（见 [scanner.ts](packages/core/src/scanner.ts) 的 `ScanFs`）：生产侧走 Rust 命令、测试侧走 `node:fs`。
- 跨组件复用的拖拽与浮层收起一律用 `composables/` 已有的 `use-pointer-drag` / `use-floating-dismiss`，不要再手写 pointer 事件监听。
- 随包带的第三方静态资源放 `apps/desktop/src/renderer/public/`；引用用相对基址（`import.meta.env.BASE_URL`），不写死 `/xxx`。
- OAuth 与禅道凭据来自 `apps/desktop/src-tauri/oauth.local.json`（`build.rs` 注入后 `include_str!`，修改后重构建）：**不入库**（模板 `oauth.example.json`），
  缺它照样能编译，OAuth 登录显示「未内置凭据」，禅道显示配置错误；禅道密码仅由 Rust 读取。

## 3. 编码规范

- 全量 TypeScript（`strict: true`）；Vue SFC 一律 `<script setup lang="ts">`，不写 Options API；接口用 `defineProps` / `defineEmits`，props 只读。
- 命名：文件 kebab-case、类型与接口 PascalCase、函数与变量 camelCase；注释与界面文案用中文。纯逻辑下沉到对应域包
  `packages/<域>/src/`（包清单见第 2 节）并补单测。
- 通道契约、新增通道的步骤、落盘字段的收敛（sanitize / `editableOf` 等）见
  [docs/modules/ipc-and-state.md](docs/modules/ipc-and-state.md) 的「约束」一节。

## 4. UI 与样式

**红线（跨模块，动到就要看）**：手写 CSS、不用原子化 CSS，颜色 / 间距 / 圆角 / 字号 / 缓动一律取
[tokens.css](apps/desktop/src/renderer/src/styles/tokens.css) 的令牌；界面主体灰度，彩色只表达运行状态与
项目标识色，主题色只管交互态与那两张图，终端始终深色；组件样式写 `<style scoped>`，跨页共用的外壳
（`.panel` / `.facts` / `.filter` / `.sort` 等）写进 [global.css](apps/desktop/src/renderer/src/styles/global.css)。
界面不写教学式说明（原理与自我声明归文档，只留影响当下操作的文案）。
Element Plus **按需引入**：不要写回 `app.use(ElementPlus)` / 引整包 css，插件管不到的
`ElMessage` / `ElMessageBox` / `v-loading` 样式集中在
[element-plus-styles.ts](apps/desktop/src/renderer/src/element-plus-styles.ts)，新增这类用法要往那儿补一行；
不要手搓 EP 已有控件。空态要配图，不许只留一行干字。弹层一律走
[AppDialog.vue](apps/desktop/src/renderer/src/components/AppDialog.vue)、不要直接写 `el-dialog`，
不要自己写遮罩；弹层开着时导航栏仍可用、**换页不关弹层**；填内容的弹层传 `penetrable`，
确认框与退出确认框保持挡住。提示条（`ElMessage`）位置与外观只在 global.css 一处定，
调用处不传 `placement` / `offset`。明暗切换经 `theme-transition.ts` 驱动（`<html>` 同时维护
`data-theme` 与 `.dark`），守卫用 `appliedTheme` 变量不读 DOM。拖动窗口用 `data-tauri-drag-region`
（裸属性只认直接按中的元素，`"deep"` 才是整棵子树），不要再写 `@dblclick` 自己 toggle，
`start_dragging` 必须在 [capabilities/default.json](apps/desktop/src-tauri/capabilities/default.json) 放行。

**其余口径与实现**（两处彩色例外、项目标识色与 ProjectTag、EP 已定用法、EmptyState 分档、
AppDialog 的 `penetrable` 清单、主题色浓度等）见
[features-and-architecture.md](docs/features-and-architecture.md) 的「UI 与样式通用口径」与各模块文档，
动手前先读那两处。

## 5. 请求 / 状态 / 配置

跨模块的硬约定只有四类（完整规则见下表对应模块文档的「约束」一节，实现细节在同文件「实现」一节）：
**宿主能力一律经 `window.workbench`**（唯一例外是工作区背景图、视频播放与 AI 预览栏的图片走
asset 协议、读取权限在 Rust 侧按单个文件授予）、**通道一律返回 `Result<T>` 不 reject**、
**业务语义（合并 / 排序 / 修剪 / 状态机 / 命令构造）
留在 TS 适配层**、**数据文件与数据目录固定在 `%APPDATA%\Workbench\data`（开发版另用
`%APPDATA%\Workbench-dev\data`，两边不共用）**。其余模块没有额外的硬约束。

| 要动的模块 | 先看 |
| --- | --- |
| 通道契约 / store / 持久化 / 数据目录 / 首屏快照 | [ipc-and-state](docs/modules/ipc-and-state.md) |
| 终端、子进程会话与日志 | [terminal](docs/modules/terminal.md) |
| 工作日志 | [work-log](docs/modules/work-log.md) |
| 笔记（正文 / 图片 / 素材 / 笔记同步） | [notes](docs/modules/notes.md) |
| 知识库（raw + data 两层仓库 / 清单列表 / 添加即首洗 / 清洗前置上传 / 删除 / 迁移 / 同步与自动拉取） | [kb](docs/modules/kb.md) |
| AI 助手（会话 / 项目 / 驱动本机 Pi / 模型与密钥 / 提示词与出口） | [ai](docs/modules/ai.md) |
| TBuddy（网关：CodeBuddy 反代；账号 / 流式对话 / 用量） | [gateway](docs/modules/gateway.md) |
| Qoder（网关：Qoder 国内版反代；独立端口 / 密钥，可同时跑） | [qoder](docs/modules/qoder.md) |
| 用量与外观同步、账号登录 | [sync-and-auth](docs/modules/sync-and-auth.md) |
| 密码保险库（密钥 / 加解密 / 多机共写一份文件） | [vault](docs/modules/vault.md) |
| 邮箱（IMAP 收信 / SMTP 发信 / 授权码 / 联网出口） | [mail](docs/modules/mail.md) |
| 禅道（API 登录 / 后台检查与通知 / 浏览器打开站点） | [zentao](docs/modules/zentao.md) |
| 截图与钉图（抓屏 / 标注 / 剪贴板 / 置顶图窗口） | [screenshot](docs/modules/screenshot.md) |
| 网速球（自由摆放 / 贴边收起 / 网卡计数取样） | [float-ball](docs/modules/float-ball.md) |
| ETF 资金流（份额 / 净值 / 净申赎 / 五年回填） | [etf](docs/modules/etf.md) |
| Git 页（只读浏览本地仓库 / 提交历史 / 文件历史 / 两个提交的差异） | [git-client](docs/modules/git-client.md) |

没有列入表里的模块（首页、项目、技能、样式、视频、快捷启动）也在 [docs/modules/](docs/modules/) 下各有一份文档，
动手前先看它的「约束」一节。

## 6. Agent 操作与验证

- 脚本：`pnpm run typecheck`、`pnpm test`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`、`pnpm run dev`、`pnpm run build`、
  `pnpm run build:renderer`、`pnpm run dev:renderer`、`pnpm run preview:renderer`（渲染层单独构建到 `.preview/`）、`pnpm run icons`、
  `pnpm run contract:gen` / `pnpm run contract:check`（Rust `// @contract` → TS 契约）；
  其余以 `package.json` 为准（根与 `apps/desktop` 各一份）。
- **改了带 `// @contract` 的 Rust 结构要跑 `pnpm run contract:gen`**：生成
  `apps/desktop/src/renderer/src/types/contract.generated.ts`；`pnpm run verify` 与 CI 里的 `contract:check`
  会拦住没同步的生成文件。
- **前端代码格式化走 ESLint**：`pnpm run lint:fix`（检查用 `pnpm run lint`），配置在根目录 `eslint.config.mjs`
  （`@antfu/eslint-config`，范围是渲染层 + 域包，`src-tauri/`、`resources/`、`apps/desktop/scripts/` 不在圈里）；
  **每次改完前端代码都要跑一遍**，只允许这一套，不要再引 Prettier 之类的第二套格式化工具。
  两条都带 `--cache`；`.eslintcache` 是本地产物（已 ignore、不提交）。耗时口径见
  [build-performance.md](docs/dev-notes/build-performance.md)。
- 改了 Rust 要跑 `cargo test` **与 `cargo build`**：`cargo test` 编译的是开着 `cfg(test)` 的那个 bin，被它关起来的东西当生产代码用时
  会 test 一片绿、build 才报错。**生产代码里不许裸 `unwrap()`**（`clippy::unwrap_used` 已在 `src/main.rs` 顶部设成 deny，测试豁免见
  `src-tauri/clippy.toml`）；要显式终止就用 `expect("原因")` —— 它带得走一句话，也会落进 `data/panic.log`。
- **push / PR 会过 `.github/workflows/ci.yml`**（`pnpm run lint` + `typecheck` + `pnpm test` + `cargo clippy -- -D warnings` + `cargo test`）：
  它是兜底、不是替代，上面那几条本地该跑的照跑。
- 动过 `.vue` 的模板（加 / 删 / 挪标签）要顺手跑一次 `pnpm run build:renderer`：`typecheck` 查不出模板标签不配平，
  只有真的编译一遍模板才发现得了。`pnpm run verify` 已经**无条件**带上这一步，不必再自己判断「这轮动没动过模板」。
  **模板里用到的组件必须在脚本里 import**（`el-*` 那几个是全局注册的除外）：
  少了它上面两条都不报错，那个标签被渲染成空，`pnpm run lint` 的 `vue/no-undef-components` 才拦得住。
- **永远不要替用户起应用**（`pnpm run dev` / `tauri dev` / `tauri build` 一律不跑）：验证只到静态检查、单测与构建为止；
  改完说一句「dev 已停、代码已就绪」，起不起、什么时候起由用户自己决定。
- **别在 cargo 与 dev 之间来回**：`tauri dev` 是 `--no-default-features`，`cargo test` / `cargo build` / `clippy` 是默认 feature 集，
  两套 feature 会把彼此的产物作废，每来回一次就是整棵重编（分钟级）。所以一次改完、cargo 只跑一轮。
- **一次改完再一次跑齐验证，别拆成多轮**：前端一条 `pnpm run verify`（`scripts/verify.mjs`，
  内部编排见 [build-performance.md](docs/dev-notes/build-performance.md)），Rust 一条命令串起来
  （`cargo test … && cargo build … && cargo clippy … -- -D warnings`）。
  改到一半只跑受影响的那个包（`pnpm -F @workbench/<包> test`），全量留到收尾那一次。
- **`pnpm test` 与 `cargo` 不要同时跑**：两边抢 CPU 会让既有那几条基于真实 git 的重测试撞 5 秒超时（假失败）。
  这类超时先单独复跑该包确认，别当成真失败去改代码。
- **cargo 之前只确认「本仓库的构建产物」没在跑，不是「没有 workbench.exe」**：开发环境与真实环境进程名
  都叫 `workbench.exe`，**先查路径，只有落在 `apps/desktop/src-tauri/target/` 下的才是锁住本次构建的那一个**；
  别的路径（真实安装版）一律不要动，也不要在用户可能正用着应用时静默杀掉它 —— 先说一句。
  **不许按进程名直接 `taskkill`**。查路径与停进程树的命令见
  [browser-preview-verification.md](docs/dev-notes/browser-preview-verification.md)；
  停要连子孙一起收（`taskkill /F /T /PID <pid>`），停完按进程名与端口各复查一遍。
- `cargo test` 卡在链接或执行上时、以及排查 WebView2 里的运行时问题（未捕获异常、控制台警告、接口实际返回值）时，
  配方见 [browser-preview-verification.md](docs/dev-notes/browser-preview-verification.md)。
- **真机接口排查（邮箱这类要登录的）有失败计数与限流**：**一次登录、复用同一会话**把要查的都查完，
  绝不反复试探登录；会话换新会让旧 token 立刻失效，
  所以别在同一轮里既用 cookie 登又用 token 读。
- **本项目是纯 vibe coding：所有改动都必须落实到文档**（只改代码不算完成）—— 动哪个模块就同步写它的
  `docs/modules/<模块>.md`（约束变了就改「约束」一节）；跨模块的通用事实更新
  [features-and-architecture.md](docs/features-and-architecture.md)。
- **文档只写事实与判据**（接口、字段、口径、为什么这么定）：不写寒暄与自评，不复述代码，不写教程式铺垫。
- **了解业务以文档为主、代码为辅**：先读文档拿结论、再用代码抽验关键点，文档没写或疑似过期才反过来以代码为准。
- **别用 `git checkout --` / `git restore` / `git stash` 去清自己插进去的探针或临时改动**：它们按**文件**回退，
  会把用户在同一文件里**未提交的改动一起冲掉**。要清探针就用反向补丁精确删那几行；更好的做法是**别往仓库文件里写探针**
  —— 量耗时夹在命令外面（`date +%s%3N`）就够。
- 不提交构建产物与缓存（`out/`、`dist/`、`.preview/`、`*.tsbuildinfo`、`.eslintcache`、`apps/desktop/src-tauri/target/`）；
  **绝不提交 `apps/desktop/src-tauri/oauth.local.json`**（client_id / client_secret）。
- **视觉验证只在用户明确要求时做**：要做就把渲染层单独跑在浏览器里截图比对，用 `.preview/` 作工作区，
  **做完删掉整个 `.preview/` 目录**；`apps/desktop/vite.preview.config.ts` 是常驻入口，不要删。
- 默认不执行 git 提交；用户要求时先看 `git status` / `git diff`，沿用中文提交风格。不硬编码用户数据目录与进程记录；
  不输出或提交任何密钥 / token。
