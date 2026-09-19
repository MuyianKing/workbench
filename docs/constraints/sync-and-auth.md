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

## 用量快照

- 合并规则分两层，改数据模型时别混：**分片内取 max**（同一台机器重复实读要幂等，上游清理旧会话时历史不缩水）、**分片之间求和**
  （每台机器各自消耗，取 max 会把另一台整个丢掉）。
- 计数里 `credits` 与五类 token 是**两个口径**（`UsageAxis`，面板上二选一展示）：`credits` 单独一个字段、不参与 `totalTokens`，
  面板按口径筛工具与排序也都走 `axisTotal`。别把它并进 token 总量，也别在 `sanitizeCounters` 里对它取整 ——
  额度是小数记账（一条请求不到 1 个是常态），取整等于把这份数据抹平。
- 一台机器一份文件、文件名就是设备 id，设备 id 存在 `%APPDATA%/Workbench/data/device.json`，**不进同步仓库**
  （两台机器撞 id 会互相覆盖文件，且没有任何报错）。
- 版本号**不能**按「版本不等就整份弃用」处理：v4 起文件里装着别的机器的历史，弃掉就再也读不回来（对端不开机就不会重写分片）。能接受
  哪些版本由 [token-usage.ts](../../src/shared/token-usage.ts) 的 `TOKEN_DATA_COMPATIBLE_VERSIONS` 显式列出，新增口径版本要手工往表里
  加，别写成 `version >= N`。

## 同步仓库布局

- 「一个功能一个目录、一台机器一个文件」：`token-usage/<设备id>.json` 是用量快照、`config/<设备id>.json` 是那份 `theme.json` 的整份
  副本（见 [sync-config.ts](../../src/shared/sync-config.ts)）。两个目录都必须保持**单写者**（只写自己那份、只读别人的）—— 这是
  「不需要人工合并」的全部依据。
- **两个目录是两条互不相干的出口，别把它们合回一条**：用量那条（`token_sync_publish`，面板按钮与一小时一轮的自动同步）
  只 add / diff `token-usage/<自己>.json`，外观那条（`token_sync_config`，设置 → 外观 →「同步一次」）只 add / diff
  `config/<自己>.json`。`sync.rs` 的 `publish_at` 按传进来的两个 `Option` 决定这次碰哪几个文件，传 `None` 的那个**这次完全不碰**
  —— 两处都别再把 `config` 塞回 `token_sync_publish`：那正是「用量同步顺手把外观也推了」的来路。
- **外观没有自动同步这一档**：它的唯一入口是设置界面那颗「同步一次」（`syncThemeConfig`）。用量是只增的计数，重复推无害；
  外观是「以谁的为准」，自动推只会往仓库里堆没意义的提交，两台机器互相自动采用更是永远收敛不了。
- **旧 `devices/` 目录不读**：升级后仓库里那些老文件就是读不到的，要手工删。
- 应用侧的克隆目录在 `%APPDATA%/Workbench/token-sync/`（与笔记图片那个 `image-sync` 分开两份），它是应用自己的缓存，可以整个删掉重来
  —— 与笔记同步相反，那边动的是用户自己的文件夹。

## 外观与首页布局（theme.json）

- 外观设置与首页布局都住在 [theme.json](../../src/shared/theme.ts) 里（哪些项算外观由
  [appearance.ts](../../src/shared/appearance.ts) 的白名单定义）。宿主读的时候把两份文件合成渲染层认的那份 `AppSettings`、写的时候按
  白名单分流（`splitSettingsPatch`），组件永远只看得到一份完整设置。三条不能破：
  1. **采用别人的配置只能由用户手动点**（它是「以谁的为准」而非可相加的数据，自动套用会在两台机器之间来回覆盖、永远收敛不了；
     同理，**推上去也只有设置里那次手动同步**，用量那条自动同步不碰 `config/`）；
  2. **只带换台机器仍然成立的项**（快捷键、开机自启、同步仓库地址一律不进 theme.json —— 把仓库地址带过去等于让另一台机器
     往一个它没填过的地址推东西）；
  3. **`updatedAt` 只在内容真的变过时才刷新**（`sameThemeContent`），它是「内容没变就不产生提交」的唯一依据，每轮都刷就会往仓库里堆
     一串只改了时间的提交。布局那一半是 `layoutSignature` 把栏与行压成一行字符串来比的：**给布局加字段（栏的属性、行的属性）要同时
     加进那个签名**，漏了就会出现「改是改了，同步那边当没变」——不报错、只是不推送，最难查的一种。
- **布局结构的版本号（`THEME_VERSION`）动一次，老配置要能跟上**：`sanitizeThemeFile` 不按版本拦，
  版本不同的那份交给 `sanitizeTheme` 先走迁移（`migrateLegacyLayout`）、再走同一条收敛路径 ——
  所以改结构时**必须补迁移**（照 v3 → v4 那个例子把「不重置」做实：能一字不差翻过来的就别让用户重摆一次），
  迁移补上了，另一台机器的旧配置就照常可「应用」；没补迁移的版本差异会被收敛回默认布局。
- 挪动设置项的落点（比如把某一项从数据文件搬进 theme.json）时，读侧必须**兼容老数据**：`migrateAppearanceIntoTheme` 负责把还在旧
  settings 里的外观搬进主题，而且搬完**要立刻落盘主题文件** —— 数据文件下一次落盘就会把那些键摘掉，慢了半拍用户的主题色 / 背景就再也
  没处可搬。

## 账号与凭据

- **账号的 access_token 绝不进渲染层**：它在 Rust 侧从授权码换出来，直接写进 Windows 凭据管理器（`credentials.rs`），回给前端的只有
  昵称 / 头像 / 登录名。机密进凭据管理器，非机密（client_id、账号资料、开关）才进数据文件 —— `workbench-data.json` 是明文 JSON。
- **凭据管理器里存的是一组机密，不是一个 token**：`TokenSet`（access_token + refresh_token + 到期时刻）序列化成 JSON，
  存在 `Workbench/<平台>/token` 这一条普通凭据里。**必须一起存** —— access_token 会过期（Gitee 官方写明一天），手里没有
  refresh_token 就没法在过期那天自己缓过来；老版本存的是裸 token，读的时候按「有 token、但不知道有效期」兼容（那种凭据过期后
  只能靠重新登录，提示里会说清）。
- 同步时把 token 交给 git 必须用 **host 限定**的配置键（`http.https://github.com/.extraheader`），经 `GIT_CONFIG_*` 环境变量注入
  （见 `oauth::git_credentials`）。写成全局 `http.extraheader` 会把 token 发给**任何**远端；写成 `-c` 参数会让它出现在进程命令行里。
- 注入**没有开关**，但有两道闸：**到期（含 60 秒余量）的先续期**（`renew` 走换 token 那个端点；回包里新的 refresh_token
  必须落盘 —— Gitee 是轮换的，旧的那张随即作废）；**过期又续不上的那一支不注入**，退回系统 git 凭据那条路。
  后者不是洁癖：Gitee 对过期的 token 回的是 403 而不是 401，git 因此不会去问系统凭据，一支坏 token 会把本来能成的同步
  （公开仓库、或系统里本来就配好了凭据）一起拖死。所以「没登录才不注入」不够，得是**用不了就不注入** ——
  系统凭据那条退路必须一直是通的。
- 认证失败要自己解释账号这件事：`sync.rs` 的 `describe` 只在「本次确实注入了账号凭据 + git 的话看着像认证被拒」
  （`looks_like_auth_failure`）时补一句「去设置 → 账号里重新登录」。别指望用户从一句 HTTP 403 想到账号上；
  反过来，走系统凭据的那次失败不该被这句话甩锅给账号。

## 技能（skill）

- 技能库是**笔记仓库的一个子目录**（设置里的 `skillSyncDir`，进外观白名单跟着配置同步 ——
  两台机器必须落在同一层才互相看得见对方的技能，见 [shared/skills.ts](../../src/shared/skills.ts) 的文件头）。
  增删改只在本机提交（`skills.rs` 的 `commit`），推到远端**只走笔记同步那颗按钮** ——
  技能不是新的网络出口：不设凭据（不走 `set_git_auth`）、没有克隆目录，git 调用全是本地操作。
  别给 skills.rs 加推送之类会出网的步骤；要出网就并进 `sync_notes` 的流程。
- 技能的「版本」就是笔记仓库的提交历史（每次改动由适配层提交一次，信息 `skill: <id> 动作`）；
  恢复是「`git rm` 已跟踪内容 → 检出旧版 → 再提交」，不是裸 `checkout <hash> -- <目录>`
  （那只盖回旧版文件，后来新增的会残留）。笔记本还不是仓库时这些动作如实返回「没有版本」，
  **不算错误** —— 技能的增删改不依赖仓库存在。
- **取某个版本的文件内容（`skills.rs` 的 `version_compare` / `read_commit_files`）有两条不能改的口径**，
  它们坏掉时界面不报错、只是显示一条并不存在的差异，而「恢复」按钮就摆在那张表下面：
  1. **内容按原始字节收**，绝不能走 `sync::run_git` —— 它把 stdout 收尾 trim 掉，文件末尾那个换行一没，
     内容一模一样的两版就会比出差异来（所以另开了 `git_stdout`，直接走 `proc::run_direct`）；
  2. **清单用 `git ls-tree -r -l -z`**：不加 `-z`，git 会把非 ASCII 路径转义成八进制（中文名的附属文件变乱码），
     带换行的路径还会把一条记录劈成两行。`-l` 报出的字节数顺带当了二进制的判据
     （拿回来的字节数对不上 = 读成字符串时中断在非法 UTF-8 上；再加「内容里有 NUL」一条）。
- 对比两侧的**方向与并集**是 [shared/skills.ts](../../src/shared/skills.ts) 里 `mergeVersionCopies` 的契约：
  `base` 永远是库里现在这份（会被换掉）、`incoming` 永远是要采纳的那份，清单取两侧**并集**
  （那一版里有、现在删掉的同样是差异，恢复会把它们带回来）。反了或漏了都不报错，只是红绿两栏的
  含义整个变样 —— 那里有单测钉着，改口径先改测试。

## 登录流程

- 回环端口（`oauth.rs` 的 `REDIRECT_PORT`）必须与两家平台上注册的回调地址**逐字一致**，那里有一条测试钉住了这个串；Gitee 要求完全
  一致，所以不能改成随机端口。
- **两家的授权码流程都必须带 `client_secret`**（GitHub 支持 PKCE，但没有因此把它变成可选项）—— 别为了「少内嵌一个 secret」把它改成
  选填：那会让浏览器授权成功、换 token 却在 `incorrect_client_credentials` 上失败，表现成「点了登录没反应」，很难往配置上想。
- 回调等待是**轮询**而不是阻塞：`auth_login_poll` 每次非阻塞地收一次，没消息就回 `pending`，节奏由渲染层定
  （[workbench/auth.ts](../../src/renderer/src/workbench/auth.ts)）。别改成在命令里等几分钟 —— 那会占着工作线程，取消也没法立刻生效。
