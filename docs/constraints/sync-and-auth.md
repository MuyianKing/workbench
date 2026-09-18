# 用量同步与账号登录（含外观配置同步）

从 [AGENTS.md](../../AGENTS.md) 第 5 节拆出的硬约束；为什么是 git、边界在哪、仓库里到底放了什么，见
[features-and-architecture.md](../features-and-architecture.md) 的「数据与隐私」一节。

关键落点：`src-tauri/src/sync.rs`（git 操作）、`oauth.rs` / `http.rs` / `credentials.rs`（登录与凭据）、
`src/shared/token-usage.ts`、`sync-config.ts`、`theme.ts`、`appearance.ts`（纯口径），
`src/renderer/src/workbench/` 下的 `index.ts` / `token.ts` / `auth.ts` / `state.ts`。

调用 git 的方式（直启 `git.exe`、不经 `cmd /C`、带 `GIT_TERMINAL_PROMPT=0` 与 `-c core.quotepath=false`）是全局规则，
见 [AGENTS.md](../../AGENTS.md) 第 1 节。两条都有非留不可的理由：`GIT_TERMINAL_PROMPT=0` 是因为子进程没有终端可问，
挂着只会等到超时；`core.quotepath=false` 是因为**git 默认把非 ASCII 路径转义成八进制**
（`周报.md` → `\345\221\250\346\212\245.md`），而冲突提示里报的就是文件名 —— 这个应用的笔记多半是中文名，
转义之后那句话直接没法看。它还是个**每台机器都可能不同**的 git 全局项，不能指望用户自己设过，
所以每次调用显式带上（`sync.rs` 的 `run()` 里一处拼好，别让调用方各带各的）。

## 开关与边界

- **没登录就没有同步**：适配层把同步仓库地址一律当空（[index.ts](../../src/renderer/src/workbench/index.ts) 的 `syncRepo()`），
  四条与用 / 拉相关的通道都经它取地址 —— 于是既推不上去，也读不到别人机器留在本地克隆里的分片，界面上的数字全部出自本机。设置里照此
  只在登录后显示同步那几项（已填的地址等设置保留，登录回来接着用）。别在 `token.ts` 或 Rust 侧另开一条绕开这个入口的路径。

## Token 用量快照

- 合并规则分两层，改数据模型时别混：**分片内取 max**（同一台机器重复实读要幂等，上游清理旧会话时历史不缩水）、**分片之间求和**
  （每台机器各自消耗，取 max 会把另一台整个丢掉）。
- 一台机器一份文件、文件名就是设备 id，设备 id 存在 `%APPDATA%/Workbench/device.json`，**不随数据目录迁移、也不进同步仓库**
  （两台机器撞 id 会互相覆盖文件，且没有任何报错）。
- 版本号**不能**按「版本不等就整份弃用」处理：v4 起文件里装着别的机器的历史，弃掉就再也读不回来（对端不开机就不会重写分片）。能接受
  哪些版本由 [token-usage.ts](../../src/shared/token-usage.ts) 的 `TOKEN_DATA_COMPATIBLE_VERSIONS` 显式列出，新增口径版本要手工往表里
  加，别写成 `version >= N`。

## 同步仓库布局

- 「一个功能一个目录、一台机器一个文件」：`token-usage/<设备id>.json` 是用量快照、`config/<设备id>.json` 是那份 `theme.json` 的整份
  副本（见 [sync-config.ts](../../src/shared/sync-config.ts)）。两个目录都必须保持**单写者**（只写自己那份、只读别人的）—— 这是
  「不需要人工合并」的全部依据；一次同步里这两个文件进**同一次提交**（`sync.rs` 的 `publish_at`），删掉配置同样是一次要提交的改动。
  **旧 `devices/` 目录不读**：升级后仓库里那些老文件就是读不到的，要手工删。
- 应用侧的克隆目录在 `%APPDATA%/Workbench/token-sync/`（与笔记图片那个 `image-sync` 分开两份），它是应用自己的缓存，可以整个删掉重来
  —— 与笔记同步相反，那边动的是用户自己的文件夹。

## 外观与首页布局（theme.json）

- 外观设置与首页布局都住在 [theme.json](../../src/shared/theme.ts) 里（哪些项算外观由
  [appearance.ts](../../src/shared/appearance.ts) 的白名单定义）。宿主读的时候把两份文件合成渲染层认的那份 `AppSettings`、写的时候按
  白名单分流（`splitSettingsPatch`），组件永远只看得到一份完整设置。三条不能破：
  1. **采用别人的配置只能由用户手动点**（它是「以谁的为准」而非可相加的数据，自动套用会在两台机器之间来回覆盖、永远收敛不了，自动同步
     只负责推上去）；
  2. **只带换台机器仍然成立的项**（快捷键、开机自启、数据目录、同步仓库地址一律不进 theme.json —— 把仓库地址带过去等于让另一台机器
     往一个它没填过的地址推东西）；
  3. **`updatedAt` 只在内容真的变过时才刷新**（`sameThemeContent`），它是「内容没变就不产生提交」的唯一依据，每轮都刷就会往仓库里堆
     一串只改了时间的提交。布局那一半是 `layoutSignature` 把栏与行压成一行字符串来比的：**给布局加字段（栏的属性、行的属性）要同时
     加进那个签名**，漏了就会出现「改是改了，同步那边当没变」——不报错、只是不推送，最难查的一种。
- **布局结构的版本号（`THEME_VERSION`）动一次，两台机器的配置就可能互相认不出**：`sanitizeThemeFile` 只认版本相同的那份，版本不同的
  一律当「那台机器没有可用配置」。这是有意的（老结构套到本机等于把用户的摆放清掉），所以改结构时**必须补迁移**（`migrateLegacyLayout`）
  并且照 v3 → v4 那个例子把「不重置」做实：能一字不差翻过来的就别让用户重摆一次。
- 挪动设置项的落点（比如把某一项从数据文件搬进 theme.json）时，读侧必须**兼容老数据**：`migrateAppearanceIntoTheme` 负责把还在旧
  settings 里的外观搬进主题，而且搬完**要立刻落盘主题文件** —— 数据文件下一次落盘就会把那些键摘掉，慢了半拍用户的主题色 / 背景就再也
  没处可搬。

## 账号与凭据

- **账号的 access_token 绝不进渲染层**：它在 Rust 侧从授权码换出来，直接写进 Windows 凭据管理器（`credentials.rs`），回给前端的只有
  昵称 / 头像 / 登录名。机密进凭据管理器，非机密（client_id、账号资料、开关）才进数据文件 —— `workbench-data.json` 是明文 JSON，还会
  跟着数据目录迁移被复制到网盘。
- 同步时把 token 交给 git 必须用 **host 限定**的配置键（`http.https://github.com/.extraheader`），经 `GIT_CONFIG_*` 环境变量注入
  （见 `oauth::git_envs`）。写成全局 `http.extraheader` 会把 token 发给**任何**远端；写成 `-c` 参数会让它出现在进程命令行里。这条注入
  只由设置里的 `useAccountForSync` 触发，**默认开但要能关** —— token 会过期，关掉才能退回系统 git 凭据。

## 登录流程

- 回环端口（`oauth.rs` 的 `REDIRECT_PORT`）必须与两家平台上注册的回调地址**逐字一致**，那里有一条测试钉住了这个串；Gitee 要求完全
  一致，所以不能改成随机端口。
- **两家的授权码流程都必须带 `client_secret`**（GitHub 支持 PKCE，但没有因此把它变成可选项）—— 别为了「少内嵌一个 secret」把它改成
  选填：那会让浏览器授权成功、换 token 却在 `incorrect_client_credentials` 上失败，表现成「点了登录没反应」，很难往配置上想。
- 回调等待是**轮询**而不是阻塞：`auth_login_poll` 每次非阻塞地收一次，没消息就回 `pending`，节奏由渲染层定
  （[workbench/auth.ts](../../src/renderer/src/workbench/auth.ts)）。别改成在命令里等几分钟 —— 那会占着工作线程，取消也没法立刻生效。
