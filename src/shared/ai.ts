/**
 * AI 助手（页面 id `ai`）：应用里那个**通用的 agent 控制台** —— 选一个目录、写一条指令，
 * 请本机的 Pi（一个开源的编码 Agent，<https://pi.dev>）在那个目录里干活。
 *
 * 分工：这一份只有纯逻辑（提示词、命令行、事件流与 RPC 帧的读法），Rust 侧（ai.rs）管三件
 * 只有它能做的事 —— 提示词写进子进程的 stdin、密钥从凭据管理器进环境变量、权限扩展文件与
 * 「别去联网」那三个开关；编排在 stores/ai.ts。放在这里是为了能直接测：提示词少一条要求、
 * 命令少一个开关、RPC 帧认错一个字段，都是几行单测就能钉住的事。
 */
import { noteRootName, sanitizeNoteRoot } from './note'

/**
 * 模型配置是**自定义端点**形态（照通用客户端的样子）：一个提供方 = 名称 + Base URL +
 * API 形态 + 密钥 + 模型清单（可启停）。落点分三处：名称 / Base URL / API 形态 / 模型清单
 * 进设置；密钥进 Windows 凭据管理器；Pi 用的那份 models.json 由 Rust 生成
 * （src-tauri/src/ai.rs 的 provider_write —— apiKey 写的是环境变量引用，不落明文）。
 *
 * 会话（`AiSession`）也在这份里：一个会话 = 一个工作目录里的一段连续对话，与 Pi 自己的
 * 会话文件一一对应 —— 连续多轮与「重启后接着聊」都是它的功劳，不是应用自己攒的上下文。
 */

/** API 形态：models.json 的 `api` 字段认的 id（两个都来自 Pi 自己的材料，别凭印象加） */
export interface AiApiFormat {
  id: string
  label: string
}

export const AI_API_FORMATS: AiApiFormat[] = [
  { id: 'openai-completions', label: 'Chat Completions（/chat/completions）' },
  { id: 'anthropic-messages', label: 'Anthropic Messages（/v1/messages）' }
]

/** 清单里的一条模型：enabled 关掉的只是不启用，不删 */
export interface AiModelEntry {
  id: string
  enabled: boolean
}

/**
 * 提供方名：models.json 的键、凭据管理器目标名的一部分。
 * 收紧到小写字母 / 数字 / 连字符（其余字符一律折成 -），存起来之前就折好。
 */
export function sanitizeAiName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
}

/** API 形态的收敛：认不出的回空串 */
export function sanitizeAiApiFormat(value: unknown): string {
  if (typeof value !== 'string') return ''
  return AI_API_FORMATS.find((format) => format.id === value)?.id ?? ''
}

/** Base URL 的收敛：去空白、限长；形状（http(s):// 开头）在保存时校验 */
export function sanitizeAiBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 300)
}

/**
 * 模型清单的收敛：去空白、按 id 去重（保序）、限长限量。
 * enabled 不是能力开关，是「这一条要不要进 models.json」。
 */
export function sanitizeAiModels(value: unknown): AiModelEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: AiModelEntry[] = []
  for (const raw of value) {
    const id =
      raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
        ? (raw as { id: string }).id.trim().slice(0, 120)
        : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({ id, enabled: (raw as { enabled?: unknown }).enabled !== false })
    if (result.length >= 32) break
  }
  return result
}

/** 模型 id 的收敛：去空白、限长（与清单里每一条同一条口径） */
export function sanitizeAiModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : ''
}

/**
 * 这一轮跑哪个模型：**用户在页面上挑的那颗**（`chosen`，记在设置里），
 * 它被关掉或删掉时退回清单里第一个启用的；一个都没启用就是空串（界面据此提示）。
 */
export function pickAiModel(models: AiModelEntry[], chosen: string): string {
  const enabled = models.filter((model) => model.enabled).map((model) => model.id)
  return enabled.includes(chosen) ? chosen : (enabled[0] ?? '')
}

/**
 * 思考等级：Pi 的 `--thinking <level>` 认的那七档，取自它自己的 defaults.js
 * （`THINKING_LEVEL_OPTIONS`，默认档 `DEFAULT_THINKING_LEVEL = 'medium'`）。
 * **id 是它认的字面量，一个字符都不能改**；label 只是界面上怎么叫 —— 收到不认的值它会直接报错退出。
 */
export interface AiThinkingLevel {
  id: string
  label: string
}

export const AI_THINKING_LEVELS: AiThinkingLevel[] = [
  { id: 'off', label: '关闭' },
  { id: 'minimal', label: '极简' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '极高' },
  { id: 'max', label: '最高' }
]

/** 默认档：与 Pi 自己的默认是同一个（medium）—— 不挑也不改变它的行为 */
export const AI_THINKING_DEFAULT = 'medium'

/** 思考等级的收敛：认不出的（含空串、手工改坏的值）回默认档 */
export function sanitizeAiThinking(value: unknown): string {
  return AI_THINKING_LEVELS.find((level) => level.id === value)?.id ?? AI_THINKING_DEFAULT
}

/** 界面上那一档怎么叫：认不出的照原样给（存坏了也别显示成空白） */
export function aiThinkingLabel(id: string): string {
  return AI_THINKING_LEVELS.find((level) => level.id === id)?.label ?? id
}

// ---------- 工具权限（composer 左边那一栏） ----------

/**
 * 工具权限两档。它管的是**执行命令这件有副作用的事**，读写文件两档都不问：
 *
 *  - `auto-edit`（自动编辑）：命令先问一句 —— `ai.rs` 会写一份 `permission.js` 扩展并以
 *    `-e` 加载，模型的每次命令调用先经它的 `tool_call` 钩子问宿主，问与答都长在运行面板里
 *    （见下面的 AiConfirm 与 confirmFrame）；
 *  - `full`（完全访问）：不问 —— 不加载那个扩展，**结构上就没有询问**，不是「问了然后自动答是」。
 *
 * id 进设置、也交给 Rust（ai.rs 只把 `full` 当「不问」，认不出的一律按自动编辑走）——
 * **改字面量要两边一起改**。
 */
export interface AiPermissionMode {
  id: string
  label: string
  /** 下拉里挂在名字下面那句：一句话说清这一档问不问 */
  hint: string
}

export const AI_PERMISSION_MODES: AiPermissionMode[] = [
  { id: 'auto-edit', label: '自动编辑', hint: '改文件不问，命令先问你' },
  { id: 'full', label: '完全访问', hint: '所有操作都不再询问' }
]

/** 默认档：自动编辑（保守的那个 —— 命令先问一句，不会有脚本悄悄跑起来） */
export const AI_PERMISSION_DEFAULT = 'auto-edit'

/** 权限模式的收敛：认不出的回默认档 */
export function sanitizeAiPermission(value: unknown): string {
  return AI_PERMISSION_MODES.find((mode) => mode.id === value)?.id ?? AI_PERMISSION_DEFAULT
}

/** 界面上这一档怎么叫：认不出的照原样给（存坏了也别显示成空白） */
export function aiPermissionLabel(id: string): string {
  return AI_PERMISSION_MODES.find((mode) => mode.id === id)?.label ?? id
}

// ---------- 用过的指令（新任务页下方那一排） ----------

/** 指令历史最多留几条 */
export const AI_HISTORY_MAX = 20
/** 一条指令最长多少字：更长的多半是把整份文件贴进来了，不进历史（照样能跑） */
export const AI_INSTRUCTION_MAX = 2000

/**
 * 指令历史的收敛：只留非空、不超长的字符串，按原文去重（保留先出现的那条）、限量。
 * 历史是**用户自己写过的东西**（见下面 rememberAiInstruction 的说明），不是内置模板。
 */
export function sanitizeAiHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (!text || text.length > AI_INSTRUCTION_MAX || seen.has(text)) continue
    seen.add(text)
    result.push(text)
    if (result.length >= AI_HISTORY_MAX) break
  }
  return result
}

/**
 * 记一条用过的指令：最新的排在最前面，重复的只留一条（同一条指令再跑一次不会多出一条），
 * 超出上限的从末尾丢掉。
 *
 * 页面在**起进程之前**调它（跑没跑起来都算用过 —— 不然「试一次没成功」这种最常见的
 * 情形反而记不下来）。留的是用户写过的原文：这一排 chips 是**他自己的历史**，
 * 页面里不内置任何一类任务的提示词（见 docs/constraints/ai.md）。
 */
export function rememberAiInstruction(history: string[], instruction: string): string[] {
  return sanitizeAiHistory([instruction, ...history])
}

// ---------- 会话（一个工作目录里的一段连续对话） ----------

/**
 * 一个会话：**一个目录里的一段连续对话**，与 Pi 自己的会话文件一一对应。
 *
 * `id` 同时是两把钥匙：
 *
 *  - **Pi 的 session-id**（`--session-id`）：它按这个 id 找盘上那份会话文件，因此必须落在
 *    Pi 认的字符集里（字母数字与 `.` `_` `-`，首尾是字母数字）—— 一个字符都不能超；
 *  - **子进程会话的 id**（`ai:<id>`，见 workbench/ai.ts）：输出与退出靠它回到这个会话。
 *
 * **工作目录创建时定下、之后不改**：Pi 按目录给会话分组，换了目录等于换一份留档。
 */
export interface AiSession {
  id: string
  /** 工作目录（绝对路径）：子进程在这儿干活，也是 Pi 找这份会话的那把钥匙 */
  dir: string
  /** 标题：第一条指令压成一行（见 aiSessionTitle）；空串 = 还没说过话 */
  title: string
  createdAt: number
  updatedAt: number
}

/** 会话 id 的长度上限（uuid 是 36 位，留一倍余量） */
export const AI_SESSION_ID_MAX = 64
/** 同时留着的会话数上限：超了从最久没说话的末尾丢 */
export const AI_SESSION_MAX = 100
/** 标题的长度上限：树行上放得下、一眼认得出 */
export const AI_SESSION_TITLE_MAX = 48

/**
 * 会话 id 的收敛：认不出的回空串（调用方据此丢掉这条记录）。
 * **规则是 Pi 定的**（它自己的 `--session-id` 只收字母数字与 `.` `_` `-`，首尾必须是字母数字），
 * 我们生成的 id 走 `crypto.randomUUID()`，天然落在里面。
 */
export function sanitizeAiSessionId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  if (id.length > AI_SESSION_ID_MAX) return ''
  // 首尾是字母数字、中间只收 `.` `_` `-`；**单个字符也认**（首尾同一位，Pi 的规则就是这样）
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id) ? id : ''
}

/** 标题的收敛：压成一行（换行会让树行高低不一）、去空白、限长 */
export function sanitizeAiSessionTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > AI_SESSION_TITLE_MAX
    ? `${oneLine.slice(0, AI_SESSION_TITLE_MAX)}…`
    : oneLine
}

/**
 * 第一条指令 → 标题：树行上要的是「这段对话在聊什么」，最长的那份原文留给输入框与日志。
 * 只截不猜 —— 不替用户概括，那会让标题与他自己写的那句话对不上。
 */
export function aiSessionTitle(instruction: string): string {
  return sanitizeAiSessionTitle(instruction)
}

/** 一个时间戳字段的收敛：认不出的回 0（排序用得着，不能是 NaN） */
function sanitizeStamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 会话清单的收敛：丢掉认不出的、按 id 去重、限量（老数据文件里没有这一项） */
export function sanitizeAiSessions(value: unknown): AiSession[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: AiSession[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const id = sanitizeAiSessionId(record.id)
    // 目录与笔记 / 技能 / 知识库同一条收敛：它要拿去拼路径、进命令行（与 kbDir 一类）
    const dir = sanitizeNoteRoot(record.dir)
    if (!id || !dir || seen.has(id)) continue
    seen.add(id)
    const createdAt = sanitizeStamp(record.createdAt)
    result.push({
      id,
      dir,
      title: sanitizeAiSessionTitle(record.title),
      createdAt,
      // 老文件里可能没有 updatedAt：那就以创建时间为准（排序只看它）
      updatedAt: sanitizeStamp(record.updatedAt) || createdAt
    })
    if (result.length >= AI_SESSION_MAX) break
  }
  return result
}

/**
 * 记一条会话（新建与「说过话之后更新标题 / 时间」都走它）：同 id 的覆盖，
 * 最近说话的排在最前面；超出上限的从末尾丢。
 */
export function rememberAiSession(sessions: AiSession[], session: AiSession): AiSession[] {
  const rest = sessions.filter((item) => item.id !== session.id)
  return sanitizeAiSessions([session, ...rest])
}

/**
 * 打开哪个会话：**用户在左栏点过的那个**（`chosen`，记在设置里），它被删掉之后退到
 * 最近说过话的那个；一个都没有就是空串（页面显示新任务那一屏）。
 */
export function pickAiActiveSession(sessions: AiSession[], chosen: string): string {
  if (sessions.some((session) => session.id === chosen)) return chosen
  let latest: AiSession | null = null
  for (const session of sessions) {
    if (!latest || session.updatedAt > latest.updatedAt) latest = session
  }
  return latest?.id ?? ''
}

/** 左栏那棵树的第一层：一个工作目录（界面上叫「项目」） */
export interface AiSessionGroup {
  dir: string
  /** 树行上显示的名字：与笔记 / 视频树的取名同一条（noteRootName），完整路径挂在 title 上 */
  name: string
  /** 这个目录下的会话，最近说话的在前 */
  sessions: AiSession[]
}

/**
 * 会话按工作目录分组（左栏那棵两层树的第一层就是它）。顺序按「这个目录里最后说过话的时间」
 * 从新到旧 —— 常去的排在上面；目录名只在界面上显示，认身份的是 `dir` 全路径。
 */
export function aiSessionGroups(sessions: AiSession[]): AiSessionGroup[] {
  const byDir = new Map<string, AiSession[]>()
  for (const session of sessions) {
    const list = byDir.get(session.dir)
    if (list) list.push(session)
    else byDir.set(session.dir, [session])
  }
  return [...byDir.entries()]
    .map(([dir, list]) => ({
      dir,
      name: noteRootName(dir),
      sessions: [...list].sort((a, b) => b.updatedAt - a.updatedAt)
    }))
    .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))
}

// ---------- 交给子进程的东西 ----------

/** 起进程要用的程序与参数（`aiRun` 的入参形状，也是给 Rust 的最终形态） */
export interface PiLaunch {
  /** `node`（内置模式）或 `pi`（全局退路） */
  program: string
  /** 参数数组：直启、不经 shell，路径里有空格也不会被拆坏 */
  args: string[]
}

/** 这一轮用哪个模型、思考到什么程度：页面上那两个下拉挑出来的东西（提供方名 + 模型 id + 档位） */
export interface PiSelection {
  provider: string
  model: string
  /** AI_THINKING_LEVELS 里的 id */
  thinking: string
}

/**
 * 起 Pi 的程序与参数。`entry` 传内置那份 cli.js 的绝对路径（`ai_runtime` 探到的），
 * 传 null 表示用 PATH 上的全局 `pi`（没内置时的退路）。`sessionId` 是这个会话的 id
 * （`AiSession.id`：同时就是 Pi 认的 session-id）。
 *
 * **提示词与权限扩展都不在这串参数里**：
 *
 *  - 提示词走子进程的 stdin（RPC 协议的一行 JSON），由 Rust 写进去 —— 它含中文与换行，
 *    走命令行必炸，落临时文件也没必要（见 ai.rs 的 run）；
 *  - 权限扩展（自动编辑那一档）由 Rust 追加 `-e <agent 目录>/permission.js`；
 *  - 会话文件的落点（`--session-dir`）也只有 Rust 知道（它在应用的数据目录下）。
 *
 * 参数本身也不是随手写的：
 *
 *  - `--mode rpc`：**双向**协议（JSONL 进、JSONL 出）。事件流与 `--print --mode json`
 *    是同一份序列化（Pi 里那个 `toJsonEvent`），界面画步骤那一套照旧；多出来的是宿主能
 *    往子进程里说话：一轮轮的提示词、以及扩展问「这条命令让不让跑」时的答复。用它是为了
 *    **聊得下去**——print/json 模式跑完就退，上下文跟着进程一起没了；
 *  - `--session-id`：按 id 打开盘上那份会话留档（没有就用这个 id 建一份，见 ai.rs 的
 *    sessions_dir）。**不再传 `--no-session`**：那正是「跑完即弃」的写法，去掉之后
 *    连续多轮、进程被杀、应用重启都接得上同一段上下文；
 *  - `--provider` + `--model`：**用哪个模型只有这两个参数说了算**。环境变量 `PI_MODEL`
 *    它根本不读，`models.json` 里的清单它也只当候选；两处都不给时它会退到自己内置的
 *    提供方默认模型上（实测：提供方叫 `opencode-go` 时它按内置表发了 `kimi-k2.6`，
 *    清单里的 `deepseek-v4.1-flash` 一个字也没用上，端点回 410 说这个模型已下线）；
 *  - `--thinking`：思考档位（off / minimal / low / medium / high / xhigh / max）。它自己默认
 *    medium，所以这里总是显式给一个档 —— 界面上挑了什么与它真跑的是什么要对得上。
 *
 * **不再传 `-xt bash,powershell`**：命令现在是能力之一，问不问由权限模式定（见上面那一节）。
 */
export function piLaunch(entry: string | null, selection: PiSelection, sessionId: string): PiLaunch {
  const flags = [
    '--mode',
    'rpc',
    '--session-id',
    sessionId,
    '--provider',
    selection.provider,
    '--model',
    selection.model,
    '--thinking',
    selection.thinking
  ]
  return entry
    ? { program: 'node', args: [entry, ...flags] }
    : { program: 'pi', args: [...flags] }
}

/** 含空白的参数在日志里补上引号，读得出来这是一段 */
function shellish(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg
}

/**
 * 给日志的那行：程序 + 参数。日志里要先把「跑的是什么」写下来（与终端面板同一条规矩）——
 * 出问题时这是唯一的线索。提示词与权限扩展的路径由 Rust 追加，不在这串里。
 */
export function piLaunchForDisplay(launch: PiLaunch): string {
  return launch.args.map(shellish).join(' ')
}

/** 内置 cli.js 要求的最低 Node 版本（Pi 的 engines 字段：>=22.19.0） */
const PI_NODE_MIN: readonly [number, number, number] = [22, 19, 0]

/**
 * 这台机器的 Node 够不够跑内置的 Pi。**内置方案不随包带 Node**（用户是 Node 开发者，
 * 机器上本来就有），所以这条门槛是 AI 助手能不能用的硬条件之一。
 * 只认 `v24.15.0` / `24.15.0` 这类形状，认不出就当不满足。
 */
export function nodeSatisfiesPi(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  if (!match) return false
  const actual = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  for (let index = 0; index < PI_NODE_MIN.length; index += 1) {
    if (actual[index] !== PI_NODE_MIN[index]) return actual[index] > PI_NODE_MIN[index]
  }
  return true
}

/** 一次运行要交代的东西：在哪个目录里干活（提示词里写明，Agent 才不会找错地方） */
export interface AiTaskInput {
  /** 工作目录（绝对路径）：子进程的工作目录，也写进提示词 */
  dir: string
  /** 用户写的指令原文 */
  instruction: string
}

/**
 * 提示词的第一行：把「在哪儿干活」说清楚（脚本里也是这一行，改要一起改）。
 * **它不进界面** —— 界面上那份是 `visibleInstruction` 剥过的用户原文（见下）。
 */
export const AI_PROMPT_PREFIX = '你在下面这个目录里工作：'

/**
 * 提示词 = 工作目录 + 指令原文。
 *
 * 页面是**通用**的：指令由用户写（想整理知识库就照那个仓库的规范写一条），应用不内置
 * 任何一类任务的提示词 —— 内置一份就会有两份（另一份在用户的脑子里 / 别处），
 * 改了一处另一处不知道。这里只管把「你在哪儿工作」说清楚。
 */
export function taskPrompt(input: AiTaskInput): string {
  const dir = input.dir.trim()
  const instruction = input.instruction.trim()
  const parts = [`${AI_PROMPT_PREFIX}${dir}`]
  if (instruction) parts.push('', instruction)
  return parts.join('\n')
}

/**
 * 落盘的提示词 → 界面上该显示的那一句：**把开头那行脚手架（`你在下面这个目录里工作：…`）
 * 去掉**。用户自己只写了后面那段，前面那行是应用替模型加的背景 —— 读历史时照原样画出来，
 * 他会在自己的气泡里看见一句自己从没写过的话（踩过：一整条气泡里就这一行最显眼）。
 * 没有那行就原样返回（用户手写的、别处粘来的，都别动）。
 */
export function visibleInstruction(text: string): string {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith(AI_PROMPT_PREFIX)) return text
  const rest = trimmed.slice(AI_PROMPT_PREFIX.length)
  const brk = rest.indexOf('\n')
  // 脚手架后面那个空行也一起吃掉，剩下的就是用户写的原文（尾部空白留给调用方去 trim）
  return brk < 0 ? '' : rest.slice(brk + 1).replace(/^\n+/, '')
}

// ---------- 子进程的输出 ----------

/** 界面上的一行：种类决定颜色（彩色只表达运行状态），text 是给人看的 */
export interface AiLogLine {
  /**
   * `user` 是**用户自己写的那几句**（发出去时补一行、打开旧会话时从历史里读回来）：
   * 一段对话里它与助手说的话要分得开（画法见 AiRunPanel：它靠右、助手的话在左）。
   * `duration` 是一轮跑完时补的那一行「用时 …」—— 它不是对话内容，是这一轮的收据。
   */
  kind: 'user' | 'info' | 'tool' | 'text' | 'error' | 'done' | 'duration'
  text: string
  /** 工具**写下**的文件（相对知识库根）：只有 write / edit 会带，用来汇总「这些条目是新的」 */
  path?: string
  /**
   * 鼠标停在那一行上才显示的补充：**给排障留的原文**，不该在正文里占地方。
   * 现在只有「这一轮跑的是什么」那条在用（完整命令行，见 stores/ai.ts）。
   */
  detail?: string
}

/** 去掉控制序列：终端那套清理是给整行用的，这里只清要展示的文本 */
function clean(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim()
}

/**
 * Pi 起进程时那句「没找到这个 id 的会话，就用它建一份」的提示：**那是我们要求的**
 * （新会话就是这么来的，见 ai.rs 的 `--session-id`），不是故障 —— 别把它画进对话里。
 */
const BENIGN_STARTUP = /^Warning: No project session found with id .*creating a new session with that id\.?$/

/** 工具调用里的文件路径：几个常见的字段名都认（Pi 的工具参数名随版本变过） */
function toolPath(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function toolVerb(name: string): { verb: string; writes: boolean } {
  switch (name) {
    case 'write':
      return { verb: '写入', writes: true }
    case 'edit':
      return { verb: '修改', writes: true }
    case 'read':
      return { verb: '读取', writes: false }
    default:
      return { verb: '调用', writes: false }
  }
}

/** 助手消息的正文：形状可能是字符串，也可能是内容块数组（两种都认） */
function messageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
    )
    .filter(Boolean)
    .join('\n')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 消息的正文块（有的消息 content 是字符串，有的是块数组：不是数组就是空） */
function contentParts(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content.filter(
    (part): part is Record<string, unknown> => !!part && typeof part === 'object'
  )
}

/**
 * 打开一个会话时，把 Pi 那边的历史消息（RPC 的 `get_messages`）翻成界面上那几行 ——
 * **续聊的界面从这儿接上**：历史在前，之后新的一轮轮往后接。
 *
 * 翻法与实时那条（`parsePiEvent`）刻意保持一致：助手说的话是正文（走 Markdown），
 * 工具调用是窄行，用户自己写的那几句单独一种行（`kind: 'user'`）。两类整条丢掉：
 *
 *  - **系统消息**：它是提示词、工具清单与工作目录那一堆，不是对话；
 *  - **工具结果的原文**：一次读文件可能几百行，摆进对话里只会把它淹掉（工具调用那一行
 *    已经说了「读了哪个文件」）。
 */
export function sessionMessagesToLines(messages: unknown): AiLogLine[] {
  if (!Array.isArray(messages)) return []
  const lines: AiLogLine[] = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as Record<string, unknown>
    const role = str(message.role)
    if (role === 'user') {
      // 落盘的是完整提示词（含「你在下面这个目录里工作：…」那行脚手架），界面上只显示
      // 用户自己写的原文 —— 见 visibleInstruction
      const text = visibleInstruction(clean(messageText(message))).trim()
      if (text) lines.push({ kind: 'user', text })
      continue
    }
    if (role !== 'assistant') continue
    for (const part of contentParts(message)) {
      const type = str(part.type)
      if (type === 'text') {
        const text = clean(str(part.text))
        if (text) lines.push({ kind: 'text', text })
        continue
      }
      if (type !== 'toolCall') continue
      const name = str(part.name) || '工具'
      const { verb } = toolVerb(name)
      const path = toolPath(part.arguments)
      lines.push({ kind: 'tool', text: path ? `${verb} ${path}` : `${verb} ${name}` })
    }
  }
  return lines
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 一行 JSONL 事件 → 界面上新起的那一行；这一行不是 JSON、或者事件类型不关心时返回 null。
 *
 * 只认几种有信息量的事件（见 Pi 的 json 模式文档）：会话头、开始与结束、工具调用、
 * 助手消息、重试与错误。**认不出的 JSON 事件一律丢掉** —— 协议里的中间态很多
 * （队列变化、块的边界），全画出来只会把有用的几行淹掉。**流式增量走另一条**：
 * 它不是新起一行，而是把对话末尾那段接长（见 parsePiDelta 与 stores/ai.ts 的 onDelta）。
 * 反过来，非 JSON 的行（子进程的报错、npm 的输出）原样留下：那不是协议噪音，是它真的在说什么。
 */
export function parsePiEvent(rawLine: string): AiLogLine | null {
  const line = rawLine.trim()
  if (!line) return null

  let event: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    event = parsed as Record<string, unknown>
  } catch {
    const text = clean(rawLine)
    // 认得出的「启动提示」丢掉（见 BENIGN_STARTUP）；其余非 JSON 的行原样留下
    if (!text || BENIGN_STARTUP.test(text)) return null
    return { kind: 'info', text }
  }

  const type = str(event.type)

  switch (type) {
    case 'session': {
      const model = str(event.model) || str((event.session as Record<string, unknown>)?.model)
      return { kind: 'info', text: model ? `已连接模型 ${model}` : '已建立会话' }
    }
    case 'response': {
      // RPC 的应答：成功的一律不画（每一条命令都有一条应答，画出来全是噪音），
      // 失败的要留一句 —— 提示词没收下这种问题不然就彻底没人说
      if (event.success !== false) return null
      const command = str(event.command) || '请求'
      return { kind: 'error', text: str(event.error) || `${command} 没有成功` }
    }
    case 'agent_start':
      return { kind: 'info', text: '开始执行' }
    case 'agent_settled':
      return { kind: 'done', text: '执行结束' }
    case 'auto_retry_start': {
      const attempt = num(event.attempt)
      const max = num(event.maxAttempts)
      return {
        kind: 'info',
        text: attempt && max ? `连接不稳，正在重试（${attempt}/${max}）` : '连接不稳，正在重试'
      }
    }
    case 'tool_execution_start': {
      const name = str(event.toolName) || '工具'
      const { verb, writes } = toolVerb(name)
      const path = toolPath(event.args)
      const text = path ? `${verb} ${path}` : `${verb} ${name}`
      return writes && path ? { kind: 'tool', text, path } : { kind: 'tool', text }
    }
    case 'tool_execution_end': {
      const failed = event.is_error === true || event.isError === true || !!str(event.error)
      if (!failed) return null
      const name = str(event.toolName) || '工具'
      const reason = str(event.error) || '工具调用失败'
      return { kind: 'error', text: `${name}：${reason}` }
    }
    case 'message_update': {
      // 逐字增量不走这里（它接在对话末尾，见 parsePiDelta）；只有出错的事件要留一句
      const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>
      if (str(delta.type) !== 'error') return null
      return { kind: 'error', text: str(delta.error) || '模型返回出错' }
    }
    case 'message_end': {
      const message = (event.message ?? {}) as Record<string, unknown>
      // 模型侧的失败长在 message 上（stopReason=error + errorMessage），别的都不算
      const failure = str(message.errorMessage)
      if (failure) return { kind: 'error', text: clean(failure) }
      // 用户消息也会触发 message_end（@文件 的回显在这儿），只画助手说的
      const role = str(message.role)
      if (role && role !== 'assistant') return null
      const text = clean(messageText(message))
      return text ? { kind: 'text', text } : null
    }
    case 'error':
    case 'extension_error': {
      const text = str(event.message) || str(event.error) || '出错了'
      return { kind: 'error', text }
    }
    default:
      return null
  }
}

/**
 * 一行输出里的**流式增量**：`message_update` 里的 `text_delta` 就是模型刚吐出来的那几个字，
 * 界面按它把助手的回话一段段接出来（见 stores/ai.ts 的 onDelta）。
 *
 * 只认正文增量：`text_start` / `text_end` 不带新文字（整段由 `message_end` 给权威版本，
 * 见 parsePiEvent），思考增量（`thinking_delta`）也丢掉 —— 与读历史那条路同一条口径
 * （只留用户说的话、助手的正文与工具调用）。不是增量的行返回 null（含非 JSON 的行）。
 */
export function parsePiDelta(rawLine: string): string | null {
  const line = rawLine.trim()
  if (!line.startsWith('{')) return null

  let event: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    event = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (str(event.type) !== 'message_update') return null
  const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>
  if (str(delta.type) !== 'text_delta') return null
  return str(delta.delta) || null
}

// ---------- RPC 帧 ----------
/**
 * 一条命令的应答（RPC 的 `response`）：`get_messages` 这类**要读回数据**的命令靠它。
 * 请求里带的 `id` 会原样带回来 —— 适配层就是拿它把应答配回等它的那条命令
 * （workbench/ai.ts 的 aiRequest）。
 */
export interface PiResponse {
  /** 请求里带的 id（协议会原样带回）；没带 id 的请求这里是空串 */
  id: string
  /** 哪条命令的应答（`get_messages` / `abort` / …） */
  command: string
  success: boolean
  /** 成功时的结果（形状随命令不同；认不出就当没有） */
  data: unknown
  /** 失败时的一句话（协议里是 `error`） */
  error: string
}

/** 一行输出里那条应答帧；不是它、或认不出的返回 null（非 JSON 的行在这里也是 null） */
export function parsePiResponse(rawLine: string): PiResponse | null {
  const line = rawLine.trim()
  if (!line.startsWith('{')) return null

  let frame: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    frame = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (str(frame.type) !== 'response') return null
  const command = str(frame.command)
  if (!command) return null
  return {
    id: str(frame.id),
    command,
    success: frame.success !== false,
    data: frame.data,
    error: str(frame.error)
  }
}

/** 模型要执行一条命令，扩展回头问宿主：让不让跑（`extension_ui_request` 的 confirm） */
export interface AiConfirm {
  /** 帧 id：答复要原样带回去（RPC 用它配对） */
  id: string
  title: string
  /** 要执行的那条命令原文（多行也不截） */
  message: string
}

/**
 * 一行输出里那条「扩展要问宿主」的帧；不是它、或认不出的返回 null。
 *
 * RPC 里扩展的 UI 都是 `extension_ui_request`：只有 `confirm` 是给用户看的一句话
 * （其余几个方法——notify / setStatus / setWidget 之类——是给宿主画界面的提示，
 * 这个应用不画那些，一律当噪音丢掉）。
 */
export function parsePiConfirm(rawLine: string): AiConfirm | null {
  const line = rawLine.trim()
  if (!line.startsWith('{')) return null

  let frame: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    frame = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (str(frame.type) !== 'extension_ui_request') return null
  if (str(frame.method) !== 'confirm') return null
  const id = str(frame.id)
  if (!id) return null
  return { id, title: str(frame.title) || '执行命令前先确认', message: str(frame.message) }
}

/**
 * 回给 Pi 的答复：**一行 JSON 写回那条会话的 stdin**（`session_write`）。形状是 Pi 的
 * `RpcExtensionUIResponse`；答「不允许」时扩展会把这次工具调用挡回去（见 ai.rs 的扩展全文）。
 */
export function confirmFrame(id: string, confirmed: boolean): string {
  return JSON.stringify({ type: 'extension_ui_response', id, confirmed })
}

/** 这一轮写下的条目（去重、按路径排）：界面用它说「写入了这些东西」 */
export function writtenEntries(lines: AiLogLine[]): string[] {
  const seen = new Set<string>()
  for (const line of lines) {
    if (line.path) seen.add(line.path)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/**
 * 一轮的用时怎么念（界面在那一轮末尾补一行「用时 12 秒」）：
 * 10 秒以内给一位小数（「3.4 秒」—— 快慢分得出），再长就取整；满一分钟换成「1 分 05 秒」。
 * 它只是给用户一个「这轮跑了多久」的量级，不做精确到毫秒的仪表盘。
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms)
  const seconds = total / 1000
  if (seconds < 60) {
    return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`
}
