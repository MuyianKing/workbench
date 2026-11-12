# Qoder（网关：Qoder 国内版反代）

## 约束

- **只接国内版**（`qoder.com.cn` / `openapi.qoder.com.cn` / `gateway.qoder.com.cn`）。不做国际版、
  不做双区路由 —— 模型清单、登录、计费都只认这一套。国际版的域名一个都不许出现在代码里。
- **端口、密钥、随程序启动都和 TBuddy 各用各的**：Qoder 的配置在自己的
  `data/wb-qoder/settings.json`（默认端口 **17879**，TBuddy 是 17878），两份配置互不相干，
  **两个代理可以同时跑**。端口仍是 `127.0.0.1`，不可改成对外监听。
- 「随程序启动」写的是 Qoder 自己配置里的 `autoStart`，与 TBuddy 的开关是两回事；
  只改配置，不立刻启停。
- **自动签到的开关不单独放**：与 TBuddy 共用设置·通用 → 网关的「福利每天自动」
  （默认关，拨一次写两份 `perks-auto.json`）。福利栏只留手动「签到 / 领取活动」，不再放开关。
- **只做 OAuth 设备授权**（用户确认的范围）：不做 PAT 导入、不做本机客户端凭证扫描。
  token 明文落在 `data/wb-qoder/accounts/<uid>.json`（与官方客户端、原项目同口径），文档写明这件事，
  不假装它已加密。**本地导出 / 导入**是唯一例外：用户显式点「导出」时把凭据给成一段 JSON
  （见「账号导出 / 导入」），账号视图本身仍不含 token。
- **COSY 签名是协议层硬约束**：自定义 Base64、AES-128-CBC（key == iv）、RSA-1024 PKCS#1 v1.5 公钥加密、
  `md5(payload\ncosyKey\ndate\nbody\npath)` 四段必须与官方客户端逐字节一致。会话密钥只有 16 个
  十六进制字符、RSA 只有 1024 位 —— 这是服务端协议决定的，**不许为了「加固」单方面改**，改了服务端解不开。
  常量（版本号 / UA / client_id / 主机）只在 [qd_upstream.rs](../../apps/desktop/src-tauri/src/qd_upstream.rs) 一处。
- **上游协议是逆向的，随包数据要能整体替换**：`src-tauri/src/qoder/baseprompt.json`（请求体骨架）与
  `catalog-cn.json`（模型目录兜底）来自 `qoder2api-hub`（MIT）。上游改模板 / 改协议时只换这两份文件与
  `qd_upstream` 常量，不要把字段散回各模块。
- **新出口只有 Qoder 的国内版三个主机**：账号与计费 `openapi.qoder.com.cn`、推理 `gateway.qoder.com.cn`、
  设备授权页 `qoder.com.cn`。默认不联网；点「登录」或「启动」代理才连。
- **请求流水只存本机**（`data/wb-qoder/usage.jsonl`），不并入 `gateway-usage/` 的多机同步 ——
  两个上游的账号 uid / 模型名 / 计价口径不同，混在一起会把两本账算进同一格。
  领取账本另走 `qoder-earnings/<设备id>/<YYYY>.jsonl`（只推成功领取的脱敏行），
  仍不碰 `gateway-usage/`。
- **错误分类不许把排队当账号故障**：403 + `10605` / `isQueued` / `RESOURCE_LIMIT` 是模型排队，
  按 `retryAfterSeconds` 等；429 是模型粒度频控，只挡那一个模型；402 / `112` 是额度耗尽；
  `110` 是当日次数上限（本地 0 点恢复，封顶 6 小时）；`TOKEN_EXPIRE` / `12153` 才是会话失效。
- **工具历史单点决策**：白名单模型（Qwen / GLM / DeepSeek 两档 —— `dmodel` / `dfmodel`，
  2026-11-07 真机补测单轮与多轮结构化历史都正常）且 `tool_call_id` 齐备才走结构化 `tool_calls`，
  否则整轮退回文本标记（`[assistant 请求调用工具]`）。只要有一个 id 不完整就退回 —— 不发畸形请求。
  **DeepSeek 必须结构化的原因**：上游对它走原生 DSML 工具模板，历史再压成文本标记会教模型把两种
  格式混着写（标记 + 残缺 JSON + 孤儿 DSML 标签），客户端收到一坨正文、工具不执行。
- 流内泄漏的工具调用在收尾时还原（`qd_tools::restore_leak` 级联：标记 + JSON 数组 → DSML 块
  （`invoke` / `parameter` 标签，间距宽容、半截也认）→ JSON 对象 —— 有名直接还原，无名按
  声明过的工具 schema 推断，唯一匹配才认；`arguments` 字符串残缺时做有界修复，非法转义
  （`\'` 这类）先修成合法转义）；**回读只认本次请求声明过的工具名**，且上下文里没有泄漏痕迹
  （标记或 DSML 标签）时正文里的 JSON 示例不会被当成调用。释放前孤儿 DSML 标签一律剥掉。

## 实现

### 分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 纯逻辑 | `qd_upstream` | 国内版常量与端点的**唯一来源** |
| | `qd_sign` | 自定义 Base64、AES-128-CBC、RSA-1024、COSY Bearer 与会话缓存 |
| | `qd_quota` | 额度 / 频控 / 排队 / 会话失效 / 瞬时故障的判定 |
| | `qd_tools` | 会话压平、工具定义归一、思考档位、泄漏回读（DSML / 无名推断） |
| | `qd_sse` | 上游信封解包、chunk 清洗、聚合、泄漏缓冲（探针态） |
| 领域 | `qd_account` | 账号模型与 `<uid>.json` 读写 |
| | `qd_body` | 以 `baseprompt.json` 为骨架构造上游请求体 |
| | `qd_models` | 随包 CN 目录 + 上游目录缓存 + 显示名 ↔ key 解析 |
| | `qd_credits` | 额度多桶归一、套餐、最近到期 |
| | `qd_tasks` | 每日签到、活动领取、自动签到 / 活动记录 |
| I/O | `qd_auth` | 设备授权、续期、userinfo |
| | `qd_api_chat` | 上游对话调用（线程 + 通道，先送状态码再送字节） |
| | `qd_usage` | `usage.jsonl` 追加与读取 |
| 编排 | `qd_pool` | 选号顺序（到期时刻 / 优先级 / 加入时间） |
| | `qd_relay` | 一次请求的编排与写回 |
| | `qd_router` | 路由表与密钥校验 |
| | `qd_gateway` | 生命周期、状态、全部 `wb_qoder_*` 命令 |
| 界面 | `components/qoder/QoderView.vue` | 账号 / 用量 / 请求 / 福利 / 模型五栏；用量栏复用 `components/gateway/UsagePane.vue` |

与 TBuddy 共用的**协议无关设施**：Rust 侧 `common.rs`（时间 / 截断 / 打码 / 历法 / uid 白名单）与 `http::request_json(_with)`（信封解包），外加直接复用 `wb_server`（HTTP 服务）与 `wb_usage`（JSONL 记账）—— 这两块本来就不懂协议；界面侧账号卡的状态机在 `renderer/src/status.ts` 的 `pool*`（状态类名已从 `state-*` 统一成 `is-*`）、余额快照在 `composables/use-credit-pool.ts`（Qoder 删号现在也清快照，与 TBuddy 同口径）。业务定义、账号模型、落盘照旧独立。

### 请求链路

```
客户端 POST /v1/chat/completions
  → 解析 model，按显示名 / key 解析出上游 key 与元数据
  → 选号（积分到期 → 优先级 → 加入时间；同一段对话固定落到顺序里的第一个可用号）
  → 需要时续期
  → build_qoder_body()   套 baseprompt 模板、压平会话、写工具与思考档位
  → qoder_encode()       自定义 Base64
  → COSY 头               RSA 包裹临时密钥 + md5 签名
  → POST gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1
  → 解 SSE 信封 {"headers","body","statusCodeValue"} → 内层 OpenAI chunk
  → 清洗 / 补 tool_call id / 泄漏缓冲 → 以 SSE 或 JSON 返回客户端
```

### 页首与页签

- 页签走**共用组件** [GatewayTabs.vue](../../apps/desktop/src/renderer/src/components/gateway/GatewayTabs.vue)
  （TBuddy 与 Qoder 同一份）：下划线式导航，`height: 34px`、项间 `--sp-5`、`padding: 0`、
  字号 `--gw-fs-body`（14px）、选中加粗取 `--ink`、active bar 2px 主色；
  **不铺底色、不拉满整行**，EP 默认那条贯穿整行的 `.el-tabs__nav-wrap::after` 也去掉。
- **字号必须走网关页的 `--gw-fs-body`**：EP 默认吃全局的 `--el-font-size-base`（13px），
  两边各写一份 CSS 时 Qoder 会小一号 —— 所以别再在页面里自己写 `el-tabs` 的 deep 规则，
  要改就去改共用组件。
- **页首右侧的运行状态与 TBuddy 同一套**：裸按钮「状态点 + 运行中 / 已停止 + `127.0.0.1:端口`」
  （停止时灰点 + 未监听），点开接入信息，悬停状态字出下划线；启停是文字按钮。
  不再用带底的药丸、也没有「Qoder ·」前缀（页签已经写着是哪一页）。

### 账号栏

- **「导出 / 导入 / 刷新积分 / 登录」不在栏首，是右下角一排浮动圆键**，与 TBuddy 同一套：
  导出 `Download` / 导入 `Upload` / 刷新 `Coin` 三枚工具键、登录一颗主色加号，悬停才有文字提示；
  口径（sticky + `margin-top: auto`、`calc(sp-5 - sp-3)`、不许改回 `position: fixed`）只在
  [gateway.md](gateway.md) 一处，这边照抄。
- 栏首不再放选号规则之类的说明文字，只留一行登录中的提示（`loginHint`：「等待浏览器完成 Qoder 授权…」）。
- **账号卡与 TBuddy 的账号卡同一套布局**：首字头像（紫）、左侧状态色标与 7% 状态色柔光、名称下的
  状态标签（可用 / 待登录 / 额度用完 / 部分模型用完 / 已停用）、右上「查余额 / 停用 / 删除」、
  额度恢复小字与优先级同一排（提示在左、空着时隐藏占位）、积分「剩余 / 总额 + 已用 + 最近到期」与余额条，
  点积分区打开积分明细弹层（复用 `CreditsDialog`，Qoder 快照在适配层转成同一形状）；
  底部三格「成功 / 失败、用量、均速」取最近 30 天流水。
  字号取 `--gw-fs-*`（与 TBuddy 账号卡一致），这一页其余栏仍用 `--fs-*`。
  彩色例外与 TBuddy 账号卡一致：头像紫、余额条与状态色标的状态色；别扩到别处
  （福利栏那三格图标的彩色另算，见「福利栏」）。
- **账号栏的 `.qd__pane` 不参与收缩**（`flex: none`）：卡片按内容自然长高，浮动键才拿得到整段滚动范围；
  空态时再撑满一栏（`is-empty`）让空态居中。
- 空态只写事实 + 「点右下角加号登录一个」，不在空态里再放一颗登录按钮。

### 用量栏

- **直接复用 TBuddy 的 [UsagePane.vue](../../apps/desktop/src/renderer/src/components/gateway/UsagePane.vue)**：
  Qoder 页只通过 `:load-rows` / `:load-names` 注入自己的 `wb_qoder_usage_rows` 与
  `wb_qoder_account_names`，布局、六张 KPI、积分总账、明细表、时间范围与刷新节奏都跟
  [gateway.md](gateway.md) 的「用量」栏同一份代码 —— **别在 Qoder 页里再抄一份**，要改就改那个组件。
- 六张 KPI 与 TBuddy 同款（请求 / 总 token / 输入 / 输出 / 成功率 / 平均延迟，含吐字速度），
  图标色板也同一套；**用量栏的彩色只落在这六枚图标上**，页面其余部分仍只灰度 + 状态色
  （账号卡的彩色例外见「账号栏」）。
- **每百万 token 的积分仍是本页的核心指标**：明细表有「积分 / 1M Token」列；积分总账面板里
  「平均积分 / 1M Token」是唯一取状态色绿的一格。比率取汇总里的 `creditsPer1MTokens`
  （`summarizeGatewayRows` 由 `credits` / `creditTokens` 两个总量直接除），**没有积分样本就显示 `—`**，
  不拿 0 冒充「测出来是零」；分母只算积分大于 0 的请求的 token，免费模型不会把比率稀释。
- **额度字段取上游 `usage.credits`（复数）**：Qoder 的 usage 里这一位是 `credits`，与客户端会话日志
  （[qoder-log.ts](../../packages/usage/src/qoder-log.ts)）同一个字段；`qd_usage::parse_credits`
  兼容旧形态 `credit`。只认这个字段，**不拿 token 乘倍率去推**（推出来是估算，这一列要的是真实扣了多少）。
- **时间范围按自然日算（UTC+8）**，含「昨日」；24 小时图固定看最近 24 小时（从当前小时往前补 0），
  不跟时间范围走。流水**每 15 秒重读一次**，页面被 KeepAlive 缓存时暂停、切回来立即补读。
- token 按千进制收短（K / M，**不写「兆」**）：`compact()` 与 TBuddy 用量页同一套。
- **取数与统计分开**：Rust 的 `wb_qoder_usage_rows` 只回窗口内的流水与 `since`，分组 / 分桶 /
  积分比率在 `packages/usage` 的 `summarizeGatewayRows`（与 TBuddy 同一份、同一口径）。
  `wb_qoder_usage`（Rust 侧的汇总）仍然保留，但界面走的是 TS 那一份 —— 两边改口径时一起看。

### 请求栏

- 条件带**就是 TBuddy 那个组件**（`components/gateway/RequestFilters.vue`：搜索框、结果下拉、
  条数下拉、右端「共 N 条 · 成功 M」+「重新读取」，模板与样式只有一份）；表格两页各是各的 ——
  这边精简七列（时间 / 账号 / 模型 / 状态 / token / 延迟 / 错误），TBuddy 全量十四列，别借共用合并。
- **换条数才重新读后端**；换结果或关键字只在前端过滤（`requestRows` computed）。
- 表格行键是「时间 + 模型 + 账号」：同一秒里两条同模型请求时，只用 `ts` 会撞键。

### 模型栏

- 五栏里唯一一栏是**卡片墙**（TBuddy 的模型栏是行式清单，两份不共用）：`qd__cards` 自适应列宽，
  卡面是 `qd-model panel` —— 首行模型 id + 「新 / 未开放」标签、行尾一枚**复制键**（无底色 text 图标键，
  tooltip「复制模型名」，走 `copyText(model.id, '模型名')`，提示「模型名已复制」），
  底下一排两格 **上下文 / 倍率**，脚注「图像 / 工具 / 免费」与未开放原因。
- **介绍行已去掉**：上游清单里的 `description` 实际一直为空，那一行只剩「官方未提供介绍」占位；
  payload 字段保留，界面不再给它留版面。
- **思考档位不进界面**：上游给的档位清单长短不一（`low / medium / xhigh` 一格放不下，
  会撑破格子压到隔壁倍率），接入方用哪个档位由请求自己带，目录里不展示。
  模型卡的那排事实格因此是**两列**（`.qd-model .qd-card__facts`），福利卡那三格仍是三列。
- **栏首是本地搜索框，不是说明文字**：`modelKeyword`（240px，与请求栏那个搜索框同宽；**高度走默认
  32px，不用 `small`** —— 这一行只有它和「重新获取」，24px 太矮）只在已拉下来的清单里按模型 id / key
  过滤（不区分大小写），**不发请求、不触发重新获取**；过滤结果为空时出「没有匹配的模型」空态。
  原先那行「目录来自上游官方清单…」的说明已去掉。
- 目录读缓存 `wb_qoder_models` 上屏；要换成本机上游此刻的清单点右端「重新获取」
  （`wb_qoder_models_refresh`，用第一个可用账号拉一次），首次来自随包快照 ——
  细则见「与上游 / TBuddy 的已知差异」。

### 登录

1. 本地生成 PKCE（S256）与 nonce；`machine_id` 读 `%USERPROFILE%\.qoder-cn\.auth\machine_id`，没有就随机。
2. 浏览器打开 `https://qoder.com.cn/device/selectAccounts?challenge=…&nonce=…&redirect_uri=…&client_id=…&machine_id=…`。
3. 每 2 秒 `GET /api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`；404 / 202 是「还没授权」。
4. 拿到 token 后 `GET /api/v1/userinfo` 补昵称 / 用户类型 / 组织，落 `accounts/<uid>.json`。
5. 之后只走 `POST /api/v1/deviceToken/refresh`（`drt-`）或 `jobToken/refresh`，永不再走登录。

### 独立监听

Qoder 与 TBuddy 是**两套完全独立的状态**：各自的 `Inner` 持有自己的 `Option<Server>` 与
`api_key`，各自的 `settings.json` 存端口、密钥与随程序启动。端口不同（17878 / 17879），
所以可以同时跑；谁也不碰谁的配置。换密钥只影响自己这一边。

### 福利栏

- **签到 / 领取活动只在栏首有一对按钮，统一跑全部账号**；卡片上不再放单号按钮。
  已经签过、活动都已领的号由快照筛掉（`checkinTargets` / `claimTargets`），**一个请求都不发**。
- 每号一张卡：**首字头像（紫、渐变底，与账号栏同款）+ 账号名 + 签到状态标签**；
  「活动未开放」这类没有结果的状态**不出标签**（`checkinLabel` 回空串，标签整个不渲染），
  下面三格「连签 / 累计 / 每日签到」各带一枚**按语义着色**的图标（连签 `--st-ok` 绿 / 累计 `#2f6bd8` 蓝 /
  每日签到 `#c2410c` 橙，图标底是同色 16%，格子铺 5–9% 的同色渐变 + 14% 内描边），
  与 TBuddy 福利栏的数字格同一套色板 —— **这是福利栏自己的彩色例外**，别扩到别的栏；
  积分余额只在账号栏的卡上看，福利卡不再重复一遍。
- 卡片上**不摆上游 status 解释与活动清单**（那是过程信息，用户只看结果）；
  活动状态仍参与顶部「领取活动」的目标筛选，只是不上屏。
- **「近一个月积分获取」柱状图直接复用 TBuddy 的 [PerksCreditsChart.vue](../../apps/desktop/src/renderer/src/components/gateway/PerksCreditsChart.vue)**：
  数据来自本机 `activity.jsonl` 里签到 / 活动领取成功时记下的 `credits`，按 UTC+8 自然日相加、
  最近 30 天、缺的天补 0（`dailyCreditSeries`，与 TBuddy 的 `dailyGrowthCredits` 同一条口径）。
  **只统计本应用领到的积分**：别的设备用本应用领的会同步进来（见下一节）；
  官方客户端领的仍不在图里。
  **活动领取的响应实测不带面额（只有 success）**：金额先认响应里的 `amount` / `rewardCredits`，
  没有就退回活动列表的 `benefit.amount`（`claim_reward`）。旧记录没有 `credits` 时，
  签到从「签到成功 +N 积分」回读，活动从标题里的「N Credits / N 积分」回读（`legacy_credits`）；
  看不出金额的（如「首次订阅福利」）不猜。
- **旧每日签到接口上游已停用**（`status=DISABLED`，`currentStreakDays` / `totalClaimDays` 恒 0）；
  每天的 100 Credits 改由活动平台发放，要按「领取活动」才真正到账。
  卡片上的「连签 / 累计」仍是旧接口的字段，保留原样，不拿活动数据硬凑。
- **「近一个月官方积分消耗」图已撤掉**：福利栏只剩「近一个月积分获取」一张图。
  `wb_qoder_credit_heatmap` 命令、`parse_heatmap` 解析与 `PATH_CREDIT_HEATMAP` 端点常量一并删除。
- **「今日尝试」列表已撤掉**（过程流水没人看）；`activity.jsonl` 仍保留 —— 它是积分获取统计的唯一来源。

### 领取账本同步

- **落点**：`qoder-earnings/<设备id>/<YYYY>.jsonl`，与 token 同步同一个私有仓库、同一个克隆；
  **按年分文件**（年份按 UTC+8）。**不进 `gateway-usage/`**，两个上游的账不混。
- **只推成功领取的脱敏行**：`ts / date / uid / task / credits / message`（活动标题），
  不含昵称与 token。本机 `activity.jsonl` 仍是权威；读的时候并入别的设备目录，
  按 `(uid, date, task, message)` 去重，再按日相加。
- **节奏**：进福利栏先 `pull` 一次（一分钟节流），手动签到 / 领取成功后 `push` 一次；
  自动签到写下的行在下次进福利栏时补推。没登录 / 没配仓库时只读本机。
- 仍覆盖不到**官方客户端**领的积分 —— 上游没有发放流水，本机也没有那台客户端的事件。

### 自动签到

开关只在设置·通用 → 网关的「福利每天自动」（TBuddy 与 Qoder 共用，默认关）；拨一次同时写
`wb-gateway/perks-auto.json` 与 `wb-qoder/perks-auto.json` 的 `enabled`。`stores/perks-auto.ts`
启动后与每十分钟各问一次，一次问两边；Qoder 这边进 `wb_qoder_perks_auto_run`
（`qd_tasks::auto_run`）判断：开关关着直接返回，每号每本地自然日（UTC+8）最多跑一次。

- 跳过停用 / 没 token 的号；需要续期时先续期，续期失败算失败、不记完成。
- `checkin` 返回 `ok` 就记完成（`daily[uid] = 今天`）—— 上游 `status != CLAIMABLE`
  （每日福利改由活动平台发放）也算完成，不再十分钟重试一次。
- 真正的失败（网络 / 上游报错）不记完成，下一轮再试；`activity.jsonl` 照常落一行。
- 活动领取（`claim_campaigns`）不自动跑，只在福利栏手动点「领取活动」。

### 账号导出 / 导入

与 TBuddy 同一套做法（见 [gateway.md](gateway.md) 的「账号导出 / 导入」）：账号栏右下角「导出 / 导入」工具键，
导出一段 JSON 让用户存进密码管理器，另一台设备贴回来，免去重复登录。

- `kind` 是 `"workbench-qoder-accounts"`，与 TBuddy 的 `"workbench-gateway-accounts"` 互不混用。
- 只搬凭据、身份与偏好（`accessToken` / `refreshToken` / `expiresAt` / `nickname` / `userType` / 组织 /
  `plan` / `weight` / `enabled` / `note`）；`quota*`、`creditExpiresAt`、`lastCheckin`、`campaignCodes`、
  `lastError`、`cooldownUntil` 这些本机瞬时状态不导出，导入时重建。
- `realm` 只接受 `cn`；导入的号 `source` 写 `"import"`；同 uid 由用户当场选「跳过已有」或「覆盖本机」。
- 导出内容含明文 token，只由用户点「导出」触发，不联网、不进 `gateway-usage/` 同步。

### 数据落位

```
%APPDATA%\Workbench\data\wb-qoder\
  settings.json         Qoder 自己的端口（默认 17879）、apiKey 与 autoStart
  accounts\<uid>.json   账号（token 明文、userType、组织、weight、creditExpiresAt、
                        quota 标记、campaignCodes、lastCheckin）
  usage.jsonl           请求流水（本机，不参与多机同步）
  models.json           上一次从上游拉下来的模型目录
  activity.jsonl        签到 / 活动尝试记录（`credits` 是本次真实领到的积分；
                        脱敏、截断；超过 1 MiB 只留最近 2000 行）
  perks-auto.json       自动签到开关与每号上次跑的日期
```

端口 / 密钥 / `autoStart` 都在 Qoder 自己的 `settings.json`，与 TBuddy 各一份。
同步仓库里另有 `qoder-earnings/<设备id>/<YYYY>.jsonl`（见「领取账本同步」），不在本机数据目录。

### 命令

| 动作 | 命令 |
| --- | --- |
| 状态 / 启停 | `wb_qoder_status` / `wb_qoder_start` / `wb_qoder_stop` |
| 配置 | `wb_qoder_auto_start_set` |
| 登录 | `wb_qoder_login_start` / `wb_qoder_login_poll` |
| 账号 | `wb_qoder_accounts` / `wb_qoder_account_set` / `wb_qoder_account_priority` / `wb_qoder_account_delete` / `wb_qoder_account_names` / `wb_qoder_accounts_export` / `wb_qoder_accounts_import` |
| 接入信息 | `wb_qoder_access` / `wb_qoder_rotate_key` |
| 模型 | `wb_qoder_models` / `wb_qoder_models_refresh` |
| 积分 | `wb_qoder_credits` |
| 用量 / 请求 | `wb_qoder_usage` / `wb_qoder_usage_rows` / `wb_qoder_usage_recent` |
| 福利 | `wb_qoder_perks_status` / `wb_qoder_checkin` / `wb_qoder_claim_campaigns` / `wb_qoder_earnings` / `wb_qoder_activity_today` |
| 领取同步 | `qoder_earnings_publish` / `qoder_earnings_pull` |
| 自动签到 | `wb_qoder_perks_auto_config` / `wb_qoder_perks_auto_set` / `wb_qoder_perks_auto_run` |

## 与上游 / TBuddy 的已知差异

- 用量栏是**同一份界面代码**（`UsagePane.vue`），差异只在取数命令与本机流水文件；
  两边的账仍然分开算。
- 不实现国际版、PAT、本地凭证扫描、Responses / Anthropic 协议。
- 活动平台（`/sash/api/v1/me/campaigns`）对机器身份敏感：没有官方 `runtime-info.exe` 的真实身份时，
  上游可能把活动列表隐藏（HTTP 200 但空）。这里只如实显示「今天没有可领的活动」，不伪造。
- 泄漏工具调用的流式限制：**扣住触发词（标记 / DSML 标签头）之后**的正文都能收尾还原；
  触发词之前已流出的正文收不回来 —— 「孤儿闭合标签」（开启标签被上游当作特殊 token 吃掉）
  若前面没有标记，那截 JSON 已经流给客户端了，只能把后续标签剥掉，工具不会执行
  （DeepSeek 进结构化白名单后这种形态应当极少再出现）。LeakGuard 的探针态让正文里
  孤立的 `[` / `<` 只扣一帧就放行，不再卡流到收尾。
- 请求流水不参与多机 git 同步（TBuddy 的 `gateway-usage/` 不变）；**领取账本单独同步**
  到 `qoder-earnings/`，只覆盖用本应用领取的记录。
- 模型目录首次来自随包快照；必须登录一个账号后点「重新获取」才会换成本机上游此刻的清单。

## 验证

- Rust：`cargo test`（签名向量、信封解包、工具归约、额度归一、选号顺序）+ `cargo build` + `cargo clippy -- -D warnings`。
- 前端：`pnpm run verify`（lint / typecheck / renderer 构建 / 单测）。
- 真机：登录 → `/v1/models` → 流式与非流式对话 → 用量与请求页出现记录 → 两个代理可以同时跑
  （17878 / 17879 各自独立），重启后各自的「随程序启动」各自恢复。真实链路必须用用户自己的 Qoder 账号验证。
