# 通道、状态与落盘（底座）

## 约束

关键落点：`apps/desktop/src/renderer/src/workbench/`（适配层）、`apps/desktop/src/renderer/src/stores/`、
`apps/desktop/src-tauri/src/commands.rs`、`apps/desktop/src-tauri/src/store.rs`、`apps/desktop/src-tauri/src/paths.rs`。
跨模块通用事实见 [features-and-architecture.md](../features-and-architecture.md)，红线见 [AGENTS.md](../../AGENTS.md)。

### 通道

- 契约以 [types/api.ts](../../apps/desktop/src/renderer/src/types/api.ts) 的 `WorkbenchApi` 为准（`@/types` 从那里 re-export；
  设置与默认值在 `types/settings.ts`）：Tauri 命令名用 snake_case，
  camelCase 方法名到命令名的映射只出现在适配层。通道载荷类型（`Gateway*` / `Qoder*` / `Etf*`）住在 `types/gateway.ts` /
  `types/qoder.ts` / `types/etf.ts`（契约侧），适配层从 `@/types` **import 并 re-export** —— `from '@/workbench/gateway'` 照旧
  能用，但**契约不再反向 import 适配层**（原先 47 处 `import('./workbench/…')`），新增载荷类型一律落 `types/`。
- 通道一律返回 `Result<T>`（[result.ts](../../packages/core/src/result.ts) 的 `ok` / `fail` / `toResult`），不 reject；调用侧判
  `result.ok`、失败取 `result.error` 提示（`data` 在类型上仍是可选，取用前判一下）。Rust 的 `Err(String)` 会被 Tauri
  直接 reject，所以适配层用 `guard()` 收敛（兼容字符串与 Error，不能直接套 `@workbench/core` 的 `toResult`）。
- **会跨到 Rust 的数据读一律走 `Result`，不再留「取不到也是一句空态」的豁免**：`getActivity` / `gatewaySyncStatus` 这类
  底下真会 `Err` 的用 `guard()`；`listProjects` / `listCommands` / `getSettings` / `getThemeConfig` 这些纯内存 / 常量的用
  `ok()` 包一层 —— 现在不会失败，但签名与失败分支保持统一，以后 Rust 真开始 `Err` 时不会以「未处理异常」冒到调用方。
  **三类例外不属于数据通道**：① 文件 / 目录选择器返回 `T | null`（`null` 是「用户取消」，不是失败）；② 窗口控制与版本
  读取这类本地能力（`getWindowState` / `getAppVersion` / `markdownWindowIsMaximized` / `minimizeWindow` 等）按原样返回；
  ③ 事件订阅（`on*`）与 void 命令。
- **Rust → TS 的线上契约由 Rust 生成，不再手抄键名**：可序列化的 payload 结构在 Rust 侧标 `// @contract`，
  `pnpm run contract:gen` 生成 [types/contract.generated.ts](../../apps/desktop/src/renderer/src/types/contract.generated.ts)；
  `pnpm run contract:check`（`verify` 与 CI 里跑）在生成结果与仓库不一致时失败。新增 / 改动这类结构只改 Rust 一处，
  别再手写同名 interface（`AuthStatus` 这种「线上形状 + 适配层补充」的可以在生成类型上再组合一次）。
  **还返回 `Value` 的命令登记在** [contract-value-allow.txt](../../apps/desktop/src-tauri/contract-value-allow.txt)：
  新增一条会让 `contract:check` 失败，逼着新命令用 typed payload；确需保留 `Value` 的跑
  `node apps/desktop/scripts/gen-rust-contract.mjs --accept` 显式改写清单（人工动作，看 diff 只该多一条）。
- **「失败」与「空」要分开**：读数据文件（`data_load` / `theme_load` / `token_load` / `work_log_load` /
  `ai_news_load` / `etf_load`）、`probe_version`、`fs_exists` / `fs_is_dir` / `fs_stat_mtime`、`process_created_at`、
  `nvm_node_dir`、`check_port`、`nvm_status` / `nrm_status` 把「读不出来 / 探测失败」回成 `Err`；
  「文件不存在 / 没装 / 进程已退出」仍是正常值（`Ok(None)` / `Ok(false)` / 带 `error` 字段的 payload）。
  调用侧要么提示，要么显式降级并留日志 —— 启动时那几份数据文件属于后者（见 `workbench/state.ts` 的 `loadFile`）。
- 新增通道三步：`WorkbenchApi` 登记 → 适配层实现 → 需要后端时在 `commands.rs` 写命令并在 `main.rs` 的 `generate_handler!`
  注册。渲染层→主进程的单向事件走适配层的 `events.ts` 广播。
- 适配层实现**按域分文件**：`workbench/index.ts` 只是装配根（spreads + 通道覆盖检查 + 安装时序），通道按域住在 `api-sync.ts`
  （同步门禁几组）、`api-project.ts`（项目 CRUD 与进程十件事）、`api-system.ts`（系统 / 窗口 / 对话框 / 系统集成）、
  `api-background.ts`（背景图与图片授权）、`api-events.ts`（事件订阅与截图 / 钉图 / 网速球三窗共用组）；域模块薄转发收在
  index.ts 的 `domainsApi`，网关、Qoder 与独立视频窗口各自整组在 `gateway.ts` / `qoder.ts` / `video-window.ts`。新增通道加到
  对应域文件，不要往 index.ts 里塞实现。
- **「通道有没有实现」是编译期的事，运行期没有兜底**：装配根把合并出来的对象与 `WorkbenchApi` 对一遍（`MissingChannels`），
  漏一条就是 tsc 报错并把名字列出来。原来那层 Proxy（缺通道返回「尚未移植」）已经删掉 —— 它有两个毛病：漏实现要到运行时才
  发现；而且它给 `then` 也编了个函数，`await window.workbench` 会被当成 thenable 永远不落地。**不要把它加回来**：新增通道时
  实现与 `types/api.ts` 的登记必须同一次改完。
- 渲染层不直接访问 Node / 文件系统 / WebView 宿主能力，一切经 `window.workbench`。**唯一例外是「大文件交给 webview 按文件
  读」的两处**：工作区背景图与视频播放 —— 让 webview 按 asset 协议自己加载（URL 由适配层 `assetUrl()` 转出），读取权限一律
  在 Rust 侧按**单个文件**授予（`commands.rs` 的 `allow_background` / `allow_video`，后者先核后缀与 MP4 文件头再放行），
  `tauri.conf.json` 的 `assetProtocol.scope` 必须保持为空 —— 写 `**` 等于把整块磁盘敞开给渲染层读。
- 后端只做「取原始数据 / 落盘 / 调系统能力」；合并、排序、修剪、状态机、命令构造这些业务语义留在 TS 适配层（改动走 Vite
  秒级热更新，不必重编 Rust）。
- **交给 Shell 的路径先换成反斜杠**：`reveal` 与文件对话框的 `defaultPath` 都归 Windows 解析，而 Shell 路径解析只认 `\` ——
  `E:/a/b`（设置里的路径可能就是它）会让 `SHParseDisplayName` 直接失败，资源管理器开到别处、对话框也不从你要的地方打开。
  适配层的 `windowsPath()` 是唯一收口（Rust 侧的文件操作两种分隔符都认；别在各调用方各写一遍 `replace`）。
- 首屏快照：Tauri 没有同步 IPC，建窗口时用 `initialization_script` 注入 `window.__WB_BOOTSTRAP__`（`main.rs` 的
  `bootstrap_script`），渲染层同步读它，第一帧就是用户设置的样子。

### 状态

- 跨组件状态按领域分在 [stores/](../../apps/desktop/src/renderer/src/stores/) 下（分工见架构文档「目录结构」）；不另建全局状态，
  也不要用事件总线传业务数据（组件设计那一层的约束见 [AGENTS.md](../../AGENTS.md) 第 0 节）。
- **谁该进 store 的判据是「跨页共享」**：多处读写的状态必须进 store 且只经 action 变更 —— 工作日志就是这一条
  （[stores/work-log.ts](../../apps/desktop/src/renderer/src/stores/work-log.ts)：「工作」页写、首页「今日完成」读，两边必须是
  同一份）；只在单页生命周期内用完即弃的数据与动作直接调 `window.workbench` 或收进 composable（首页用量卡片的取数与轮询在
  [use-token-usage.ts](../../apps/desktop/src/renderer/src/composables/use-token-usage.ts)），不为它造 store 切片。
- **store 里不要直接 import element-plus**：提示与确认框一律经 [notify.ts](../../apps/desktop/src/renderer/src/notify.ts) 的
  `notifySuccess` / `notifyError` / `confirmAction` —— 这样这些 action 才可能被单测覆盖，也让状态层与「怎么提示」分开演进。

### 落盘

- 落盘全在 Rust 侧（`store.rs`：300ms 防抖 + 临时文件 rename + 退出前同步落盘）。数据文件分工：`workbench-data.json`（项目 /
  快捷启动 / 命令 + 与本机绑定的设置，含笔记文件夹 `noteDir`）、`theme.json`（外观 + 首页布局）、`token-usage.json`、
  `work-log.json` 与 `ai-news.json`（都只在本机）、`vault.json`（密码保险库，**里面只有密文**，密钥在 Windows 凭据管理器，
  见 [vault.md](vault.md)）、`mail-watch.json`（邮件后台监视的 UID 基准与上轮检查时间，见 [mail.md](mail.md)，只是通知记账，
  不进同步仓库），加上设备标识 `device.json`，以及 `panic.log`（崩溃落痕）—— 全在数据目录下（安装版
  `%APPDATA%/Workbench/data/`，开发版 `%APPDATA%/Workbench-dev/data/`；根目录 `%APPDATA%/Workbench` 是 Electron 版留下的
  Chromium 配置目录；老版本也把数据文件写在那儿，启动时由 `migrate_legacy_files` 搬进 `data/`）。
  **禅道没有数据文件**：后台检查的编号基线只在本机内存（重启后第一轮重新建立，见 [zentao.md](zentao.md)），周期住
  `workbench-data.json` 的 `zentaoPollMinutes`。**技能没有数据文件**：技能库是用户挑的目录（`skillDir`，与笔记文件夹互不
  相干），磁盘文件就是数据；它在哪个仓库由 `skills.rs` 的 `state` 往上找。**独立视频窗口没有数据文件**：播放会话与置顶只在
  Rust 内存（窗口关掉即清），位置 / 尺寸建窗时按主窗口现算、不记账（见 [video.md](video.md)）。
- **开发版（`pnpm dev`）不注册单实例**，可与装着的那份同时开（正式版之间仍按 identifier 互斥）。两边数据目录按环境分开
  （`Workbench-dev` 与 `Workbench`），各写各的；代价是邮件 / 禅道的后台轮询与通知仍各跑一遍（见
  [dev-notes/browser-preview-verification.md](../dev-notes/browser-preview-verification.md)）。
- **数据目录按环境固定**：安装版 `%APPDATA%\Workbench\data`，开发版 `%APPDATA%\Workbench-dev\data`（根目录
  `%APPDATA%\Workbench` 是 Electron 版留下的 Chromium 配置目录，数据文件收进 `data` 子目录，两边不混），**没有「换目录」
  这回事**：不要图省事改用 Tauri 的 `app_config_dir()`（它按 identifier 生成 `%APPDATA%\com.muyian.workbench`，换位置用户就
  等于丢了项目列表）；路径一律经 `paths.rs` 的 `data_dir()` / `data_file()` 现取，不要缓存写死，也别在别处另拍一个数据目录。
  开发版与安装版共用同一份设置会让两边互相盖掉（截图开关、全局快捷键、项目列表都是），所以判据用编译期 `dev` cfg
  （`tauri dev` / `cargo build` 为真，`tauri build` 为假），与单实例、开机自启同一条口径。
- 数据结构变更要同步落盘的 sanitize（[persisted-data.ts](../../apps/desktop/src/renderer/src/persisted-data.ts) 的
  `sanitizeSettings` / `parseData`），老数据文件缺字段须有默认值，不留未收敛的 `undefined`。
- **设置项先分清是「外观」还是「行为习惯」，落点完全不同**：
  - **外观**（明暗、主题色、顶部样式、卡片不透明度、毛玻璃描边、终端高度、程序名、背景、导航菜单、首页布局、笔记树宽度）住
    `theme.json`，判据是它在 [appearance.ts](../../packages/appearance/src/appearance.ts) 的 `APPEARANCE_SETTING_KEYS` 里 ——
    **进这张白名单就等于「会被整份同步到另一台机器」**，所以只放「这台机器该长成什么样」的项；**没有例外**：技能库在哪儿不是
    「界面长什么样」，它是**本机的一个目录**（`skillDir`，住 `workbench-data.json`，与 `noteDir` 同一类），也不再有「技能放在
    仓库哪一层」这种配置；
  - **行为习惯**（`activeView`、`projectSort`、`workRange` / `workSort`、`noteTreeExpanded`、密码页那两样 `vaultGroupOrder` /
    `vaultHiddenGroups`）与本机路径 / 凭据（快捷键、开机自启、两个同步仓库地址 —— 用量与图片；**笔记与技能那两个仓库的地址
    都不在设置里**：跟着各自那个文件夹的 `origin` 走、`noteDir`、`skillDir`）住 `workbench-data.json`。天气城市 `weatherCity`
    也在这边：它是「这台机器上的人住哪儿」，不是「界面长什么样」，而且它管着一条联网出口的开关（留空即关闭），不该被同步
    顶掉。判据是「换台机器还成不成立」：「我上一眼在看什么」「我的笔记在哪个盘」换台机器就没了，同步过去只会把那边正看的
    东西顶掉。
  不确定时的口径：**它是「界面长什么样」还是「我上次用到哪儿」** —— 后者一律留数据文件。
- 给项目加可编辑字段时，除了 `Project` / `ProjectPatch`，还要加进 store 里的 `editableOf`
  （[stores/projects.ts](../../apps/desktop/src/renderer/src/stores/projects.ts)）：项目是就地改 `projects.value` 的，落盘靠
  那条「与快照比对后推差异」的 watch，`editableOf` 就是它认得的字段清单 —— 漏加的表现是改完看着生效、重启回到旧值。
- **读取时补齐老数据的字段**（例如项目标识色）要走「先 `snapshotProjects()`、再补」的顺序：补齐要经上面那条 watch 推给后端，
  而它只推与快照不同的项 —— 顺序反了的话快照里已是补好的值，那批数据永远写不进磁盘。

## 实现

### 底座的形状

- **后端刻意做薄**（`commands.rs` 只取数据 / 落盘 / 调系统能力，业务语义在适配层）。**例外是 store 的「形状」**：加了字段 /
  动作之后，正在跑的那个应用**要整页刷新一次**才认得 —— 组件会热替换，而 Pinia 的 store 实例不会（项目里没有一处
  `acceptHMRUpdate`，实例是上次整页加载时建好的）。新组件读 store 上还不存在的字段，渲染时就抛错、被 Vue 吞掉（控制台才有）。
  store 里加东西之后**把应用重开一次**（或刷新 webview 页面）。
- **「按钮在、点下去什么都没发生」有两种来路，别只认一种**（2026-10 密码页那次就认错了）：一是上面那条 store 实例过期；
  二是**模板里用了组件、脚本里漏了 import** —— 少了 import 时 `vue-tsc` 与 `vite build` **都不报错**（标签被当成认不出的元素
  渲染成空），只有 `pnpm run lint` 的 `vue/no-undef-components` 拦得住（见 eslint.config.mjs 里那条说明）。诊断先看这两处，
  别一上来就猜 HMR。
- **适配层顶替的是 Electron 时代的进程边界**：递给渲染层的列表一律是快照（`structuredClone`），渲染层的乐观追加写不进要落盘
  的数据。
- **IPC 命令默认跑主线程**：会起子进程、读写文件、解码图片、跑 SQL 的命令都标 `(async)`（落到 `async_runtime::spawn` 工作
  线程），漏标的后果不是慢而是界面卡死。**标了 `async` 也不等于安全**：在工作线程上等一个被长网络请求占住的 `Mutex`
  同样会耗尽线程、拖死整个应用的 IPC —— 长网络一律在锁外跑（网关那次全体卡死的教训见 [gateway](gateway.md) 与
  [qoder](qoder.md)）。
- **工作区背景图与视频播放走 asset 协议，后端不碰它们的字节**：渲染层只调一次 `allow_background` / `allow_video`，后端核文件头
  后把**这一个文件**的读取权限授给 asset 协议，URL 由 `convertFileSrc` 转出；`assetProtocol.scope` 刻意留空。
- **崩溃落痕**：release 档把 panic 设成直接中止进程（`Cargo.toml` 的 `panic = "abort"`），进程凭空消失、什么都不留 ——
  `main()` 第一行装 `panic_log::install()`，把「时间 / 线程 / 位置 / 消息 / 回溯」追加到 `data/panic.log`（写失败就放弃；默认
  钩子照旧调用，dev 的 stderr 上还有一份）。单份超 256KB 先清空。
- **webview 有全局 CSP**（`tauri.conf.json` 的 `csp`；dev 用 `devCsp`，多放行 HMR 的 ws）。底线是 `default-src 'self'`、
  `script-src 'self'`、`object-src 'none'`；必须放行的几处都有理由：
  `style-src 'unsafe-inline'`（Element Plus / Vditor 的动态样式与邮件正文 —— **但它只管 CSSOM**：入口 HTML 里只要有一段内联
  `<style>`，Tauri 就给那一段加 nonce、并往 `style-src` 追加 `'nonce-…'`，按 CSP 规则 nonce 在场 `'unsafe-inline'` 即失效，
  **源码里的行内 `style` 属性整个被丢弃**；`el.style.x = …` 这类 CSSOM 写入不受影响。`markdown` / `video` / `capture` / `pin` /
  `ball` 这五个带内联 `<style>` 的入口因此不能依赖行内 style 属性，独立 Markdown 窗口踩过：Vditor 的图标 sprite 靠行内样式缩成
  0×0，被丢弃后占成 300×150，把整扇窗往下顶 153px，补法见 [notes.md](notes.md) 的「独立编辑窗口」）、
  `script-src` 上的 **`'unsafe-inline'`**（**只为 HTML 附件那一档**：这份 CSP 由 Tauri 按 meta 注入、**子框架会继承**，附件
  脚本要跑只能在这儿放行；代价与三条不能动的边界见 [mail.md](mail.md) 的「HTML 附件：给脚本、不给宿主能力」—— 别再往
  `script-src` 加别的来源，**也别给附件那个 iframe 加 `allow-same-origin`**）、`connect-src ipc: http://ipc.localhost`（IPC
  本身）与它的 `data:`（截图遮罩把那一帧的 base64 交给浏览器原生解，见 [screenshot.md](screenshot.md)；`data:` 不出进程、放行
  它不等于开了新出口）、`worker-src blob:`（pptx 预览与笔记里的 graphviz 都用 blob 建 Worker）、`img-src` 的 asset 协议与
  `https:`/`http:`（背景图、笔记与邮件的外链图）、`frame-src` 的 `about:`（邮件与 AI 预览的 srcdoc 内嵌框）。
  **改这条、或引新的前端依赖 / 资源之前先想它会不会被拦**，而且**要在生产态的真应用里过一遍**：dev 下页面来自 Vite、CSP 根本
  不生效，浏览器预览也验不了。

## 涉及文件

```
  src/main.rs            入口、窗口、托盘、单实例、生命周期
  src/commands.rs        IPC 命令层（薄：取数据 / 落盘 / 调系统能力）
  src/session.rs         子进程会话：起命令、按批回传输出、按进程树终止
  src/proc.rs            带超时的子进程原语 + 进程树终止
  src/store.rs           去抖 JSON 落盘（300ms 合并 + 临时文件 rename）
  src/paths.rs           数据目录与指针（安装版与旧 Electron 版同一位置，开发版另用 Workbench-dev）
  src/system.rs          端口检测（GetExtendedTcpTable）、资源管理器、ShellExecute
  src/http.rs            WinHTTP 极简 HTTP 客户端（登录、AI 热点与天气的取数都走它）。
                         默认那条是「HTTPS + 443 + 主机名」的固定形状（那几家的地址钉死在代码里）；
                         另有一条**按 URL 走**的（`request_url`，http / https 与端口都认）——
                         AI 拉模型列表用它，因为地址是用户自己填的（本机服务也在内）；
                         禅道使用内嵌配置中的地址及显式禁重定向的入口，避免认证信息随跳转离开原部署
  src/credentials.rs     Windows 凭据管理器读写（access_token 与**保险库密钥**落在这里，不落 JSON）
  src/encoding.rs        base64 / SHA-256 / UTF-16 宽字符串（前两者用 base64 / sha2）

    bridge.ts            invoke / 事件 / 错误收敛
    events.ts            适配层内部广播
    auto-sync.ts         「一台机器一份分片」那类同步的公共节流
    state.ts             持久化状态与增删改
    session.ts           进程会话与事件翻译
    scanner.ts           扫描的生产侧（fs 经 IPC 落到 Rust）
```

前七行在 `apps/desktop/src-tauri/src/`，中间三行也在 `apps/desktop/src-tauri/src/`（http / credentials / encoding）；
末尾五件在 `apps/desktop/src/renderer/src/workbench/`（适配层的底座部分）。两个壳层 store（`stores/nav.ts` 当前页、
`stores/settings.ts` 设置与外观）与导航壳层的注解仍留在主文档「目录结构」里，因为它们与「导航与页面」「系统集成」两节长在
一起。
