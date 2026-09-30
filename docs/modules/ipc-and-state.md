# 通道、状态与落盘（底座）

通道、状态与落盘（底座）的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`apps/desktop/src/renderer/src/workbench/`（适配层）、`apps/desktop/src/renderer/src/stores/`、`apps/desktop/src-tauri/src/commands.rs`、
`apps/desktop/src-tauri/src/store.rs`、`apps/desktop/src-tauri/src/paths.rs`。

### 通道

- 契约以 [types.ts](../../apps/desktop/src/renderer/src/types.ts) 的 `WorkbenchApi` 为准：Tauri 命令名用 snake_case，camelCase 方法名到命令名的
  映射只出现在适配层。
- 通道一律返回 `Result<T>`（[result.ts](../../packages/core/src/result.ts) 的 `ok` / `fail` / `toResult`），不 reject；调用侧判 `result.ok`、
  失败取 `result.error` 提示。Rust 的 `Err(String)` 会被 Tauri 直接 reject，所以适配层用 `guard()` 收敛（它兼容字符串与 Error，
  不能直接套 shared 的 `toResult`）。
- 新增通道三步：`WorkbenchApi` 登记 → 适配层实现 → 需要后端时在 `commands.rs` 写命令并在 `main.rs` 的 `generate_handler!`
  注册。渲染层→主进程的单向事件走适配层的 `events.ts` 广播。
- **数组 / 对象形状的取值接口必须真实现，绝不能落到「尚未移植」兜底**：兜底返回的是 `Result` 对象，store 会把它当数组遍历、
  直接抛错并把整条 `init()` 打断，表现成完全无关的功能失灵（`listQuickApps` / `listCommands` 就这么让「系统状态」一直没数据）。
- 渲染层不直接访问 Node / 文件系统 / WebView 宿主能力，一切经 `window.workbench`。**唯一的例外
  是「大文件交给 webview 按文件读」的两处**：工作区背景图与视频播放 —— 让 webview 按 asset 协议
  自己加载（URL 由适配层的 `assetUrl()` 转出），读取权限一律在 Rust 侧按**单个文件**授予
  （`commands.rs` 的 `allow_background` / `allow_video`，后者先核后缀与 MP4 文件头再放行），
  `tauri.conf.json` 的 `assetProtocol.scope` 必须保持为空 —— 往里写 `**` 等于把整块磁盘敞开给渲染层读。
- 后端只做「取原始数据 / 落盘 / 调系统能力」；合并、排序、修剪、状态机、命令构造这些业务语义留在 TS 适配层（改动因此走 Vite
  的秒级热更新，不必重编 Rust）。少数通道按约定直接返回具体结构而非 `Result`：`checkPort`、`listProjects`、`getNvmStatus`、
  `listWallpapers`、`checkPackageManagers`。
- 首屏快照：Tauri 没有同步 IPC，建窗口时用 `initialization_script` 注入 `window.__WB_BOOTSTRAP__`（`main.rs` 的
  `bootstrap_script`），渲染层同步读它，第一帧就是用户设置的样子。

### 状态

- 跨组件状态按领域分在 [stores/](../../apps/desktop/src/renderer/src/stores/) 下（分工见架构文档的「目录结构」一节）；不另建全局状态，也不
  用事件总线传业务数据（组件设计那一层的约束见 [AGENTS.md](../../AGENTS.md) 第 0 节）。
- **谁该进 store 的判据是「跨页共享」**：多处读写的状态必须进 store 且只经 action 变更；只在单页生命周期内用完即弃的数据与动作
  （工作日志的读写入参、Token 卡片的取数节流）直接调 `window.workbench`，不为它造 store 切片。
- **store 里不要直接 import element-plus**：提示与确认框一律经 [notify.ts](../../apps/desktop/src/renderer/src/notify.ts) 的 `notifySuccess` /
  `notifyError` / `confirmAction` —— 这样这些 action 才可能被单测覆盖，也让状态层与「怎么提示」分开演进。

### 落盘

- 落盘全在 Rust 侧（`store.rs`：300ms 防抖 + 临时文件 rename + 退出前同步落盘）。数据文件分工：`workbench-data.json`（项目 /
  快捷启动 / 命令 + 与本机绑定的设置，含笔记文件夹 `noteDir`）、`theme.json`（外观 + 首页布局）、`token-usage.json`、
  `work-log.json` 与 `ai-news.json`（都只在本机）、`vault.json`（密码保险库，**里面只有密文**，
  密钥在 Windows 凭据管理器里，见 [vault.md](vault.md)），加上设备标识 `device.json` —— 全都在 `%APPDATA%/Workbench/data/` 下
  （根目录 `%APPDATA%/Workbench` 是 Electron 版留下的 Chromium 配置目录；老版本也把数据文件写在那儿，启动时由 `migrate_legacy_files` 搬进 `data/`）。
  **技能没有数据文件**：技能库是用户挑的一个目录（设置里的 `skillDir`，与笔记文件夹互不相干），
  磁盘上的文件就是数据本身；它在哪个仓库里由 `skills.rs` 的 `state` 从那个目录往上找。
- **数据目录固定 `%APPDATA%\Workbench\data`**（根目录 `%APPDATA%\Workbench` 是 Electron 版留下的 Chromium 配置目录，
  数据文件收进 `data` 子目录，两边不混），**没有「换目录」这回事**：不要图省事改用 Tauri 的
  `app_config_dir()`（它按 identifier 生成 `%APPDATA%\com.muyian.workbench`，换了位置用户就等于丢了项目列表）；
  路径一律经 `paths.rs` 的 `data_dir()` / `data_file()` 现取，不要缓存写死，也不要在别处另拍一个数据目录。
- 数据结构变更要同步落盘的 sanitize（[persisted-data.ts](../../apps/desktop/src/renderer/src/persisted-data.ts) 的 `sanitizeSettings` / `parseData`），
  老数据文件缺字段须有默认值，不留未收敛的 `undefined`。
- **设置项先分清是「外观」还是「行为习惯」，落点完全不同**：
  - **外观**（明暗、主题色、顶部样式、卡片不透明度、终端高度、程序名、背景、导航菜单、首页布局、笔记树宽度）住
    `theme.json`，判据是它在 [appearance.ts](../../packages/appearance/src/appearance.ts) 的 `APPEARANCE_SETTING_KEYS` 里
    —— **进这张白名单就等于「会被整份同步到另一台机器」**，所以只放「这台机器该长成什么样」的项；
    **没有例外**：技能库在哪儿不是「界面长什么样」，它是**本机的一个目录**
    （设置里的 `skillDir`，住 `workbench-data.json`，与 `noteDir` 同一类），
    也不再有「技能放在仓库哪一层」这种配置；
  - **行为习惯**（`activeView`、`projectSort`、`workRange` / `workSort`、`noteTreeExpanded`）与
    本机路径 / 凭据（快捷键、开机自启、两个同步仓库地址 —— 用量与图片；**笔记与技能那两个仓库的地址
    都不在设置里**：它们跟着各自那个文件夹的 `origin` 走、`noteDir`、`skillDir`）住 `workbench-data.json`。
    天气城市 `weatherCity` 也在这一边：它是「这台机器上的人住哪儿」，不是「界面长什么样」，
    而且它管着一条联网出口的开关（留空即关闭），不该被同步顶掉。
    判据是「换台机器还成不成立」：「我上一眼在看什么」「我的笔记在哪个盘」换台机器就没了，
    同步过去只会把那边正看的东西顶掉。
  不确定时的口径：**它是「界面长什么样」还是「我上次用到哪儿」** —— 后者一律留数据文件。
- 给项目加可编辑字段时，除了 `Project` / `ProjectPatch`，还要把它加进 store 里的 `editableOf`
  （[stores/projects.ts](../../apps/desktop/src/renderer/src/stores/projects.ts)）：项目是就地改 `projects.value` 的，落盘靠那条「与快照比对后推
  差异」的 watch，`editableOf` 就是它认得的那份字段清单 —— 漏加的表现是界面上改完看着生效、重启后回到旧值。
- **读取时补齐老数据的字段**（例如项目标识色）要走「先 `snapshotProjects()`、再补」的顺序：补齐要经上面那条 watch 推给后端，
  而它只推与快照不同的项 —— 顺序反了的话快照里已经是补好的值，那批数据永远写不进磁盘。

## 实现

### 底座的形状

- **后端刻意做薄**：`commands.rs` 只做「取原始数据 / 落盘 / 调系统能力」；合并、排序、修剪、
  状态机、命令构造这些业务语义在渲染层适配层（`apps/desktop/src/renderer/src/workbench/`）——
  改动因此大多走 Vite 的秒级热更新，只有动到系统能力时才重编 Rust。
- **适配层顶替的是 Electron 时代的进程边界**：它递给渲染层的列表一律是快照
  （`structuredClone`），渲染层的乐观追加写不进要落盘的数据。
- **IPC 命令默认跑在主线程上**：会起子进程、读写文件、解码图片、跑 SQL 的命令都标 `(async)`
  （落到 `async_runtime::spawn` 的工作线程），漏标的后果不是慢而是界面卡死。
- **首屏快照**：Tauri 没有同步 IPC，建窗口时用 `initialization_script` 注入
  `window.__WB_BOOTSTRAP__`（`main.rs` 的 `bootstrap_script`），渲染层同步读它，
  第一帧就是用户设置的样子。
- **工作区背景图与视频播放走 asset 协议，后端不碰它们的字节**：渲染层只调一次
  `allow_background` / `allow_video`，后端核文件头后把**这一个文件**的读取权限授给 asset 协议，
  URL 由 `convertFileSrc` 转出；`assetProtocol.scope` 刻意留空。

## 涉及文件

这些条目的原文注解从主文档「目录结构」迁来（主文档的树里各留一行，指回这里）。

```
  src/main.rs            入口、窗口、托盘、单实例、生命周期
  src/commands.rs        IPC 命令层（薄：取数据 / 落盘 / 调系统能力）
  src/session.rs         子进程会话：起命令、按批回传输出、按进程树终止
  src/proc.rs            带超时的子进程原语 + 进程树终止
  src/store.rs           去抖 JSON 落盘（300ms 合并 + 临时文件 rename）
  src/paths.rs           数据目录与指针（与旧 Electron 版同一位置）
  src/system.rs          端口检测（GetExtendedTcpTable）、资源管理器、ShellExecute
  src/http.rs            WinHTTP 极简 HTTP 客户端（登录、AI 热点与天气的取数都走它）。
                         默认那条是「HTTPS + 443 + 主机名」的固定形状（那几家的地址钉死在代码里）；
                         另有一条**按 URL 走**的（`request_url`，http / https 与端口都认）——
                         只有 AI 拉模型列表用它，因为地址是用户自己填的（本机服务也在内）
  src/credentials.rs     Windows 凭据管理器读写（access_token 与**保险库密钥**落在这里，不落 JSON）
  src/encoding.rs        base64 / SHA-256 / UTF-16 宽字符串（前两者用 base64 / sha2）

    bridge.ts            invoke / 事件 / 未移植通道兜底
    events.ts            适配层内部广播
    state.ts             持久化状态与增删改
    session.ts           进程会话与事件翻译
    scanner.ts           扫描的生产侧（fs 经 IPC 落到 Rust）
```

前七行在 `apps/desktop/src-tauri/src/`，中间三行也在 `apps/desktop/src-tauri/src/`（http / credentials / encoding）；
末尾五件在 `apps/desktop/src/renderer/src/workbench/`（适配层的底座部分）。
两个壳层 store（`stores/nav.ts` 当前页、`stores/settings.ts` 设置与外观）与导航壳层的注解
仍留在主文档「目录结构」里，因为它们与「导航与页面」「系统集成」两节长在一起。
