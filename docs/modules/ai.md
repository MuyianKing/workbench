# AI 助手（ai）

AI 助手（ai）的文档：先读「约束」一节（不能破的规矩）；「实现」一节装为什么这么做、踩过哪些坑。
跨模块的通用事实（导航壳层、数据与隐私、目录结构）见
[features-and-architecture.md](../features-and-architecture.md)，跨模块红线见 [AGENTS.md](../../AGENTS.md)。

## 约束

关键落点：`packages/ai/src/ai.ts`（服务 / 模型 / 会话的形状与收敛、`thinkingLevelMap`、提示词、启动参数、RPC 帧解析、
历史消息 → 日志行，带单测）、`packages/ai/src/ai-preview.ts`（回答里的站内链接 → 预览目标的解析与画法判定，带单测）、
`packages/ai/src/pi-skills.ts`（技能的根与开关键、交给 Pi 的清单，带单测）、
`apps/desktop/src-tauri/src/pi_skills.rs`（技能的列 / 装 / 卸、手写 zip 与 `Location` 跳转，带单测）、
`apps/desktop/src-tauri/src/ai.rs`（提示词进 stdin、权限扩展、models.json、拉模型列表、密钥、环境变量、起会话、拼 `--skill`、删会话）、
`workbench/ai.ts`（按会话 id 认领进程事件、确认帧应答、`aiRequest` / `aiAbort` 与会话删除）、
`workbench/pi-skill.ts`（技能四条通道适配）、`stores/ai.ts`（编排、每会话运行态、确认队列、服务增删改与 models.json 对齐）、
`stores/ai-skills.ts`（两栏扫描、开关、装 / 卸）；组件：`AiView.vue`（左树右对话，左栏底部一行是技能入口与收起开关）、
`AiSessionTree.vue`、`AiLocationBar.vue`（两屏共用）、`AiComposer.vue`（贴图缩略图与 `/skill:` 候选）、
`AiSkillDialog.vue`、`AiRunPanel.vue`（对话画法与确认条）、`AiPreviewPane.vue`（右侧预览栏）、
`AiModelDialog.vue` / `AiProviderDialog.vue` / `AiPresetGrid.vue` / `AiModelPicker.vue`（模型管理三层）。

- **会话是头等对象**：一个会话 = 一个工作目录里的一段连续对话，与 Pi 的会话文件一一对应。
  `aiSessions` 存调度字段（id / dir / title / createdAt / updatedAt，收敛见 `sanitizeAiSessions`）
  **加这个会话自己的一份配置**（provider / model / thinking / permission 四个可选字段，
  同函数收敛 —— 认得出才记，坏值不写字段）：**composer 那一栏（权限 / 模型 / 档位）每个会话
  各自独立**，起进程参数（`--provider` / `--model` / `--thinking` 与那份权限扩展）按会话自己的
  生效配置取（stores/ai.ts 的 `configOf`）；没记过的回落设置里的默认（老会话不用迁移），
  在会话上改任何一样就把**那一刻生效的四样一起快照**进它；起始屏（还没建会话）改的才是
  设置默认 —— 之后新建的对话用它起步。配置变了要收进程重开：按会话精确收（哪个会话变了
  收哪个），改服务那种整份 models.json 重写的入口仍旧全收。
  对话本身不在应用的数据文件里；左栏按 `dir` 分组（`aiSessionGroups`），第一层项目、第二层会话。
  **工作目录创建后定死**（Pi 按目录分组，换目录等于换对话），要换就新建；`aiActiveSession` 记上次打开的那个
  （认不出回最近说过话的）。**「起一段新的」只是切屏**（`drafting` / `startNew`），**不先建空会话**；
  `drafting` 期间 `activeId` 为空（左栏哪行都不铺底色）。
- **这一页是通用控制台，与知识库无关**：目录由用户挑（与 `kbDir` 互不相干）、指令由用户写（`taskPrompt`
  只把「在哪儿干活」说清楚）；**不内置任务提示词、跑完不做任何与任务绑定的事**（不重建索引、不刷新列表）——
  要做专用任务就在这层上面加模板。起始屏**不摆「用过的指令」**（`aiHistory` 已整体去掉，2026-09-29）——
  别加回来，也别拿预设模板填。
- **起始屏中间就是那条 composer**：一进来就能写，**会话在发出第一句时才建**（`run` → `ensureSession`，
  用那一屏挑好的目录）—— 别改回「先建会话再跳过去」。那一屏没有线稿没有标题，中间一张输入卡片；
  空会话时左栏用 `.tree__empty` 空态（标题 + 一行小字，不成块不描边）。
- **位置栏（`AiLocationBar.vue`）两屏共用**：挑中会话时目录定死（下拉只有「打开 / 复制路径」），
  起始屏上它就是挑目录的地方（最近目录 + 「选择其他目录…」，只记在 `newDir`，不建会话）。
  那格 git 分支是**页面自己的显示**：AiView 拿着 `watchedDir` 去探（`aiRepoState`），store 只留
  「当前盯着的目录」那一位 —— `ai-skills` 的项目技能根也跟着它走，**别把它挪进组件**。
- **两屏分界是「挑中了没有」**（`AiView.vue` 的模板）；装 Pi 的输出画在运行面板里。
  **「安装 Pi」两屏各一颗**（控制台在运行面板顶部通知条，起始屏在 composer 底下），发送按钮的悬停里说的也是它。
- **控制台画的是聊天不是步骤流**（`AiRunPanel.vue`）：用户几句靠右（气泡限宽 72%），助手正文在左、**无气泡框**
  （几屏长的正文框住只会少阅读面积）；工具与系统行是浅灰窄行注脚；轮尾补「用时 …」，端点报了消耗同轮带上 token
  （`parsePiUsage` 拆 `usage`、按轮累加，输入含缓存读 / 写；没报就只有用时）。**回话流式长出**（`message_update` ›
  `text_delta`）：增量攒到 `STREAM_TICK`（80ms）发布一次（逐字重画白烧钱）；`message_end` 的整段为准；块首尾不画；
  被停的那轮保留已吐出的部分（`endStream` 的 `keep`）。**一轮 = 用户那句 + 过程 + 答案 + 收据**（`aiTurns` 切轮、
  `AiProcess.vue` 画，都有单测）：过程默认收着、跑着摊开（标题转圈）、跑完自动收，点标题再摊；
  **答案只认收尾时紧挨收据的那段正文**（后面还跟工具 / 思考行的都是旁白，旁白照常渲染 markdown、跟着过程收）；
  收据只收轮尾成串的「用时 …」，报错不进收据。**跑着的那轮不摘答案**，收尾才弹出。
  想的几段（`thinking_delta`，同一节流）走**纯文本**，一段以 `thinking_end` 整块为准；历史里的 `thinking` 块同样认
  （脱敏空块不画）。**顶部状态行只说等确认 / 接历史 / 在停 / 装 Pi / 出错**，「运行中」的动静跟过程块走
  （转圈 + 正文末尾竖条）。**轮间「开始执行 / 执行结束」不画**（`isTurnMarker`）—— 连续对话里是噪音。
  **对话区不铺底色、不描边**（底色归 `.panel` 与卡片不透明度，再铺一层就是灰压在对话上）。
- **正文里的站内链接与「写下 N 个文件」都点得动，开进右侧预览栏**（`AiPreviewPane.vue`，
  DOCX / PPTX / HTML 三个画法各是 `AiPreviewDoc` / `AiPreviewSlides` / `AiPreviewHtml`）：
  这是**页内的分栏面板，不是弹层**（读文件与继续看对话要同时进行，AppDialog 那套不适用）。
  **一个文件一个 Tab**（`previews` + `activeKey`，行上的 × 关那一个，全关了整栏收起、
  对话占满整行；切 Tab 是 v-show 保活，PPTX 不重解析；再点同一个文件 = 摊开它并重读一遍）；
  **宽度拖预览栏左缘那条缝改**（`use-pointer-drag`，280 起、给对话留一截，不落盘重启回默认）。
  只有非 http(s) / mailto 的地址会进预览（外部地址照旧交系统浏览器，见 MarkdownView 的 `internalLinks`），
  相对地址一律对到**会话工作目录**解析（口径唯一出处 `resolveAiPreview`，`../` 出目录是本意）；
  画法按扩展名：markdown / html 按正文渲染（html 走**沙箱 iframe**，`sandbox` 全禁 —— AI 写的
  HTML 里若有脚本，绝不能在带宿主能力的 webview 里执行，这是硬边界）、图片显示原图、
  docx / pptx 交给渲染库（`docx-preview` / `@aiden0z/pptx-renderer`，二者**不出网**：资源都出自文件
  本身，pptx 的 pdf.js 兜底必须显式 `pdfjs: false` 关掉 —— 那是潜在的新出口；库都是动态引的，
  不用就不进包）、其余文本等宽原文；docx / pptx 的二进制经 `fs_read_base64`（commands.rs，
  base64 已在依赖图里）回传，解码用 `decodeBase64ToBuffer`；读不到 / 超限（文本 2 MB、
  二进制约 24 MB，`AI_PREVIEW_MAX_*`）就地给一行错因；**Excel（.xlsx/.xls）与老二进制格式
  （.doc/.ppt）明确不支持**，解析那层就给出理由、不掉进文本通道读乱码。换会话（换工作目录）
  预览整栏收起。
- **这一页不摆提示行，弹窗里也不写说明段**：缺什么由 `blocking` 说（它长在 composer 上，与 `canRun`
  一处 —— 「能不能发、还差什么」是那条输入框自己的事），只出现在**发送按钮的悬停**里（`sendTitle`）；
  页面上只留控件自己的字（栏名、placeholder、composer 里那句工具边界），与首页「不打招呼不问好」同一条语气。
  弹窗里没有「只留一句」的余地：说明句、空态提示、生效时机说明全不写，只有控件与数据；
  例外是**技能弹窗组头的根路径与计数徽标**（那是数据不是说明句）。别加「点这里开始」类引导。
- **干活的不是应用，是本机 Pi**：**随包内置**，Node 用系统里的（≥ 22.19，判定在 `nodeSatisfiesPi`，
  跑不起来整页明说原因）。内置形态由 [scripts/vendor-pi.mjs](../../apps/desktop/scripts/vendor-pi.mjs)
  在构建 / 开发前生成到 `resources/pi/`（不进版本库）：钉死版本、删掉运行时用不到的云厂商 SDK ——
  真正被执行的只有 `dist/bundle/cli.js`，它只要 `@earendil-works/chord`、`typebox`、`undici`、
  `@silvia-odwyer/photon-node` 几个外部包；pi-coding-agent 自带 `npm-shrinkwrap.json`、整棵树嵌在自己的
  `node_modules` 下，按顶层路径删会一声不响地空转（`findDeps` 就为此写）。瘦身后 55.5MB（Pi 1.0.4；这一轮删掉 62.3MB，2026-10-06 实测）。
  **升级 Pi** = 改版本常量 + 重跑 `pnpm run vendor:pi` + 瘦身验证重做（假 key 打一轮每个提供方），
  会话 / 续聊 / 权限扩展 / 确认帧那条链照 [dev-notes/pi-session-probe.md](../dev-notes/pi-session-probe.md)
  的假端点探针重跑。
- **进程直启、不经 `cmd /C`**（`session::spawn_args`，带一根可写 stdin）：整行交给 cmd 会被它的引号剥离规则拆坏
  （实测 node 收到只剩盘符的路径）。提示词与确认答复都走那根 stdin，不落临时文件、不走 shell。
- **内置 cli.js 路径两处候选**（`resolve_cli`，与内置壁纸同一条路子）：打包走 `resource_dir()/pi/...`，
  开发态读仓库 `resources/pi/`，都没有才退回全局 `pi`。**`resource_dir` 给的 `\\?\` 前缀必须剥掉再用**。
- **模型管理是「服务 + 模型」两层**：一个服务 = 名称 + Base URL + API 形态 + 密钥 + 模型清单，每条模型带
  上下文窗口、最大输出、思考档位、能看图（形状见 [shared/ai.ts](../../packages/ai/src/ai.ts) 的
  `AiProvider` / `sanitizeAiProviders`）。落点：名称 / 地址 / 形态 / 清单进设置（`aiProviders`）；
  密钥进凭据管理器（`Workbench/ai/<服务名>/token`，只写不回显）；端点由 `models_write` **一次写整份**成
  `models.json`（`%APPDATA%\Workbench\data\pi\`，不做增量 —— 增量会留残影）；**停用的服务与模型不进文件**
  （`aiProviderPayload`），界面能挑的与 Pi 看到的一致。**`apiKey` 是环境变量引用**（`$WORKBENCH_AI_KEY`），
  文件里不落明文（几个服务共用一个变量名是安全的：一轮只起一个进程）。**API 形态只认
  `openai-completions` / `anthropic-messages`**（`AI_API_FORMATS`），别凭印象加。**服务名只收小写字母 /
  数字 / 连字符**（`sanitizeAiName`）—— 它同时是 models.json 键、凭据名与 `--provider` 值，别放宽。
- **厂商预设只填地址**（`AI_PROVIDER_PRESETS`）：收进去的判据是**地址与形态都没争议**，宁可少列
  （地址写错的代价是用户以为 key 不对）；**清单由端点自己报**（不内置模型清单），但**能力默认值从随包 Pi 的
  内置目录预填**（见下条「四层」）—— 端点只报 id 不报能力，不预填会把视觉模型配成纯文本。
- **模型列表从端点拉**（`ai_models_fetch`）：`openai-completions` 走 `{baseUrl}/models`，`anthropic-messages`
  的 baseUrl 到主机为止、走 `/v1/models`（`models_url`），带 `/v1` 的中转地址不再补一层。
  打的是用户自己的端点（同主机同 Key），只有粘 Key / 点「获取列表」才走。回包几种形状都认
  （`data` / `models` / 顶层数组）；端点没报的给 0 / null 由渲染层兜底；密钥先用草稿里刚粘的那把。
- **上下文 / 最大输出 / 思考 / 图片按「端点报 → 内置目录认 → 按名字认 → 留空」四层**：
  1. 端点报了就用（`context_length` / `max_completion_tokens` / `supported_parameters`）；
  2. 从随包 Pi 的模型目录认（`builtinModelMeta`，表是 vendor 剪出的 `ai-builtin-models.generated.ts`）——
     **Pi 跑同一 id 用的就是这张表**；图片能力只在这层认得出，端点不报、名字也猜不得；
  3. 按模型 id 认确定的家族（`inferModelMeta`），**宁缺毋滥**、认不出留空别编数字；
  4. 都认不出：上下文 / 最大输出**不写字段**（写 0 被 Pi schema 挡），Pi 按 128000 / 16384 兜底。
  **勾了「能看图」才写 `input: ["text","image"]`，不写 Pi 按 `["text"]` 算** —— read 读图、工具结果里的截图都会被丢
  （模型那句「我看不了图」就是这么来的）。**渲染层 payload 与 Rust `ModelInput` 字段名一字不差**（`imageInput` /
  `maxTokens`）—— serde 静默丢弃认不出的键，名字对不上**两边单测都绿**（踩过：勾了「图片」永远写不进 models.json）。
  思考档位落成 `thinkingLevelMap`：`reasoning: true` 时 off–high 默认支持（不写），`xhigh` / `max` 必须显式给，
  不支持的写 `null`；下拉只列支持的档位，挑了不支持的退默认档（`pickAiThinking`）。
- **默认模型一条设置**（`aiDefaultProvider` + `aiDefaultModel`，行为记忆）：它是**起始屏与
  新对话的默认** —— 会话建起来之后 composer 那一栏就各自独立了（见「会话是头等对象」那条），
  模型管理弹窗顶上那一栏写的仍是这个默认。挑的没了退回第一个能挑的
  （`pickAiChoice`）。**只由 `--provider <服务名> --model <模型 id>` 钉住**（piLaunch，有单测）：内置 Pi **不读
  `PI_MODEL`**、`models.json` 的清单只当候选，两处都不给它退到自己那张内置默认表（踩过：`opencode-go` 被按内置表
  发了 `kimi-k2.6`，用户清单里的模型没用上，端点回 410）。**验法**：把 models.json 指向本地假端点（回 400 即可）
  看实际请求的 `model` 字段 —— 比读文档可靠；换 Pi 版本后重验。
- **思考档位总是显式给**（`--thinking <level>`）：七档 id 是 Pi 认的（off / minimal / low / medium / high /
  xhigh / max），**一个字符都不能改**（不认的值它直接报错退出）；界面名由 `AI_THINKING_LEVELS` 定
  （默认 `medium`，与 Pi 一致）。给的是该模型支持的档位里挑的那档（不支持思考的只有 `off`，Pi 自己也会夹档）。
- **别把「读懂并改写内容」搬进应用**：怎么拆怎么组织由用户与目录里的规范说了算；应用只交目录与指令、
  备好模型与密钥、把过程与结果画出来。
- **提示词与密钥都不经过渲染层**：RPC 模式（`--mode rpc`），提示词是 **stdin 的一行 JSON**（`prompt_frame`）——
  含中文与换行，走命令行必炸。**一句一轮、同一根 stdin**（第一句由 `ai_run` 写，之后每句都是同一条命令）。
  密钥只在起进程时注入环境变量（命令行参数在进程列表是明文）。
- **贴图随这一句走**（composer Ctrl+V，缩略图画在输入框上、角上 × 删一张，**点开 `el-image` 看大图** ——
  56px 缩略图连截图上的字都认不出）：只收 png / jpeg / webp / gif（`AI_IMAGE_TYPES`），一次最多 `AI_IMAGE_MAX` 张。
  与提示词同一行 JSON：`{"type":"prompt","message":…,"images":[{type:"image",data,mimeType}]}`，`data` 是 base64、
  **不带 `data:` 前缀**（`aiImagePayload`）。**渲染层 → Rust 字段是 `data` / `mimeType`**（serde 静默丢弃，
  改名两边一起改并各留单测）；**一张都没有时不发 `images` 键**；只贴图没字也发得出去（标题记「（N 张图）」——
  标题空着等于「还没说过话」）。图随会话文件落盘（Pi 自己存），读历史由 `sessionMessagesToLines` 换回数据 URL
  画进气泡 —— 形状对不上图会静默不显示，这条也有单测。形状已用假端点探针验过
  （[dev-notes/pi-session-probe.md](../dev-notes/pi-session-probe.md)），换 Pi 版本重跑。
- **贴图前提是当前模型能看图**（`AiModelChoice.imageInput`）：不能看图的模型 Pi 会把图换成「图被略去」占位发出去
  —— 用户以为发过去了。挑中不能看图的模型时贴的图照收、**发送按钮按不动**（理由在悬停里）；
  格式不认的图在**贴进来那一刻**就拦下（`notifyWarning`）。
- **提示词开头那行脚手架不进界面**：`taskPrompt` 造的是「`你在下面这个目录里工作：<目录>` + 空行 + 用户原文」
  （`AI_PROMPT_PREFIX`），模型看见与落盘的都是整份；**界面只显示用户那段** —— 读历史用 `visibleInstruction` 剥掉
  （否则气泡里有一句用户没写过的话）。改字面量连 `AI_PROMPT_PREFIX` 一起改。
- **会话留档由 Pi 写，落点由我们钉住**：起进程传 `--session-id` 与 `--session-dir <数据目录>/pi/sessions`
  （`sessions_dir`），**不传 `--no-session`**；默认落点是全局 `~/.pi/agent/sessions/`，必须拨到应用数据目录下
  （与 `PI_CODING_AGENT_DIR` 同一条理由）。**续聊与重启后还在 = 同一 id 再起进程**（实测 `get_messages` 读得回
  全部历史，杀在半路不留坏数据），应用不自己攒上下文。**删会话认的是会话文件首行 header 的 id**（不认文件名 ——
  时间戳与目录分组是 Pi 的实现细节），删之前**先收进程**（活进程在写文件，Windows 删不掉）。
- **打开会话先读历史**：`get_messages` → `sessionMessagesToLines` → 对话区。**只有活进程答得出来**，
  所以先按空提示词起一次进程再要消息；读过的（`hydrated`）不再读，之后由事件流接上。系统消息与**成功的**
  工具结果整条丢掉（前者是提示词与工具清单、后者一次几百行）；**失败的工具结果留一行错因**（与实时那条共用
  `failureLine`）。**没说过话的会话跳过这一趟**（没有历史，白起一次进程用户看得出「卡了一下」）。
  「在哪个目录里工作」那行插在**最后一句用户消息之后**（与实时起进程同一处）—— 接在轮尾会把
  `aiTurns` 该摘的答案顶进过程块，重开一看整段回话都收在折叠的「过程」里。
  Pi 起进程那句 `Warning: No project session found` 是我们要求的（新会话就这么建），别画进对话（`BENIGN_STARTUP`）。
- **一个会话一个进程**（进程会话 id `ai:<会话 id>`）：一轮跑完**不收**（上下文在它那儿），所以能一句一句聊下去；
  几个会话可同时在跑（`runs` 按会话 id 分，界面一次画一个）。模型 / 档位 / 权限在起进程时定死：改设置后闲着的
  当场收、跑着的等这轮结束收（`stale`），下一句按新参数重开、历史从会话文件接上。**别把「跑完就杀」写回来**。
- **替 Pi 关掉三条出网旁路**：`PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`、`PI_OFFLINE=1` —— 它默认报遥测、
  向 pi.dev 查版本，RPC 启动还会刷模型目录（实测关掉后真正请求照常）。这三条不在任何已登记出口里，**不许删**。
- **工具面全开，问不问由权限模式定**（`aiPermission`，默认 `auto-edit`）：`auto-edit` 时 `ai.rs` 写 Pi 扩展
  （`permission.js`：`tool_call` 钩子对 bash / powershell 调 `ctx.ui.confirm`，答否 `{ block: true, reason }` 挡回）
  以 `-e` 加载；`full` 不加载任何扩展 —— **「不问」是「没有扩展」，不是扩展里判了一下**。两档的差别只有
  「执行命令问不问」，读写文件两档都不问。**扩展只在内容变了时重写**（多会话同时起进程，每次截断重写会让
  别的进程读到半份）。
- **扩展问的那句要答得回去**：`ctx.ui.confirm` 是 stdout 上的 `extension_ui_request`（`parsePiConfirm`），
  确认条画在对话末尾，答复 `{"type":"extension_ui_response","id","confirmed"}` 经 `session_write` 写回同一条 stdin。
  确认可能同时压几条（一轮的工具调用是并发的），`stores/ai.ts` 用队列按 id 应答；**确认排在会话上**
  （切走再切回来还在原会话里等着）。**别做 print 模式兜底**：print 下扩展 UI 是空实现（一律 false），
  命令会被全挡掉 —— 要问一句就得跑 RPC。
- **一轮的结束判据是 `agent_settled`，不是退出码**：RPC 进程跑完不退，收到那条事件就是这轮完了，**进程留着**。
  退出码只在**没跑完**时算数：我们让它停的不算失败，它自己退的非零要如实说「这一轮没跑完」。
  事件流与 print 模式是同一份序列化，画步骤那套照旧。
- **要读结果的命令靠应答配对**：`get_messages` / `abort` 的应答是 stdout 的 `response` 帧，请求带 id、应答带回来
  （`parsePiResponse` + `aiRequest`）。**配上对的应答不再当日志画**（读回来的数据不是给人看的）；
  超时与进程退出都算失败，别让一条等不到应答的命令把界面吊死。
- **模型请求由 Pi 自己发**（直连用户配的端点；第 8 条出口、用户显式开启）：名称 / 地址 / 形态 / 模型 / 密钥
  缺一样跑不起来（composer 的 `canRun` 拦）。**它在这个目录里读到的内容与这段会话的历史都会发给端点**，文档里要如实写。
- **一个会话一次一轮**：跑着时发送按钮是停止，按会话挡重复提交；几条会话互不相干。**停止走 `abort`**
  （进程与上下文留着、这轮正常收尾），应答没回来再按进程树杀（复用 `stop`）—— 那颗按钮什么时候都得有用。
  换参数重开时对话里写一行「在哪个目录里工作」，那串命令行（cli.js 绝对路径 + 开关）收进这行的悬停
  （`AiLogLine.detail`），同进程续聊不重复。**失败落错误行，来源两处**：模型侧在 message 的 `errorMessage`，
  工具侧在事件 `result.content[].text`（`tool_execution_end` **没有 `error` 字段** —— 只认 error 会把
  「找不到 bash」「EISDIR」全显示成同一句兜底文案），多行只留第一句、全文进悬停。
  **有报错不能装顺利；顺利跑完不留状态行**。
- **技能 = `--no-skills` + 逐条 `--skill`，两头合起来才成立**：Pi（1.0.4）有显式 `--skill <路径>`（可重复）与
  **自动发现**（`~/.agents/skills`、信任项目的 `.agents/skills`（还往上找）、`<agentDir>/skills`、`<cwd>/.pi/skills`、
  package 与扩展）。**自动发现必须关**（`-ns`），否则「关掉」是假的（实测只给 `--skill` 时 `~/.agents/skills`
  仍在清单里，加 `-ns` 才只剩给出去的）。于是**应用那份表是唯一真源**：起进程先 `-ns`，再把开着的逐个
  `--skill <目录>`（目录不存在跳过、按整条路径去重、上限 200）。代价：**用户在应用之外装给 Pi 的技能
  在应用的会话里看不见**，想用就在弹窗里装一份。`--skill` 认「一个目录 + SKILL.md」、不往里递归；
  项目技能**不依赖「项目被信任」**（显式路径总是加载）。
- **两条技能根，都是用户自己的目录**（口径唯一出处 `shared/pi-skills.ts`）：**全局** `%USERPROFILE%\.agents\skills`
  （`pi_skills::global_root` 探出，跟 `ai_runtime` 回渲染层）、**项目** `<工作目录>\.agents\skills`。
  一个技能 = 根下带 `SKILL.md` 的子目录（裸 `.md` 不算）。全局那份与别的 agent 共用、项目那份就是技能页
  「安装到项目」写的 —— 两处共用有意为之，**别改成「应用自己另存一份」**，也**别写** `skills-lock.json`
  （那是别的 agent 的账本，两边对不上是预期）。`<cwd>/.pi/skills` 应用不碰、不承诺读。
- **开关是「关掉的那些」，只对下次起进程生效**：`aiSkillsOff`（键「根 + 技能名」，`skillKey` 统一写法；
  收敛 `sanitizeAiSkillsOff`）存数据文件，新技能默认开着 —— **不要改成「登记开着的」**（那样每加一个都要补一笔）。
  进程活着时装 / 卸 / 开关不生效，界面不解释也没有「结束它」按钮（2026-09-29 连说明一起删了）：
  要新表生效就结束这段会话的进程再续聊（`ai.recycle`，等价停止那轮进程树、会话文件不动）。
- **装进来的东西只落盘，脚本一概不执行**（`pi_skills.rs`）：zip 解包手写（中央目录 + deflate，压缩交 `flate2`），
  **条目名逐段过 `sync::is_plain_segment`**（挡 `..` / 盘符 / 通配）、跳过符号链接，解到 `<根>/.tmp-…` 再整棵改名
  （同盘原子，半路失败不留半个技能）。上限：包 64 MB、解压后 256 MB、4000 条目；不支持 zip64 / 加密 /
  非 deflate（说清楚，别硬猜）；没有 SKILL.md 的包不是技能包。**「导入目录」也不碰 git** —— 两条根是用户自己的
  目录（项目那份多半就在他仓库里），替他提交不是应用该做的事。
- **`/skill:名字` 必须摆在提示词最前面**：Pi 只在文本**开头**认它（`startsWith('/skill:')`，一次一条，
  名字取到第一个空白）。`taskPrompt` 在指令以命令开头时把脚手架**挪进命令参数位**，`visibleInstruction`
  对称还原（**技能名留着**、脚手架去掉），`aiSessionTitle` 把命令剥掉当标题。**别把命令插到中间** ——
  Pi 不认，整条会原样发给模型当普通文本。
- **装技能这条出口**（第 9 条，见 AGENTS.md 第 1 节）：只有「粘地址」出网 —— 地址用户粘、点「装上」才 GET 一次，
  **主机不设白名单**（与「用户自己填的 git 仓库」同类），跟 `Location` 最多 5 跳，只收 zip、超 64 MB 停
  （`http::request_url_limited` —— 那个 8 MiB 阀门是所有出口共用的，**别调大**）。导入本地 zip / 目录、
  装卸开关、`--skill` 注入全在本机；这趟除地址本身不带任何用户数据。http.rs 因此多了 `location`
  （**不自动跟重定向**，跟不跟由调用方定）与 `request_url_limited`。
- **索引重建归应用**：`kb.rs` 的 `index_build` 是 `kb/_catalog.md` 与 `index/index.json` 的唯一生成者，
  格式与既有生成物一致（CRLF、文件头、JSON 键序），`generated_at` 由渲染层按本机时区算（`todayIsoDate`）；
  改输出格式只改 kb.rs 一处，断言在其测试里。**别把索引交回 Agent**：清洗的提示词同样明令 Pi 不碰生成物。
- **明确不做**：订阅登录（Pi 的 `/login`）、云厂商原生协议（Bedrock / Vertex / Azure —— 鉴权要装回各家 SDK，
  与瘦身冲突）、**拉 models.dev 的目录**（清单由端点报；能力默认值只认随包 Pi 那份目录）。
  会话续跑在做；**不做**：会话改名（标题取第一条指令）、跨目录搬会话（搬了等于换对话）、`/tree` / `/fork` /
  `/clone`（要做就得把 Pi 会话树整套搬来，现在只做「一段对话接着聊」）。

## 实现


- 导航栏第七项（名字跟设置里的程序名走 —— 用户把程序叫什么，这个智能体就叫什么，见 stores/settings.ts 的 viewLabelOf）：**通用 agent 控制台** —— 在一个目录里跟一段对话，请内置的 Pi 干活。
  版式**左树右对话**（与笔记 / 视频页同一副分栏，宽度住 `aiTreeWidth`，缝可拖）；**左栏能整栏收起**
  （开关在左栏底部那一行，收起后右栏左上角浮出「展开」，落 `aiTreeCollapsed`，0 宽过渡与视频页同一套）。
  - **左栏**是两层树：第一层**项目**（工作目录）、第二层**会话**。项目行右侧「在这里起一段新的」（悬停出）、
    会话行右侧「删除」（悬停出，删前问一句）；顶上「+」不挑目录、接着最近用过的那个。
    会话行的小圆点表示正在跑（几个会话可同时在跑）。一段会话都没有时左栏给一句空态说明。
    **底部一行是两个不跟会话走的入口**：**技能**（管理弹窗）与**收起整栏** —— 不占 composer 工具行。
  - **右栏**挑中会话即**控制台**（上面对话、下面目录与分支 + 同一条 composer）；没挑中是**起始屏**
    （中间就是 composer，上面是挑目录的位置栏）。**「起一段新的」只是切屏**（`drafting` / `startNew`），
    **会话在发出第一句时才建**（`run` → `ensureSession`）—— 还没说过话的会话不在左栏占一行。
    两屏都没有顶部工具条（标题与导航栏重复）。
  两屏共用 `AiLocationBar.vue`：挑中会话时目录定死（没有「换一个工作目录」—— 目录跟着会话走，
  Pi 按目录分组，换目录 = 新建会话），起始屏上它**就是挑目录的地方**（最近目录 + 「选择其他目录…」，
  只记在 `newDir`）；不是仓库或分离头指针时分支格不出现（分支来自 `note_repo_state` 那条通用探测，见
  [../notes/constraints.md](notes.md)；探测是 AiView 的 `refreshRepo`，分支值作 prop 递进位置栏）。
  `AiComposer.vue`：输入框 + 一行控件（左权限、右模型 / 思考 / 发送-停止），Enter 发送
  （Shift+Enter 换行，输入法选字的 Enter 不算）。**指令与贴的图归 AiView 持有**（两屏各一条 composer
  实例，放页面这层才换屏不丢；composer 经 `update:instruction` / `add-images` / `remove-image` 回报，
  `send` 事件把那句交给页面、页面转 `run`，store 说收下了才清空输入框），`canRun` / `blocking` 也长在
  composer 上。贴图（Ctrl+V）一行缩略图、上限 `AI_IMAGE_MAX` 张、点开 `el-image` 看大图、
  只收 png / jpeg / webp / gif ——
  形状与边界见 [../ai/constraints.md](ai.md)。**这一页不摆提示行**：缺什么（目录 / Node /
  Pi / 模型 / 密钥）由 `blocking` 一次说一件、只出现在发送按钮悬停里；页面上剩的字都是控件自己的。
  **这一页与知识库无关**：不内置任务提示词（`taskPrompt` 那行「你在下面这个目录里工作：」脚手架只给模型看，
  读历史由 `visibleInstruction` 剥掉）、跑完不做任务绑定的事（见 [../ai/constraints.md](ai.md)）。
  干活的不是应用，是内置的 Pi
  （[scripts/vendor-pi.mjs](../../apps/desktop/scripts/vendor-pi.mjs) 生成到 `resources/pi/`，Node 用系统里的）。
- **模型管理是一屏「服务 + 模型」**（`AiModelDialog.vue`，从「模型」下拉底部进）：顶栏写默认模型
  （`服务 · 模型`，点一下换），下面列服务，能加改停删；服务的形状与落点、`models.json` 的写法见
  [../ai/constraints.md](ai.md)。加服务三步（`AiProviderDialog.vue`）：挑厂商（预设网格
  `AI_PROVIDER_PRESETS`，「自定义端点」在最前）→ 粘 Key（粘上即自动拉一次端点的模型列表）→ 挑模型
  （左栏点进右栏，行上预显「加进来会填成什么」，端点没报而靠认出的带 ≈）；行上「高级」摊开
  `AiModelPicker.vue` 编辑面板：别名（清空回 id）、上下文与最大输出（快捷档位 + 认 `128k` 写法）、
  思考 chips、能力（图片）。默认值的「四层」认法与 `thinkingLevelMap` 的写法见
  [../ai/constraints.md](ai.md)。跑哪个模型在 composer 挑（`aiDefaultProvider` /
  `aiDefaultModel`，行为记忆，挑的没了退回第一个能挑的）；服务名撞上 Pi 内置的几个（`opencode-go`、
  `deepseek`、`zai`）时它的内置模型目录也进候选，只影响可选范围。历史包袱：更早的单端点设置
  （`aiProviderName` / `aiBaseUrl` / `aiApiFormat` / `aiModels`）在收敛时搬成一条服务（`legacyAiProvider`）
  后清掉；`aiWorkDir` 已废弃（目录跟着会话走）。
- **会话：一段对话一份留档，接着聊就是接着那个进程**。`aiSessions` 只存调度字段；留档由 Pi 写
  （`--session-id` + `--session-dir`）、续聊与重启后还在靠同一 id 再起进程、打开先读历史
  （`get_messages`，只有活进程答得出来）、删除先收进程再按 header id 删 —— 规矩见
  [../ai/constraints.md](ai.md)。
- **工具权限是 composer 左边那一栏**（`aiPermission`，默认「自动编辑」，两档差别只有「执行命令问不问」，
  机制见 [../ai/constraints.md](ai.md)）：确认条画在**对话的末尾**（命令原文 + 允许 / 拒绝 +
  后面还压几条），顶部状态这时说「等你确认这条命令…」；确认可能同时压几条（一轮的工具调用是并发的），
  `stores/ai.ts` 用队列按 id 应答，答与不答都在对话里留一行（「允许执行：…」/「拒绝执行：…」）；
  **确认排在会话上** —— 切到别的会话干别的，它还在原来那段里等着。
- **一轮的流程**：写一句 → 交给那条会话的进程（没在跑先起，同一会话一句一轮、同一根 stdin）→
  事件流翻成对话行（失败也落错误行）→ `agent_settled` 收尾但进程留着；停止走 `abort`、应答没回来再按进程树杀。
  画法（气泡、过程块、收据、流式）见 [AiProcess.vue](../../apps/desktop/src/renderer/src/components/AiProcess.vue)
  与 [../ai/constraints.md](ai.md)；正文里的站内链接与「写下 N 个文件」点开在右侧预览栏
  （`AiView` 编排取数与图片授权、`AiPreviewPane.vue` 画，DOCX / PPTX / HTML 三个画法在
  `AiPreviewDoc` / `AiPreviewSlides` / `AiPreviewHtml`，解析口径见 `packages/ai/src/ai-preview.ts`）。
- **Pi 已随包内置，Node 用系统里的**：资源解析与内置壁纸同一条路子（打包走 `resource_dir`、开发态读仓库目录，
  `\\?\` 前缀要剥）；两处都没有才退回 PATH 上的全局 `pi`，再没有才显示「安装 Pi」（`npm install -g`，
  与包管理器安装同一条会话通道）—— 打包出的安装包里内置那份永远在，这颗按钮只在开发态可能见到。
- **技能**：「技能」按钮弹出的弹窗，两条技能根各一栏（**全局** `%USERPROFILE%\.agents\skills` 与别的 agent
  共用、**项目** `<工作目录>\.agents\skills` 就是技能页「安装到项目」写的那份 —— 两处共用有意为之），
  每栏导入文件 / 导入目录 / 粘地址三颗按钮，行内开关、看 `SKILL.md` 原文、文件管理器、卸载（要确认，
  删的是用户自己的目录，应用不替他提交 git）；**应用不内置任何技能**。装卸边界、`-ns` + 逐条 `--skill`、
  `/skill:` 注入与开关表见 [../ai/constraints.md](ai.md)；出网只有「粘地址」
  （第九条出口，见[「数据与隐私」](../features-and-architecture.md)）。
- 页面结构：左栏两层树归
  [AiSessionTree.vue](../../apps/desktop/src/renderer/src/components/AiSessionTree.vue)（手写两层列表：
  固定两层、行上悬停按钮、展开态自己说了算 —— 笔记树用 `el-tree` 为的是拖拽与任意深度，这儿用不上）；
  两屏排版与 composer 归
  [AiView.vue](../../apps/desktop/src/renderer/src/components/AiView.vue) 与
  [AiComposer.vue](../../apps/desktop/src/renderer/src/components/AiComposer.vue)（composer 自己一张卡片，
  父级只决定摆哪儿）；回答里的文件链接点开的右侧预览栏归
  [AiPreviewPane.vue](../../apps/desktop/src/renderer/src/components/AiPreviewPane.vue)（页内分栏不是弹层，
  取数与授权都在 AiView）；模型管理两屏各自一个组件：
  [AiModelDialog.vue](../../apps/desktop/src/renderer/src/components/AiModelDialog.vue)（默认模型 + 服务列表）
  与 [AiProviderDialog.vue](../../apps/desktop/src/renderer/src/components/AiProviderDialog.vue)（加 / 改服务），
  后者的两半又是
  [AiPresetGrid.vue](../../apps/desktop/src/renderer/src/components/AiPresetGrid.vue)（预设网格与搜索）与
  [AiModelPicker.vue](../../apps/desktop/src/renderer/src/components/AiModelPicker.vue)（模型 / 设置两栏）；
  技能弹窗归
  [AiSkillDialog.vue](../../apps/desktop/src/renderer/src/components/AiSkillDialog.vue)（「全部 / 全局 / 项目」
  分段筛选与搜索，组头级名 + 根路径 + 计数徽标 + 三颗导入按钮，行内看 / 更多菜单 / 开关；
  详情与「粘地址」各再一层，共三层弹窗）。这些组件都不碰通道：拉列表、写设置、存密钥、写 models.json 全在
  `stores/ai.ts`（`fetchModels` / `saveProvider` / `removeProvider` / `toggleProvider`），技能那几件事全在
  `stores/ai-skills.ts`。


## 涉及文件

这些条目的原文注解从主文档「目录结构」迁来（主文档的树里各留一行，指回这里）。

```
  src/ai.rs             AI 助手的宿主侧：把提示词写成子进程 stdin 的第一行（RPC 的 prompt、
                        含中文与换行的东西走命令行必炸）、写「自动编辑」那份权限扩展
                        （permission.js，`tool_call` 钩子问宿主）、把 AI 服务整份写成 Pi 的
                        models.json（多服务一份文件，`%APPDATA%\Workbench\data\pi\`，
                        apiKey 只写环境变量引用；模型那几条带上下文 / 最大输出 /
                        thinkingLevelMap / 能看图的 input）、
                        **按用户填的 Base URL 拉一次模型列表**（`{baseUrl}/models`，
                        同一个主机同一把 Key，几种回包形状都认，只有人点了那一下才走）、
                        从凭据管理器取密钥并**只经环境变量**注入、替 Pi 关掉它自己的遥测 /
                        版本检查 / RPC 启动时的模型目录刷新，再复用 session.rs 直启进程
                        （带一根可写的 stdin，不经 cmd /C）。模型的形状、提示词与
                        事件 / RPC 帧的读法都在 shared/ai.ts；密钥的存 / 查 / 清也在这里
  src/pi_skills.rs       Pi 的技能（AI 助手页那颗「技能」按钮）：两条技能根（全局
                        `%USERPROFILE%\.agents\skills` / 项目 `<工作目录>\.agents\skills`）的
                        列 / 装 / 卸。zip 解包手写（中央目录 + deflate，flate2 已在编译图里）——
                        条目名逐段过越界检查（`..` / 盘符 / 通配字符）、跳过符号链接、解到
                        `.tmp-…` 再整棵改名；「粘地址」那条自己跟着 Location 跳（最多 5 跳，
                        上限 64 MB，只 http/https）。**装进来的脚本只落盘、不执行**，
                        **也不碰 git**（与技能页那条「从文件夹导入」的差别就在这儿）
```

渲染层四处（原注解）：

```
    pi-skill.ts（Pi 的技能：列 / 装（zip / 目录 / 地址）/ 卸四条通道的包装，见 shared/pi-skills.ts）
    ai.ts（AI 助手：在一段会话里说一句 / 起进程、按会话 id 前缀认领进程事件、认扩展的确认帧
    并把答复写回那条会话的 stdin、命令应答的配对（`aiRequest`）、停止与会话删除、密钥的存 / 查 / 清）
    ai.ts                AI 助手：环境探测（Pi / Node 在不在）、工作目录的分支探测、
                          AI 服务清单 / 默认模型 / 思考档位 / 工具权限 / 密钥状态
                         这些设置项、服务的增删改（落设置 + 写 models.json + 存密钥三处一起对齐）、
                         从端点拉模型列表、跑一轮的编排（起进程 → 事件流进日志 → 等用户答确认 →
                         跑完不收进程）、确认队列、装 Pi（复用包管理器安装那条会话通道）（stores/）
    ai-skills.ts         Pi 的技能：两条技能根的扫描结果（全局 / 项目）、每个技能的开关
                         （落设置里的 `aiSkillsOff`）、装 / 卸 / 粘地址的编排；起进程那一趟把
                         开着的那些交给 stores/ai.ts（见 shared/pi-skills.ts）（stores/）
```
