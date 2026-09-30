/**
 * AI 助手的适配层：把「在一条会话里跑一轮」接到 Rust（`ai_run`）与进程会话的事件流上，
 * 外加密钥三条、探测、RPC 的命令应答与会话删除。
 *
 * **一个会话一个进程**：进程会话的 id 是 `ai:<会话 id>`（见 `aiSessionProcessId`），
 * 与终端会话**共用** `session:lines` / `session:exit` 两个事件，靠 id 分流 —— 这一层只认
 * 自己注册过的 id，别的放在那儿不动；反过来终端那边（session.ts 的 live 表）也没有这些 id，
 * 同样不会去接。同时跑几个会话，就是 `runs` 里有几条（界面一次只画一个，但各跑各的）。
 *
 * 输出里有三类帧：**事件流**（翻成界面上的步骤，`parsePiEvent`）、**扩展的询问**
 * （`parsePiConfirm` —— 模型要执行命令，答复由 `aiSend` 写回它的 stdin）、**命令的应答**
 * （`parsePiResponse` —— `get_messages` / `abort` 这类要读结果的命令靠 `aiRequest` 配对）。
 * 提示词与密钥都不从这一层过：提示词全文交给 `aiRun`，由 Rust 写成子进程 stdin 的一行
 * JSON（RPC 协议）；密钥存在 Windows 凭据管理器里，进子进程的环境变量。
 * 这一层只做形状收敛与事件翻译的接线，怎么读帧在 shared/ai.ts（有单测）。
 */
import {
  parsePiConfirm,
  parsePiDelta,
  parsePiEvent,
  parsePiResponse,
  parsePiUsage,
  type AiConfirm,
  type AiFetchedModel,
  type AiLogLine,
  type AiProviderPayload,
  type AiUsage,
  type PiDelta
} from '@workbench/ai'
import type { NoteRepoState } from '@workbench/notes'
import { fail, ok } from '@workbench/core'
import type { AiRunInput, Result } from '@/types'
import { errorText, invoke, listen } from './bridge'
import { noteRepoState } from './note'

/** AI 会话的 id 前缀：与项目终端（终端键）、包管理器安装（`pm-install:`）分得开 */
export const AI_SESSION_PREFIX = 'ai:'

/**
 * 一条会话在进程表里的 id：`ai:<会话 id>`。**会话 id 同时是 Pi 认的 session-id**
 * （在 `--session-id` 里，见 shared/ai.ts 的 piLaunch），前缀只是应用这边的命名空间 ——
 * 终端、安装那些会话共用一张表，靠它分得开。
 */
export function aiSessionProcessId(sessionId: string): string {
  return `${AI_SESSION_PREFIX}${sessionId}`
}

/** 安装 Pi 的那条会话的 id（也不属于任何终端） */
export const AI_INSTALL_SESSION_ID = 'ai-install'

/**
 * 工作目录的 git 状态：页面上只用它说清「在哪个分支上干活」（是不是仓库也用得上）。
 *
 * 与笔记 / 知识库是**同一条通道**（`note_repo_state` 本来就是「对任意文件夹、认它自己的
 * origin」的通用实现，见 commands.rs 的说明），这里只换个名字让人一眼看出是谁在问 ——
 * 实现直接借笔记那份，别再抄一遍形状收敛。
 */
export async function aiRepoState(dir: string): Promise<Result<NoteRepoState>> {
  return noteRepoState(dir)
}

interface RunHandlers {
  onLine: (line: AiLogLine) => void
  /**
   * 模型正一个字一个字往外吐（RPC 的 `message_update`）：**正文**（`text_delta`）接在
   * 对话末尾让回话流式长出来，**思考**（`thinking_delta` / `thinking_end`）接在末尾那块
   * 「思考中…」里 —— 形状见 shared/ai.ts 的 parsePiDelta。
   */
  onDelta: (delta: PiDelta) => void
  /**
   * 一条助手消息的 token 消耗（`message_end` 带的 `usage`，形状见 shared/ai.ts 的
   * parsePiUsage）：按轮累加是 store 的事，这里只把每一条递过去。
   */
  onUsage: (usage: AiUsage) => void
  /** 扩展问「这条命令让不让跑」（RPC 的 extension_ui_request）：要用户答一句才往下走 */
  onConfirm: (confirm: AiConfirm) => void
  onExit: (code: number | null) => void
}

/** 正在跑的会话：key 是进程会话 id，值是两个回调 */
const runs = new Map<string, RunHandlers>()

/** 等应答的命令（请求 / 应答按 id 配对），见 `aiRequest` */
interface PendingRequest {
  /** 这条命令属于哪个会话：那个进程退了就当场失败，不必等超时 */
  sessionId: string
  settle: (result: Result<unknown>) => void
}

const pending = new Map<string, PendingRequest>()

/** 命令应答的默认等待上限：够长到能扛住一次慢工具调用，又短到不会把界面永远吊住 */
const REQUEST_TIMEOUT = 15000

/** AI 运行时的探测结果：内置那份优先，没有再看全局 */
export interface AiRuntime {
  source: 'bundled' | 'path' | 'none'
  /** 内置 cli.js 的绝对路径（仅 bundled 模式有值；拼命令时直接交给 node） */
  cli: string
  /** Pi 版本串；两边都没有时是空串 */
  pi: string
  /** 本机 Node 版本串（内置 cli.js 一样要 node ≥ 22.19） */
  node: string
  /** 都没有时的原因（内置那份探测失败的原始输出），排障用，界面不展示 */
  detail: string
  /** 全局技能根（`%USERPROFILE%\.agents\skills`）：技能弹窗拿它扫列表、拼开关状态。拿不到用户目录时是空串 */
  skillRoot: string
}

/**
 * 探测 AI 运行时：内置（resources/pi）→ 全局 pi → 都没有。
 * 探测失败不该被吞掉（见 workbench/system.ts 的教训），warn 一条再按「都没有」处理。
 */
export async function aiRuntime(): Promise<AiRuntime> {
  try {
    const raw = await invoke<Partial<AiRuntime>>('ai_runtime')
    const source =
      raw.source === 'bundled' || raw.source === 'path' ? raw.source : ('none' as const)
    return {
      source,
      cli: typeof raw.cli === 'string' ? raw.cli : '',
      pi: typeof raw.pi === 'string' ? raw.pi : '',
      node: typeof raw.node === 'string' ? raw.node : '',
      detail: typeof raw.detail === 'string' ? raw.detail : '',
      skillRoot: typeof raw.skillRoot === 'string' ? raw.skillRoot : ''
    }
  } catch (error) {
    const message = errorText(error, '探测 AI 运行时失败')
    console.warn('[workbench] 探测 AI 运行时失败', error)
    return { source: 'none', cli: '', pi: '', node: '', detail: message, skillRoot: '' }
  }
}

/**
 * 装上事件监听（由 workbench/index.ts 在启动时与终端那套一起装）。
 * 只翻译自己认识的会话 —— 认不出的 id 一律不动，终端那边自己会接。
 */
export function installAiListeners(): void {
  listen<{ sessionId: string; lines: Array<{ stream: string; text: string }> }>(
    'session:lines',
    ({ sessionId, lines }) => {
      const handlers = runs.get(sessionId)
      if (!handlers) return
      for (const line of lines) {
        // **一条帧翻不出来不许连累同批后面的帧**：这里断一下，同一批里排在后面的
        // agent_settled 就没人处理了 —— 轮次收不了尾，转圈永远停不下来（踩过：
        // 开发期两份模块先后热更的窗子里，新分流调到旧 handlers 缺的回调就是这一幕）。
        // 记一条 warn 让问题看得见，然后继续走。
        try {
          dispatchLine(handlers, line)
        } catch (error) {
          console.warn('[workbench] 处理 Pi 的一帧输出失败', error, line.text.slice(0, 200))
        }
      }
    }
  )

  listen<{ sessionId: string; code: number | null }>('session:exit', ({ sessionId, code }) => {
    // 进程没了：还在等它应答的命令当场失败（等下去只会白等满超时）
    for (const [id, request] of [...pending]) {
      if (request.sessionId !== sessionId) continue
      pending.delete(id)
      request.settle(fail('这一轮已经结束了'))
    }
    const handlers = runs.get(sessionId)
    if (!handlers) return
    runs.delete(sessionId)
    handlers.onExit(code)
  })
}

/** 一帧输出走一遍分流：应答 → 流式增量 → 扩展询问 → 消耗与事件行（顺序就是热路径在前的顺序） */
function dispatchLine(handlers: RunHandlers, line: { stream: string; text: string }): void {
  // 先看它是不是某条命令的应答（`get_messages` / `abort` 这些要读结果的命令在等它）：
  // 配上了就不再当日志画 —— 读回来的数据不是给人看的，成败由等它的那边说
  const response = parsePiResponse(line.text)
  if (response && settleRequest(response)) return
  // 流式增量：助手正一个字一个字往外吐，接在对话末尾（这条是热路径，排在前面）
  const delta = parsePiDelta(line.text)
  if (delta !== null) {
    handlers.onDelta(delta)
    return
  }
  // 再看它是不是「扩展要问宿主」的那一帧：那不是日志，是要人答一件事
  const confirm = parsePiConfirm(line.text)
  if (confirm) {
    handlers.onConfirm(confirm)
    return
  }
  // 消耗与正文行同源（同一条 message_end 帧）：先递 usage 再落正文行，两个都要
  const usage = parsePiUsage(line.text)
  if (usage) handlers.onUsage(usage)
  const parsed = parsePiEvent(line.text)
  if (parsed) handlers.onLine(parsed)
}

/** 把应答兑现给等它的那条命令；没有在等它的（或不是应答）返回 false */
function settleRequest(response: ReturnType<typeof parsePiResponse>): boolean {
  if (!response || !response.id) return false
  const request = pending.get(response.id)
  if (!request) return false
  pending.delete(response.id)
  request.settle(
    response.success ? ok(response.data) : fail(response.error || `${response.command} 没有成功`)
  )
  return true
}

/**
 * 在一条会话里跑一轮：先挂回调再起进程（起得来才有事件，但顺序反过来的话，进程跑得够快时
 * 头几行会在挂上之前就发出去，日志缺开头）。**会话已经有进程在跑时 Rust 只把提示词写进
 * 它的 stdin**（接着聊），所以这个函数一句一轮地叫就行，`prompt` 传空串表示只把进程备好
 * （打开旧会话读历史走这条）。
 */
export async function aiRun(input: AiRunInput, handlers: RunHandlers): Promise<Result<number>> {
  runs.set(input.sessionId, handlers)
  try {
    const pid = await invoke<number>('ai_run', {
      sessionId: input.sessionId,
      dir: input.dir,
      prompt: input.prompt,
      // 随这一句贴的图（数据 URL 已拆成 Pi 的 `{data, mimeType}`，见 shared/ai.ts）
      images: input.images,
      program: input.program,
      args: input.args,
      provider: input.provider,
      permission: input.permission,
      // 这一轮启用的技能（根 + 技能名）：Rust 逐条拼成 `--skill <目录>` 交给 Pi
      skills: input.skills
    })
    return ok(pid)
  } catch (error) {
    runs.delete(input.sessionId)
    return fail(errorText(error, '启动失败'))
  }
}

/**
 * 写一条 RPC 命令并等它的应答（`get_messages` / `abort` 这类要读结果的）。
 *
 * 请求自己带一个 id，应答原样带回来 —— 事件流里认到那条应答就当场兑现（见
 * `settleRequest`）。**超时 / 进程退出都当失败**：一条等不到应答的命令不该把界面吊死。
 */
export async function aiRequest(
  sessionId: string,
  frame: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT
): Promise<Result<unknown>> {
  const id = `wb-${crypto.randomUUID()}`
  const sent = await aiSend(sessionId, JSON.stringify({ id, ...frame }))
  if (!sent.ok) return sent

  return await new Promise<Result<unknown>>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(fail('Pi 没有应答（这一轮可能正忙，或者进程已经不在了）'))
    }, timeoutMs)
    pending.set(id, {
      sessionId,
      settle: (result) => {
        clearTimeout(timer)
        resolve(result)
      }
    })
  })
}

/** 读回这条会话的全部历史消息（RPC 的 `get_messages`）：打开旧会话时画对话用 */
export async function aiMessages(sessionId: string): Promise<Result<unknown>> {
  const result = await aiRequest(sessionId, { type: 'get_messages' })
  if (!result.ok) return result
  const data = result.data
  const messages =
    data && typeof data === 'object' ? (data as { messages?: unknown }).messages : undefined
  return ok(messages)
}

/**
 * 停下这一轮（RPC 的 `abort`）：**进程留着、上下文留着**，只把正跑着的这一轮停掉 ——
 * 这是 Pi 自己的停止路径，比按进程树杀干净（杀进程会把它那一轮留成半截）。
 * 它「等这一轮真的停下来」才回应答，所以超时给得比别的命令长；应答没回来时调用方
 * 再按进程树杀（见 stores/ai.ts 的 stop）。
 */
export async function aiAbort(sessionId: string): Promise<Result<unknown>> {
  return aiRequest(sessionId, { type: 'abort' }, 12000)
}

/**
 * 往那条会话的 stdin 写一行（RPC 通道）：提示词的后续轮次、扩展确认的答复、以及
 * `aiRequest` 那些命令都走这里（提示词由 Rust 写，见 ai.rs）。订阅那一段的会话已经没有
 * stdin 这一条，写不进去会回一句明说的失败，不当成写成功了。
 */
export async function aiSend(sessionId: string, line: string): Promise<Result<null>> {
  try {
    await invoke('session_write', { sessionId, line })
    return ok(null)
  } catch (error) {
    return fail(errorText(error, '写入会话失败'))
  }
}

/** 收掉一条会话的进程：按进程树杀（Rust 侧来），随后的 session:exit 会把界面收回去 */
export async function aiStop(sessionId: string): Promise<Result<null>> {
  try {
    await invoke('stop_session', { sessionId })
    return ok(null)
  } catch (error) {
    return fail(errorText(error, '停止失败'))
  }
}

/**
 * 删掉一条会话：**先把进程收掉再删文件**（活着的进程还在往会话文件里写，
 * Windows 上那份文件删不掉），返回删掉几个文件（会话文件由 Pi 写，一段对话一份）。
 * 收进程失败（本来就没在跑）不算错 —— 继续删文件。
 */
export async function aiSessionDelete(sessionId: string): Promise<Result<number>> {
  await aiStop(aiSessionProcessId(sessionId))
  try {
    return ok(await invoke<number>('ai_session_delete', { sessionId }))
  } catch (error) {
    return fail(errorText(error, '删除会话失败'))
  }
}

/** 存 / 覆盖某个提供方的 API Key（进 Windows 凭据管理器） */
export async function aiKeySave(provider: string, secret: string): Promise<Result<null>> {
  try {
    await invoke('ai_key_save', { provider, secret })
    return ok(null)
  } catch (error) {
    return fail(errorText(error, '保存 Key 失败'))
  }
}

/** 这个提供方配过 Key 没有（只回有没有） */
export async function aiKeyState(provider: string): Promise<Result<boolean>> {
  try {
    return ok((await invoke<boolean>('ai_key_state', { provider })) === true)
  } catch (error) {
    return fail(errorText(error, '读取 Key 状态失败'))
  }
}

/** 清掉某个提供方的 Key */
export async function aiKeyClear(provider: string): Promise<Result<null>> {
  try {
    await invoke('ai_key_clear', { provider })
    return ok(null)
  } catch (error) {
    return fail(errorText(error, '清除 Key 失败'))
  }
}

/**
 * 写 AI 服务的 models.json（Pi 的 agent 目录下，`PI_CODING_AGENT_DIR` 指过去的那份）：
 * 模型管理弹窗里保存 / 增删 / 停用之后调，传的是**当前启用着的那些服务**，整份重写
 * （停用的不传 —— 它们不该出现在 Pi 那边）。密钥不进这份文件（里面只有环境变量引用）。
 */
export async function aiModelsWrite(providers: AiProviderPayload[]): Promise<Result<null>> {
  try {
    await invoke('ai_models_write', { providers })
    return ok(null)
  } catch (error) {
    return fail(errorText(error, '写入模型配置失败'))
  }
}

/**
 * 从用户自己那个端点拉一份模型列表（「添加服务」里粘完 Key、或点「获取列表」时调）。
 * **地址由 baseUrl 与 API 形态推出来**（`{baseUrl}/models`，Anthropic 那套是 `/v1/models`），
 * 打的是同一个主机、同一把 Key，只是换个路径 —— 这是 AI 那个出口的延伸，不新增出口。
 * `secret` 传空串表示用凭据管理器里存着的那把（编辑已经保存过的服务时不必重填）。
 */
export async function aiModelsFetch(
  provider: string,
  baseUrl: string,
  api: string,
  secret = ''
): Promise<Result<AiFetchedModel[]>> {
  try {
    const raw = await invoke<unknown[]>('ai_models_fetch', {
      provider,
      baseUrl,
      api,
      secret
    })
    const list = Array.isArray(raw) ? raw : []
    return ok(
      list.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const record = item as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id : ''
        if (!id) return []
        return [
          {
            id,
            name: typeof record.name === 'string' && record.name ? record.name : id,
            contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : 0,
            // 端点没报就是 0（不是「没有」）
            maxTokens: typeof record.maxTokens === 'number' ? record.maxTokens : 0,
            // null = 端点没说（不是「不支持」）
            reasoning: typeof record.reasoning === 'boolean' ? record.reasoning : null
          }
        ]
      })
    )
  } catch (error) {
    return fail(errorText(error, '获取模型列表失败'))
  }
}
