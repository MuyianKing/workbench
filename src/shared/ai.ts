/**
 * AI 助手（页面 id `ai`）：应用里那个**能代替 ZCode 整理知识库**的地方。
 *
 * 它不是一个「调模型接口」的客户端，而是把本机的 Pi（一个开源的编码 Agent，<https://pi.dev>）
 * 请到知识库目录里干活：应用负责挑出待整理的原始资料、把要求写成提示词、准备模型与密钥，
 * 然后起一个子进程让它按知识库自己的规范去读写条目；跑完由应用重建目录与索引。
 *
 * 分工：这一份只有纯逻辑（提示词、命令行、事件流的读法），Rust 侧（ai.rs）管三件只有它
 * 能做的事 —— 提示词落文件、密钥从凭据管理器进环境变量、替 Pi 关掉它自己的遥测；
 * 编排在 stores/ai.ts。放在这里是为了能直接测：提示词少一条要求、命令少一个开关，
 * 都是几行单测就能钉住的事。
 */

/**
 * 模型配置是**自定义端点**形态（照通用客户端的样子）：一个提供方 = 名称 + Base URL +
 * API 形态 + 密钥 + 模型清单（可启停）。落点分三处：名称 / Base URL / API 形态 / 模型清单
 * 进设置；密钥进 Windows 凭据管理器；Pi 用的那份 models.json 由 Rust 生成
 * （src-tauri/src/ai.rs 的 provider_write —— apiKey 写的是环境变量引用，不落明文）。
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

/** 这一轮跑哪个模型：第一个启用的。没有启用的就是空串（界面据此提示） */
export function activeAiModel(models: AiModelEntry[]): string {
  return models.find((model) => model.enabled)?.id ?? ''
}

// ---------- 交给子进程的东西 ----------

/**
 * 起 Pi 的那行命令。三处都不是随手写的：
 *
 *  - `--print --mode json`：一次性跑完，事件流（JSONL）给界面画步骤；
 *  - `--no-session`：这是一次性的活，不必在 Pi 的会话目录里留档；
 *  - `-xt bash,powershell`：只留 read / write / edit —— 整理条目用不着执行命令，
 *    关掉之后「不会跑脚本、不会碰 data/raw 之外的东西」这件事才有个硬边界；
 *  - `< "{prompt}"`：提示词从 stdin 进去（它有中文与换行，走命令行必炸；Pi 会把
 *    stdin 的内容并进第一个提示词，见 ai.rs 的文件头）。
 */
/** 起进程要用的程序与参数（`aiRun` 的入参形状，也是给 Rust 的最终形态） */
export interface PiLaunch {
  /** `node`（内置模式）或 `pi`（全局退路） */
  program: string
  /** 参数数组：直启、不经 shell，路径里有空格也不会被拆坏 */
  args: string[]
}

/**
 * 起 Pi 的程序与参数。`entry` 传内置那份 cli.js 的绝对路径（`ai_runtime` 探到的），
 * 传 null 表示用 PATH 上的全局 `pi`（没内置时的退路）。提示词**不在参数里**：
 * Rust 把它写进临时文件后以 Pi 的 `@文件` 语法追加在最后一个参数上（见 ai.rs）。
 *
 * 参数本身也不是随手写的：
 *
 *  - `--print --mode json`：一次性跑完，事件流（JSONL）给界面画步骤；
 *  - `--no-session`：这是一次性的活，不必在 Pi 的会话目录里留档；
 *  - `-xt bash,powershell`：只留 read / write / edit —— 整理条目用不着执行命令，
 *    关掉之后「不会跑脚本、不会碰 data/raw 之外的东西」这件事才有个硬边界。
 */
export function piLaunch(entry: string | null): PiLaunch {
  const flags = ['--print', '--mode', 'json', '--no-session', '-xt', 'bash,powershell']
  return entry
    ? { program: 'node', args: [entry, ...flags] }
    : { program: 'pi', args: [...flags] }
}

/** 含空白的参数在日志里补上引号，读得出来这是一段 */
function shellish(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg
}

/**
 * 给日志的那行：程序 + 参数 + 末尾的提示词文件占位（真正的 `@路径` 参数由 Rust 追加）。
 * 日志里要先把「跑的是什么」写下来（与终端面板同一条规矩）—— 出问题时这是唯一的线索。
 */
export function piLaunchForDisplay(launch: PiLaunch): string {
  return [...launch.args.map(shellish), '@<提示词文件>'].join(' ')
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
 * 提示词 = 工作目录 + 指令原文。
 *
 * 页面是**通用**的：指令由用户写（想整理知识库就照那个仓库的规范写一条），应用不内置
 * 任何一类任务的提示词 —— 内置一份就会有两份（另一份在用户的脑子里 / 别处），
 * 改了一处另一处不知道。这里只管把「你在哪儿工作」说清楚。
 */
export function taskPrompt(input: AiTaskInput): string {
  const dir = input.dir.trim()
  const instruction = input.instruction.trim()
  const parts = [`你在下面这个目录里工作：${dir}`]
  if (instruction) parts.push('', instruction)
  return parts.join('\n')
}

// ---------- 子进程的输出 ----------

/** 界面上的一行：种类决定颜色（彩色只表达运行状态），text 是给人看的 */
export interface AiLogLine {
  kind: 'info' | 'tool' | 'text' | 'error' | 'done'
  text: string
  /** 工具**写下**的文件（相对知识库根）：只有 write / edit 会带，用来汇总「这些条目是新的」 */
  path?: string
}

/** 去掉控制序列：终端那套清理是给整行用的，这里只清要展示的文本 */
function clean(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim()
}

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

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 一行 JSONL 事件 → 界面上一行；这一行不是 JSON、或者事件类型不关心时返回 null。
 *
 * 只认几种有信息量的事件（见 Pi 的 json 模式文档）：会话头、开始与结束、工具调用、
 * 助手消息、重试与错误。**认不出的 JSON 事件一律丢掉** —— 协议里的中间态很多
 * （逐字增量、队列变化），全画出来只会把有用的几行淹掉。反过来，非 JSON 的行
 * （子进程的报错、npm 的输出）原样留下：那不是协议噪音，是它真的在说什么。
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
    return text ? { kind: 'info', text } : null
  }

  const type = str(event.type)

  switch (type) {
    case 'session': {
      const model = str(event.model) || str((event.session as Record<string, unknown>)?.model)
      return { kind: 'info', text: model ? `已连接模型 ${model}` : '已建立会话' }
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
      // 逐字增量不画（会把日志淹掉）；只在出错的事件上留一句
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

/** 这一轮写下的条目（去重、按路径排）：界面用它说「写入了这些东西」 */
export function writtenEntries(lines: AiLogLine[]): string[] {
  const seen = new Set<string>()
  for (const line of lines) {
    if (line.path) seen.add(line.path)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}
