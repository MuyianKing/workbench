# 禅道

禅道**不在应用里打开**：点顶栏那一行里的禅道图标（或点系统通知），交给系统默认浏览器打开配置里的部署根。浏览器里是禅道
自己的完整站点，登录由用户自己在那里做一次。应用里**没有**禅道页签、没有列表、也不建独立窗口：详情、指派与解决都在浏览器里
的禅道界面上做。**后台检查与系统通知照旧** —— 到点取一轮「指派给我的」编号全集，比出新增就弹 Windows toast，点通知用浏览器
打开站点。跨模块的导航、主题与联网边界见 [功能与架构](../features-and-architecture.md)，通道规则见 [ipc-and-state.md](ipc-and-state.md)。

## 约束

- 凭据由 `oauth.local.json` 的 `zentao` 节构建期注入（部署根 + 账号 + 密码）；配置缺失时打开浏览器会失败，界面弹一句提示
  （`ElMessage`）。账号密码仅由 Rust 读取，不进渲染层，**也不带进浏览器**（只用于后台检查的 API 会话）。
- **不在应用里内嵌禅道页面**：服务端对每个响应都发 `X-Frame-Options: SAMEORIGIN`，跨源 iframe 会被直接拒绝渲染；独立窗口
  那套（远程 webview + 免登录脚本）已按需求拿掉，不要再加回来。站点交给系统浏览器，是顶层文档、也是用户自己的登录态。
- **不做自动登录**：外部浏览器没有可注入脚本的地方。浏览器里第一次打开要手登一次，勾「保持登录」后由禅道自己种 30 天
  cookie；**不要把账号密码拼进地址或查询串**。
- **应用自己发出的请求只读**（唯一一发 POST 是登录换 token），不提供任何写通道；写操作只发生在浏览器里那套禅道自己的界面上。
  别为了「顺便能改状态」再往 Rust 里加写接口。
- 应用发出的请求固定在配置的部署根与固定端点，不跟 HTTP 重定向；**不提供任意 URL / 方法 / 请求头通道**。
- API 会话的 token 仅在 Rust 内存中保管，不回渲染层、不写数据文件、日志或凭据管理器；重启清除。个人密码会内嵌到二进制，
  **不分发带密码的构建**；部署是明文 HTTP，凭据与页面内容都过公网。
- **后台检查默认 30 分钟**（设置「通用」里的检查间隔可改，0 = 关闭，范围 1..1440）：间隔由 Rust 计时线程计时并到点发
  `zentao:check`，取数、比新增与弹通知全在渲染层。**计时必须在 Rust**：窗口收进托盘后 WebView 定时器会被节流。只有配置完整、
  周期非 0 才发检查事件，线程自己不做网络、不持锁 emit。
- **只有后台检查发现新增才弹通知**：第一轮成功只建立基线；失败不推进基线；按**编号全集**比对（旧 Bug 重新指派给我也算新增；
  类比「指派给我的」这个口径固定）。点通知用浏览器打开站点，不唤主窗口。
- 外部字符串（Bug 标题等）只作纯文本用，绝不 `v-html`。

## 实现

### 打开站点

`AppHeader.vue` 那一排里的禅道图标（收起 / 展开菜单那颗的右边）是它唯一的入口：`stores/zentao.ts` 的 `open()` → 适配层
`workbench/zentao.ts` 的 `openSite()` → 命令 `zentao_open_site` → `zentao.rs` 的 `open_site()` → `system::open_external`。
地址取内嵌配置的部署根（`normalize_base_url` 也接受 `my-work*.html` 并收敛到根），**不带任何凭据**。每次点击都交给系统默认
浏览器（浏览器自己决定新开还是复用标签页），应用不跟踪那扇浏览器窗口。系统通知的点击回调在 Rust 侧走同一个 `open_site()`，
所以通知与顶栏图标的行为一致。

### 会话与传输

`zentao_login` 无凭据入参，由 Rust 读取内嵌配置；token 留在 Tauri managed state，仅返回非机密的本机会话标识、部署根与账号。
`zentao_session` 只读本机状态；`zentao_logout` 只清本机 token，不变更服务器数据。`zentao_page` / `zentao_products` 要求匹配
当前会话标识，后端构造固定 GET 请求并做字段白名单投影；**这一组全是读**。

后台检查用的 API 会话与浏览器里的登录态是**两份**（前者给列表与通知，后者是禅道自己的浏览器会话），互不需要对方。
`zentao_session` 读到的就是本应用登录出来的那一份：取数报认证过期时按 401 重登一次，不循环；会话换账号或换部署时基线重立。

HTTP 复用系统 WinHTTP，不增加 Rust 编译单元，也不放宽 WebView CSP。禅道请求显式关闭重定向，认证失败不回传上游响应正文；
`401` 只清理对应会话。

### 后台检查与通知

`zentao_watch(poll_minutes)` 登记周期（0 = 关闭，1..1440 收敛）：**间隔没变时后端不动计时**；关闭后再启用、或启用时立刻来
一轮（给渲染层一次立基线的机会），改间隔则从现在重新计时。`zentao.rs` 的计时线程每 60 秒醒一次，到点给主窗口发
`zentao:check`（不持锁 emit、不做网络）。

渲染层收到 `zentao:check` 后取一轮完整列表：与 `baselineIds`（编号全集）比出新增（`diffZentaoBugs`），有新增才调
`zentao_notify(session_id, count, title)`。通知点击回调在 Rust 侧用浏览器打开站点（不再发事件让渲染层换页，也不唤主窗口）。
通知发失败留在待发队列里，下一轮重试；失败原因写在 store 的 `error` 里。

一次取数的顺序：**产品清单**（账号资料里的可见范围）→ 逐产品读该口径的 Bug 分页 → 汇总去重按编号降序。产品名不再补取
（界面上不显示它了）。

### 22.2 API 契约

核对依据为官方固定标签 `zentaopms_22.2_20260527`：

- 登录：`POST <部署根>/api.php/v1/tokens`，JSON `{account,password}`；成功返回 `201 {token}`。
- 认证：`Token: <token>`，不使用 Bearer 或新版 `ss_` 前缀。
- 产品：`GET <部署根>/api.php/v1/products?status=all&page=1&limit=100`。
- Bug：`GET <部署根>/api.php/v1/products/{非零产品ID}/bugs?status=assigntome&order=id_desc&page=1&limit=100`。
- 分页响应包含 `page,total,limit,products` 或 `page,total,limit,bugs`，根据 `total` 取完整分页。
- 其它用到的入口只剩一个：`GET /user`（账号资料里的可见产品）。**v1 无 PATCH**。
- **本版不用** `GET /bugs/{id}`（详情与历史）、`GET /users`、`GET /builds`、`GET /products/{id}` 与两个写入口
  （`POST /bugs/{id}/assign`、`POST /bugs/{id}/resolve`）：详情与改动都在浏览器里的禅道上做。

官方来源：[登录](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/tokens.php)、
[产品](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/products.php)、
[Bug 列表](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/bugs.php)、
[路由表](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/config/apiv1.php)。

### 产品清单与用户字段（本部署实测的两个坑）

- **产品清单不用 `GET /v1/products`**：那条走 `product/all`，在把产品挂在项目集 / 项目下的部署里**返回空数组**（本部署实测
  total=0）。改为读 `GET /v1/user` 的账号资料 `profile.view.products`（逗号分隔的产品 id，即账号可见范围）；万一为空或写成
  `all` 这类非数字，再退回 `/v1/products` 枚举。
- **`assignedTo` 等用户字段在 v1 里是对象**（`format($bug, 'assignedTo:user')` 的结果），后端投影时压成一句可显示文本
  （真实姓名优先、退回账号），域包解析时 `userText` 再兜一道。

## 涉及文件（入口与状态）

- [入口图标](../../apps/desktop/src/renderer/src/components/AppHeader.vue)（收起 / 展开菜单那颗的右边）。
- [状态](../../apps/desktop/src/renderer/src/stores/zentao.ts)、[适配层](../../apps/desktop/src/renderer/src/workbench/zentao.ts)。
- [域包](../../packages/zentao/src/zentao.ts)：类型、分页聚合、新增判定、周期收敛。
- [Rust](../../apps/desktop/src-tauri/src/zentao.rs)、[命令层](../../apps/desktop/src-tauri/src/commands.rs)、
  [主窗口](../../apps/desktop/src-tauri/src/main.rs)。
- [凭据读取](../../apps/desktop/src-tauri/src/oauth.rs)、[空值模板](../../apps/desktop/src-tauri/oauth.example.json)。
- [设置](../../apps/desktop/src/renderer/src/components/settings/GeneralPane.vue)、
  [落盘收敛](../../apps/desktop/src/renderer/src/persisted-data.ts)。
- [页面挂载](../../apps/desktop/src/renderer/src/App.vue)（只挂 `startWatch()`，没有禅道页签）。

`oauth.local.json` 顶层新增（与 `github`、`gitee` 并列）：

```json
"zentao": {
  "baseUrl": "http://115.159.41.157:81/zentao/",
  "account": "",
  "password": ""
}
```

填写真实账号密码后重新构建。沿用 `build.rs` 整份复制、Rust `include_str!` 的流程，运行中的程序不读取磁盘上该文件的新内容；
配置及二进制都含明文个人凭据，不是加密保存。该文件已忽略，不能提交；模板 `oauth.example.json` 保持空值。密码保留原值，不做
trim。地址由现有后端校验，也接受该部署的 `my-work*.html` 页面地址并收敛到根目录。

## 已知代价与边界

- 站点在系统浏览器里：观感、明暗主题与登录态都归浏览器与禅道自己，不跟随应用的皮肤。
- 浏览器里第一次打开要手动登录一次（勾「保持登录」后由禅道种 30 天 cookie）；内嵌的账号密码只用于后台检查的 API 会话，
  不参与网页登录。
- 每次点击都会交给浏览器一次，浏览器可能新开标签页；应用不跟踪那扇窗口。
- 部署是明文 HTTP：凭据、会话与页面内容都过公网。

## 验证与边界

纯逻辑测试覆盖多产品、多页汇总、分页异常、编号去重排序、新增比较（首轮静默 / 旧编号重新指派 / 失败不推进基线 / 编号去重）、
周期收敛与到点判定、用户对象压成文本；store 测试覆盖首轮静默、失败保留基线、通知失败重试不重复、关闭不发请求、并发单航班、
换账号后基线重立、用浏览器打开的成功与失败；适配层测试覆盖错误收敛、单页请求参数、登录 / 会话契约与打开站点命令；Rust 测试
覆盖地址规范化、会话守卫、只读端点构造（含 browse 白名单）、产品清单来自账号资料、用户对象压平与字段白名单投影。

**已在本部署上实测过的**：`user.view.products` 拿到 16 个可见产品 id；`tokens` 返回的 token 就是 session id（响应里的
`zentaosid` 与 token 同值），但拿它请求 HTML 页面仍被 302 到登录页 —— 所以浏览器里的登录没法用 API token 代劳，必须由用户
自己登。

真实部署的权限、定制补丁与系统通知落地都只在凭据配置完整后才谈得上验证；没有真实结果时不宣称联调通过。**真机排查要一次
登录、复用同一会话**：禅道对登录失败有计数与冷却，反复试探会把账号临时锁住（见 AGENTS.md 第 6 节）。
