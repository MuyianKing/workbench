# 网关（WorkBuddy / CodeBuddy 反代）

## 约束

- **只监听 `127.0.0.1`**。这不是默认值可以改的配置项 —— 网关进程里带着账号 token，任何监听
  `0.0.0.0` 的版本都不该存在。端口可改，回环地址不可改。
- **默认不启动、不联网**。用户点「启动」之前不绑端口；点「登录」之前不连上游。这两件事是这一页
  唯一的两个出站点。
- **接入信息值得单独一层弹层，但不进设置**：地址与密钥是第三方客户端缺一不可的两样，一件都不能藏；
  但它们只是「配客户端时抄一次」的东西 —— 收进 `AccessDialog`，页首统计带最后一格点开。
  常驻过一版：那张卡把下面三栏一直往下推，而这两样一天看不了一回。
- **模型目录从上游拉，不写死、也不轮询**：点「重新获取」时用第一个可用账号探
  `/v3/config`（字段最全），失败再退 `/console/enterprises/personal/models`，合并去重后落进
  `models.json`；界面、`/v1/models` 与接入信息都读那一份。**不挂定时器** —— 拉一次就是一次真实的上游往返，
  而模型一天也不变几回。`SEED_MODELS` 只在一次都没拉过时给 `/v1/models` 兜底（免得首启返回空数组），
  **不往界面上摆**：界面没拉过就是空表 + 「点右上角重新获取」。
  上游没给的字段（上下文、最大输出、思考档位、倍率）显示 `—` / 「未知」，不拿本地推断冒充事实。
- **这一页的字号比全局大一号**（`--gw-fs-*`，定义在 tokens.css）：主体是表格与小号说明字，
  压在壁纸上 10.5 / 12px 读着发虚。只有 `components/gateway/*` 吃这套 —— 别处要放大先想清楚，
  不然全应用一起长。
- **「请求」「模型」两栏不单起标题带**：页签已经写着栏名，再为标题铺一块玻璃卡只多占一行；
  「请求」的条数并进条件带右端、与「重新读取」同侧，「模型」的计数与「重新获取」铺在面板外面。
- **长表的表头钉住**：「请求」「模型」两栏的表格在卡片里自己滚（根节点 `min-height: 0`、面板
  `overflow: auto`），表头 `position: sticky` 并画上**面板同款底**（`rgba(var(--bg-surface-rgb),
  var(--card-alpha, 1))` + 毛玻璃）—— 透明表头会让滚上来的行从字底下穿过去。别指望整页滚动
  （`.gw`）带出 sticky：`.panel` 的 `overflow: hidden` 会让它失效。
- **启停就在页首那一格**：状态（运行中 / 已停止）与地址写在同一格里，点状态开接入弹层，旁边那枚按钮就地
  启停 —— 这一页最高频的动作不该先点开一层，所以弹层里也不再放第二份。
- **密钥默认开启**：首次启动自动生成（`wbg-` + 32 位 hex），除 `/health` 外一律校验。
  它不是防外人的（只监听回环），是防本机其它程序随手调，以及满足客户端"key 不能为空"的要求。
- 账号视图**不含 token**。`wb_gateway_accounts` 只回展示字段，界面拿不到凭据；想加"顺便把令牌读回来"
  的接口，先读这一条。
- 余额查询是**显式动作**，不是 GET 副作用。原项目把 `GET /accounts/credits` 做成"遍历每个号真打一次
  上游"，一个读请求带着写代价 —— 这里拆成「读缓存」与「点刷新」两个动作。
- **不猜数字**。上游没给的字段（token 数、到期时间、积分）一律留空或 0，界面上显示"未查询 / 未记录"，
  不拿估算值冒充事实。**积分只认上游 `usage.credit`，不拿 token × 倍率去推**。
- **积分比率的口径固定**：分母是**与积分同时观测到的总 token**（`creditTokens`）；缺积分的行既不进样本数
  （`creditSamples`）也不进分母；跨账号 / 跨模型汇总时，先把积分与 token 两个总量分别累加，再**直接相除**，
  不平均各组比率。总 token 含缓存命中的 token，而缓存 token 的积分单价远低于输出 token —— 比较两个账号 /
  模型时先把缓存命中率一起看，别把这个数当模型单价。
- **明细只有一张表**：「用量明细」的每一行同时给用量（请求 / 失败 / token / 延迟 / 速度）与积分
  （扣除积分 / 匹配 Token / 比率 / 缓存命中率），由同一个「按账号 / 按模型」切换控制；「积分与缓存」
  那一组只留五张汇总卡。不要再拆回两张表 —— 同一个账号要在上下两处对齐看，请求数还会写两遍。
- **网关只在本机跑**：单账号或少账号、由用户手动启停、不做账号池调度与配额护栏。**历史流水可以可选地
  同步到用户的私有 git 仓库**（见「多机流水同步」）—— 网关进程本身仍然只监听回环、只在本机执行。
- **出站请求体要先过指纹清洗**（`wb_sanitize`）：上游会对 system 里的 Claude Code / Codex CLI 固定模板句
  做逐字匹配，命中回 400 `11128`「Illegal API invocation from an unapproved channel」。只改确认会被拦的
  那几整句（`Main branch (...)` → `Default branch (...)` 等），**不要把它扩成通用内容过滤**，也不许拿它删
  用户内容；这张字面量表随上游更新（口径来自 workbuddy2api-hub）。同一趟还要把 `developer` 归一到
  `system`、`{type:"reasoning"}` 片段折进 `reasoning_content`、给 DeepSeek 的 assistant 按 thinking 状态
  回填 `reasoning_content` —— 否则长会话分别撞 11101 / 11155。

## 实现

### 分层

单向依赖：编排 → I/O → 领域 → 纯逻辑。反向 import 一律不允许。

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 纯逻辑 | `wb_realm` | 区域常量与上游端点的**唯一来源**（版本号、UA、Origin、X-Domain） |
| | `wb_fingerprint` | 手写 MD5 + `derive_id`（机器码 / 会话标识） |
| | `wb_jwt` | 只解 `iss` / `exp` / `sub` / `enterprise_id`，不验签 |
| | `wb_identity` | uuid7、会话 ID、三种出站身份的头构造 |
| | `wb_sanitize` | 出站请求体的渠道指纹清洗、reasoning 内容归一、`max_completion_tokens` 翻译 |
| | `wb_sse` | 切帧 / 白名单重建 / 聚合 |
| | `wb_credits` | 逐包解析、汇总、企业额度、墙钟时间换算 |
| | `wb_pricing` | 静态价表与花费估算 |
| 领域 | `wb_account` | 账号模型与 `<uid>.json` 读写 |
| I/O | `wb_api_auth` | 设备授权登录、续期 |
| | `wb_api_billing` | 个人 / 企业两条计费路径 |
| | `wb_api_chat` | 上游对话调用（线程 + 通道两阶段） |
| | `wb_usage` | `usage.jsonl` 追加与聚合 |
| | `wb_models` | 上游模型目录的探测、解析与 `models.json` 缓存 |
| 编排 | `wb_relay` | 一次对话请求的编排 |
| | `wb_router` | 路由表 |
| | `wb_server` | 本地 HTTP/1.1 服务 |
| | `wb_gateway` | 生命周期、状态、Tauri 命令 |
| 界面 | `components/gateway/*` | 看板（账号 / 用量 / 请求 / 模型四栏）与接入信息弹层 |

### 三个不显然的设计

**1. 上游调用要两根线程。** 网关得先知道上游状态码，才能决定回给客户端的是「200 + SSE 流」还是
「401 + 错误 JSON」；而这两件事都发生在读正文之前。同步做只能二选一：缓存整段（丢掉流式）或盲猜
200。于是 `wb_api_chat` 把上游调用放到单独线程，用通道把「状态码」与「正文片段」按到达顺序送回；
调用方阻塞等到状态码，再组装自己的响应。`http::request_url_stream` 为此多了一个 `on_head` 回调。

**2. 记账写在响应收尾处，不在入口。** 流式请求的 token 数只有末帧才知道，所以 `UsageRow` 在
`Response::sse` 的闭包尾部落盘。写失败**不打断用户** —— 账本的问题不该让对话报错。

**3. 认证凭据是明文的。** 与客户端自己、与原项目同口径：`accounts/<uid>.json` 里的 token 不加密。
这一点在文档里写明，而不是假装它已加密。

### 登录流程

`POST /v2/plugin/auth/state?platform=CLI` 拿 `state` 与授权链接 → 浏览器授权 → 轮询
`GET /v2/plugin/auth/token?state=` 换 token → `GET /v2/plugin/login/account?state=` 取昵称与企业 id。
state 存在内存里（10 分钟过期），不落盘。上游签发 state，没有 PKCE。

之后靠 `POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token` 头）续期，**永不再走登录**。

### 数据落位

```
%APPDATA%\Workbench\data\wb-gateway\
  settings.json      端口与自启开关
  accounts\<uid>.json  账号（token 明文）
  usage.jsonl        请求流水（一行一条，只追加）
  models.json        上一次从上游拉下来的模型目录（含 fetchedAt / realm）
```

`usage.jsonl` 的一行除 token 数之外还记：`machine`（产生这条流水的机器名，旧行没有就是空串）、
`effort`（客户端要的推理强度，取自请求体）、`stream`（流式与否）、`reasoningTokens`（思考 token）、
`credit`（上游在 `usage.credit` 里给的单次扣费，没给是 `null`）、`apiKey`（调用方密钥的**末四位**，
`…cdef` 形态）与 `costCny`（早期按价表折的估算花费，未定价是 `null`，**只留在历史流水里，界面不再展示**）。
密钥只留末四位是硬约束：这个文件是会被翻着看的。同步到仓库时会再去掉 `apiKey` 与 `costCny`（见下一节）。

### 积分与 token

用量页只回答一个问题：这些 token 一共扣了多少积分。

- 分子是 `UsageRow.credit` 之和，分母是**同一批有 credit 的请求的总 token**（`creditTokens`）。
  缺 credit 的行既不进样本数（`creditSamples`）也不进分母；`credit = 0` 是真实的免费请求，照常计样本。
- 比率 = `credits / creditTokens × 1_000_000`。跨模型 / 跨账号的总比率由两个总量**直接除**，
  不是各组比率的平均。
- 按账号 / 按模型各自算自己的比率；没有样本的组显示「未记录」，不显示 0。两种维度带上同一套字段
  （请求 / 失败 / token / 延迟 / 速度 / 积分 / 缓存命中率），所以明细表切维度时列不跟着变。
- 总 token 口径包含缓存命中 token，而缓存 token 的积分单价远低于输出 token，所以这个数会随缓存命中率漂移。
  比较两个账号 / 两个模型时先把缓存命中率一起看。
- 单条流水的 `credit` 只保留两位小数，短请求的逐条比率噪声大，**只做聚合，不逐条算**。
- 「模型」栏里的单价是横向比价用的静态快照，不是消费账，也不参与这里的积分比率。
- 用量页**自己每 15 秒重读一次**本机流水（与网关页顶栏同一个节奏），页面被 `KeepAlive` 缓存时暂停、切回来立即补读。
  只挂 `onMounted` 的话，打开那一刻读到什么就一直是它 —— 清空流水后正好读到空文件，就会一直显示 0。
- **取数与统计分开**：Rust 的 `wb_gateway_usage_rows` 只回窗口内的流水（本机 + 同步仓库里别的机器），
  用量页与「账号」栏都读它；分组 / 分桶 / 积分比率的语义在 `packages/usage` 的 `summarizeGatewayRows`
  （单测同目录），与 Rust 的 `wb_usage::summarize` 同口径 —— 改口径时两边一起看（界面走的是 TS 那份）。

### 多机流水同步

`usage.jsonl` 是本机账本；把它同步到设置里那个 git 仓库（与 token 用量同一个仓库、同一个克隆）之后，
用量页会把各台机器的流水合起来算。**没登录 / 没填仓库就只有本机**，和 token 同步同一个门禁。

- 仓库里的落点：`gateway-usage/<设备id>/<YYYY-MM>.jsonl`。一台机器只写自己那个目录，每月一个文件；
  月份按 UTC+8（与用量页分桶一致）。所以多机同步没有同文件冲突。
- 同步的是本地流水的一份**脱敏副本**：`apiKey` 置空、`costCny` 置空，其余（账号 uid、模型、token、
  credit、耗时、UA、错误文本、`machine`）原样带过去。密钥尾号即使只有四位也不进仓库。
- `machine` 是主机名：新流水在记账时写入，旧流水在同步 / 读取时补本机名；远端行缺这一项时用设备目录名。
  请求记录页不再单列「机器」与「API Key」两列（单机使用时没有信息量），`machine` 仍留在流水与搜索条件里。
- **本机 `usage.jsonl` 是权威账本**：读取时只合入别的设备的目录，本机目录跳过，避免同一条被算两遍。
  同步失败只影响「看到别的机器」，不影响本机出数与聚合。
- 节奏跟 token 用量同步一致：现有的一小时一轮同步顺带推一次；用量页页首另有一颗「同步」按钮，
  手动强制推一次并重新读取。内容没变时 `git diff` 会挡住空提交。
- 同步只加不删：本机流水被清空 / 删掉某个月时，仓库里已有的旧月份**不会被删**
  （`git add --ignore-removal`）。要清理某个月：先删本机 `usage.jsonl` 里那个月的行，再在仓库里手工删
  对应文件；只删仓库那边，下一次同步会按本机流水写回来。

### 已知边界

- 只做 Chat Completions（含 `/completions` 别名）。Responses API 与 Anthropic Messages 未接。
- 只查 `p_tcaca` 这一本积分账 —— 另一本（评测侧）网关看不到，这是上游边界不是遗漏。
- 静态价表（`wb_pricing`）与 `costCny` 仍在历史流水里，但界面不再展示，也不参与积分口径。
- `扣除积分` 一列只有上游在 `usage.credit` 里给了数才有值，否则是 `—`：不拿 token 乘倍率去推，
  推出来的数看着像真的，实际只是另一份估算。
- 积分比率的分母是总 token（含缓存命中），不是「未命中输入 + 输出」的计费 token；这是为了口径简单，
  读数时要连缓存命中率一起看。
- 多账号只做到「列表 + 启停选择」，没有权重轮转与失败接手。
- 渠道指纹清洗是**字面量黑名单**（`wb_sanitize` 的 `FEATURES` / `REWRITES`）：上游新增一种客户端模板句时
  要手工补表；它只保证「请求能发出去」，不代表上游认可这种用法，账号风险仍由用户承担。
- 同步仓库会随月份文件长期增长，**不做自动清理**；清理办法见「多机流水同步」。
- 两台机器共用同一个 `device.json` 会写同一个设备目录并互相覆盖；本机 `usage.jsonl` 丢了但设备 id
  还在时，自己的远端目录会被跳过（避免双计），那段历史在界面上看不到。

## 涉及文件

- `apps/desktop/src-tauri/src/wb_*.rs`（18 个）
- `apps/desktop/src-tauri/src/http.rs`（流式接口）
- `apps/desktop/src-tauri/src/paths.rs`（`gateway_dir` / `gateway-usage` 系列）
- `apps/desktop/src-tauri/src/sync.rs`（网关流水的 git 写入 / 读取、按月分文件）
- `apps/desktop/src-tauri/src/commands.rs`（`gateway_sync_publish`）
- `apps/desktop/src-tauri/src/main.rs`（模块、managed state、命令注册）
- `apps/desktop/src/renderer/src/components/gateway/{GatewayView,AccessDialog,UsagePane,RequestsPane,ModelsPane}.vue`
- `apps/desktop/src/renderer/src/workbench/{gateway,sync-queue}.ts`
- `packages/appearance/src/views.ts`（`gateway` 页签）
