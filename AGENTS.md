# AGENTS.md

本文件是 Workbench 的 AI Coding Agent 约束：只写跨模块的硬约束，一行一条，不写解释。每个模块一份文档，
在 [docs/modules/](docs/modules/) 下（开头「约束」一节是不能破的规矩、动手前先读，后面是实现细节，索引见第 5 节）；
跨模块的通用事实在 [features-and-architecture.md](docs/features-and-architecture.md)，**联网、弹层、目录结构这三块的细则只在
它的「数据与隐私」与「功能」两节，动到再读它**（本文件只留闸门）；动手方法与踩坑见 [docs/dev-notes/](docs/dev-notes/)，
通用知识库的位置见 [AGENT-DOC.md](AGENT-DOC.md)。
第 0 节为跨项目通用约束，第 1 节起为本项目专属，冲突时以后者为准。

## 0. 通用约束

跨项目模板（全文在 `.agents/skills/generate-project-constraints/AGENT_COMMON.md`）；与本文件后文重复的条目只保留后文那一份。

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
  （应用在 `apps/desktop/`，纯逻辑按域拆在 `packages/` 的 17 个 `@workbench/*` 包，见第 2 节），`Cargo.lock` 要提交；
  例外：`vendor-pi.mjs` 内部装 Pi 仍走 `npm install`（`resources/pi/` 要整树打进安装包，不能用符号链接布局）。
- **联网边界：默认不联网、不上报任何数据；出口只有十二条，且都由用户显式开启** —— 清单与每条细则见
  [features-and-architecture.md](docs/features-and-architecture.md) 的「数据与隐私」一节，**动联网代码前先读那一节**。
  **不要新增网络出口、不往任何第三方服务发数据**；笔记里的外链图片、密码保险库（推的是用量同步那个仓库的 `vault/vault.json`，
  推上去的只有密文）都**不算**新出口；构建期内嵌 OAuth client_id/secret 与用户指定的禅道个人凭据是明确例外，后者不得随包分发。
- 引新前端依赖先看它会不会在**运行时**去取外面的资源（Vditor 就是这类：资源按 `options.cdn` 取，默认指 unpkg）—— 这类要么把资源
  随包带一份、要么别引。
- webview 有**全局 CSP**（`tauri.conf.json` 的 `csp` / `devCsp`，细则见 [ipc-and-state](docs/modules/ipc-and-state.md)）：引新依赖 / 资源
  之前先确认它不被拦（`connect-src` / `worker-src` / `img-src` 这几项最容易踩）；**改动只能在生产态真应用里验**（dev 与浏览器预览都不生效）。
  `script-src` 上的 `'unsafe-inline'` **只为 HTML 附件那一档**（这份 meta 会被子框架继承，见 [mail.md](docs/modules/mail.md)）——
  **别再往上加任何来源，也别给附件那个 iframe 加 `allow-same-origin`**。
- Rust 依赖的判据是**不新增编译单元**，不是「不新增 crate 名」：先 `cargo tree -e normal -i <crate>` 确认它已经在图里；不要引
  `reqwest`、`git2`、`sysinfo` 这类会拉进整套栈的 native / 运行时依赖。唯一例外是邮箱的 TLS（`schannel`，理由见 `mail.rs`）。
- 唯一需要用户预装的外部程序是 **git**：`sync.rs` 的几处同步与 `skills.rs` 的版本提交 / 同步，外加两条只读探测
  （笔记 / 知识库 / AI 助手工作目录的 `repo_state`、技能库的 `skills::state`）。直启 `git.exe`（`proc::run_direct`），**不要**经 `cmd /C`；
  子进程一律带 `GIT_TERMINAL_PROMPT=0` 与 `-c core.quotepath=false`（前者：没有终端可问，挂着只会等超时；后者：中文文件名在冲突提示里会变乱码）；
  超时与失败收敛成给用户看的提示。**只在用户自己那两个文件夹（笔记本、技能库）所在的仓库里跑 git，且从不写它们的远端配置**
  （不 `init`、不 `remote add` / `set-url`；只在仓库没配过身份时写一次本地 `user.email` / `user.name` 兜底）。别处不新增这类外部依赖。
- VS Code 是唯一**可选**的外部程序，只服务项目卡的「在 VS Code 中打开」：走它自己注册的 `vscode://` 协议（`system.rs` 的
  `open_in_vscode`），不去找 `Code.exe` 的安装路径；没装只影响那一个菜单项，不要照着再引别的编辑器。
- **Pi**（开源编码 Agent）只服务 AI 助手页（一个通用控制台：左栏按项目列会话、右栏跟一段对话，它去干活）：**随包内置** —— `apps/desktop/scripts/vendor-pi.mjs` 在构建 / 开发前
  生成瘦身的 `apps/desktop/resources/pi/`（钉死版本、删掉运行时用不到的云厂商 SDK，细则见 [ai.md](docs/modules/ai.md)），
  Node 用系统里的（≥ 22.19，门槛判定在 `packages/ai/src/ai.ts`）。它跑 **RPC 模式**（提示词与「命令让不让跑」的答复都走子进程的 stdin，
  两档工具权限见 docs/modules/ai.md），**一个会话一个进程**（一轮跑完不收：连续对话靠它），会话留档由 Pi 自己写在
  `data\pi\sessions\`（起进程时传 `--session-id` 与 `--session-dir`，**不要传 `--no-session`**）。跑它时子进程必须带 `PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1` 与 `PI_OFFLINE=1`
  （它默认会报遥测、向 pi.dev 查最新版本、RPC 启动时还刷一遍模型目录 —— 那三条不在任何已登记的出口里），密钥只经环境变量给，
  **进程直启不经 `cmd /C`**（行内层引号会被 cmd 拆坏，见 session.rs 的 `spawn_args`）。别照着再引别的 Agent。
- 测试用 Vitest（各包子目录里的 `vitest.config.ts` 是配置来源；根目录 `pnpm test` 走根 `vitest.config.ts` 的
  `test.projects`，把 18 个项目收进**一个** vitest 进程跑全量 —— 别退回 `pnpm -r test`，那是 18 次进程启动；
  渲染层用例在 `@workbench/desktop` 包里）
  + `cargo test`（写在同文件的 `#[cfg(test)] mod tests`）。**TypeScript 与 vue-tsc 的版本不要动**：升到 TS 7 会让 `pnpm run typecheck` 直接不可用。
- 仅 Windows，不做 macOS / Linux 适配。

## 2. 文件落位

- 总览：monorepo。桌面应用自包含在 `apps/desktop/` —— Rust 在 `src-tauri/src/`、渲染层在 `src/renderer/src/`（组件 `components/`、
  store `stores/`、交互骨架 `composables/`、适配层 `workbench/`、设计令牌与全局样式 `styles/`）、随包资源 `resources/`、构建脚本 `scripts/`；
  跨页面复用的类型 / 契约 / 纯逻辑按域拆在 `packages/` 的 17 个 `@workbench/*` 包里（`core` 是平台原语，其余按业务域；
  逐包逐文件分工见 [features-and-architecture.md](docs/features-and-architecture.md) 的「目录结构」）。
- 渲染层有**四个 HTML 入口**（`src/renderer/` 下，`vite.config.ts` 的 `rollupOptions.input`）：`index.html`（主界面）、
  `capture.html`（截图遮罩）、`pin.html`（钉图）、`ball.html`（网速球）。后三个是独立窗口、各自的 JS 上下文，
  **只装适配层，不装 store、不 initState**
  —— 装了会与主窗口抢着读 / 写同一批数据文件（见 [screenshot.md](docs/modules/screenshot.md)、[float-ball.md](docs/modules/float-ball.md)）。
- **禅道是一扇独立窗口**（顶栏那一排右侧、收起 / 展开菜单那颗右边的图标打开，通知点击也开它），里面直接加载禅道站点、用系统标题栏：
  它是唯一的**远程来源窗口**，**不登记任何 capability**（远程来源不给 IPC，见 [zentao.md](docs/modules/zentao.md)）。
  别把它做进页面里当 iframe（服务端 `X-Frame-Options: SAMEORIGIN` 会拒绝渲染），也别自绘窗口按钮
  （自绘的按钮盖不住远程页面 —— 原生画面与 HTML 是两层）。
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

- 手写 CSS，不用原子化 CSS；颜色、间距、圆角、字号与动效缓动一律取 [tokens.css](apps/desktop/src/renderer/src/styles/tokens.css) 的
  `--bg-*` `--ink-*` `--st-*` `--sp-*` `--r-*` `--fs-*` `--ease-*`。暗色只在 `:root[data-theme='dark']` 覆盖令牌。
- 界面主体灰度，彩色只表达运行状态（`--st-run` / `--st-ok` / `--st-fail`）与项目标识色；用户配的主题色只管
  交互态、首页活跃度图的色阶与网关用量页那张柱状图（口径在 [accent-color.ts](packages/appearance/src/accent-color.ts) 的文件头，别扩到别处）；
  终端面板始终深色（`--term-*`）。**例外只有一处**：邮箱附件片左首那枚类型图标按文件类型着色（PDF 红 / Word 蓝 / 幻灯片橙 / Markdown 紫 / 网页青），
  色阶口径只在 [parse.ts](packages/mail/src/parse.ts) 的 `attachmentTint`（见 [mail.md](docs/modules/mail.md)），
  名字、大小与其余一切照旧灰度，不许扩到别处、也不许拿它给整片附件上色。
- **项目标识色**（[project-color.ts](packages/core/src/project-color.ts)）：预设色存名字不存色值，自定义色 `#rrggbb` 一律经
  `sanitizeProjectColor()` 收敛；颜色怎么分配只在那一个文件里定义，界面别自己另拍一个。
- 项目标签统一走 [ProjectTag.vue](apps/desktop/src/renderer/src/components/ProjectTag.vue)（`el-tag` + `effect="dark"`），**别自绘浅底同色字标签**；
  调用方只负责限宽、给 `.el-tag__content` 加 `overflow: hidden`，行盒高度由它兜着。
- 组件样式写 `<style scoped>`；要穿透 Element Plus 或供多页共用的外壳（`.panel`、`.facts`、`.filter`、`.sort` 等）写进
  [global.css](apps/desktop/src/renderer/src/styles/global.css)。
- **Element Plus 是按需引入的**（vite 的 `Components` 插件在编译期把模板里的 `<el-*>` 换成单组件 import +
  该组件的 css，配置只在 `vite.config.ts` 与 `vite.preview.config.ts`）：**不要**再写回
  `app.use(ElementPlus)` 或引整包 `dist/index.css`。插件管不到的三样（`ElMessage` / `ElMessageBox` /
  `v-loading` 的样式）集中在 [element-plus-styles.ts](apps/desktop/src/renderer/src/element-plus-styles.ts)，
  指令本身由 `main.ts` 的 `app.use(ElLoading)` 注册 —— **新增这类「命令式 API / 指令」用法时要往那儿补一行**，
  否则样式静默缺失。不要手搓 EP 已有的控件。已定下来的用法：
  分段选择 `el-segmented`（外壳与选中态的口径只在 global.css 的 `.el-segmented` 一处；**选中项取主色实心** `--el-color-primary` + `--el-color-white`，别改回白底药丸）；弹窗字段 `el-form` + `el-form-item`（`label-position="top"`，校验失败就地显示，不弹 `ElMessage`）；
  图标按钮与关键操作用 `el-tooltip`，纯截断文字的全名用原生 `title`。
- **空态要配图**：一栏 / 一整页 / 弹层正文区空着时用 [EmptyState.vue](apps/desktop/src/renderer/src/components/EmptyState.vue)
  （小图 + 一句事实；窄地方 `compact`），**不许只留一行干字**；几十像素的小格子（首页卡片、日志框、
  编辑态空栏、下拉空项）仍走 global.css 的 `.empty` + `.empty__icon`。
- **界面不写教学式说明**（作者自己用的程序）：原理、机制与自我声明（「应用不内置任何…」「只在下次起进程时生效」这类）写在文档里（docs/modules/ 各模块文档），界面上只留影响当下操作的文案；「点这里开始」「第一次用？」这类引导一律不加（AI 助手页细则见 docs/modules/ai.md）。
- **弹层一律走 [AppDialog.vue](apps/desktop/src/renderer/src/components/AppDialog.vue)，不要直接写 `el-dialog`**：`append-to-body`、
  「挡不挡背后」、可拖动（抓手是标题栏、关掉后位置复位）这几条跨弹层的规矩只写在那里（**不要自己写遮罩**，
  `.el-overlay` 统一处理）；其余属性与插槽原样透传。
- 弹层开着时导航栏仍然可用（导航栏浮在遮罩之上，见 [NavRail.vue](apps/desktop/src/renderer/src/components/NavRail.vue)）；
  **换页不关弹层** —— 弹框留在原地，切回来还是它，别在换页路径上加「收弹层」的动作。
- **填内容的弹层传 `penetrable`（不挡背后）**：「要回别处抄一段再填」的那几个都这么开，遮罩只围住弹框自己
  （清单见 [features-and-architecture.md](docs/features-and-architecture.md) 的「填内容的弹层不挡背后」一条），代价是没有「点外面关掉」（它们本来就关着）。
  **确认框（`ElMessageBox`）与退出确认框保持挡住**，设置 / 技能这类不抄内容的弹层也照旧挡点击。
- **提示条（`ElMessage`）的位置与外观只在 global.css 的 `.el-message` 一处定**（顶栏下沿居中、不透明面底色卡片 +
  一条状态色竖条）：调用处不要传 `placement` / `offset` —— 会跟那条让开顶栏的上边距打架。新增一处 `ElMessage` 不用管这些。
- 明暗切换经 `theme-transition.ts` 驱动，`<html>` 上同时维护 `data-theme` 与 `.dark`；切换守卫用
  [stores/settings.ts](apps/desktop/src/renderer/src/stores/settings.ts) 里的 `appliedTheme` 变量，不读 DOM。
- 拖动窗口用 `data-tauri-drag-region`：裸属性只认直接按在带属性的那个元素上（子元素要再标一遍），`"deep"` 才是整棵子树；
  **不要再写 `@dblclick` 自己 toggle 一次**；`start_dragging` 必须在
  [capabilities/default.json](apps/desktop/src-tauri/capabilities/default.json) 放行（被 ACL 拦下是静默失效），改完重启应用。

## 5. 请求 / 状态 / 配置

跨模块的硬约定只有四类（完整规则见下表对应模块文档的「约束」一节，实现细节在同文件「实现」一节）：
**宿主能力一律经 `window.workbench`**（唯一例外是工作区背景图、视频播放与 AI 预览栏的图片走
asset 协议、读取权限在 Rust 侧按单个文件授予）、**通道一律返回 `Result<T>` 不 reject**、
**业务语义（合并 / 排序 / 修剪 / 状态机 / 命令构造）
留在 TS 适配层**、**数据文件与数据目录固定在 `%APPDATA%\Workbench\data`**。其余模块没有额外的硬约束。

| 要动的模块 | 先看 |
| --- | --- |
| 通道契约 / store / 持久化 / 数据目录 / 首屏快照 | [ipc-and-state](docs/modules/ipc-and-state.md) |
| 终端、子进程会话与日志 | [terminal](docs/modules/terminal.md) |
| 工作日志 | [work-log](docs/modules/work-log.md) |
| 笔记（正文 / 图片 / 素材 / 笔记同步） | [notes](docs/modules/notes.md) |
| 知识库（原始数据 / 条目 / 一键清洗 / 索引重建 / 同步） | [kb](docs/modules/kb.md) |
| AI 助手（会话 / 项目 / 驱动本机 Pi / 模型与密钥 / 提示词与出口） | [ai](docs/modules/ai.md) |
| TBuddy（网关：WorkBuddy / CodeBuddy 反代；账号 / 流式对话 / 用量） | [gateway](docs/modules/gateway.md) |
| 用量与外观同步、账号登录 | [sync-and-auth](docs/modules/sync-and-auth.md) |
| 密码保险库（密钥 / 加解密 / 多机共写一份文件） | [vault](docs/modules/vault.md) |
| 邮箱（IMAP 收信 / SMTP 发信 / 授权码 / 联网出口） | [mail](docs/modules/mail.md) |
| 禅道（API 登录 / 内存会话 / 独立窗口与免登录 / 后台检查与通知） | [zentao](docs/modules/zentao.md) |
| 截图与钉图（抓屏 / 标注 / 剪贴板 / 置顶图窗口） | [screenshot](docs/modules/screenshot.md) |
| 网速球（自由摆放 / 贴边收起 / 网卡计数取样） | [float-ball](docs/modules/float-ball.md) |

没有列入表里的模块（首页、项目、技能、样式、视频、快捷启动）也在 [docs/modules/](docs/modules/) 下各有一份文档，
动手前先看它的「约束」一节。

## 6. Agent 操作与验证

- 脚本：`pnpm run typecheck`、`pnpm test`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`、`pnpm run dev`、`pnpm run build`、
  `pnpm run build:renderer`、`pnpm run dev:renderer`、`pnpm run preview:renderer`（渲染层单独构建到 `.preview/`）、`pnpm run icons`；
  其余以 `package.json` 为准（根与 `apps/desktop` 各一份）。
- **前端代码格式化走 ESLint**：`pnpm run lint:fix`（检查用 `pnpm run lint`），配置在根目录 `eslint.config.mjs`
  （`@antfu/eslint-config`，范围是渲染层 + 域包，`src-tauri/`、`resources/`、`apps/desktop/scripts/` 不在圈里）；
  **每次改完前端代码都要跑一遍**，只允许这一套，不要再引 Prettier 之类的第二套格式化工具。
  两条都带 `--cache`：热缓存下全仓库一遍约 5s（不带是 20s，冷启动多付 1s 左右）。
  `.eslintcache` 是**本地产物**（已 ignore、不提交），CI 上每次都是空的 —— 那 1s 不值得为它加特例。
- 改了 Rust 要跑 `cargo test` **与 `cargo build`**：`cargo test` 编译的是开着 `cfg(test)` 的那个 bin，被它关起来的东西当生产代码用时
  会 test 一片绿、build 才报错。**生产代码里不许裸 `unwrap()`**（`clippy::unwrap_used` 已在 `src/main.rs` 顶部设成 deny，测试豁免见
  `src-tauri/clippy.toml`）；要显式终止就用 `expect("原因")` —— 它带得走一句话，也会落进 `data/panic.log`。
- **push / PR 会过 `.github/workflows/ci.yml`**（`pnpm run lint` + `typecheck` + `pnpm test` + `cargo clippy -- -D warnings` + `cargo test`）：
  它是兜底、不是替代，上面那几条本地该跑的照跑。
- 动过 `.vue` 的模板（加 / 删 / 挪标签）要顺手跑一次 `pnpm run build:renderer`：`typecheck` 查不出模板标签不配平（vue-tsc 全绿而
  vite 报 `Invalid end tag`、页面白屏），只有真的编译一遍模板才发现得了。`pnpm run verify` 已经**无条件**带上这一步了
  （3s 出头，塞在并行组里等于免费），不必再自己判断「这轮动没动过模板」。
  **模板里用到的组件必须在脚本里 import**（`el-*` 那几个是全局注册的除外）：
  少了它上面两条都不报错，那个标签被渲染成空 —— 现象是「按钮在、点下去什么都没发生」，`pnpm run lint` 的 `vue/no-undef-components` 才拦得住。
- **永远不要替用户起应用**（`pnpm run dev` / `tauri dev` / `tauri build` 一律不跑）：验证只到静态检查、单测与构建为止；
  改完说一句「dev 已停、代码已就绪」，起不起、什么时候起由用户自己决定。
- **别在 cargo 与 dev 之间来回**：`tauri dev` 是 `--no-default-features`，`cargo test` / `cargo build` / `clippy` 是默认 feature 集，
  两套 feature 会把彼此的产物作废，每来回一次就是整棵重编（分钟级）。所以一次改完、cargo 只跑一轮。
- **一次改完再一次跑齐验证，别拆成多轮**：前端一条命令 `pnpm run verify`（`scripts/verify.mjs`）——
  里面是 `lint:fix` 先独自跑完（它会写文件），然后 `lint` / `typecheck:code` / `typecheck:test` /
  `build:renderer` 四条**并行**（typecheck 拆两段就是为了能并行 —— `pnpm run typecheck` 本身仍是两段串行），
  最后 `test` 单独串行（它要独占 CPU）；实测约 24s，原来是 70s。怎么量、坑在哪见
  [build-performance.md](docs/dev-notes/build-performance.md)。Rust 一条命令串起来
  （`cargo test … && cargo build … && cargo clippy … -- -D warnings`）。
  改到一半只跑受影响的那个包（`pnpm -F @workbench/<包> test`，走那个包自己的配置），全量留到收尾那一次。
- **`pnpm test` 与 `cargo` 不要同时跑**：两边抢 CPU 会让既有那几条基于真实 git 的重测试撞 5 秒超时（假失败）。
  这类超时先单独复跑该包确认，别当成真失败去改代码。
- **cargo 之前只确认「本仓库的构建产物」没在跑，不是「没有 workbench.exe」**（exe 被占用会「拒绝访问」链接失败，
  而失败后跑起来的仍是旧二进制）。**开发环境与真实环境是分开的**，进程名却都叫 `workbench.exe` ——
  先查路径再决定：`Get-Process workbench | Select-Object Id,Path`（或
  `wmic process where name='workbench.exe' get ProcessId,ExecutablePath`），**只有路径落在本仓库
  `apps/desktop/src-tauri/target/` 下**才是锁住本次构建的那一个；别的路径（真实安装版）一律不要动。
  确实要停就停，但不要顺手再起回来，也不要在用户可能正用着应用时静默杀掉它 —— 先说一句。
  **不许按进程名直接 `taskkill`**：2026-10-21 就是这么把用户正在用的那份连同子进程一起停掉的。
- **停应用的进程树要连子孙一起收**（Windows 上杀掉外层命令不会带走它的子孙）：`taskkill /F /T /PID <pid>`，
  停完按进程名与端口各复查一遍（`tasklist | grep -i workbench`、`netstat -ano | grep LISTENING | grep -E ":(5274|9222)"`）。
- `cargo test` 卡在链接或执行上时、以及排查 WebView2 里的运行时问题（未捕获异常、控制台警告、接口实际返回值）时，
  配方见 [browser-preview-verification.md](docs/dev-notes/browser-preview-verification.md)。
- **真机接口排查（禅道 / 邮箱这类要登录的）有失败计数与限流**：**一次登录、复用同一会话**把要查的都查完，
  绝不反复试探登录（禅道的 `fails` 计数会把账号临时锁住，只能等冷却）；
  会话换新会让旧 token 立刻失效，所以别在同一轮里既用 cookie 登又用 token 读。
- **本项目是纯 vibe coding：所有改动都必须落实到文档**（只改代码不算完成）—— 动哪个模块就同步写它的
  `docs/modules/<模块>.md`（约束变了就改「约束」一节）；跨模块的通用事实更新
  [features-and-architecture.md](docs/features-and-architecture.md)。
- **了解业务以文档为主、代码为辅**：先读文档拿结论、再用代码抽验关键点，文档没写或疑似过期才反过来以代码为准。
- **别用 `git checkout --` / `git restore` / `git stash` 去清自己插进去的探针或临时改动**：它们按**文件**回退，
  会把用户在同一文件里**未提交的改动一起冲掉**。2026-10-19 在 `App.vue` 上就是这么丢了「禅道页从应用里摘掉」那两行：
  被冲掉的改动拿不回来（Local History 常是空的；没 `git add` 过就没有悬空 blob，只能靠上一次构建产物反推）。
  要清探针就用反向补丁精确删那几行；更好的做法是**别往仓库文件里写探针** —— 量耗时夹在命令外面（`date +%s%3N`）就够。
- 不提交构建产物与缓存（`out/`、`dist/`、`.preview/`、`*.tsbuildinfo`、`.eslintcache`、`apps/desktop/src-tauri/target/`）；
  **绝不提交 `apps/desktop/src-tauri/oauth.local.json`**（client_id / client_secret）。
- **视觉验证只在用户明确要求时做**：要做就把渲染层单独跑在浏览器里截图比对，用 `.preview/` 作工作区，
  **做完删掉整个 `.preview/` 目录**；`apps/desktop/vite.preview.config.ts` 是常驻入口，不要删。
- 默认不执行 git 提交；用户要求时先看 `git status` / `git diff`，沿用中文提交风格。不硬编码用户数据目录与进程记录；
  不输出或提交任何密钥 / token。
