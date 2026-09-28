# AI 助手

从 [AGENTS.md](../../AGENTS.md) 第 5 节拆出的硬约束（AI 助手页）；功能说明见
[features-and-architecture.md](../features-and-architecture.md) 的「AI 助手（ai）」一节。

关键落点：`src/shared/ai.ts`（模型配置的形状与收敛、提示词、启动参数、事件解析，带单测）、
`src-tauri/src/ai.rs`（写提示词文件、写 models.json、取密钥、拼环境变量、起会话）、
`src/renderer/src/workbench/ai.ts`（按会话 id 前缀认领进程事件）、
`src/renderer/src/stores/ai.ts`（编排）、`src/renderer/src/components/AiView.vue` 与
`AiModelDialog.vue`（页面与模型配置）。

- **这一页是通用控制台，与知识库无关**：工作目录由用户挑（`aiWorkDir`，与知识库的 `kbDir`
  互不相干）、指令由用户写（`shared/ai.ts` 的 `taskPrompt` 只把「在哪儿干活」说清楚）。
  **不内置任何一类任务的提示词、也不在跑完之后做与具体任务绑在一起的事**（不重建索引、
  不刷新谁的列表）—— 处理知识库只是「把目录指到那个仓库、写一条照它规范整理的指令」的一种
  用法。要做「知识库专用任务」，在这一层上面加模板，别往下面这条链路里塞分支。
- **干活的不是应用，是本机的 Pi**（一个开源的编码 Agent）：**Pi 随包内置**，Node 用系统里的。
  内置的形态由 [scripts/vendor-pi.mjs](../../scripts/vendor-pi.mjs) 在构建 / 开发前生成到
  `resources/pi/`（不进版本库，见 .gitignore）：装**钉死版本**的 Pi，再删掉运行时用不到的
  云厂商 SDK（`@aws-sdk`、`@smithy`、`@google`、`@esbuild`、`openai`、`@anthropic-ai`、
  `web-streams-polyfill` —— Pi 的提供方层走它自己的 HTTP 客户端，实测删掉后 Anthropic /
  OpenAI / DeepSeek 三条路都照常发出真实请求）。瘦身后 75MB，给安装包增加约 10MB；
  不瘦身是 143MB。**Node 不内置**：跑内置 cli.js 要本机 node ≥ 22.19（版本判定在
  `shared/ai.ts` 的 `nodeSatisfiesPi`），跑不起来整个 AI 助手页明说原因。
  **升级 Pi** = 改 vendor 脚本里的版本常量 + 重跑 `npm run vendor:pi` + 把下面的瘦身验证
  重新做一遍（假 key 打一轮每个要用的提供方）。
- **干活的进程直启、不经 `cmd /C`**：`session::spawn_args`（程序 + 参数数组，与 git 直启
  同一条理由）—— 整行交给 cmd 时，**行内层引号会被 cmd 的引号剥离规则拆坏**（实测：
  cli.js 路径带引号时 node 收到的是被剥得只剩盘符的路径，报 EISDIR）。提示词随之不走
  shell 重定向：Rust 写进临时文件，以 Pi 自己的 `@文件` 语法追加在最后一个参数上。
- **内置 cli.js 的路径解析有两处候选**（`ai.rs` 的 `resolve_cli`，与内置壁纸同一条路子）：
  打包后走 `resource_dir()/pi/...`，开发态读仓库 `resources/pi/`；两处都没有才退回 PATH 上
  的全局 `pi`。**resource_dir 给的是 `\\?\` 原样路径，必须剥掉前缀再用** —— cmd / 与若干
  程序对这种前缀的处理都不可靠（踩过：node 收到只剩盘符的路径）。
- **模型配置是自定义端点形态**（照通用客户端的样子）：一个提供方 = 名称 + Base URL +
  API 形态 + 密钥 + 模型清单（可启停）。四样东西的落点各不相同 ——
  名称 / Base URL / API 形态 / 清单进**设置**（`aiProviderName` / `aiBaseUrl` / `aiApiFormat` /
  `aiModels`，形状与收敛在 [shared/ai.ts](../../src/shared/ai.ts)）；
  密钥进 **Windows 凭据管理器**（`Workbench/ai/<名称>/token`，只写不回显）；
  端点本身由 `ai.rs` 的 `provider_write` 写成 Pi 的 **`models.json`**，
  落在 `%APPDATA%\Workbench\data\pi\`（`PI_CODING_AGENT_DIR` 指过去的那份 agent 目录，
  与用户全局的 `~/.pi` 互不掺和）。
  **`models.json` 里的 `apiKey` 是环境变量引用**（`$WORKBENCH_AI_KEY`，Pi 的插值语法）——
  密钥值只经环境变量注入，那份文件从头到尾不落明文。
  **API 形态只认登记过的那两个 id**（`openai-completions` / `anthropic-messages`，见
  `shared/ai.ts` 的 `AI_API_FORMATS`）：都来自 Pi 自己的材料，别凭印象加。
  跑的是清单里**第一个启用的**模型，走 `PI_MODEL=<名称>/<模型>` 寻址。
- **别把「读懂并改写内容」搬进应用**（在 Rust / TS 里写死一套改写逻辑）：怎么拆、怎么组织
  由用户与目录里的规范（AGENTS.md 之类）说了算，那是 Agent 的活；应用只做三件事 ——
  把目录与指令交给它、准备模型与密钥、把过程与结果画出来。
- **提示词与密钥都不经过渲染层**：提示词由 `ai.rs` 写进 `%TEMP%\workbench-ai-prompt.md`，
  起进程时以 Pi 的 `@文件` 语法追加在参数末尾（它含中文与换行，走命令行必炸）；
  密钥存在凭据管理器里，只在起进程时注入**环境变量**
  （命令行参数在进程列表里是明文）。
- **替 Pi 关掉它自己的出网旁路**：起进程时注入 `PI_TELEMETRY=0` 与 `PI_SKIP_VERSION_CHECK=1` ——
  它默认会报安装 / 更新遥测、并向 pi.dev 查最新版本，那两条不在任何已登记的出口里。
  **这两条不许删**，删了就变成「应用替用户向第三方发请求」。
- **工具面只留 read / write / edit**（`-xt bash,powershell`）：整理条目用不着执行命令，
  关掉之后「不跑脚本、不碰 `data/raw` 之外的东西」才有个硬边界。索引因此由应用自己重建
  （见下一条），别把它交回给 Agent。
- **模型请求由 Pi 自己发**（直连用户配的那个端点），这是第 8 条出口、且由用户显式开启：
  名称 / Base URL / API 形态 / 模型 / 密钥缺一样界面上就跑不起来（`canRun` 会拦）。注意
  **它在这个目录里读到的内容会发给那个端点** —— 与天气的城市名同一条性质，文档里要如实写。
- **一次一轮**：同一时刻只跑一个整理任务（会话 id 固定 `ai:organize`，界面按 `running` 挡重复点击）。
  停止按进程树杀（复用 session.rs 的 `stop`），退出码由 `stores/ai.ts` 收尾。
  日志里先写一遍「要跑什么」（出问题时用户手上唯一的线索），模型侧的失败（message 的
  errorMessage）要落成错误行，跑完但有报错时状态行不能装作顺利。
- **索引重建是仓库脚本的等价实现**：`kb.rs` 的 `index_build` 与知识库仓库的
  `scripts/build_index.py` **逐字节一致**（含 CRLF 换行、那个「请勿手改」的文件头与 JSON 的键顺序），
  `generated_at` 由渲染层按本机时区算（`shared/kb.ts` 的 `todayIsoDate`）。
  改输出格式要两边一起改，否则谁最后跑的会把对方的重写掉。有一条标了 `#[ignore]` 的手工核对
  （`cargo test -- --ignored crosscheck`）拿真知识库的副本比对 —— 动过 `index_build` 就跑一次。
- **明确不做**：订阅登录（要走 Pi 自己的 `/login`）、云厂商的原生协议（Bedrock / Vertex / Azure ——
  那几家的鉴权要装回各自的 SDK，与瘦身冲突）、会话续跑（一次性跑完就完）、
  把模型清单内置进来（各家的模型名变得太快，由用户按端点的叫法填）。
