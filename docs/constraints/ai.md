# AI 助手

从 [AGENTS.md](../../AGENTS.md) 第 5 节拆出的硬约束（AI 助手页）；功能说明见
[features-and-architecture.md](../features-and-architecture.md) 的「AI 助手（ai）」一节。

关键落点：`src/shared/ai.ts`（模型配置的形状与收敛、思考档位、工具权限、**会话的形状 / 收敛 /
标题 / 分组**、提示词、启动参数、事件与 RPC 帧的解析、指令历史的收敛、**历史消息 → 日志行**，
带单测）、`src-tauri/src/ai.rs`（把提示词写进子进程的 stdin、写权限扩展、写 models.json、
取密钥、拼环境变量、起会话、**会话文件目录与按 id 删会话**）、
`src/renderer/src/workbench/ai.ts`（按会话 id 前缀认领进程事件、认扩展的确认帧、把答复写回
那条会话的 stdin、**RPC 的命令应答配对（`aiRequest`）、停止（`aiAbort`）与会话删除**）、
`src/renderer/src/stores/ai.ts`（编排、每个会话一份运行态、确认队列）、
`src/renderer/src/components/AiView.vue`（左树右对话两栏）、
`AiSessionTree.vue`（左栏那棵两层树：项目 → 会话）、
`AiLocationBar.vue`（这一段在哪个目录里干活）、`AiComposer.vue`（在选中的会话里说一句，
左边是权限那一栏）、`AiRunPanel.vue`（对话的画法、等确认的那一条命令）、
`AiModelDialog.vue`（模型配置）。

- **会话是这里的头等对象**：一个会话 = **一个工作目录里的一段连续对话**，与 Pi 自己的
  会话文件一一对应（见下面「会话留档」那条）。`aiSessions` 里只存调度用的那点东西
  （id / dir / title / createdAt / updatedAt，收敛在 `shared/ai.ts` 的 `sanitizeAiSessions`），
  对话本身不在应用的数据文件里。左栏那棵树按 `dir` 分组（`aiSessionGroups`）：
  **第一层是项目（一个目录）、第二层是这个目录下的会话**。
  **工作目录在会话里是定住的、创建后不改**：Pi 按目录给会话分组，换目录等于换一段对话 ——
  要换目录就新建一个会话（左栏那颗「+」或者项目行上那颗）。
  `aiActiveSession` 记「上次打开的是哪一个」（认不出来的回最近说过话的那个）。
- **这一页是通用控制台，与知识库无关**：工作目录由用户挑（跟着会话走，与知识库的 `kbDir`
  互不相干）、指令由用户写（`shared/ai.ts` 的 `taskPrompt` 只把「在哪儿干活」说清楚）。
  **不内置任何一类任务的提示词、也不在跑完之后做与具体任务绑在一起的事**（不重建索引、
  不刷新谁的列表）—— 处理知识库只是「把目录指到那个仓库、写一条照它规范整理的指令」的一种
  用法。要做「知识库专用任务」，在这一层上面加模板，别往下面这条链路里塞分支。
  **新任务那一屏下方那排 chips 是用户自己写过的指令**（`aiHistory`，起进程之前记一条，
  跑没跑起来都算用过），点一下填回输入框 —— 不是预设模板，别把它做成内置任务。
- **两屏的分界是「挑中了没有」**：挑中一个会话（包括还没说过话的新会话）就是控制台那一屏，
  一个都没挑中才是新任务那一屏（`AiView.vue` 的模板）。装 Pi 的输出也算控制台那一屏
  的一部分（它画在运行面板里）。
- **控制台那一屏画的是聊天，不是步骤流**（`AiRunPanel.vue`，这一版的口径）：
  **用户自己写的那几句靠右**（浅底气泡、限宽 72%），**助手的话在左**（正文，无气泡框 ——
  它常常几屏长，框住只会少一圈阅读面积）；工具调用与系统那几行是浅灰的窄行注脚；
  一轮跑完在末尾补一行「用时 …」（`formatDuration`，它是这一轮的句号）。
  **回话是流式长出来的**（`message_update` › `text_delta`，`parsePiDelta` +
  `stores/ai.ts` 的 `onDelta`）：增量攒到 `STREAM_TICK`（80ms）才发布一次 —— 每个字都重画
  一遍对话区（还要重跑一遍 markdown）是白烧钱，攒一小会儿看着仍是连续长出来的；
  **整段到了（`message_end`）就以它为准**（增量拼起来只是过程版）。思考增量、
  块的开头结尾（`text_start` / `text_end`）都不画（与读历史那条路同一条口径）；
  被停掉的那一轮把已经吐出来的部分留在对话里（`endStream` 的 `keep`）。
  **轮与轮之间的「开始执行 / 执行结束」不画**（`stores/ai.ts` 的 `isTurnMarker`）——
  那种分节放在单次运行的步骤流里合适，连续对话里就是每轮插一句的噪音。
  **对话区自己不许铺底色、也不描边**（别写 `background: var(--bg-inset)` 那一类）：
  这一块就是那张卡片本身，底色归 `.panel` 与卡片不透明度管 —— 在它里面再铺一层灰底，
  用户看到的就是一大块灰压在对话上（踩过，已改）。
- **这一页不摆提示行**：说明、问候、「还差什么」都不写在页面上 —— 缺什么由 `blocking` 说，
  而它只出现在**发送按钮的悬停**里（`AiComposer.vue` 的 `sendTitle`）；问候只有顶栏那一处
  （见 HomeGreeting 的文件头）。页面上留下的字只该是控件自己的：标题、输入框的 placeholder、
  composer 里那句工具边界。这个应用是给作者自己用的，把控件已经说清的事再讲一遍就是噪音 ——
  与首页那一行「不打招呼、不问好、不鼓励」同一条语气。别再加「点这里开始」「第一次用？」
  这类引导。
- **干活的不是应用，是本机的 Pi**（一个开源的编码 Agent）：**Pi 随包内置**，Node 用系统里的。
  内置的形态由 [scripts/vendor-pi.mjs](../../scripts/vendor-pi.mjs) 在构建 / 开发前生成到
  `resources/pi/`（不进版本库，见 .gitignore）：装**钉死版本**的 Pi，再删掉运行时用不到的
  云厂商 SDK（`@aws-sdk`、`@smithy`、`@google`、`@esbuild`、`openai`、`@anthropic-ai`、
  `web-streams-polyfill` —— Pi 的提供方层走它自己的 HTTP 客户端，实测删掉后 Anthropic /
  OpenAI / DeepSeek 三条路都照常发出真实请求）。瘦身后 75MB，给安装包增加约 10MB；
  不瘦身是 143MB。**Node 不内置**：跑内置 cli.js 要本机 node ≥ 22.19（版本判定在
  `shared/ai.ts` 的 `nodeSatisfiesPi`），跑不起来整个 AI 助手页明说原因。
  **升级 Pi** = 改 vendor 脚本里的版本常量 + 重跑 `npm run vendor:pi` + 把下面的瘦身验证
  重新做一遍（假 key 打一轮每个要用的提供方），**会话、续聊、权限扩展与确认帧那条链**照
  [dev-notes/pi-session-probe.md](../dev-notes/pi-session-probe.md) 的假端点探针再跑一遍。
- **干活的进程直启、不经 `cmd /C`**：`session::spawn_args`（程序 + 参数数组 + 一根
  **可写的 stdin**，与 git 直启同一条理由）—— 整行交给 cmd 时，**行内层引号会被 cmd 的引号
  剥离规则拆坏**（实测：cli.js 路径带引号时 node 收到的是被剥得只剩盘符的路径，报 EISDIR）。
  提示词与确认答复都走那根 stdin（见下面两条），不落临时文件、也不走 shell 重定向。
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
  跑的是页面上**挑的那颗模型**（`aiRunModel`，行为记忆）：挑的没了（被关停 / 删掉）退回清单里
  第一个启用的，成不成看 `shared/ai.ts` 的 `pickAiModel`；**只由启动参数
  `--provider <名称> --model <模型>` 指定**
  （`shared/ai.ts` 的 piLaunch，有单测）：内置 Pi **不读 `PI_MODEL` 环境变量**，`models.json`
  里的清单它也只当候选 —— 两处都不给时它退到自己那张内置的「提供方 → 默认模型」表上
  （踩过：提供方叫 `opencode-go` 时它按内置表发了 `kimi-k2.6`，用户清单里的
  `deepseek-v4.1-flash` 一个字没用上，端点回 410 说这个模型已下线）。
  **验法**：把 `models.json` 的 baseUrl 指向一个本地假端点（回 400 即可），看它实际请求的
  `model` 字段 —— 比读文档可靠；换 Pi 版本后要重验这一条。
- **思考档位也总是显式给**（`--thinking <level>`，`aiThinking`）：那七档是 Pi 自己认的
  （`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，取自它的 `defaults.js`），
  **id 一个字符都不能改** —— 给它不认的值它会直接报错退出；界面上叫什么叫由
  `shared/ai.ts` 的 `AI_THINKING_LEVELS` 定（默认档 `medium`，与 Pi 自己的默认一致）。
  不显式给也能跑，但界面上挑了什么与它真跑的是什么就对不上了 —— 所以总是给。
- **别把「读懂并改写内容」搬进应用**（在 Rust / TS 里写死一套改写逻辑）：怎么拆、怎么组织
  由用户与目录里的规范（AGENTS.md 之类）说了算，那是 Agent 的活；应用只做三件事 ——
  把目录与指令交给它、准备模型与密钥、把过程与结果画出来。
- **提示词与密钥都不经过渲染层**：Pi 跑 **RPC 模式**（`--mode rpc`），提示词是 **stdin 上的
  一行 JSON**（`{"type":"prompt","message":…}`，`ai.rs` 的 `prompt_frame`）—— 它含中文与
  换行，走命令行必炸；提示词因此既不落临时文件、也不进参数。**一句一轮，写的是同一根 stdin**：
  第一句由 `ai_run` 起进程时写，之后每一句都是同一条命令（进程在就只写这一句，见下面
  「一个会话一个进程」那条）。密钥存在凭据管理器里，只在起进程时注入**环境变量**
  （命令行参数在进程列表里是明文）。
- **提示词开头那行脚手架不进界面**：`taskPrompt` 造出来的提示词是
  「`你在下面这个目录里工作：<目录>` + 空行 + 用户原文」（`AI_PROMPT_PREFIX`），模型看见的
  就是这一整份、落盘的也是它；但**界面上只显示用户自己写的那段** —— 读历史时用
  `visibleInstruction` 把那行剥掉。不剥的话，用户会在自己的气泡里看见一句他从来没写过的话
  （踩过：一整条气泡里就那行最显眼）。改那行字面量要连着 `AI_PROMPT_PREFIX` 一起改。
- **会话留档由 Pi 写，落点由我们钉住**：起进程时传 `--session-id <会话 id>` 与
  `--session-dir <数据目录>/pi/sessions`（`ai.rs` 的 `sessions_dir`）—— **不传
  `--no-session`**（那是「跑完即弃」时代的写法）。一段对话一份
  `<时间戳>_<会话 id>.jsonl`，Pi 自己写、自己续；**默认落点是用户全局的
  `~/.pi/agent/sessions/`，必须用 `--session-dir` 拨到应用的数据目录下**（与
  `PI_CODING_AGENT_DIR` 同一条理由：自己的东西自己收着）。
  **续聊与「重启后还在」就是同一个 id 再起一个进程**（实测：进程杀掉后按同一个 id 重开，
  `get_messages` 读得回全部历史；杀在半路也不留半行坏数据），应用不自己攒上下文。
  **删会话**（`ai_session_delete`）认的是**会话文件首行的 header 里的 id**
  （`{"type":"session","id":…}`），不认文件名 —— 时间戳与目录分组是 Pi 的实现细节。
  删之前**先把进程收掉**（活着的进程还在往那个文件里写，Windows 上删不掉）。
- **打开会话要把历史读回来**：`get_messages`（RPC）→ `sessionMessagesToLines`
  （`shared/ai.ts`）→ 对话区。**只有活的进程才答得出来**，所以打开会话时先按空提示词起一次
  进程（`ai_run` 的 `prompt` 空串 = 只起进程），再问它要消息；读过的会话（`hydrated`）不再读，
  之后的对话由事件流接着往上接。系统消息与工具结果的原文**整条丢掉**（前者是提示词与工具
  清单、后者一次几百行），只留用户说的话、助手的正文与工具调用那几行。
  **还没说过话的会话（标题为空）直接跳过这一趟**：没有历史可读，为它起一次进程等于白花
  一两秒（用户看得出来是「卡了一下」）。第一句发出去时进程自然会起来。
  Pi 起进程时那句 `Warning: No project session found with id …` 也是这么来的 ——
  **那是我们要求的**（新会话就是这么建的），别画进对话里（`shared/ai.ts` 的 `BENIGN_STARTUP`）。
- **一个会话一个进程**（进程会话 id 是 `ai:<会话 id>`，`workbench/ai.ts` 的
  `aiSessionProcessId`）：一轮跑完**不收进程**（上下文就在它那儿），所以同一个会话可以一句
  一句聊下去；**几个会话可以同时在跑**（`runs` 是一张按会话 id 分的表，界面一次只画一个）。
  模型 / 档位 / 权限这三样是**起进程时定死的**（`--model` / `--thinking` / 那份权限扩展加不
  加载）：改设置之后闲着的会话当场收掉、正在跑的等这一轮跑完收掉（`stale`），下一句按新参数
  重开、历史从会话文件接上。**别把「跑完就杀」写回来** —— 那正是「单次对话」的成因。
- **替 Pi 关掉它自己那三条出网旁路**：起进程时注入 `PI_TELEMETRY=0`、
  `PI_SKIP_VERSION_CHECK=1` 与 `PI_OFFLINE=1` —— 它默认会报安装 / 更新遥测、向 pi.dev
  查最新版本，**RPC 模式启动时还会去刷一遍模型目录**（print 模式没这一下，换到 RPC 才出现；
  实测关掉后真正的模型请求照常）。这三条不在任何已登记的出口里，
  **不许删**，删了就变成「应用替用户向第三方发请求」。
- **工具面全开，问不问由权限模式定**（`aiPermission`，composer 左边那一栏，形状与收敛在
  `shared/ai.ts` 的 `AI_PERMISSION_MODES` / `sanitizeAiPermission`，默认自动编辑）：
  `auto-edit`（自动编辑）时 `ai.rs` 会写一份 **Pi 扩展**（agent 目录下的
  `permission.js`，全文是 `ai.rs` 里的一个常量：`pi.on("tool_call")` 里对 bash / powershell
  调 `ctx.ui.confirm`，答否则 `{ block: true, reason }` 把这次调用挡回去）并以 `-e` 加载；
  `full`（完全访问）不加载任何扩展 —— **「不问」是「没有扩展」，不是扩展里判了一下**。
  **不再传 `-xt bash,powershell`**；命令跑起来之后「不碰这个目录之外的东西」不再成立
  （那是命令本身的能力），拦住它的是自动编辑那一问 —— 两档的差别只有这一件事，
  读写文件两档都不问。
  **扩展文件只在内容变了的时候重写**：好几个会话可以同时起进程，每次都截断重写的话，
  另一个进程可能正好在这会儿加载它、读到半份。
- **扩展问的那一句要能答得回去**：RPC 模式下 `ctx.ui.confirm` 是 stdout 上的一条
  `extension_ui_request`（`shared/ai.ts` 的 `parsePiConfirm`），确认条画在运行面板的对话
  末尾（`AiRunPanel.vue`），答复是 `{"type":"extension_ui_response","id","confirmed"}`
  （`confirmFrame`）经 `session_write` 写回**同一条 stdin**。确认可能同时压着好几条
  （一轮里的工具调用是并发的），`stores/ai.ts` 用队列排着，答的是按 id 认的那一条。
  **确认是排在那条会话上的**：切到别的会话去干别的，那一条还在原来那个会话的运行面板里等着
  （左栏那一行的小圆点表示它还在跑）。
  **别在扩展里做 print 模式的兜底**：`--print --mode json` 下扩展的 UI 是空实现
  （`ctx.ui.confirm` 一律回 false），命令只会被全挡掉 —— 要问一句就得跑 RPC。
- **一轮的结束判据是 `agent_settled`，不是退出码**：RPC 的进程跑完不会自己退（等下一条命令
  才动），收到那条事件就是这一轮完了（`stores/ai.ts` 的 `settle`）—— **进程留着**。
  退出码只在**没跑完**时才算数：我们让它停的（用户点了停止 / 换了参数）不算失败，
  它自己退的非零退出码要如实说成「这一轮没有跑完」。事件流本身与
  `--print --mode json` 是同一份序列化（Pi 里那个 `toJsonEvent`），画步骤那一套照旧。
- **要读结果的命令靠应答配对**：`get_messages` / `abort` 这类命令的应答是 stdout 上的
  `response` 帧，请求自己带一个 id、应答原样带回来（`shared/ai.ts` 的 `parsePiResponse` +
  `workbench/ai.ts` 的 `aiRequest`）。**配上对的应答不再当日志画**（读回来的数据不是给人看
  的）；超时与进程退出都当失败，一条等不到应答的命令不该把界面吊死。
- **模型请求由 Pi 自己发**（直连用户配的那个端点），这是第 8 条出口、且由用户显式开启：
  名称 / Base URL / API 形态 / 模型 / 密钥缺一样界面上就跑不起来（`canRun` 会拦）。注意
  **它在这个目录里读到的内容、以及这一段会话的历史都会发给那个端点**（聊得越久发得越多，
  这是「连续对话」的代价）—— 与天气的城市名同一条性质，文档里要如实写。
- **一个会话一次一轮**：同一个会话里跑着一轮时发送那颗按钮是停止，按会话挡重复提交；
  **几条会话可以同时在跑**（互不相干，`runs` 按会话 id 分开）。
  **停止走 RPC 的 `abort`**（进程留着、上下文留着、这一轮正常收尾），**应答没回来**
  （卡在某个请求上答不出来）再按进程树杀（复用 session.rs 的 `stop`）—— 那颗按钮什么时候
  都得有用。一轮跑完在对话末尾补一行**用时**（跑没跑完都补；被停掉的那一轮由 `finish` 补）。
  换过参数重开进程时，对话里先写一行「在哪个目录里工作」，**那条命令行（含 cli.js 的绝对
  路径与一串开关）收进这一行的悬停提示**（`AiLogLine.detail`）——摆在正文里只会把对话开头
  堵死；同一个进程接着聊时不必每轮都写一遍。模型侧的失败（message 的 errorMessage）要落成
  错误行，**跑完但有报错时状态行不能装作顺利；顺利跑完则不留状态行**（跟用户说一句
  「跑完了」没有信息量）。
- **索引重建是仓库脚本的等价实现**：`kb.rs` 的 `index_build` 与知识库仓库的
  `scripts/build_index.py` **逐字节一致**（含 CRLF 换行、那个「请勿手改」的文件头与 JSON 的键顺序），
  `generated_at` 由渲染层按本机时区算（`shared/kb.ts` 的 `todayIsoDate`）。
  改输出格式要两边一起改，否则谁最后跑的会把对方的重写掉。有一条标了 `#[ignore]` 的手工核对
  （`cargo test -- --ignored crosscheck`）拿真知识库的副本比对 —— 动过 `index_build` 就跑一次。
  **别把索引交回给 Agent**：命令现在是能力之一，但索引仍归应用自己重建（它要的是「谁跑的
  结果都一样」）。
- **明确不做**：订阅登录（要走 Pi 自己的 `/login`）、云厂商的原生协议（Bedrock / Vertex / Azure ——
  那几家的鉴权要装回各自的 SDK，与瘦身冲突）、把模型清单内置进来（各家的模型名变得太快，
  由用户按端点的叫法填）。
  **会话续跑已经在做**（会话文件 + 同一个 id 再起进程，见上面「会话留档」那条），
  但**不做的**是：会话改名（标题取第一条指令，之后不改）、跨目录搬会话（Pi 按目录分组，
  搬了等于换一段对话）、`/tree`、`/fork`、`/clone` 那些 Pi 自己的分支玩法 ——
  要在界面上做就得把 Pi 的会话树整套搬过来，现在只做「一段对话接着聊」。
