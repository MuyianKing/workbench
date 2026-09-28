/**
 * AI 助手的适配层：把「整理一轮」接到 Rust（`ai_run`）与进程会话的事件流上，
 * 外加密钥三条与探测。
 *
 * 与终端会话**共用** `session:lines` / `session:exit` 两个事件，靠会话 id 分流 ——
 * 这一层只认自己注册过的 id（`ai:` 开头），别的放在那儿不动；反过来终端那边
 * （session.ts 的 live 表）也没有这些 id，同样不会去接。两套互不打扰。
 *
 * 提示词与密钥都不从这儿过：提示词全文交给 `aiRun`，由 Rust 写进临时文件；
 * 密钥存在 Windows 凭据管理器里，进子进程的环境变量（见 src-tauri/src/ai.rs）。
 * 这一层只做形状收敛与事件翻译的接线，怎么读事件在 shared/ai.ts（有单测）。
 */
import { parsePiEvent, type AiLogLine } from '@shared/ai'
import { fail, ok } from '@shared/result'
import type { AiRunInput, Result } from '@shared/types'
import { errorText, invoke, listen } from './bridge'

/** AI 会话的 id 前缀：与项目终端（终端键）、包管理器安装（`pm-install:`）分得开 */
export const AI_SESSION_PREFIX = 'ai:'

/** 整理任务用的会话 id：同一时刻只跑一轮（界面在 running 时挡住重复点击） */
export const AI_SESSION_ID = `${AI_SESSION_PREFIX}organize`

/** 安装 Pi 的那条会话的 id（也不属于任何终端） */
export const AI_INSTALL_SESSION_ID = 'ai-install'

interface RunHandlers {
  onLine: (line: AiLogLine) => void
  onExit: (code: number | null) => void
}

/** 正在跑的会话：key 是会话 id，值是两个回调 */
const runs = new Map<string, RunHandlers>()

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
      detail: typeof raw.detail === 'string' ? raw.detail : ''
    }
  } catch (error) {
    const message = errorText(error, '探测 AI 运行时失败')
    console.warn('[workbench] 探测 AI 运行时失败', error)
    return { source: 'none', cli: '', pi: '', node: '', detail: message }
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
        const parsed = parsePiEvent(line.text)
        if (parsed) handlers.onLine(parsed)
      }
    }
  )

  listen<{ sessionId: string; code: number | null }>('session:exit', ({ sessionId, code }) => {
    const handlers = runs.get(sessionId)
    if (!handlers) return
    runs.delete(sessionId)
    handlers.onExit(code)
  })
}

/**
 * 跑一轮整理：先挂回调再起进程（起得来才有事件，但顺序反过来的话，进程跑得够快时
 * 头几行会在挂上之前就发出去，日志缺开头）。
 */
export async function aiRun(input: AiRunInput, handlers: RunHandlers): Promise<Result<number>> {
  runs.set(input.sessionId, handlers)
  try {
    const pid = await invoke<number>('ai_run', {
      sessionId: input.sessionId,
      dir: input.dir,
      prompt: input.prompt,
      program: input.program,
      args: input.args,
      provider: input.provider,
      model: input.model
    })
    return ok(pid)
  } catch (error) {
    runs.delete(input.sessionId)
    return fail(errorText(error, '启动整理失败'))
  }
}

/** 停掉整理：按进程树杀（Rust 侧来），随后的 session:exit 会把界面收回去 */
export async function aiStop(sessionId: string = AI_SESSION_ID): Promise<Result<null>> {
  try {
    await invoke('stop_session', { sessionId })
    return ok(null)
  } catch (error) {
    return fail(errorText(error, '停止失败'))
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
 * 写自定义端点的 models.json（Pi 的 agent 目录下，`PI_CODING_AGENT_DIR` 指过去的那份）：
 * 设置页保存「模型配置」时调。密钥不进这份文件（里面只有环境变量引用，见 ai.rs）。
 */
export async function aiProviderWrite(
  provider: string,
  baseUrl: string,
  api: string,
  models: string[]
): Promise<Result<null>> {
  try {
    await invoke('ai_provider_write', { provider, baseUrl, api, models })
    return ok(null)
  } catch (error) {
    return fail(errorText(error, '写入模型配置失败'))
  }
}
