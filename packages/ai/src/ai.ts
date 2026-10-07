/**
 * AI 助手（页面 id `ai`）：应用里那个**通用的 agent 控制台** —— 选一个目录、写一条指令，
 * 请本机的 Pi（一个开源的编码 Agent，<https://pi.dev>）在那个目录里干活。
 *
 * 分工：这一份只有纯逻辑（提示词、命令行、事件流与 RPC 帧的读法），Rust 侧（ai.rs）管三件
 * 只有它能做的事 —— 提示词写进子进程的 stdin、密钥从凭据管理器进环境变量、权限扩展文件与
 * 「别去联网」那三个开关；编排在 stores/ai.ts。放在这里是为了能直接测：提示词少一条要求、
 * 命令少一个开关、RPC 帧认错一个字段，都是几行单测就能钉住的事。
 */
import { noteRootName, sanitizeNoteRoot } from '@workbench/notes'
import { stripAnsi } from '@workbench/terminal'
import { AI_BUILTIN_MODELS, type AiBuiltinModelEntry } from './ai-builtin-models.generated'

/**
 * 模型配置是**多服务形态**（模型管理弹窗里那一屏）：一个服务 = 名称 + Base URL + API 形态 +
 * 密钥 + 模型清单（每条可启停，带上下文与思考档位）。落点分三处：名称 / Base URL / API 形态 /
 * 模型清单进设置；密钥进 Windows 凭据管理器；Pi 用的那份 models.json 由 Rust 生成
 * （src-tauri/src/ai.rs 的 models_write —— apiKey 写的是环境变量引用，不落明文）。
 * HTTP 形态只认登记过的那两个（AI_API_FORMATS），厂商预设只填地址（AI_PROVIDER_PRESETS）。
 *
 * 会话（`AiSession`）也在这份里：一个会话 = 一个工作目录里的一段连续对话，与 Pi 自己的
 * 会话文件一一对应 —— 连续多轮与「重启后接着聊」都是它的功劳，不是应用自己攒的上下文。
 */

// ---------- AI 服务（模型管理弹窗里的那些） ----------

/** API 形态：models.json 的 `api` 字段认的 id（两个都来自 Pi 自己的材料，别凭印象加） */
export interface AiApiFormat {
  id: string
  label: string
}

export const AI_API_FORMATS: AiApiFormat[] = [
  { id: 'openai-completions', label: 'Chat Completions（/chat/completions）' },
  { id: 'anthropic-messages', label: 'Anthropic Messages（/v1/messages）' }
]

/**
 * 清单里的一条模型。**上下文与思考这两样是「端点说 / 认得出就当默认，认不出留空」**：
 * 用户在模型那一行上能改，改完落进 models.json（见 aiThinkingMap），Pi 拿它决定
 * 什么时候压缩上下文、以及 `/thinking` 里给哪几档。
 */
export interface AiModelEntry {
  /** 模型 id：端点的叫法（进 models.json 的 `id`，也进 `--model`） */
  id: string
  /** 启停：关掉的留在清单里（还能再打开），但不进 models.json、也挑不到 */
  enabled: boolean
  /** 别名：端点给的 name / display_name，用户也能改（界面上怎么叫它；空了回 id） */
  name: string
  /** 上下文窗口（token）。**0 = 不知道**：models.json 里不落这个字段，Pi 按它的 128000 兜底 */
  contextWindow: number
  /** 最大输出（token）。**0 = 不知道**：models.json 里不落这个字段，Pi 按它的 16384 兜底 */
  maxTokens: number
  /** 支持思考（Pi 的 `reasoning`）。false 时只有 `off` 一档，界面也就不给挑档位 */
  reasoning: boolean
  /** 支持的思考档位（AI_THINKING_LEVELS 的子集，按档位顺序；见 sanitizeAiThinkingLevels） */
  levels: string[]
  /**
   * 能看图（Pi 的 `input` 带 `"image"`）：工具结果里的截图、read 读的图片才会真的发给模型。
   * 添加模型时从随包 Pi 的内置目录预填（builtinModelMeta），用户在「高级」面板上能改。
   */
  imageInput: boolean
}

/** 一个服务最多留几个模型（models.json 那一边的上限也是这个数，改要一起改） */
export const AI_MODEL_MAX = 32
/** 最多几个服务（弹窗里排得下、models.json 也不会被撑爆） */
export const AI_PROVIDER_MAX = 12

/**
 * 一个 AI 服务 = **一个端点 + 一份模型清单**（模型管理弹窗里那一行）。
 *
 * 四样东西的落点：id / label / baseUrl / apiFormat / 模型清单进设置，密钥进 Windows
 * 凭据管理器（`Workbench/ai/<id>/token`），端点本身由 Rust 写成 Pi 的 models.json。
 */
export interface AiProvider {
  /** 端点键名：models.json 的键、凭据名的后缀（`ai/<id>/token`）、`--provider` 的值 */
  id: string
  /** 界面上怎么叫（预设的厂商名，或用户自己起的名字） */
  label: string
  baseUrl: string
  apiFormat: string
  /** 预设的厂商 id（界面拿它画字母头像）；自定义端点空串 */
  preset: string
  /** 停用的不进 models.json、也不能当默认模型（留着不用删，改天再打开） */
  enabled: boolean
  models: AiModelEntry[]
}

/**
 * 预设厂商：**只填地址与 API 形态**，用户粘一把 API Key 就能连上
 * （模型清单从端点拉，见 Rust 的 `ai_models_fetch`）。
 *
 * 收在这里的判据是「地址与形态都没争议」——宁可少列几个。地址写错的代价很实在：
 * 401 / 404 长得都像「你的 key 不对」。剩下的走「自定义端点」，那张表单的三个字段
 * （名称 / Base URL / API 形态）本来就是给这种情况准备的。**不内置任何模型清单**
 * （各家的模型名变得太快，清单由端点自己报）。
 */
export interface AiProviderPreset {
  id: string
  label: string
  baseUrl: string
  apiFormat: string
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai-completions' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic-messages' },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiFormat: 'openai-completions'
  },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai-completions' },
  { id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiFormat: 'openai-completions' },
  { id: 'zhipu', label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiFormat: 'openai-completions' },
  { id: 'zai', label: 'Z.AI', baseUrl: 'https://api.z.ai/api/paas/v4', apiFormat: 'openai-completions' },
  {
    id: 'dashscope',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiFormat: 'openai-completions'
  },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', apiFormat: 'openai-completions' },
  { id: 'volces', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiFormat: 'openai-completions' },
  { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', apiFormat: 'openai-completions' },
  { id: 'xiaomi', label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', apiFormat: 'openai-completions' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiFormat: 'openai-completions' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiFormat: 'openai-completions' },
  { id: 'xai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', apiFormat: 'openai-completions' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiFormat: 'openai-completions' },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', apiFormat: 'openai-completions' },
  { id: 'fireworks', label: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiFormat: 'openai-completions' },
  { id: 'cerebras', label: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', apiFormat: 'openai-completions' },
  { id: 'nvidia', label: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', apiFormat: 'openai-completions' },
  { id: 'huggingface', label: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', apiFormat: 'openai-completions' },
  { id: 'baseten', label: 'Baseten', baseUrl: 'https://inference.baseten.co/v1', apiFormat: 'openai-completions' },
  { id: 'opencode-zen', label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', apiFormat: 'openai-completions' },
  { id: 'opencode-go', label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiFormat: 'openai-completions' }
]

/** 认得出的预设（认不出的回空串：预设 id 只用来画头像，界面不该显示一个不存在的厂商） */
export function sanitizeAiPreset(value: unknown): string {
  if (typeof value !== 'string') return ''
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === value)?.id ?? ''
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

/** 界面上那个名字的收敛：压成一行、去空白、限长 */
export function sanitizeAiLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 40)
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

/** 模型 id 的收敛：去空白、限长（与清单里每一条同一条口径） */
export function sanitizeAiModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : ''
}

/** 上下文窗口的收敛：认不出的、非正数、离谱大的都回 0（= 不知道） */
export function sanitizeAiContext(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(size) || size <= 0) return 0
  return Math.min(Math.floor(size), 20_000_000)
}

/** 最大输出的收敛：与上下文同一条口径（非正数 / 离谱大 = 不知道，回 0） */
export function sanitizeAiMaxTokens(value: unknown): number {
  return sanitizeAiContext(value)
}

/** 支持思考的模型默认给哪几档：与 Pi 一致（见 aiThinkingMap 的说明） */
export const AI_THINKING_BASE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high']

/**
 * 思考档位的收敛：只留下这七档里认得出的、按档位顺序去重。
 * **不支持思考的模型只有 `off`**（Pi 那边 `getSupportedThinkingLevels` 就是这么算的），
 * 空清单也按这个默认给，免得界面上一个档位都不剩。
 */
export function sanitizeAiThinkingLevels(value: unknown, reasoning: boolean): string[] {
  if (!reasoning) return ['off']
  const raw = Array.isArray(value) ? value : AI_THINKING_BASE_LEVELS
  const wanted = new Set(raw.filter((level): level is string => typeof level === 'string'))
  const levels = AI_THINKING_LEVELS.filter((level) => wanted.has(level.id)).map((level) => level.id)
  return levels.length ? levels : [...AI_THINKING_BASE_LEVELS]
}

/**
 * 模型清单的收敛：去空白、按 id 去重（保序）、限量；缺的字段补齐（老数据文件里只有
 * id 与 enabled，上下文与思考那两样按「不知道」落）。
 */
export function sanitizeAiModels(value: unknown): AiModelEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: AiModelEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const id = sanitizeAiModelId(record.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const reasoning = record.reasoning === true
    result.push({
      id,
      enabled: record.enabled !== false,
      name: sanitizeAiLabel(record.name) || id,
      contextWindow: sanitizeAiContext(record.contextWindow),
      maxTokens: sanitizeAiMaxTokens(record.maxTokens),
      reasoning,
      levels: sanitizeAiThinkingLevels(record.levels, reasoning),
      imageInput: record.imageInput === true
    })
    if (result.length >= AI_MODEL_MAX) break
  }
  return result
}

/** 一个服务的收敛：认不出的整条丢掉（清单空的、地址不成形的、跑不起来的都不留） */
export function sanitizeAiProviders(value: unknown): AiProvider[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: AiProvider[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const id = sanitizeAiName(record.id)
    const baseUrl = sanitizeAiBaseUrl(record.baseUrl)
    const apiFormat = sanitizeAiApiFormat(record.apiFormat)
    const models = sanitizeAiModels(record.models)
    if (!id || !/^https?:\/\//.test(baseUrl) || !apiFormat || !models.length || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      label: sanitizeAiLabel(record.label) || id,
      baseUrl,
      apiFormat,
      preset: sanitizeAiPreset(record.preset),
      enabled: record.enabled !== false,
      models
    })
    if (result.length >= AI_PROVIDER_MAX) break
  }
  return result
}

/**
 * 「自动获取」的兜底：端点没报上下文 / 思考时，按模型 id 认一下。
 *
 * 规矩是**宁缺毋滥**：只认写法很确定的那些家族，认不出来就留空（上下文 0 = 不写进
 * models.json、Pi 按 128k 兜底；思考按不支持），由用户在模型那一行上改。
 * 编一个数字比留空更坏 —— 上下文给大了会在该压缩的时候不压缩。
 */
const AI_MODEL_HINTS: Array<{ pattern: RegExp; contextWindow: number; reasoning: boolean }> = [
  { pattern: /^claude-/, contextWindow: 200_000, reasoning: true },
  { pattern: /^o[1-9](-|$)/, contextWindow: 200_000, reasoning: true },
  { pattern: /^gpt-5/, contextWindow: 400_000, reasoning: true },
  { pattern: /^gpt-oss/, contextWindow: 131_072, reasoning: true },
  { pattern: /^gpt-4/, contextWindow: 128_000, reasoning: false },
  { pattern: /^deepseek-(reasoner|r\d|v3\.[12])/, contextWindow: 128_000, reasoning: true },
  { pattern: /^deepseek/, contextWindow: 128_000, reasoning: false },
  { pattern: /^gemini-(2\.5|3)/, contextWindow: 1_048_576, reasoning: true },
  { pattern: /^gemini/, contextWindow: 1_048_576, reasoning: false },
  { pattern: /^glm-(4\.[5-9]|[5-9])/, contextWindow: 128_000, reasoning: true },
  { pattern: /^glm-/, contextWindow: 128_000, reasoning: false },
  { pattern: /^kimi-(k2|k3|latest)/, contextWindow: 256_000, reasoning: true }
]

/**
 * 按模型 id 认一下上下文与思考（认不出就是「不知道」）。上下文写在名字里的那种
 * （`moonshot-v1-8k` / `-32k` / `-128k`）也在这条规则里。
 *
 * 它是预填的**最后一层**：Pi 自带的目录认得出的（builtinModelMeta）轮不到它。
 */
export function inferModelMeta(id: string): { contextWindow: number; reasoning: boolean } {
  const name = id.trim().toLowerCase()
  const moonshot = /^moonshot-v1-(\d+)k$/.exec(name)
  if (moonshot) return { contextWindow: Number(moonshot[1]) * 1024, reasoning: false }
  const hint = AI_MODEL_HINTS.find((item) => item.pattern.test(name))
  return hint
    ? { contextWindow: hint.contextWindow, reasoning: hint.reasoning }
    : { contextWindow: 0, reasoning: false }
}

/** 内置目录里认出来的一条默认值（认不出的字段按「不知道」给 0 / false） */
export interface AiBuiltinModelMeta {
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  imageInput: boolean
}

function toBuiltinMeta(entry: AiBuiltinModelEntry | undefined): AiBuiltinModelMeta | null {
  if (!entry) return null
  return {
    contextWindow: entry.contextWindow ?? 0,
    maxTokens: entry.maxTokens ?? 0,
    reasoning: entry.reasoning === true,
    imageInput: entry.image === true
  }
}

/**
 * 在随包 Pi 自带的模型目录里按 id 认一遍默认值 —— **Pi 跑同一个 id 用的就是这张表**，
 * 加模型时从它预填，端点没报也不至于把一个视觉模型配成纯文本（图片被 Pi 丢掉，
 * 模型只会说「我看不了图」）。目录是 vendor 脚本从钉死版本的 Pi 里剪出来的
 * （ai-builtin-models.generated.ts），应用不连 models.dev、也不拿它当模型清单。
 *
 * 认法三步，**更近的认法优先于更宽的**，每一步都先认原样再认小写（手工填 `GLM-5.2`
 * 也认得出来）：**指定厂商里认 id**（服务的 preset 与目录里的厂商同名时最准）、
 * **任意厂商里认 id**（按厂商名排序取第一个，结果稳定）、**认「厂商/模型」的后缀**
 * （OpenRouter 那种目录键带前缀、端点报裸 id 的情形）。都认不着回 null。
 */
export function builtinModelMeta(id: string, provider = ''): AiBuiltinModelMeta | null {
  const raw = sanitizeAiModelId(id)
  if (!raw) return null
  const lower = raw.toLowerCase()
  const keys = raw === lower ? [raw] : [raw, lower]
  const names = Object.keys(AI_BUILTIN_MODELS).sort()

  if (provider) {
    const map = AI_BUILTIN_MODELS[provider]
    if (map) {
      for (const key of keys) {
        const hit = toBuiltinMeta(map[key])
        if (hit) return hit
      }
    }
  }
  for (const name of names) {
    const map = AI_BUILTIN_MODELS[name]
    for (const key of keys) {
      const hit = toBuiltinMeta(map[key])
      if (hit) return hit
    }
  }
  for (const name of names) {
    const map = AI_BUILTIN_MODELS[name]
    for (const key of keys) {
      const prefixed = Object.keys(map)
        .sort()
        .find((candidate) => candidate.endsWith(`/${key}`))
      if (prefixed) return toBuiltinMeta(map[prefixed])
    }
  }
  return null
}

/**
 * 拉回来的一个模型（Rust 的 `ai_models_fetch` 的应答）：**端点说什么就是什么** ——
 * 上下文 / 最大输出 / 思考都可能缺（为 0 / 为 null 表示端点没提），
 * 渲染层拿内置目录与 inferModelMeta 兜底，用户在模型那一行上还能改。
 */
export interface AiFetchedModel {
  id: string
  name: string
  contextWindow: number
  /** 端点没报就是 0（不是「没有」） */
  maxTokens: number
  /** null = 端点没说（不是「不支持」） */
  reasoning: boolean | null
}

/**
 * 一步补全清单里新加的一条（端点的应答只带 id 时走它）。
 *
 * 每个字段都是「端点报了的优先，其次随包 Pi 的内置目录（`provider` 传服务的 preset id
 * 能让目录认得更准），再次按名字认一遍，都认不出才是『不知道』」—— 图片能力只有
 * 前两层（端点不报这个，名字也猜不得）；用户在「高级」面板上都能改。
 */
export function aiModelFromId(
  id: string,
  extra: Partial<AiModelEntry> = {},
  provider = ''
): AiModelEntry {
  const modelId = sanitizeAiModelId(id)
  const hint = inferModelMeta(modelId)
  const builtin = builtinModelMeta(modelId, provider)
  const reasoning = extra.reasoning ?? builtin?.reasoning ?? hint.reasoning
  return {
    id: modelId,
    enabled: extra.enabled !== false,
    name: sanitizeAiLabel(extra.name) || modelId,
    contextWindow:
      sanitizeAiContext(extra.contextWindow) || builtin?.contextWindow || hint.contextWindow,
    maxTokens: sanitizeAiMaxTokens(extra.maxTokens) || builtin?.maxTokens || 0,
    reasoning,
    levels: sanitizeAiThinkingLevels(extra.levels, reasoning),
    imageInput: extra.imageInput === true || builtin?.imageInput === true
  }
}

/**
 * 支持的档位 → models.json 的 `thinkingLevelMap`：**只有与 Pi 的默认不一样的那几档才落进去**。
 *
 * Pi 的算法（它自己的 `getSupportedThinkingLevels`）：`reasoning` 为真时 off / minimal /
 * low / medium / high 自动算支持；`xhigh` 与 `max` 必须在 map 里给一个字符串才算支持；
 * map 里某一档写成 `null` 就是明说不支持。所以这里：
 *
 *  - 支持 xhigh / max → 写成它自己那个名字（值就是档位 id —— Pi 拿它当 reasoning_effort
 *    那类字段的值，两档的名字各家一致）；
 *  - 不支持的档位 → `null`；
 *  - 其余不落（省得每次都要跟着 Pi 的默认表对着改）。
 *
 * 不支持思考的模型整份 map 都不写（它只看 `reasoning: false`）。
 */
export function aiThinkingMap(entry: AiModelEntry): Record<string, string | null> | undefined {
  if (!entry.reasoning) return undefined
  const supported = new Set(sanitizeAiThinkingLevels(entry.levels, true))
  const map: Record<string, string | null> = {}
  for (const { id } of AI_THINKING_LEVELS) {
    const extended = id === 'xhigh' || id === 'max'
    if (supported.has(id)) {
      // xhigh / max 不写就等于不支持，支持的必须显式写一个值出来了
      if (extended) map[id] = id
      continue
    }
    // 落回默认的那几档要写成 null 才是「不支持」；扩展档不支持的默认就是不支持，不必写
    if (!extended) map[id] = null
  }
  return Object.keys(map).length ? map : undefined
}

/**
 * 思考档位的回退：挑的那一档这个模型不支持时退到默认档（medium），
 * 默认档也不支持就退到它支持的最高一档；只有 `off` 就是 `off`。
 * 界面上那个下拉只列支持的档位，存坏的 / 换了模型的值全靠它收敛。
 */
export function pickAiThinking(levels: string[], chosen: string): string {
  // 只有 off 的模型（不支持思考）传进来的就是 ['off']；清单是空的按同一档算
  const list = sanitizeAiThinkingLevels(levels.length ? levels : ['off'], true)
  if (list.includes(chosen)) return chosen
  if (list.includes(AI_THINKING_DEFAULT)) return AI_THINKING_DEFAULT
  return list[list.length - 1] ?? 'off'
}

/** 页面上那个「模型」下拉里的一项：一个服务下启用的那颗模型 */
export interface AiModelChoice {
  /** 在清单里唯一（`<服务 id>/<模型 id>`）：下拉拿它当值 */
  key: string
  provider: string
  providerLabel: string
  /** 模型 id（`--model` 就是它） */
  model: string
  /** 界面上的显示名（端点给了就用它） */
  name: string
  contextWindow: number
  reasoning: boolean
  levels: string[]
  /**
   * 能看图（Pi 的 `input` 带 `"image"`）：界面上「能不能往这句话里贴图」按它拦 ——
   * 没勾的模型，Pi 会把图换成一句「图被略去」的占位，用户以为发过去了（见 AI_IMAGE_TYPES）。
   */
  imageInput: boolean
}

/** 能挑的模型：**启用的服务下启用的模型**，按服务清单的顺序排 */
export function aiModelChoices(providers: AiProvider[]): AiModelChoice[] {
  const choices: AiModelChoice[] = []
  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const entry of provider.models) {
      if (!entry.enabled) continue
      choices.push({
        key: `${provider.id}/${entry.id}`,
        provider: provider.id,
        providerLabel: provider.label || provider.id,
        model: entry.id,
        name: entry.name || entry.id,
        contextWindow: entry.contextWindow,
        reasoning: entry.reasoning,
        levels: entry.levels,
        imageInput: entry.imageInput
      })
    }
  }
  return choices
}

/**
 * 这一轮跑哪个模型：**用户在页面上挑的那颗**（记在设置里），它被关掉 / 删掉 / 服务被停用
 * 时退回清单里第一个能挑的；一个都没有就是 null（界面据此提示「还没配模型」）。
 */
export function pickAiChoice(
  providers: AiProvider[],
  provider: string,
  model: string
): AiModelChoice | null {
  const choices = aiModelChoices(providers)
  return (
    choices.find((choice) => choice.provider === provider && choice.model === model) ??
    choices[0] ??
    null
  )
}

/** 一个服务够不够跑：名称 + Base URL + API 形态 + 至少一个启用的模型 */
export function aiProviderReady(provider: AiProvider): boolean {
  return (
    !!sanitizeAiName(provider.id) &&
    /^https?:\/\//.test(sanitizeAiBaseUrl(provider.baseUrl)) &&
    !!sanitizeAiApiFormat(provider.apiFormat) &&
    provider.models.some((entry) => entry.enabled)
  )
}

/**
 * 一个服务在 models.json 里的那份形状（Rust 的 ProviderInput 就是照它收的）。
 * **字段名两边必须一字不差**（`maxTokens` / `imageInput` / `thinkingLevelMap`）——
 * 名字对不上 serde 不认识就静默丢弃（踩过：渲染层发 `input: [...]`、Rust 收
 * `imageInput: bool`，两边单测都是绿的，勾了「图片」却永远写不进 models.json）。
 */
export interface AiProviderPayload {
  id: string
  name: string
  baseUrl: string
  api: string
  models: Array<{
    id: string
    name: string
    contextWindow: number
    /** 端点 / 用户都没给就是不带这个字段（Pi 按 16384 兜底） */
    maxTokens?: number
    reasoning: boolean
    thinkingLevelMap?: Record<string, string | null>
    /** 能看图：Rust 收到真值再落成 Pi 的 `input: ["text","image"]` */
    imageInput?: boolean
  }>
}

/**
 * 设置里的服务清单 → 交给 Rust 写 models.json 的那份：**停用的服务与停用的模型都不进去**
 * （Pi 那边看到的清单就是界面上能挑的那些），思考档位映射在这一步算好
 * （aiThinkingMap —— 那条规则只写一处）。清单空的 / 跑不起来的服务也跳过，
 * 免得 models.json 里留一个连不上的端点。
 */
export function aiProviderPayload(providers: AiProvider[]): AiProviderPayload[] {
  return providers
    .filter((provider) => provider.enabled && aiProviderReady(provider))
    .map((provider) => ({
      id: sanitizeAiName(provider.id),
      name: sanitizeAiLabel(provider.label),
      baseUrl: sanitizeAiBaseUrl(provider.baseUrl),
      api: sanitizeAiApiFormat(provider.apiFormat),
      models: provider.models
        .filter((entry) => entry.enabled)
        .map((entry) => {
          const map = aiThinkingMap(entry)
          return {
            id: entry.id,
            name: entry.name,
            contextWindow: entry.contextWindow,
            ...(entry.maxTokens > 0 ? { maxTokens: entry.maxTokens } : {}),
            reasoning: entry.reasoning,
            ...(map ? { thinkingLevelMap: map } : {}),
            // 键名是（Rust 的）imageInput，不是 Pi 文件里的 input —— 后者由 Rust 落
            ...(entry.imageInput ? { imageInput: true } : {})
          }
        })
    }))
    .filter((provider) => provider.models.length > 0)
}

/**
 * 服务 id 的去重：用户连着加两个同名（或者预设重名）时排一个后缀上去
 * （`deepseek-2`、`deepseek-3`……），免得后加的那个把先加的覆盖掉。
 */
export function uniqueAiName(id: string, taken: string[]): string {
  const base = sanitizeAiName(id) || 'provider'
  if (!taken.includes(base)) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 32)
    if (!taken.includes(candidate)) return candidate
  }
  return base
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
  /** 这个会话自己的模型（服务名 + 模型 id 分开记）：没记过的回落设置里的默认模型 */
  provider?: string
  model?: string
  /** 思考档位（AI_THINKING_LEVELS 七档 id 之一）：没记过的回落设置里的默认档 */
  thinking?: string
  /** 工具权限（AI_PERMISSION_MODES 之一）：没记过的回落设置里的默认档 */
  permission?: string
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
  // 显式调起技能的那一轮：标题要的是「这段在聊什么」，开头那条 `/skill:名字` 是方式不是内容
  // （只剩命令、后面没写字的那种，照原样当标题）
  const words = stripSkillCommand(instruction).trim()
  return sanitizeAiSessionTitle(words || instruction)
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
    const entry: AiSession = {
      id,
      dir,
      title: sanitizeAiSessionTitle(record.title),
      createdAt,
      // 老文件里可能没有 updatedAt：那就以创建时间为准（排序只看它）
      updatedAt: sanitizeStamp(record.updatedAt) || createdAt
    }
    // 会话自己那份配置（模型 / 档位 / 权限）：**认得出才记**，认不出的不写字段 ——
    // 读的时候回落设置里的默认（见 stores/ai.ts 的 configOf）。老文件没有这些字段，原样有效
    const provider = sanitizeAiName(record.provider)
    if (provider) entry.provider = provider
    const model = typeof record.model === 'string' ? record.model.trim().slice(0, 200) : ''
    if (model) entry.model = model
    if (AI_THINKING_LEVELS.some((level) => level.id === record.thinking)) {
      entry.thinking = record.thinking as string
    }
    if (AI_PERMISSION_MODES.some((mode) => mode.id === record.permission)) {
      entry.permission = record.permission as string
    }
    result.push(entry)
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

/** 显式调起一个技能的那条命令的前缀（Pi 自己那条 `/skill:<名字>`，见下） */
export const AI_SKILL_COMMAND = '/skill:'

/**
 * 指令开头那条 `/skill:名字` → 那个名字（没有就是空串）。
 *
 * Pi 展开这条命令的两个硬条件都在这里体现：**只在文本最开头认**（`_expandSkillCommand` 一来就
 * `startsWith('/skill:')`），**一次只认一条**（名字取到第一个空白为止，后面整段都是它的参数）。
 */
export function skillCommandOf(instruction: string): string {
  const text = instruction.trimStart()
  if (!text.startsWith(AI_SKILL_COMMAND)) return ''
  const match = /^\S+/.exec(text.slice(AI_SKILL_COMMAND.length))
  return match ? match[0] : ''
}

/** 去掉开头那条 `/skill:名字` 与它后面的空白（没有就原样返回） */
export function stripSkillCommand(instruction: string): string {
  const match = /^\s*\/skill:\S+\s*/.exec(instruction)
  return match ? instruction.slice(match[0].length) : instruction
}

/**
 * 提示词 = 工作目录 + 指令原文。
 *
 * 页面是**通用**的：指令由用户写（想整理知识库就照那个仓库的规范写一条），应用不内置
 * 任何一类任务的提示词 —— 内置一份就会有两份（另一份在用户的脑子里 / 别处），
 * 改了一处另一处不知道。这里只管把「你在哪儿工作」说清楚。
 *
 * **显式调起技能的那一轮**（指令以 `/skill:名字` 开头，见 AI_SKILL_COMMAND）：命令必须挪到
 * 整个提示词的最前面 —— Pi 只在开头认它。于是「你在哪儿工作」那句脚手架就退到**命令的参数位**，
 * 展开出来正好是「技能全文 + 目录说明 + 用户自己写的那段」。不这么摆的话，前面那行脚手架会把
 * 命令顶到第二位，Pi 不认，整条命令就原样发给模型当普通文本了。
 */
export function taskPrompt(input: AiTaskInput): string {
  const dir = input.dir.trim()
  const raw = input.instruction.trim()
  const skill = skillCommandOf(raw)
  const instruction = skill ? stripSkillCommand(raw).trim() : raw
  const parts = [`${AI_PROMPT_PREFIX}${dir}`]
  if (instruction) parts.push('', instruction)
  const body = parts.join('\n')
  return skill ? `${AI_SKILL_COMMAND}${skill} ${body}` : body
}

/**
 * 落盘的提示词 → 界面上该显示的那一句：**把应用替模型加的那点脚手架去掉** ——
 * 开头那条 `/skill:名字` 与 `你在下面这个目录里工作：…` 那一行。
 *
 * 为什么两条都要剥：读历史时照原样画出来，用户会在自己的气泡里看见一句自己从没写过的话
 * （踩过：一整条气泡里就这一行最显眼）。**技能名留一半**：那是用户自己的选择，
 * 屏幕上得看得见 —— 于是 `/skill:名字` 保留、后面那些脚手架去掉。
 * 两条都没有就原样返回（用户手写的、别处粘来的，都别动）。
 */
export function visibleInstruction(text: string): string {
  const skill = skillCommandOf(text)
  const rest = stripScaffold(skill ? stripSkillCommand(text) : text)
  if (!skill) return rest
  return rest ? `${AI_SKILL_COMMAND}${skill} ${rest}` : `${AI_SKILL_COMMAND}${skill}`
}

/** 去掉开头那行「你在下面这个目录里工作：…」（连同它后面的空行）；没有那行就原样返回 */
function stripScaffold(text: string): string {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith(AI_PROMPT_PREFIX)) return text
  const rest = trimmed.slice(AI_PROMPT_PREFIX.length)
  const brk = rest.indexOf('\n')
  // 脚手架后面那个空行也一起吃掉，剩下的就是用户写的原文（尾部空白留给调用方去 trim）
  return brk < 0 ? '' : rest.slice(brk + 1).replace(/^\n+/, '')
}

// ---------- 用户贴在输入框里的图 ----------

/**
 * 贴在输入框里、要随这一句一起发出去的一张图。
 *
 * **存的是数据 URL**（`data:image/png;base64,…`）：缩略图直接拿它当 `src` 显示，
 * 发出去时再拆成 Pi 认的那两个字段（见 aiImagePayload —— 协议里是 `{type:'image',
 * data, mimeType}`，base64 不带 `data:` 前缀）。
 */
export interface AiImage {
  dataUrl: string
  /** `image/png` 那几种（从数据 URL 的头部取，也是 Pi 字段里那个 mimeType） */
  mimeType: string
}

/**
 * 收哪几种图：**Pi 能直接内联给模型的那四种**（它的 `normalizeSupportedImageMimeType`）
 * —— 其余格式它要么转成 PNG、要么换成一句「图被略去」，不如在贴进来这一刻就说清楚。
 */
export const AI_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * 一次最多贴几张：一张 4K 截图的 base64 就是好几 MB，而它们要挤进**同一行** JSON
 * （Rust 写进子进程的 stdin，见 ai.rs 的 prompt_frame）。
 */
export const AI_IMAGE_MAX = 4

/** 这个类型收不收（从剪贴板拿到的 mime 带参数时认前半段） */
export function aiImageAccepted(mimeType: string): boolean {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return AI_IMAGE_TYPES.includes(base)
}

/** 发给 Rust 的一张图（提示词那一行 JSON 里 Pi 的 `ImageContent`，见 ai.rs 的 prompt_frame） */
export interface AiImagePayload {
  /** base64：数据 URL 里逗号后面那一段 */
  data: string
  mimeType: string
}

/**
 * 数据 URL → Pi 那个 `{data, mimeType}` 的形状。**认不出的丢掉**（不是数据 URL 的、
 * 逗号后面空着的）—— 宁可少发一张，也别发一段它解析不了的东西出去。
 */
export function aiImagePayload(images: AiImage[]): AiImagePayload[] {
  const result: AiImagePayload[] = []
  for (const image of images) {
    const comma = image.dataUrl.indexOf(',')
    if (comma < 0) continue
    const data = image.dataUrl.slice(comma + 1).trim()
    const mimeType = image.mimeType.trim()
    if (!data || !mimeType) continue
    result.push({ data, mimeType })
  }
  return result
}

// ---------- 子进程的输出 ----------

/** 界面上的一行：种类决定颜色（彩色只表达运行状态），text 是给人看的 */
export interface AiLogLine {
  /**
   * `user` 是**用户自己写的那几句**（发出去时补一行、打开旧会话时从历史里读回来）：
   * 一段对话里它与助手说的话要分得开（画法见 AiRunPanel：它靠右、助手的话在左）。
   * `duration` 是一轮跑完时补的那一行「用时 …」—— 它不是对话内容，是这一轮的收据。
   * `thinking` 是模型想的那一段（草稿）：**在对话里画成一块收着的「思考过程」**，
   * 跑完自动收起、点一下还能展开（见 AiProcess.vue）。
   */
  kind: 'user' | 'info' | 'tool' | 'text' | 'error' | 'done' | 'duration' | 'thinking'
  text: string
  /**
   * 用户贴在这句话里的图（数据 URL，见 AiImage）：**只有 `user` 行会带** ——
   * 发出去那一刻补进那一行，打开旧会话时从历史里读回来。一句话可以只有图没有字。
   */
  images?: string[]
  /** 工具**写下**的文件（相对知识库根）：只有 write / edit 会带，用来汇总「这些条目是新的」 */
  path?: string
  /**
   * 鼠标停在那一行上才显示的补充：**给排障留的原文**，不该在正文里占地方。
   * 现在只有「这一轮跑的是什么」那条在用（完整命令行，见 stores/ai.ts）。
   */
  detail?: string
}

/** 去掉控制序列：终端那套清理是给整行用的，这里只清要展示的文本（OSC 之类的序列它也一并剥掉） */
function clean(text: string): string {
  return stripAnsi(text).trim()
}

/** 多行原文的头一句：错误行是窄行注脚，全文另收在 `detail` 里（见 failureLine） */
function firstLine(text: string): string {
  return text.split('\n')[0].trim()
}

/**
 * 失败那一行怎么念：`工具名：原文的头一句`，多行原文收进悬停的 detail（窄行里摆不下，
 * 「找不到 bash」那种还带一串搜索路径）。**实时那条（`parsePiEvent`）与读历史这条
 * （`sessionMessagesToLines`）共用它** —— 两处口径要一致，不然同一个失败重开会话就换个说法。
 *
 * 原文只从**工具结果**里来：`tool_execution_end` 的形状是
 * `{ toolCallId, toolName, result, isError }`，压根没有 `error` 字段 —— 只认 error 的话
 * 三种截然不同的失败（找不到 bash / EISDIR / ENOENT）会显示成同一句兜底文案。
 */
function failureLine(name: string, raw: string): AiLogLine {
  const detail = clean(raw)
  const reason = detail ? firstLine(detail) : '工具调用失败'
  const line: AiLogLine = { kind: 'error', text: `${name || '工具'}：${reason}` }
  if (detail && detail !== reason) line.detail = detail
  return line
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

/**
 * 一段内容的正文：形状可能是字符串，也可能是内容块数组（两种都认）。
 * 助手消息与工具结果用的是同一种形状（工具结果是 `{ content: [{ type: 'text', text }] }`）。
 */
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

/**
 * 一张图内容块（`{type:'image', data, mimeType}`）→ 数据 URL；认不出的回空串。
 * 落盘的是 base64，界面要的是能直接喂给 `<img>` 的那种串。
 */
function imageDataUrl(part: Record<string, unknown>): string {
  const data = str(part.data).trim()
  const mimeType = str(part.mimeType).trim()
  if (!data || !mimeType) return ''
  return `data:${mimeType};base64,${data}`
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
 * 工具调用是窄行，用户自己写的那几句单独一种行（`kind: 'user'`），**想的那一段**
 * （`thinking` 块）单独一种行 —— 界面上它是一块收着的「思考过程」。丢掉的：
 *
 *  - **系统消息**：它是提示词、工具清单与工作目录那一堆，不是对话；
 *  - **成功的工具结果原文**：一次读文件可能几百行，摆进对话里只会把它淹掉（工具调用那一行
 *    已经说了「读了哪个文件」）。**失败的那一条不能丢** —— 原文就一句错因，
 *    重开会话时它没了，用户回头再看就只剩一行「读取 …」（见 failureLine）。
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
      // 贴在这句话里的图（发出去时与文字同一条消息）：一句只有图没有字的话照画
      const images = contentParts(message)
        .filter((part) => str(part.type) === 'image')
        .map(imageDataUrl)
        .filter(Boolean)
      if (text || images.length) lines.push({ kind: 'user', text, ...(images.length ? { images } : {}) })
      continue
    }
    // 工具结果（落盘的 role 是 toolResult）：只有失败的那条留一行，与实时那条同一句话
    if (role === 'toolResult') {
      if (message.isError === true) {
        lines.push(failureLine(str(message.toolName), messageText(message)))
      }
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
      // 想的那一段（草稿）：界面上是一块收着的「思考过程」。被厂商脱敏过的块
      // 一个字都没有，那就不画
      if (type === 'thinking') {
        const text = clean(str(part.thinking))
        if (text) lines.push({ kind: 'thinking', text })
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
 * 一行输出 → JSON 对象：五条「一行 JSONL」的解析（parsePiEvent / parsePiDelta / parsePiUsage /
 * parsePiResponse / parsePiConfirm）共用的前置 —— trim 之后 JSON.parse，且必须是对象。
 * 不是合法 JSON、或解析出来不是对象（数组、字符串、数字、null）都返回 null，各自再按
 * 自己关心的事件类型去筛。**这里不先看首字符**：合法 JSON 但不是对象的行要走到 type 判断
 * 才能确定去留，提前拦会改变 parsePiEvent 对「原样保留的行」的判定。
 */
function parseJsonObject(rawLine: string): Record<string, unknown> | null {
  const line = rawLine.trim()
  if (!line) return null

  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
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
  const event = parseJsonObject(rawLine)
  if (!event) {
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
      // 失败与否看三处：事件顶层那两个（Pi 会给）、结果里的那一份（扩展可以改这一层，
      // 见 agent-loop 的 `afterResult.isError ?? isError`），以及老形状里的 error 字段
      const result = (event.result ?? {}) as Record<string, unknown>
      const failed =
        event.is_error === true || event.isError === true || result.isError === true || !!str(event.error)
      if (!failed) return null
      // 原文先看工具结果（Pi 现在就把原因放在那儿），error 字段只作兜底 —— 见 failureLine
      return failureLine(str(event.toolName), messageText(event.result) || str(event.error))
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
 * 一行输出里**正在长出来的那一段**，三种：
 *
 *  - `text`：模型正在写的正文（`text_delta`）；
 *  - `thinking`：模型正在想的那些（`thinking_delta`）—— 它是草稿，画在对话里但默认收着；
 *  - `thinkingEnd`：**一段思考到齐了**（`thinking_end` 带着这一整块的权威内容，见 Pi 的
 *    json.md：增量拼起来只是过程版）。
 *
 * 正文的整段仍由 `message_end` 给（那条是整条消息的权威版本，见 parsePiEvent）。
 * 不是增量的行返回 null（含非 JSON 的行）。
 */
export interface PiDelta {
  kind: 'text' | 'thinking' | 'thinkingEnd'
  text: string
}

export function parsePiDelta(rawLine: string): PiDelta | null {
  const event = parseJsonObject(rawLine)
  if (!event) return null

  if (str(event.type) !== 'message_update') return null
  const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>
  const kind = str(delta.type)

  if (kind === 'text_delta' || kind === 'thinking_delta') {
    const text = str(delta.delta)
    if (!text) return null
    return { kind: kind === 'text_delta' ? 'text' : 'thinking', text }
  }
  // 一段思考结束：**这一块以它为准**。内容为空也要报一声 —— 调用方靠它把「正在思考」
  // 那个状态收掉（被厂商脱敏过的块一个字都没有）
  if (kind === 'thinking_end') return { kind: 'thinkingEnd', text: clean(str(delta.content)) }
  return null
}

// ---------- Token 消耗 ----------

/**
 * 一条助手消息的 token 消耗（Pi 的 `message_end` 带整条消息，`usage` 长在它上面）。
 * **四个字段是互不重叠的桶**（pi-ai 拆好了：OpenAI 那套的 `input = prompt_tokens −
 * 命中缓存 − 缓存写入`）—— 展示时「输入」= input + cacheRead + cacheWrite（对端点来说
 * 都是收进去的 prompt），「输出」= output（思考 token 已含在内）。
 */
export interface AiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * 一行输出里那条助手消息的 token 消耗；不是 `message_end`（或端点没报）返回 null。
 *
 * **与 parsePiEvent 各走各的**：一轮里模型可能说了好几段（中间隔着工具调用），每段的
 * `message_end` 都带一份 usage —— 有的那段压根没有正文（只调了工具），画不出正文行来，
 * 挂在正文行上就会漏。调用方把多份**累加成这一轮的**（见 stores/ai.ts），收尾时跟在
 * 「用时 …」旁边落一行。
 */
export function parsePiUsage(rawLine: string): AiUsage | null {
  const event = parseJsonObject(rawLine)
  if (!event) return null

  if (str(event.type) !== 'message_end') return null
  const message = (event.message ?? {}) as Record<string, unknown>
  // 用户消息也会触发 message_end（@文件 的回显，见 parsePiEvent），它没有消耗
  const role = str(message.role)
  if (role && role !== 'assistant') return null
  const raw = (message.usage ?? {}) as Record<string, unknown>
  const field = (key: string): number => {
    const value = raw[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }
  const usage: AiUsage = {
    input: field('input'),
    output: field('output'),
    cacheRead: field('cacheRead'),
    cacheWrite: field('cacheWrite')
  }
  // 四个桶全是 0 = 这个端点没报消耗（自定义端点不保证都有），那就当没有
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  return total > 0 ? usage : null
}

/**
 * token 数怎么念（收据上那点字的量级，不是仪表盘）：一千以内给整数，一万以内给一位小数的
 * 「k」，再大取整；上百万换「m」。与模型弹窗认 `128k` 那格同一套单位（k / m 都是千进制）。
 *
 * 名字带 Short 是跟用量面板那套中文数量级（万 / 亿，见 @workbench/usage 的 formatTokensWan）
 * 分开 —— 两边都叫 formatTokens 的话， import 的人只能靠猜。
 */
export function formatTokensShort(value: number): string {
  const n = Math.max(0, Math.floor(value))
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

/**
 * 这一轮的消耗怎么念：`输入 … · 输出 …`。两边都是 0 返回空串 —— 端点没报就不写这段，
 * 「用时 12 秒」单独待着不难看。
 */
export function formatUsageSummary(usage: AiUsage): string {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  if (prompt === 0 && usage.output === 0) return ''
  return `输入 ${formatTokensShort(prompt)} · 输出 ${formatTokensShort(usage.output)}`
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
  const frame = parseJsonObject(rawLine)
  if (!frame) return null

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
  const frame = parseJsonObject(rawLine)
  if (!frame) return null

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

/**
 * 对话按「轮」切开，每轮再切成过程 / 答案 / 收据 —— 面板照它画（见 AiRunPanel.vue）：
 *
 *  - **过程**（`process`）：这一轮干活的全部 —— 想的那几段、工具调用、报错、旁白；
 *    正文后面只要还跟着工具 / 思考行，那段正文也是旁白（「我分块写入再合并」
 *    然后就去写文件了），跟着留在过程里。界面上它收成一块「过程」（AiProcess.vue）：
 *    一段对话要读的是「我说了什么、它最后说了什么」，中间那些步骤是要查证时才摊开的
 *    （一次读文件、一条命令都占一行，摊着就是一面墙）。
 *  - **答案**（`answer`）：**收尾时**紧挨着收据的那段正文 —— 它后面没再跟工具 / 思考，
 *    才算「最后说了什么」。`live` 为真（这轮还在跑）时不摘：正文落地也先留在过程里，
 *    新长出来的思考才会在它**下面**（摘出去的话思考段就压到它头上了，时序倒挂），
 *    等收尾（`agent_settled`）再弹出去当答案。
 *  - **收据**（`tail`）：轮尾成串的那几行（「用时 …」，收尾时才落地）—— 留在外面，
 *    它是一轮的句号。
 *
 * 边界是用户自己写的那句话：一句一轮。
 */
export interface AiTurn {
  /** 这一轮的第一行在整条日志里的下标（展开态跟着它走：日志只往后接，它不会变） */
  index: number
  user: AiLogLine | null
  process: AiLogLine[]
  answer: AiLogLine | null
  tail: AiLogLine[]
}

export function aiTurns(lines: AiLogLine[], live = false): AiTurn[] {
  const turns: Array<{ index: number; user: AiLogLine | null; rest: AiLogLine[] }> = []
  lines.forEach((line, index) => {
    // 用户那句话开一轮；整条日志的头几行（还没跟谁说过话时的那些注脚）也自成一「轮」
    if (line.kind === 'user' || !turns.length) turns.push({ index, user: null, rest: [] })
    const turn = turns[turns.length - 1]
    if (line.kind === 'user') turn.user = line
    else turn.rest.push(line)
  })

  return turns.map((turn) => {
    // 收据从轮尾往回收（「用时 …」收尾时才落地，只会成串地待在末尾）；
    // 紧挨着它的那段正文才是答案，再往前哪怕也是正文，那也是过程中的旁白
    let tailAt = turn.rest.length
    while (tailAt > 0 && turn.rest[tailAt - 1].kind === 'duration') tailAt--
    if (!live && tailAt > 0 && turn.rest[tailAt - 1].kind === 'text') {
      return {
        index: turn.index,
        user: turn.user,
        process: turn.rest.slice(0, tailAt - 1),
        answer: turn.rest[tailAt - 1],
        tail: turn.rest.slice(tailAt)
      }
    }
    // 摘不出答案（这轮还在跑 / 正文后面跟着工具或思考 / 压根没有正文）：
    // 收据以外全部归过程 —— 界面上按时序排在过程块里，正文不再占着「答案」的位置
    return {
      index: turn.index,
      user: turn.user,
      process: turn.rest.slice(0, tailAt),
      answer: null,
      tail: turn.rest.slice(tailAt)
    }
  })
}

/** 这个会话写下的条目（去重、按路径排）：界面用它说「写入了这些东西」 */
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
