# 禅道

禅道是一扇**独立窗口**：点顶栏那一行里那颗禅道图标（或点系统通知）打开（或聚焦）它，窗口里直接是禅道站点，
用内嵌的账号密码自动登录一次。窗口用系统标题栏 —— 右上角正好是关闭 / 最大化 / 最小化三个按钮。
应用里**没有**禅道页签、没有列表、也没有「点标题走浏览器」：详情、指派与解决都在那扇窗里的禅道界面上做。

**后台检查与系统通知照旧** —— 到点取一轮「指派给我的」编号全集，比出新增就弹 Windows toast，
点通知打开这扇窗。跨模块的导航、主题与联网边界见 [功能与架构](../features-and-architecture.md)，
通道规则见 [ipc-and-state.md](ipc-and-state.md)。

## 约束

- 凭据由 `oauth.local.json` 的 `zentao` 节构建期注入（部署根 + 账号 + 密码）；配置缺失时窗口打不开，
  界面弹一句提示（`ElMessage`）。账号密码仅由 Rust 读取，不进渲染层。
- **窗口里是远程站点，不做 iframe、也不嵌进主窗口**：禅道对每个响应都发 `X-Frame-Options: SAMEORIGIN`，
  跨源 iframe 会被浏览器直接拒绝渲染（本部署实测）。独立窗口是顶层文档，不受这条限制。
  同样的理由，窗口里的按钮**只能**用系统标题栏：自绘按钮要盖在远程页面之上，而原生画面与 HTML 是两层。
- **窗口 label `zentao` 不登记任何 capability**：远程来源是独立执行上下文，本地 capability 不授予它 IPC
  （tauri 的 `remote_context_denied`），所以公司页面里的脚本够不到任何宿主命令。这是这扇窗的安全前提，
  别为了「顺手」给它开权限。
- **应用自己发出的请求只读**（唯一一发 POST 是登录换 token），不提供任何写通道；写操作只发生在窗口里那套禅道自己的界面上。
  别为了「顺便能改状态」再往 Rust 里加写接口。
- 应用发出的请求固定在配置的部署根与固定端点，不跟 HTTP 重定向；**不提供任意 URL / 方法 / 请求头通道**。
- API 会话的 token 仅在 Rust 内存中保管，不回渲染层、不写数据文件、日志或凭据管理器；重启清除。
  个人密码会内嵌到二进制，**不分发带密码的构建**；部署是明文 HTTP，凭据与页面内容都过公网。
- **自动登录一轮只试一次**：只在登录页触发，失败就留在登录页让用户手登 —— 禅道对登录失败有计数与冷却，
  脚本化重试会把账号临时锁住。进到站内页后复位，下次过期还能再来一次。
- **后台检查默认 30 分钟**（设置「通用」里的检查间隔可改，0 = 关闭，范围 1..1440）：间隔由 Rust 计时线程
  计时并到点发 `zentao:check`，取数、比新增与弹通知全在渲染层。**计时必须在 Rust**：窗口收进托盘后
  WebView 定时器会被节流。只有配置完整、周期非 0 才发检查事件，线程自己不做网络、不持锁 emit。
- **只有后台检查发现新增才弹通知**：第一轮成功只建立基线；失败不推进基线；按**编号全集**比对
  （旧 Bug 重新指派给我也算新增；类比「指派给我的」这个口径固定）。点通知打开禅道窗口，不唤主窗口。
- 窗口里的站外链接与 `target=_blank` 交给系统浏览器；`about:` / `data:` / `blob:`（打印与下载会用）放行。
- 外部字符串（Bug 标题等）只作纯文本用，绝不 `v-html`。

## 实现

### 窗口

`AppHeader.vue` 那一排里的禅道图标（收起 / 展开菜单那颗的右边）是它唯一的入口：`stores/zentao.ts` 的 `open()` → 适配层
`workbench/zentao.ts` 的 `openWindow()` → 命令 `zentao_open_window` → `zentao.rs` 的 `open_window`。
窗口已经开着就只是 show / unminimize / set_focus（**不**顺手再最大化一次：那是用户自己还原的大小）。

窗口以**最大化**打开、铺满整屏 —— 禅道是拿去干活的工作台，不该先给一扇小窗；**不用 fullscreen**：
fullscreen 连系统标题栏一起吃掉，而这扇窗只能靠系统标题栏（见上面「约束」）。系统标题栏那三个按钮
照旧能把它还原（还原尺寸是 1280×900）。

`open_window` 建窗时挂三样东西（都在 `zentao.rs`）：

- `on_page_load`：页面加载完成时判断这是不是登录页（见下面「免登录」）；
- `on_navigation`：站内放行，其余 http(s) 交给系统浏览器并取消导航，`about/data/blob` 放行；
- `on_new_window`：不在应用里开新窗口，能交出去的就交给浏览器。

窗口先以 `visible(false)` 建出来，进到站内或有兜底时限时再显示（见下）。建窗口不能在同步命令里跑，
所以命令是 `#[tauri::command(async)]`；通知点击那一路跑在 COM 回调线程上，改成丢独立线程再建。

### 免登录

窗口打开时若本机没有禅道登录态，站点会跳到登录页（`user-login.html` 或 `user-login-<base64>.html`）。
`on_page_load(Finished)` 认出这类地址后，`WebviewWindow::eval()` 注入一小段脚本：

1. 把内嵌配置里的账号与密码写进 `#account` / `#password`；
2. 调用**页面自己的** `window.safeSubmit(...)` —— 取随机数、按禅道的方案算密码、带 `verifyRand` 提交，
   全走禅道现成的登录逻辑（**不自己复刻那套 md5 + rand**：它随版本变，复刻迟早分叉）。

窗口先藏着（登录页那一帧不该闪给用户看），进到站内再显示；一直进不去（密码错 / 账号被锁）时由兜底
线程在 6 秒后把登录页亮出来，用户能看见发生了什么并手动登录。自动登录一轮只试一次，进到站内页后复位。

> **为什么不是「把 token 当 cookie 注入」**：本部署实测，`POST /api.php/v1/tokens` 返回的 token 就是 PHP 的
> session id（`Set-Cookie: zentaosid` 与 token 同值），而且登录确实写在同一个会话里 —— 但拿这枚 token
> 无论以 `Token` 头还是以 `zentaosid` cookie 去请求 HTML 页面，都仍然 302 到登录页。网页层的登录态
> 不只看 session id。所以走的是真实表单登录这条路。

### 会话与传输

`zentao_login` 无凭据入参，由 Rust 读取内嵌配置；token 留在 Tauri managed state，仅返回非机密的本机会话标识、
部署根与账号。`zentao_session` 只读本机状态；`zentao_logout` 只清本机 token，不变更服务器数据。
`zentao_page` / `zentao_products` 要求匹配当前会话标识，后端构造固定 GET 请求并做字段白名单投影；
**这一组全是读**。

后台检查用的 API 会话与窗口里的浏览器会话是**两份**（前者给列表与通知，后者是禅道自己的浏览器会话）。
Rust 侧的会话可能被窗口里的自动登录换掉，所以渲染层取数失败时会重读一次本机会话，id 变了就用新的再试一次。

HTTP 复用系统 WinHTTP，不增加 Rust 编译单元，也不放宽 WebView CSP（窗口里是远程文档，走它自己的响应头）。
禅道请求显式关闭重定向，认证失败不回传上游响应正文；`401` 只清理对应会话。

### 后台检查与通知

`zentao_watch(poll_minutes)` 登记周期（0 = 关闭，1..1440 收敛）：**间隔没变时后端不动计时**；
关闭后再启用、或启用时立刻来一轮（给渲染层一次立基线的机会），改间隔则从现在重新计时。
`zentao.rs` 的计时线程每 60 秒醒一次，到点给主窗口发 `zentao:check`（不持锁 emit、不做网络）。

渲染层收到 `zentao:check` 后取一轮完整列表：与 `baselineIds`（编号全集）比出新增（`diffZentaoBugs`），
有新增才调 `zentao_notify(session_id, count, title)`。通知的点击回调在 Rust 侧直接打开禅道窗口
（不再发事件让渲染层换页）。通知发失败留在待发队列里，下一轮重试；失败原因写在 store 的 `error` 里。

一次取数的顺序：**产品清单**（账号资料里的可见范围）→ 逐产品读该口径的 Bug 分页 → 汇总去重按编号降序。
产品名不再补取（界面上不显示它了）。

### 22.2 API 契约

核对依据为官方固定标签 `zentaopms_22.2_20260527`：

- 登录：`POST <部署根>/api.php/v1/tokens`，JSON `{account,password}`；成功返回 `201 {token}`。
- 认证：`Token: <token>`，不使用 Bearer 或新版 `ss_` 前缀。
- 产品：`GET <部署根>/api.php/v1/products?status=all&page=1&limit=100`。
- Bug：`GET <部署根>/api.php/v1/products/{非零产品ID}/bugs?status=assigntome&order=id_desc&page=1&limit=100`。
- 分页响应包含 `page,total,limit,products` 或 `page,total,limit,bugs`，根据 `total` 取完整分页。
- 其它用到的入口只剩一个：`GET /user`（账号资料里的可见产品）。**v1 无 PATCH**。
- **本版不用** `GET /bugs/{id}`（详情与历史）、`GET /users`、`GET /builds`、`GET /products/{id}`
  与两个写入口（`POST /bugs/{id}/assign`、`POST /bugs/{id}/resolve`）：详情与改动都在窗口里做。
- 网页登录（自动登录脚本走的那条路）：`GET /user-refreshRandom.html` 取随机数，
  `POST /user-login.html`（`account` / `password` / `passwordStrength` / `referer` / `verifyRand` / `keepLogin` / `captcha`），
  由页面自己的 `safeSubmit` 组装。

官方来源：[登录](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/tokens.php)、
[产品](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/products.php)、
[Bug 列表](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/bugs.php)、
[路由表](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/config/apiv1.php)。

### 产品清单与用户字段（本部署实测的两个坑）

- **产品清单不用 `GET /v1/products`**：那条走 `product/all`，在把产品挂在项目集 / 项目下的部署里
  **返回空数组**（本部署实测 total=0）。改为读 `GET /v1/user` 的账号资料 `profile.view.products`
  （逗号分隔的产品 id，即账号可见范围）；万一为空或写成 `all` 这类非数字，再退回 `/v1/products` 枚举。
- **`assignedTo` 等用户字段在 v1 里是对象**（`format($bug, 'assignedTo:user')` 的结果），
  后端投影时压成一句可显示文本（真实姓名优先、退回账号），域包解析时 `userText` 再兜一道。

## 涉及文件（窗口与状态）

- [入口图标](../../apps/desktop/src/renderer/src/components/AppHeader.vue)（收起 / 展开菜单那颗的右边）。
- [状态](../../apps/desktop/src/renderer/src/stores/zentao.ts)、[适配层](../../apps/desktop/src/renderer/src/workbench/zentao.ts)。
- [域包](../../packages/zentao/src/zentao.ts)：类型、分页聚合、新增判定、周期收敛。
- [Rust](../../apps/desktop/src-tauri/src/zentao.rs)、[命令层](../../apps/desktop/src-tauri/src/commands.rs)、[主窗口](../../apps/desktop/src-tauri/src/main.rs)。
- [凭据读取](../../apps/desktop/src-tauri/src/oauth.rs)、[空值模板](../../apps/desktop/src-tauri/oauth.example.json)。
- [设置](../../apps/desktop/src/renderer/src/components/settings/GeneralPane.vue)、[落盘收敛](../../apps/desktop/src/renderer/src/persisted-data.ts)。
- [页面挂载](../../apps/desktop/src/renderer/src/App.vue)（只挂 `startWatch()`，没有禅道页签）。

`oauth.local.json` 顶层新增（与 `github`、`gitee` 并列）：

```json
"zentao": {
  "baseUrl": "http://115.159.41.157:81/zentao/",
  "account": "",
  "password": ""
}
```

填写真实账号密码后重新构建。沿用 `build.rs` 整份复制、Rust `include_str!` 的流程，
运行中的程序不读取磁盘上该文件的新内容；配置及二进制都含明文个人凭据，不是加密保存。
该文件已忽略，不能提交；模板 `oauth.example.json` 保持空值。密码保留原值，不做 trim。
地址由现有后端校验，也接受该部署的 `my-work*.html` 页面地址并收敛到根目录。

## 已知代价与边界

- 窗口用系统标题栏（那三个按钮是系统画的），窗口里的观感与明暗主题都归禅道自己 —— 它不跟随应用的皮肤。
- 首次打开会晚一两秒才出现（窗口先藏着，进到站内才显示，免得把登录页闪给用户看）；
  密码错 / 账号被锁时是 6 秒后停在登录页让你手登。
- 站外链接与 `target=_blank` 交给系统浏览器 —— 浏览器那边没有禅道登录态，打开是未登录的页面。
- 部署是明文 HTTP：凭据、会话与页面内容都过公网。

## 验证与边界

纯逻辑测试覆盖多产品、多页汇总、分页异常、编号去重排序、新增比较（首轮静默 / 旧编号重新指派 /
失败不推进基线 / 编号去重）、周期收敛与到点判定、用户对象压成文本；store 测试覆盖首轮静默、
失败保留基线、通知失败重试不重复、关闭不发请求、并发单航班、换账号后基线重立、
会话被窗口的自动登录换掉后重读会话、打开窗口的成功与失败；适配层测试覆盖错误收敛、
单页请求参数、登录 / 会话契约与开窗命令；Rust 测试覆盖地址规范化、会话守卫、
只读端点构造（含 browse 白名单）、产品清单来自账号资料、用户对象压平与字段白名单投影，
以及窗口那几处纯逻辑（同源判定、登录页识别、脚本字面量转义）。

**已在本部署上实测过的**：`user.view.products` 拿到 16 个可见产品 id；`tokens` 返回的 token 就是
session id（响应里的 `zentaosid` 与 token 同值），但**用它请求 HTML 页面仍被 302 到登录页**；
登录页里填表并调用 `window.safeSubmit` **可以完成登录**（跳到 `my.html`）。

真实部署的权限、定制补丁与系统通知落地都只在凭据配置完整后才谈得上验证；没有真实结果时不宣称联调通过。
**真机排查要一次登录、复用同一会话**：禅道对登录失败有计数与冷却，反复试探会把账号临时锁住
（见 AGENTS.md 第 6 节）。
