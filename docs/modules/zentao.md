# 禅道

禅道页通过 REST API 登录，读取「指派给我 / 未解决 / 未关闭」的 Bug 列表，并可弹系统通知。
**应用只看列表**：Bug 的正文、历史与一切改动都在禅道页面里做，点列表标题交给系统浏览器打开那条 Bug。
跨模块的导航、主题与联网边界见 [功能与架构](../features-and-architecture.md)，通道规则见
[ipc-and-state.md](ipc-and-state.md)。

## 约束

- 禅道凭据由 `oauth.local.json` 的 `zentao` 节构建期注入，进入禅道页时由 Rust 自动认证；配置缺失不发请求。
- **只读**：本模块的请求全是 GET，**不提供任何写通道** —— 没有指派、解决、评论、改状态的路子，
  域包里也没有对应的入参校验与选项表。要改禅道的数据就去禅道页面改（点标题就过去了）。
  别为了「顺手」再加一个写接口：那会把一条纯读出口变成会改公司数据的出口。
- 所有请求都固定在配置的部署根与**固定端点**上，不跟 HTTP 重定向；
  **不提供任意 URL / 方法 / 请求头通道** —— 渲染层只说「哪个产品、第几页、哪个口径」，地址由后端拼。
- 账号密码仅由 Rust 读取，不经过渲染层；token 仅在 Rust 内存中保管，不回传渲染层，不写入数据文件、日志或凭据管理器。
  重启清除 token；切换页面保留会话。个人密码会内嵌到二进制，不分发带密码的构建；HTTP 传输未加密。
- Rust 只负责认证、会话保管、单页 JSON 读取与字段白名单投影；分页、验证、跨产品去重与排序在 `@workbench/zentao`。
- 查询完整产品与 Bug 分页，所有产品成功才替换界面列表；失败不能当成零条 Bug，刷新失败保留上次结果。
- 列表口径是三个**白名单** browseType（`assigntome` / `unresolved` / `unclosed`），由后端再校验一次、
  不接受别的值；不使用未被 API 读取的 `assignedTo` 查询参数。列表按编号降序。
- **点标题 = 用系统浏览器打开那条 Bug**（`zentaoBugUrl` 只由部署根 + 编号拼站内链接，见「打开 Bug 页面」），
  走的是登录授权页也在用的 `open_external` 通道：**不是新的网络出口**（应用自己不去取那个页面，是浏览器去取）。
  不要把地址拼装搬到界面里，也不要把禅道页面嵌进 webview —— 未认证的 webview 只会被跳到登录页。
- **后台检查默认 30 分钟**（设置「通用」里的检查间隔可改，0 = 关闭，范围 1..1440）：间隔由 Rust 计时线程
  计时并到点发 `zentao:check`，取数、比新增与弹通知全在渲染层（分页与判定已有带单测的域包）。
  **计时必须在 Rust**：窗口收进托盘后 WebView 定时器会被节流。只有配置完整、周期非 0 才发检查事件，
  线程自己不做网络、不持锁 emit。
- **只有后台检查发现新增才弹通知**：第一轮成功只建立基线（不把存量报成新增）；失败不推进基线；
  按**编号全集**比对，旧 Bug 重新指派给我也算新增；手动刷新不弹。通知复用现有 Windows toast（`notify.rs`），
  正文是条数与首条标题（纯文本、控制字符压平），点击唤出主窗口并切到禅道页。通知发失败留着下一轮重试，
  不吞掉也不重复报同一批。
- 宿主调用一律经 `window.workbench`，通道返回 `Result<T>`；认证过期只清当前会话并就地显示错误（重登一次即止，
  不循环），保留上次列表，刷新时再认证。
- 页面使用现有 `.panel` 外壳、Element Plus 控件与主题令牌，跟随明暗、主题色及卡片不透明度；
  **外部字符串一律只作文本插值**：Bug 标题是服务端内容，只当纯文本渲染，绝不 `v-html`。
- **严重程度 / 优先级按等级着色**（这是 AGENTS.md 第 4 节「彩色只表达运行状态与项目标识色」的**唯一例外**，
  且只限列表这**两个字段的两个色点**）：色阶取自禅道 22.2 的 `config->bug->colorList`，与禅道页面一致；
  口径**只定义在 `packages/zentao/src/zentao.ts`**，别在界面里另拍一套，也别把这套色扩到别的字段。

## 实现

### 导航与页面

页面 ID 为 `zentao`，导航名为「禅道」。默认顺序放在末尾，旧的 `viewOrder` 收敛时自动补入，
无需迁移数据。沿用设置 → 菜单的排序 / 显隐与 `KeepAlive`，不增加路由或独立窗口。

会话与取数在 `stores/zentao.ts`（它同时服务后台检查与通知点击），`ZentaoView.vue` 只管展示；
没有登录表单和退出按钮。首次挂载先读本机会话，没有会话则调用无参 `zentaoLogin()`，再读取列表；
KeepAlive 切回不重复请求。配置缺失、认证或取数失败都显示错误与重试按钮；手动刷新时没有会话会重新认证。
`App.vue` 挂载时调 `startWatch()`：**先挂上 `zentao:check` / `zentao:notify-click` 订阅，再登记周期** ——
后端在启用时会立刻发一次检查（用来立基线），订阅晚一步就漏掉了。

在 `apps/desktop/src-tauri/oauth.local.json` 顶层新增，与 `github`、`gitee` 并列：

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

列表展示编号、标题、产品、指派给、创建者、状态、严重程度与优先级（后两者带等级色点；
`openedBy` 与 `assignedTo` 一样经用户字段压平），顶部那颗分段选择器切换
**指派给我的 / 未解决 / 未关闭** 三个口径（换口径即重取）。**点标题用系统浏览器打开那条 Bug**；
工具条另有刷新与打开禅道（不带 Bug，就开部署首页）。加载态复用 `PanelLoading`；刷新期间留着旧列表。

一次取数的顺序：**产品清单**（账号资料里的可见范围）→ 逐产品读该口径的 Bug 分页 →
对真有 Bug 的产品补一次名字 → 汇总去重按编号降序。产品名取不到只影响那一列，不挡列表。

### 打开 Bug 页面

`zentaoBugUrl(baseUrl, id)` 造 `<部署根>/bug-view-<id>.html`（清掉基址里的查询与片段，只接受
不含内嵌凭据的 HTTP(S) 地址，编号必须是正整数），再由 store 经 `window.workbench.openExternal`
交给系统默认浏览器。这条通道能打开任意 URL，所以拼装只留在域包这一处，界面只交出「哪条 Bug」。

### 产品清单与用户字段（本部署实测的两个坑）

- **产品清单不用 `GET /v1/products`**：那条走 `product/all`，在把产品挂在项目集 / 项目下的部署里
  **返回空数组**（本部署实测 total=0），于是「先枚举产品再取 Bug」会一条都拿不到。
  改为读 `GET /v1/user` 的账号资料 `profile.view.products`（逗号分隔的产品 id，即账号可见范围）；
  万一为空或写成 `all` 这类非数字，再退回 `/v1/products` 枚举。产品名**按需补**：只对真有 Bug 的
  产品调一次 `GET /v1/products/{id}`，避免为十几个空产品各发一条请求。
- **`assignedTo` 等用户字段在 v1 里是对象**（`format($bug, 'assignedTo:user')` 的结果），
  不是账号字符串。后端投影时压成一句可显示文本（真实姓名优先、退回账号），域包解析时 `userText`
  再兜一道 —— 直接把对象丢给 `project_fields` 会被当成非法字段，整页读不出来。
- Bug 列表行**不带产品名**（`bugs.php` 只补 `statusName` 与 `productStatus`），所以产品名必须另取。

## 涉及文件（页面与状态）

- [页面](../../apps/desktop/src/renderer/src/components/ZentaoView.vue)。
- [状态](../../apps/desktop/src/renderer/src/stores/zentao.ts)、[适配层](../../apps/desktop/src/renderer/src/workbench/zentao.ts)。
- [域包](../../packages/zentao/src/zentao.ts)：类型、分页聚合、新增判定、Bug 页面地址、色阶与口径文案表。
- [Rust](../../apps/desktop/src-tauri/src/zentao.rs)、[命令层](../../apps/desktop/src-tauri/src/commands.rs)、[注册](../../apps/desktop/src-tauri/src/main.rs)。
- [凭据读取](../../apps/desktop/src-tauri/src/oauth.rs)、[空值模板](../../apps/desktop/src-tauri/oauth.example.json)。
- [设置](../../apps/desktop/src/renderer/src/components/settings/GeneralPane.vue)、[落盘收敛](../../apps/desktop/src/renderer/src/persisted-data.ts)。
- [导航 ID](../../packages/appearance/src/views.ts)、[导航栏](../../apps/desktop/src/renderer/src/components/NavRail.vue)、[页面挂载](../../apps/desktop/src/renderer/src/App.vue)。

### 22.2 API 契约

核对依据为官方固定标签 `zentaopms_22.2_20260527`：

- 登录：`POST <部署根>/api.php/v1/tokens`，JSON `{account,password}`；成功返回 `201 {token}`。
- 认证：`Token: <token>`，不使用 Bearer 或新版 `ss_` 前缀。
- 产品：`GET <部署根>/api.php/v1/products?status=all&page=1&limit=100`。
- Bug：`GET <部署根>/api.php/v1/products/{非零产品ID}/bugs?status=assigntome&order=id_desc&page=1&limit=100`。
- 分页响应包含 `page,total,limit,products` 或 `page,total,limit,bugs`，根据 `total` 取完整分页。
  `product=0` 不代表所有产品；需要枚举当前账号可见产品后分别读取。
- `assigntome` 筛 `assignedTo` 为 token 对应的当前账号，不额外限制 Bug 状态。
- 其它用到的入口只有两个：`GET /user`（账号资料里的可见产品）与 `GET /products/{id}`（补产品名）。
  **v1 无 PATCH**；「未解决」是 browseType `unresolved`（= `status=active`），不是 `status=active` 直接当参数用。
  **产品可见范围也不来自 `/v1/products`** —— 见上面那条。
- **本版不用** `GET /bugs/{id}`（详情与历史）、`GET /users`、`GET /builds` 与两个写入口
  （`POST /bugs/{id}/assign`、`POST /bugs/{id}/resolve`）：正文与改动都在禅道页面里做，见「只读」那条。
- Bug 页面地址是禅道内置页面的老式路由：`<部署根>/bug-view-<id>.html`。

官方来源：[登录](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/tokens.php)、
[产品](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/products.php)、
[Bug 列表](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/api/v1/entries/bugs.php)、
[路由表](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/config/apiv1.php)、
[指派筛选](https://github.com/easysoft/zentaopms/blob/zentaopms_22.2_20260527/module/bug/tao.php)。

### 会话与传输

`zentao_login` 无凭据入参，由 Rust 读取内嵌配置；token 留在 Tauri managed state，仅返回非机密的本机会话标识、部署根与账号。
`zentao_session` 只读本机状态；`zentao_logout` 只清本机 token，不变更服务器数据。
`zentao_page` / `zentao_products` / `zentao_product` 要求匹配当前会话标识，后端构造固定 GET 请求
（`zentao_products` 从账号资料取可见产品 id、`zentao_product` 补产品名）；
**这一组全是读，没有任何写命令**。产品与 Bug 列表响应先按允许字段投影，再回渲染层。
请求不持有状态锁；旧登录、旧查询与旧退出不能覆盖后来的会话。

HTTP 复用系统 WinHTTP，不增加 Rust 编译单元，也不放宽 WebView CSP。禅道请求显式关闭重定向，
认证失败不回传上游响应正文，避免秘密出现在错误提示中；`401` 只清理对应会话。

> 一条平台事实：v1 的 `Token` **就是 PHP 的 session id**（`tokens.php` 返回 `session_id()`），`Token` 头会把该
> 会话还原。所以同一枚 token 也能调禅道内置页面接口（如 `message-ajaxGetMessage` 的未读消息）。本版**没有**
> 用这条：通知仍走 `assigntome` 列表比对，够用且不必依赖内置页面接口的开关（`message.browser.turnon`）。

### 后台检查与通知

`zentao_watch(poll_minutes)` 登记周期（0 = 关闭，1..1440 收敛）：**间隔没变时后端不动计时**（设置里改
别的项也会重登一次）；关闭后再启用、或启用时立刻来一轮（给渲染层一次立基线的机会），改间隔则从现在
重新计时。`zentao.rs` 的计时线程每 60 秒醒一次，到点给主窗口发 `zentao:check`（不持锁 emit、不做网络）。
周期没登记（默认 0）时只睡。

渲染层收到 `zentao:check` 后取一轮完整列表：与 `baselineIds`（编号全集）比出新增（`diffZentaoBugs`），
有新增才调 `zentao_notify(session_id, count, title)`。`title` 是首条 Bug 的纯文本标题，后端压平控制字符、
截断后拼进 toast（XML 转义在 `notify.rs`）。通知的提示音用系统默认音（不与新邮件混同）。点击唤出主窗口、
发 `zentao:notify-click`，渲染层切到禅道页。`notify.rs` 的 COM 公寓改为**按线程初始化**（原先进程级 `Once`
只对邮件监视线程成立，禅道通知走 Tauri 命令工作线程）—— `zentao_notify` 会更换会话时拒绝旧会话的通知。

### 验证与边界

纯逻辑测试覆盖多产品、多页汇总、分页异常、编号去重排序与 Bug 页面地址（含拒绝非 HTTP(S) 协议、
相对地址与内嵌凭据）、新增比较（首轮静默 / 旧编号重新指派 / 失败不推进基线 / 编号去重）、
周期收敛与到点判定、通知标题压平、产品名按需补取（没有 Bug 的产品不补）、用户对象压成文本、
状态文案与等级色阶；store 测试覆盖首轮静默、失败保留基线、手动刷新不弹、通知失败重试不重复、
关闭不发请求、并发单航班、切口径重取与换账号后基线重立；适配层测试覆盖错误收敛、单页请求参数
与登录 / 会话契约。Rust 测试覆盖地址规范化、会话守卫、只读端点构造（含 browse 白名单与拒绝任意值）、
产品清单来自账号资料、用户对象压平与字段白名单投影。开发实现与测试不需要访问公司站点。

**已在本部署上实测过的**（只读）：`user.view.products` 拿到 16 个可见产品 id、对产品 17 取 `assigntome`
取到那两条 Bug（#285 / #286）、产品名「巩留县人民医院重症系统」。

真实部署的权限、定制补丁、账号密码认证与系统通知落地都只在凭据配置完整后才谈得上验证；
没有真实结果时不宣称联调通过。**真机排查要一次登录、复用同一会话**：禅道对登录失败有计数与冷却，
反复试探会把账号临时锁住（见 AGENTS.md 第 6 节）。
