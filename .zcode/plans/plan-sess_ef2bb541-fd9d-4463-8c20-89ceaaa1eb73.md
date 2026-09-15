## 目标

给 Workbench 加「用 GitHub / Gitee 账号登录」，体验对齐 VS Code：**使用者只需要有账号，点一下就登录，不需要配置任何东西**。登录拿到的 access_token 用来**授权 Token 多机同步的私有仓库**，省掉现在必须先在命令行给 git 配凭据这一步。未登录时一切照旧。

## 两家的流程：统一走授权码 + 本机回环回调

你已把 GitHub 的回调地址注册成 `http://127.0.0.1:45871/callback`，与代码里的常量逐字一致。两家因此收敛成**同一套实现**：

| | GitHub | Gitee |
|---|---|---|
| 回调地址 | `http://127.0.0.1:45871/callback` | 同上，逐字一致 |
| client_secret | 配置里有就带、没有就不带（先试 PKCE 不带） | **必须带** |
| 用户看到 | 打开浏览器 → 点 Authorize → 浏览器跳回本机 → 应用自动登录 | 同左 |

一个监听器、一份 `state` 校验、一个 `start → poll → cancel` 形状，两家只有授权 URL 与 token 端点不同。**不再需要设备码流程**，因此 GitHub 那边不用勾 "Enable Device Flow"。

## 凭据内置（这是「零配置」的实现方式）

VS Code 不需要你配置，是因为微软注册了 OAuth 应用并把凭据内置进了安装包。Workbench 照做，所以**你一次性注册这两个应用**，之后所有使用者（包括你换机器）都零配置。

凭据不能进 git（你 AGENTS.md 明令禁止提交密钥），所以这样落：

- `src-tauri/oauth.local.json` —— 你的真实凭据，**加进 `.gitignore`，不入库**
- `src-tauri/oauth.example.json` —— 入库的模板，值留空
- `build.rs`（现在是三行空壳）加几行：哪个文件存在就拷成 `$OUT_DIR/oauth.json`，并加 `cargo:rerun-if-changed`
- `auth.rs` 用 `include_str!(concat!(env!("OUT_DIR"), "/oauth.json"))` 读进来
- **没配凭据时应用照样能编译**，登录按钮显示「此构建未内置 OAuth 凭据」而不是崩掉——仓库永远干净可构建

## 阶段零：你需要做的一次性注册

**GitHub**（你已完成大半）→ [github.com/settings/developers](https://github.com/settings/developers) → OAuth Apps
- Authorization callback URL：`http://127.0.0.1:45871/callback` ✅ 已填
- **取消勾选 "Expire user access tokens"** ← 默认是勾的，勾着则 token 8 小时过期，症状是「今天配好明天全挂」，极难排查。**请确认这一项**
- 记下 Client ID；再点 "Generate a new client secret" 存一份备用（只显示一次）
- "Enable Device Flow" 不用勾

**Gitee** → [gitee.com/oauth/applications](https://gitee.com/oauth/applications) → 创建应用
- 回调地址填 `http://127.0.0.1:45871/callback`（与 GitHub 同一个地址）
- **权限范围至少勾 `user_info` + `projects`** ← Gitee 的权限是注册时预先勾死的（不像 GitHub 运行时请求），漏勾 `projects` 会让同步私有仓库 403
- 记下 client_id 与 client_secret

把这几个值填进 `oauth.local.json` 即可，我来准备模板。

## 已核实的事实

| 事实 | 来源 | 影响 |
|---|---|---|
| GitHub 的 OAuth App 注册表单里 callback URL 必填（最多 10 个），且含默认开启的 "Expire user access tokens" | GitHub 官方文档 + 你的实操确认 | 回调方案可行；那个陷阱要人工处理 |
| GitHub 授权码流程中 `client_secret` 标为 Required，同时支持 PKCE（只接受 `S256`） | GitHub 文档 | 故把 secret 做成可选字段 |
| GitHub 对回环回调豁免端口匹配，建议写 `127.0.0.1` 而非 `localhost` | 同上 | 备用依据（我们已用完全一致地址，不依赖它） |
| `reqwest` 只在 `Cargo.lock` 里、**未编译**（797 个 rlib 中无 reqwest/hyper/rustls） | 本机实测 | 走 WinHTTP 才能真正零新增 crate |
| `windows-sys` 已是直接依赖，且已有 Win32 直调风格（`icon.rs` 的 GDI、`proc.rs` 的 GetProcessTimes） | 代码库 | 各加一个 feature 即可 |
| `opener:default` 已放行任意 `http(s)://` URL | `capabilities/default.json` | 开浏览器不用改能力文件 |
| `build.rs` 只有 `tauri_build::build()` 三行 | 代码库 | 加凭据注入很干净 |

⚠️ **Gitee 的端点、参数、scope 名称未能核实**：`gitee.com/api/v5/oauth_doc` 是前端渲染空壳，`help/articles/4181` 与 `/4191` 都 302 到 help.gitee.com 首页，整站抓不到正文。这部分凭既有知识写，实现时用真实应用实测校正，预留返工时间。

## 关键设计决策

**1. token 绝不进入渲染层。** Rust 拿到 token 直接写 Windows 凭据管理器（`CredWriteW`，DPAPI 加密），只把「登录名/昵称/头像」返回前端。同步时由 Rust 自己取用。凭据管理器只存 access_token——client_secret 是构建期常量，不需要另存。

**2. 注入 git 的 header 必须按 host 限定。** 用 `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`，经 `proc::run_direct` 已有的 `envs` 参数传入。写成全局 `http.extraheader` 会让 git 把 token 发给**任何**远程地址。token 不进命令行、不落 `.git/config`。

**3. 回环服务器用 `std::net::TcpListener`，零依赖。** 只接受一次连接、解析 `GET /callback?code=...&state=...`、校验 `state` 防 CSRF、回一个「可以关掉这个页面了」的 HTML、关闭。整体超时 5 分钟。**端口被占用时明确报错**，不静默降级。

**4. 留一条手动兜底。** 回调没回来时（端口占用、浏览器没跳回），允许把浏览器地址栏的完整回调 URL 粘进对话框，应用自己解析 code——VS Code 也留了同类兜底，成本约 20 行。

**5. token 失效可诊断。** 同步遇 401/403 时明确提示「登录已失效，请重新登录」，不让 git 原始报错糊过去。

## 实施步骤

**阶段一 — Rust 基础设施（新增 3 个模块，只加 windows-sys 两个 feature，不新增 crate）**
- `src-tauri/src/http.rs`：WinHTTP 极简客户端。`WinHttpOpen`(自动代理) → `Connect`(443) → `OpenRequest`(`WINHTTP_FLAG_SECURE`) → `SetTimeouts` → 加 header → `SendRequest`/`ReceiveResponse` → 读状态码 → `WinHttpReadData` 循环。
- `src-tauri/src/credentials.rs`：`CredWriteW` / `CredReadW` / `CredDeleteW`，`CRED_TYPE_GENERIC`，目标名 `Workbench/<provider>/token`。
- `src-tauri/src/oauth.rs`：内置凭据加载（`include_str!` + 缺失时降级）、两家授权 URL 构造、回环监听、token 交换、头像转 data URL（复用 `encoding::base64`，网络出口全留在 Rust 侧可审计）。
- 改 `build.rs`、`Cargo.toml`（两个 feature）、`.gitignore`（`src-tauri/oauth.local.json`）、新增 `oauth.example.json`。

**阶段二 — 登录主流程**
- 起流程：固定端口监听 → 拼授权 URL（带 `state`；GitHub 另带 PKCE 的 `code_challenge`/`S256`）→ 交给已有命令 `open_external` 开浏览器。
- 回调到达 → 校验 `state` → 换 token（GitHub `POST github.com/login/oauth/access_token`；Gitee `POST gitee.com/oauth/token`，参数按实测校正；两家都在配置有 secret 时才带 `client_secret`）→ 存凭据管理器 → 拉资料（GitHub `GET api.github.com/user`，**必须带 `User-Agent`** 否则 403；Gitee `GET gitee.com/api/v5/user`）。
- GitHub scope 取 `read:user repo`，`repo` 是为了推私有仓库，授权页需说明理由。

**阶段三 — 接到 Token 同步**
- `sync.rs` 的 `run_git`/`run` 增加可选凭据参数，按 `tokenSyncRepo` 的 host 匹配 provider 后注入 host 限定的 extraheader（两家 Basic 值格式不同，以实测为准）。
- 设置里给开关（默认开），关掉就继续用系统 git 凭据，避免 token 失效时把原本能用的路径一起带坏。

**阶段四 — 渲染层**
- `src/shared/auth.ts`：provider 定义、授权 URL 构造、回调 URL 解析等纯逻辑 + `auth.test.ts`。
- `src/shared/types.ts`：`AuthProvider` / `AccountProfile` / 新 settings 键（`useAccountForSync`）/ `PersistedData.account`；同步改 `persisted-data.ts` 的 `sanitizeSettings` / `parseData` / `emptyData`。
- `src/renderer/src/workbench/auth.ts`：适配层（起流程、轮询、取消、手动粘贴兜底），按既有模式接进 `index.ts` 的 `createApi`。
- `AppHeader.vue`：设置齿轮左侧加头像/登录入口（现在只有 3 个图标按钮，`actions` 区正好）。
- 新增 `AccountDialog.vue`：未登录显示两家登录按钮；等待中显示「已打开浏览器，等待授权…」+ 取消 + 手动粘贴回调地址的折叠入口；已登录显示头像/昵称/来源 + 退出登录。
- `SettingsDialog.vue`：「通用」页末尾加一个「账号」区块——登录状态、退出、`useAccountForSync` 开关。**没有凭据表单**（凭据是内置的）。沿用既有 `.block` / `.row` 结构。

**新增 IPC 通道（6 个，均 `#[tauri::command(async)]`）**

`auth_status` / `auth_refresh_account` / `auth_login_start` / `auth_login_poll` / `auth_login_cancel` / `auth_logout`

**阶段五 — 文档与验证**
- README：功能表、架构表、「数据与隐私」整节（现在写的「除 Token 用量同步外不联网」必须重写，并新增凭据管理器这一处落盘说明）、开发前置加阶段零那份注册清单（**给开发者/你自己看，不是给使用者的**）。
- AGENTS.md：第 1 节联网边界（你已口头解除，落到文件）、第 2 节新增模块落位、第 5 节写明「token 不进渲染层」与内置凭据的存放约定。
- 验证：`npm run typecheck`、`npm test`、`cargo test`、`cargo build`；界面用 `.preview/` 跑浏览器预览比对，**收尾删掉整个 `.preview/`**；改 Rust 前先关掉正在运行的应用。

## 需要你知道的取舍

- **Gitee 端点是唯一没查实的部分**，实现时对着真实文档校正。
- **Gitee 的 client_secret 会随安装包分发**，理论上可被逆出来；影响面被「回调地址必须是 127.0.0.1:45871」限死。GitHub 侧能不能不内嵌 secret，取决于 PKCE 实验的结果——能的话就完全不内嵌。
- `oauth.local.json` 一旦入库就等于公开凭据，靠 `.gitignore` 兜住，我会在提交前检查一遍。
- 固定端口 45871 被占用时登录会失败，给明确报错 + 手动粘贴兜底。
- 头像由 Rust 拉取转 data URL（而非让渲染层直接 `<img src>` 外网地址），多一次请求，换来网络出口全部集中在 Rust 侧。
