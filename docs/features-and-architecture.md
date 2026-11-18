# 功能与架构

Workbench 的文档按「通用 / 模块」分层：

- **本文件**是跨模块通用事实的**入口**：模块索引、技术栈、开发与打包、本期不做；正文三份按需读 ——
  [features.md](features.md)（功能）、[privacy.md](privacy.md)（数据与隐私）、[directory.md](directory.md)（目录结构）；
- **[modules/](modules/)** 下每个模块一份 `<模块>.md`：「约束」一节的开口那段**红线**是**不能破的规矩**（动手前先读），
  其下按主题分小节（改到哪块读哪块，不必整份读）；后面「实现」一节装实现细节，末尾是「涉及文件」；
- 工程约束的骨架在 [AGENTS.md](../AGENTS.md)（跨模块红线 + 模块索引），概览与上手在 [README.md](../README.md)，动手方法与
  施工记录在 [dev-notes/](dev-notes/)。

改功能或调架构时：**模块内的改动改对应那份模块文档（规矩动「约束」节、事实动「实现」节），跨模块的通用事实才动这个入口与那三份**。

## 模块索引

| 模块 | 文档（先读「约束」开头的红线） |
| --- | --- |
| 首页（画布与九块卡片） | [home.md](modules/home.md) |
| 快捷启动（常用软件） | [quick-launch.md](modules/quick-launch.md) |
| 项目（含一键操作、Node 清理、nrm） | [projects.md](modules/projects.md) |
| 工作日志 | [work-log.md](modules/work-log.md) |
| 笔记 | [notes.md](modules/notes.md) |
| 技能（skill） | [skills.md](modules/skills.md) |
| 知识库（kb） | [kb.md](modules/kb.md) |
| AI 助手（ai） | [ai.md](modules/ai.md) |
| TBuddy（网关：CodeBuddy 反代） | [gateway.md](modules/gateway.md) |
| Qoder（网关：Qoder 国内版反代，独立端口 / 密钥） | [qoder.md](modules/qoder.md) |
| 密码保险库 | [vault.md](modules/vault.md) |
| 邮箱（IMAP 收发） | [mail.md](modules/mail.md) |
| 禅道（浏览器打开站点 + 后台检查与通知） | [zentao.md](modules/zentao.md) |
| 样式（设计参考库） | [styles.md](modules/styles.md) |
| 视频（本地 MP4 播放器） | [video.md](modules/video.md) |
| 截图与钉图（capture） | [screenshot.md](modules/screenshot.md) |
| 终端面板 | [terminal.md](modules/terminal.md) |
| ETF 资金流（份额 / 净值 / 净申赎） | [etf.md](modules/etf.md) |
| Git 页（只读浏览本地仓库 / 提交历史 / 差异） | [git-client.md](modules/git-client.md) |
| 用量与外观同步、账号登录 | [sync-and-auth.md](modules/sync-and-auth.md) |
| 通道、状态与落盘（底座） | [ipc-and-state.md](modules/ipc-and-state.md) |

## 功能

见 [features.md](features.md)——跨模块的能力与界面口径（导航壳层、弹层、设置面板、首页与各页交互）。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | Tauri 2（Windows 上走系统 WebView2，不再随包附带 Chromium） |
| 后端 | Rust（窗口 / 托盘 / 单实例、子进程与日志、文件与 sqlite、系统能力） |
| 前端 | Vue 3（组合式 API + `<script setup>`）+ Element Plus + Pinia |
| 工作日志渲染 | markdown-it（只服务工作日志正文：`html: false` 转义原文里的标签、`linkify` 认裸地址、`breaks` 让单个换行就是 `<br>`，链接统一新窗口 + 交系统浏览器打开） |
| 笔记编辑器 | Vditor（只服务笔记正文；静态资源随包带一份、不走 CDN，见[「笔记」](modules/notes.md)那一节） |
| 构建 | Vite 8（渲染层，打包器是 rolldown）+ cargo / Tauri CLI（后端）。根与 `apps/desktop` 的 `package.json` 都是 `"type": "module"`，所以各 vite / vitest 配置里用 `import.meta.dirname`（`__dirname` 只在旧的打包式加载器下被 shim 出来；仓库里也不要有 CJS 的 `.js` / `.cjs`，它们会被当成 ESM） |
| 语言 | TypeScript（渲染层）+ Rust（后端）；契约与纯逻辑按域拆在 `packages/` 的 19 个 `@workbench/*` 包 |
| 持久化 | 本地 JSON，由 Rust 侧 `store.rs` 负责（防抖 300ms、临时文件 + rename、退出前同步落盘） |
| 子进程 | `std::process` 起 shell 命令（按批回传输出，Windows 下 `taskkill /T /F` 结束整棵进程树） |
| 端口 → 进程 | `GetExtendedTcpTable`（iphlpapi，一次系统调用拿到监听表）+ `QueryFullProcessImageNameW`；不再起 `netstat` / `tasklist` 解析文本输出（全量检测会并发问十几个端口，原先每个端口两个子进程） |
| Coding 用量数据源 | ZCode：`rusqlite` 只读打开本地 sqlite（WAL 并发读），SQL 按天 × 项目 × 模型聚合；DeepSeek Harness：Rust 逐帧解压 `~/.dsh/sessions` 的多帧 zstd 会话；CodeBuddy：Rust 列扩展日志清单、渲染层读内容并解析；WorkBuddy：Rust 列会话正文清单、渲染层读内容并解析；Qoder：Rust 列 `~/.qoder-cn/projects` 的会话正文清单、渲染层读内容并解析（只取 `usage.credits`，它不报 token）。五者都只读，只取用量数字与会话的工作目录 |
| 多机同步 | 可选（默认关闭）：`std::process` 直启系统的 `git`（不经 `cmd`，参数行不会被二次解析），推 / 拉一个用户指定的仓库；`token-usage/<设备id>.json`、`config/<设备id>.json`、`gateway-usage/<设备id>/<YYYY-MM>.jsonl`、`etf/<设备id>.json` 与 `activity/<设备id>.json`，都按一台机器一份写。用量、外观、ETF 是三条互不相干的出口：用量（token 快照 + 网关流水）自动 + 手动，活跃度账本跟着自动那一轮走（首页取数时触发、一小时一轮），外观只在设置里点「同步一次」（采用别人的配置也只能手动），ETF 只由那一页自己进页面时拉、刷新完推。凭据默认走系统 git，登录过账号则改用该账号的 token（按 host 限定注入请求头，过期前自动续期） |
| 账号登录 | 可选：GitHub / Gitee 的授权码流程 + 本机回环回调（RFC 8252 那套，与 VS Code 同路）。HTTPS 走系统自带的 WinHTTP，access_token 与 refresh_token 存 Windows 凭据管理器（DPAPI）—— 两者都只给已有的 `windows-sys` 加 feature，**没有引入任何新的 crate**。两家都要求 clientId + clientSecret，凭据由 `build.rs` 编译期内置 |
| 依赖取舍 | 新增 crate 的标准是**「不新增编译单元」**而不是「不新增名字」：`url` / `percent-encoding` / `form_urlencoded` / `walkdir` / `base64` / `sha2` 都已被 tauri / tao / wry / tauri-utils 拉进编译图（`cargo tree -e normal -i <crate>` 可查），所以直接用它们替掉手写的 URL 编解码、目录递归与摘要实现，代价为零。反过来，`reqwest`（hyper + tower + TLS 整套）、`git2`（libgit2 的 C 依赖）、`sysinfo` 会新增成片的编译单元，一律不引 |
| 测试 | Vitest（渲染层与域包）+ `cargo test`（Rust） |
| 打包 | Tauri CLI → NSIS 安装包（Windows x64） |

**后端刻意做薄** —— 只提供「取原始数据 / 落盘 / 调系统能力」，合并、排序、修剪、状态机、命令构造这些业务语义都在渲染层适配层
（`apps/desktop/src/renderer/src/workbench/`）。绝大多数改动因此仍是 Vite 的秒级热更新，只有动系统能力才重编 Rust（实测增量
4~15 秒，见 [dev-notes](dev-notes/)）。适配层顶替的是 Electron 时代「preload + 主进程」那条**进程边界**，递给渲染层的列表一律
是快照（`structuredClone`）：渲染层的乐观追加不会与适配层刚改过的数据叠在一起，往自己列表里 push 也写不进要落盘的数据 ——
边界搬进同一个 JS 上下文后必须自己补，漏掉的表现是「添加一个程序先变成两个，刷新又合成一个」。

**IPC 命令默认跑在主线程上**：`#[tauri::command]` 不加参数时函数体会在主线程内联跑完，凡会起子进程、读写文件、解码图片、
跑 SQL 的命令都标 `(async)`（落 `async_runtime::spawn` 到工作线程），只有纯内存读写与窗口控制保持同步；漏标的后果不是「慢」
而是「界面卡死」（消息循环被堵住，渲染层的 `await` / `Promise.all` 挡不住）。启动路径踩过一次：包管理器探测加壁纸缩略图把
首屏冻了好几秒，现在都改成「挂载之后再拉」。

**工作区背景图与视频播放走 asset 协议，后端不碰它们的字节**：渲染层只调一次 `allow_background`（后端读文件头确认能解码，
1ms 量级），把**这一个文件**的读取权限授给 asset 协议，URL 由 `convertFileSrc` 转出交给 CSS，图片由 webview 自己读、自己缩放
—— 代价是全尺寸原图进 webview 内存（旧方案「解码 → 缩放 → 编 JPEG → base64」一张 3824×2400 实测 249ms，且每次启动重算）。
视频同一套思路（`allow_video`：核后缀与 MP4 文件头 `ftyp`，协议自带 Range，拖进度条不用整份下完）。AI 预览栏显示回答里提到的
图片也走 `allow_background`（同一条「验图 + 单文件授权」边界，见适配层 `allowPreviewImage`）。`assetProtocol.scope` 刻意留空
—— 授权一律运行时按文件给，**别为了省事写成 `**`**。

**重复的实现先收成一份再谈复用**：Rust 侧跨模块小工具（时间、截断、打码、历法换算、uid 白名单、密钥尾号）在
`src-tauri/src/common.rs`，「发请求 → 判 200 → 解 JSON」的信封解包在 `http::request_json(_with)`；渲染层的状态文案与 tone
映射在 `status.ts`（项目状态与两套网关的账号池各一组）、剪贴板在 `clipboard.ts`（文本统一经
`window.workbench.copyText` 写 Win32 的 `CF_UNICODETEXT`，不走 `navigator.clipboard`）、界面数字与时间的格式化在 `format.ts`
（token 千进制收短 / 千分位 / 带秒时间戳）、空态与失败态在 `EmptyState.vue`（`tone="error"`）。TBuddy 与 Qoder 两个网关页
的账号池逻辑层共用这些（余额快照另收在 `composables/use-credit-pool.ts`），业务定义照旧独立 —— 新写类似逻辑先看这里有没有，
别再各抄一份。

## 目录结构

见 [directory.md](directory.md)——monorepo 的树与逐项注解。

## 开发

```bash
pnpm install

pnpm run dev             # 启动开发态（Rust 后端 + 渲染层热更新）
pnpm run typecheck       # 根目录单一 TS 工程覆盖渲染层与全部域包
pnpm test                # Vitest 单元测试（根配置收 20 个项目，一条进程跑全量）
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml   # Rust 侧测试
pnpm run build:renderer  # 只编渲染层，产物落 apps/desktop/out/renderer
pnpm run preview:renderer # 只把渲染层跑在浏览器里，方便看布局（产物落 apps/desktop/.preview/）
```

环境前置：pnpm（版本钉在根 `package.json` 的 `packageManager`）+ Rust stable（`x86_64-pc-windows-msvc`）+ MSVC 生成工具 +
Windows SDK。不需要再为 native 模块准备编译环境 —— `better-sqlite3` / `node-gyp` 那套随 Electron 一起去掉了。用 Token 多机
同步还需系统里有 `git`（`git --version` 有输出即可）。**登录后不必再配 git 凭据**：同步用账号 token 推送，token 到期自动用
refresh_token 续一次（Gitee 只有一天，不续每天都会失败一回）。不登录也能同步、走系统 git 凭据，但首次同步私有仓库会直接
报错而不是弹输入框（子进程没有终端可问），得先在命令行对这个仓库 `git clone`（或 `git fetch`）一次把凭据存下来，或改用 SSH
地址。

## 打包

这里只说本机出包；打 tag → CI 校验 → 建 Release 的整套发版流程见 [dev-notes/releasing.md](dev-notes/releasing.md)，流水线
里的约定写在 [release.yml](../.github/workflows/release.yml) 头部注释里。

```bash
pnpm run icons        # 需要改图标时：重新生成 src-tauri/icon.ico（窗口与托盘共用）
pnpm run dist:dir     # 产出免安装目录（只编不打包，用于快速验证）
pnpm run dist         # 产出 NSIS 安装包
```

打包配置见 [`apps/desktop/src-tauri/tauri.conf.json`](../apps/desktop/src-tauri/tauri.conf.json)；NSIS 安装包落在
`apps/desktop/src-tauri/target/release/bundle/nsis/`。几点需要留意：

- 渲染层产物 `apps/desktop/out/renderer` 是在**编译期**被内嵌进可执行文件的，所以改了前端要先 `pnpm run build:renderer`
  （`pnpm run dist` 与 `pnpm run dev` 都会自动带上这一步）。
- 内置壁纸经 `bundle.resources` 映射到 `backgrounds/`，运行时 Rust 从 `resource_dir()` 读取（清单与缩略图用）；开发态
  `list_wallpapers` 回落到仓库里的 `apps/desktop/resources/backgrounds`，`tauri dev` 会把资源拷到
  `target/debug/backgrounds/`、实际优先命中那份。工作区背景图本身走 asset 协议按文件加载，不经过这条链。**壁纸按长边 2560 /
  JPEG q82 存**（7 张共 2.2MB，2026-10-22 重采样）：界面按 `cover` 铺、上面还压一层蒙版，再高的分辨率看不出来，而 JPEG 在
  安装包里压不动 —— **图多大，包就大多少**（原来是 4.2MB）。换图时照这个口径压，别再塞 4K 原图。
- 安装包里的大头与实测口径见 [ai.md](modules/ai.md) 的 Pi 瘦身一节：Pi 那棵树原来占 44%（压缩后 9.7MB）、壁纸占 17%
  （3.8MB），两处按上面的口径收完约省 8.5MB。
- release 档位是 thin LTO + 16 个 codegen 单元，链接器换成工具链自带的 `rust-lld`（配置在
  [`apps/desktop/.cargo/config.toml`](../apps/desktop/.cargo/config.toml)）。**打包前先停掉 `pnpm run dev`**：两者会抢
  `target/` 的构建锁并互相拖慢。取舍、实测数据与更多坑见 [`dev-notes/build-performance.md`](dev-notes/build-performance.md)。
- 可执行文件的版本资源：`CompanyName` 取 `bundle.publisher`，**没配时回退到 `identifier` 的第二段**
  （`com.muyian.workbench` → `muyian`）；`LegalCopyright` **只在配了 `bundle.copyright` 时才写**，不配就是空的
  （`tauri-build` 那句在 `if let Some` 里）。两个都显式配在 `tauri.conf.json` 里，不再依赖回退 —— 否则改了 identifier，
  `CompanyName` 会静默跟着变。**NSIS 安装包那颗 exe 没有 `CompanyName`**：Tauri 的 NSIS 模板只写 ProductName /
  FileDescription / LegalCopyright / FileVersion / ProductVersion。安装包在「应用和功能」里的发布者走 `${MANUFACTURER}`
  （同一个 publisher 值），不受此影响；要给安装包也补上得自备 `bundle.windows.nsis.template`，代价是那份模板要一直跟着
  Tauri 升级，暂时不做。仓库根是 MIT（`LICENSE`，2026 muyian）。

安装包为单用户、可选安装目录，卸载时保留 `workbench-data.json`，不会连带删掉项目列表。

## 数据与隐私

见 [privacy.md](privacy.md)——十四条联网出口、落盘与不同步的边界，**动联网代码前先读**。

## 本期不做

多项目批量串行构建、远程部署与 Docker、代码编辑器与 Git 图形化、macOS / Linux 适配、截图的云 OCR 取字（会多出一条联网出口）
与录屏 / GIF（与截图几乎是两套东西），交互式命令输入（伪终端）、多人协作与项目数据云同步（多机同步只做 Token 用量快照、那份
主题文件、网关请求流水、工作日志与笔记；项目列表、快捷启动、独立命令这些本机数据不跟着走，笔记本来就是用户自己目录里的文件，
见 [privacy.md](privacy.md)）。
