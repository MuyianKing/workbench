# 通道、状态与落盘

从 [AGENTS.md](../../AGENTS.md) 第 5 节拆出的硬约束：渲染层怎么与后端说话、状态放哪、数据落在哪。功能与架构事实（为什么这么做、
踩过哪些坑）见 [features-and-architecture.md](../features-and-architecture.md) 的「数据与隐私」「目录结构」两节。

关键落点：`src/renderer/src/workbench/`（适配层）、`src/renderer/src/stores/`、`src-tauri/src/commands.rs`、
`src-tauri/src/store.rs`、`src-tauri/src/paths.rs`。

## 通道

- 契约以 [types.ts](../../src/shared/types.ts) 的 `WorkbenchApi` 为准：Tauri 命令名用 snake_case，camelCase 方法名到命令名的
  映射只出现在适配层。
- 通道一律返回 `Result<T>`（[result.ts](../../src/shared/result.ts) 的 `ok` / `fail` / `toResult`），不 reject；调用侧判 `result.ok`、
  失败取 `result.error` 提示。Rust 的 `Err(String)` 会被 Tauri 直接 reject，所以适配层用 `guard()` 收敛（它兼容字符串与 Error，
  不能直接套 shared 的 `toResult`）。
- 新增通道三步：`WorkbenchApi` 登记 → 适配层实现 → 需要后端时在 `commands.rs` 写命令并在 `main.rs` 的 `generate_handler!`
  注册。渲染层→主进程的单向事件走适配层的 `events.ts` 广播。
- **数组 / 对象形状的取值接口必须真实现，绝不能落到「尚未移植」兜底**：兜底返回的是 `Result` 对象，store 会把它当数组遍历、
  直接抛错并把整条 `init()` 打断，表现成完全无关的功能失灵（`listQuickApps` / `listCommands` 就这么让「系统状态」一直没数据）。
- 渲染层不直接访问 Node / 文件系统 / WebView 宿主能力，一切经 `window.workbench`。**唯一例外是工作区背景图**：让 webview 按
  文件直接加载（asset 协议，URL 由适配层的 `assetUrl()` 转出），读取权限一律在 Rust 侧按**单个文件**授予（`commands.rs` 的
  `allow_background`），`tauri.conf.json` 的 `assetProtocol.scope` 必须保持为空 —— 往里写 `**` 等于把整块磁盘敞开给渲染层读。
- 后端只做「取原始数据 / 落盘 / 调系统能力」；合并、排序、修剪、状态机、命令构造这些业务语义留在 TS 适配层（改动因此走 Vite
  的秒级热更新，不必重编 Rust）。少数通道按约定直接返回具体结构而非 `Result`：`checkPort`、`listProjects`、`getNvmStatus`、
  `listWallpapers`、`checkPackageManagers`。
- 首屏快照：Tauri 没有同步 IPC，建窗口时用 `initialization_script` 注入 `window.__WB_BOOTSTRAP__`（`main.rs` 的
  `bootstrap_script`），渲染层同步读它，第一帧就是用户设置的样子。

## 状态

- 跨组件状态按领域分在 [stores/](../../src/renderer/src/stores/) 下（分工见架构文档的「目录结构」一节）；不另建全局状态，也不
  用事件总线传业务数据（组件设计那一层的约束见 [AGENTS.md](../../AGENTS.md) 第 0 节）。
- **谁该进 store 的判据是「跨页共享」**：多处读写的状态必须进 store 且只经 action 变更；只在单页生命周期内用完即弃的数据与动作
  （工作日志的读写入参、Token 卡片的取数节流）直接调 `window.workbench`，不为它造 store 切片。
- **store 里不要直接 import element-plus**：提示与确认框一律经 [notify.ts](../../src/renderer/src/notify.ts) 的 `notifySuccess` /
  `notifyError` / `confirmAction` —— 这样这些 action 才可能被单测覆盖，也让状态层与「怎么提示」分开演进。

## 落盘

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
- 数据结构变更要同步落盘的 sanitize（[persisted-data.ts](../../src/shared/persisted-data.ts) 的 `sanitizeSettings` / `parseData`），
  老数据文件缺字段须有默认值，不留未收敛的 `undefined`。
- **设置项先分清是「外观」还是「行为习惯」，落点完全不同**：
  - **外观**（明暗、主题色、顶部样式、卡片不透明度、终端高度、程序名、背景、导航菜单、首页布局、笔记树宽度）住
    `theme.json`，判据是它在 [appearance.ts](../../src/shared/appearance.ts) 的 `APPEARANCE_SETTING_KEYS` 里
    —— **进这张白名单就等于「会被整份同步到另一台机器」**，所以只放「这台机器该长成什么样」的项；
    **没有例外**：技能库在哪儿不是「界面长什么样」，它是**本机的一个目录**
    （设置里的 `skillDir`，住 `workbench-data.json`，与 `noteDir` 同一类），
    也不再有「技能放在仓库哪一层」这种配置；
  - **行为习惯**（`activeView`、`projectSort`、`workRange` / `workSort`、`noteTreeExpanded`）与
    本机路径 / 凭据（快捷键、开机自启、两个同步仓库地址 —— 用量与图片；**笔记与技能那两个仓库的地址
    都不在设置里**：它们跟着各自那个文件夹的 `origin` 走、`noteDir`、`skillDir`）住 `workbench-data.json`。
    判据是「换台机器还成不成立」：「我上一眼在看什么」「我的笔记在哪个盘」换台机器就没了，
    同步过去只会把那边正看的东西顶掉。
  不确定时的口径：**它是「界面长什么样」还是「我上次用到哪儿」** —— 后者一律留数据文件。
- 给项目加可编辑字段时，除了 `Project` / `ProjectPatch`，还要把它加进 store 里的 `editableOf`
  （[stores/projects.ts](../../src/renderer/src/stores/projects.ts)）：项目是就地改 `projects.value` 的，落盘靠那条「与快照比对后推
  差异」的 watch，`editableOf` 就是它认得的那份字段清单 —— 漏加的表现是界面上改完看着生效、重启后回到旧值。
- **读取时补齐老数据的字段**（例如项目标识色）要走「先 `snapshotProjects()`、再补」的顺序：补齐要经上面那条 watch 推给后端，
  而它只推与快照不同的项 —— 顺序反了的话快照里已经是补好的值，那批数据永远写不进磁盘。
