import type { AiConfirm, AiLogLine, AiUsage } from '@workbench/ai'
import { formatDuration, formatUsageSummary } from '@workbench/ai'
import { reactive } from 'vue'

/**
 * 一个会话的运行态（内存，不落盘）：一段对话从这里长出来。
 * 落盘的那份只是调度用的记录（id / 目录 / 标题 / 时间，见 AiSession），对话本身在 Pi 那边。
 */
export interface AiRun {
  /** 这个会话的对话（历史 + 之后一轮轮接上来的） */
  lines: AiLogLine[]
  /** 这一轮在跑（Pi 在干活） */
  running: boolean
  /** 进程起过、还活着：连续对话靠它（跑完不收，见 ai.ts 文件头） */
  live: boolean
  /** 历史读回来过没有（打开会话时读一次） */
  hydrated: boolean
  /** 正在读历史（界面上给一个「正在接上这段对话」的样子） */
  hydrating: boolean
  /** 用户点了停止（`abort` 已经发出去） */
  stopping: boolean
  /** 模型 / 档位 / 权限改过了：这一轮跑完把进程收掉，下一句按新参数重开 */
  stale: boolean
  exitCode: number | null
  runError: string
  /** 等用户答话的命令（扩展的确认）：一次只画队首那条 */
  confirms: AiConfirm[]
  /** 这一轮是哪一刻发出去的（跑完拿它算用时）；0 = 这一轮还没开始 */
  startedAt: number
  /**
   * 助手正在流式吐出来的那段文字（`message_end` 一到就换成整段的权威版本，见 onLine）。
   * 面板把它画在对话末尾 —— 「一个字一个字长出来」就是这一段在变。
   */
  streamText: string
  /** 攒着还没发布出去的增量：发布按 STREAM_TICK 节流，见 onDelta */
  streamBuffer: string
  streamTimer: ReturnType<typeof setTimeout> | null
  /**
   * 模型正在想的那一段（`thinking_delta`）：与正文同一套节流，画在跑着那轮的
   * 「过程」块末尾（它就是那一刻最新的内容，长在所有已落地行的下面）。
   * **一段想完了（`thinking_end`）就落成一行 `kind: 'thinking'`**（收进同一块），这里随之清空。
   */
  thinkText: string
  thinkBuffer: string
  thinkTimer: ReturnType<typeof setTimeout> | null
  /** 这一刻正在思考（`thinking_start` / 第一个增量到、到 `thinking_end` 为止） */
  thinking: boolean
  /**
   * 这一轮攒下的 token 消耗（每条助手消息的 `usage` 累加，见 onUsage）：收尾时跟在
   * 「用时 …」旁边落一行（见 noteDuration）。发下一句时清零 —— 那一行是每一轮自己的账。
   */
  usage: AiUsage
}

/** 还没建过运行态时读到的那一份（只读，永远不写进去） */
export const IDLE_RUN: AiRun = Object.freeze({
  lines: [] as AiLogLine[],
  running: false,
  live: false,
  hydrated: false,
  hydrating: false,
  stopping: false,
  stale: false,
  exitCode: null,
  runError: '',
  confirms: [] as AiConfirm[],
  startedAt: 0,
  streamText: '',
  streamBuffer: '',
  streamTimer: null,
  thinkText: '',
  thinkBuffer: '',
  thinkTimer: null,
  thinking: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
})

/**
 * 流式增量发布的最小间隔（ms）：模型一个字一个字往外吐，每个字都重画一遍对话区
 * （还要重跑一遍 markdown）是白烧钱 —— 攒够这么一小会儿再画，看着仍是连续长出来的
 * （与 session.rs 那边按窗口攒批同一个思路）。
 */
export const STREAM_TICK = 80

/**
 * 每个会话的运行态容器，以及流式 / 思考两段的收尾。
 *
 * 从 `stores/ai.ts` 拆出来的叶子：只认自己的那份 Map，不碰设置、不碰 IPC。
 * 收尾的「落成一行」与「用时」都是纯状态迁移，单独放一处的价值是它能被单测直接覆盖。
 */
export function useAiRunState() {
  /** 每个会话的运行态：key 是会话 id（界面只画当前那个，但每个都在跑自己的） */
  const runs = reactive(new Map<string, AiRun>())

  /** 取一条会话的运行态（没有就建一个空的） */
  function runOf(sessionId: string): AiRun {
    const existing = runs.get(sessionId)
    if (existing)
      return existing
    const created: AiRun = {
      lines: [],
      running: false,
      live: false,
      hydrated: false,
      hydrating: false,
      stopping: false,
      stale: false,
      exitCode: null,
      runError: '',
      confirms: [],
      startedAt: 0,
      streamText: '',
      streamBuffer: '',
      streamTimer: null,
      thinkText: '',
      thinkBuffer: '',
      thinkTimer: null,
      thinking: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    runs.set(sessionId, created)
    // 回**代理**而不是 created 本体：reactive Map 的 get 才会把对象包成响应式代理，
    // 拿本体写的字段（hydrate 里的 hydrating / hydrated / lines）不触发任何依赖 ——
    // 界面就会永远停在旧值上（首次打开旧会话挂在「正在接上这段对话…」、对话迟迟不画，
    // 就是这批写入丢了响应式）
    return runs.get(sessionId) ?? created
  }

  /**
   * 流式那段收尾：把攒着的增量冲出来、清掉待发布的那口气。
   * `keep` 为真时（被停掉 / 进程没了时还没等到整段）把已经吐出来的部分**留在对话里** ——
   * 已经看到过的字不该凭空消失。
   */
  function endStream(run: AiRun, keep = false): void {
    if (run.streamTimer) {
      clearTimeout(run.streamTimer)
      run.streamTimer = null
    }
    const text = run.streamBuffer
    run.streamBuffer = ''
    run.streamText = ''
    if (keep && text.trim())
      run.lines = [...run.lines, { kind: 'text', text }]
  }

  /**
   * 思考那一段收尾（与 endStream 同一条路子）：`authoritative` 是 `thinking_end` 给的
   * 整块内容（有就以它为准），`keep` 为真时把这一段落成对话里的一行 `kind: 'thinking'`
   * —— 面板上它是那块**收着的**「思考过程」（跑完自动收起，点开还能看，见 AiProcess.vue）。
   */
  function endThink(run: AiRun, authoritative = '', keep = false): void {
    if (run.thinkTimer) {
      clearTimeout(run.thinkTimer)
      run.thinkTimer = null
    }
    const text = (authoritative || run.thinkBuffer).trim()
    run.thinkBuffer = ''
    run.thinkText = ''
    run.thinking = false
    if (keep && text)
      run.lines = [...run.lines, { kind: 'thinking', text }]
  }

  /**
   * 轮与轮之间那两条要不要画：**不画**。
   * 它们（`agent_start` 的「开始执行」与 `agent_settled` 的「执行结束」）是单次运行的步骤流里
   * 该有的分节，放到一段连续的对话里就成了每轮插一句的噪音 —— 用户那句与助手的正文本来就
   * 把两轮分得很清楚，跑没跑完由顶部那行状态说（`AiRunPanel` 的 notice）。
   */
  function isTurnMarker(line: AiLogLine): boolean {
    return line.kind === 'done' || (line.kind === 'info' && line.text === '开始执行')
  }

  /**
   * 在这一轮末尾补一行「用时 …」：回复长的时候用户就想知道它到底跑了多久
   * （也是「这一轮到这儿完了」的一个安静的句号 —— 那两条进度行不画，见 isTurnMarker）。
   * 端点报了消耗的话把 token 也带上（`输入 … · 输出 …`，这一轮各段消息累加的账）；
   * 没报就只有用时 —— 自定义端点不保证都有。
   */
  function noteDuration(run: AiRun): void {
    if (!run.startedAt)
      return
    const text = formatDuration(Date.now() - run.startedAt)
    run.startedAt = 0
    const usage = formatUsageSummary(run.usage)
    run.lines = [
      ...run.lines,
      { kind: 'duration', text: usage ? `用时 ${text} · ${usage}` : `用时 ${text}` },
    ]
  }

  return { runs, runOf, endStream, endThink, isTurnMarker, noteDuration }
}

/**
 * 一条会话的配置变过一次之后，它的进程该怎么收。
 *
 * - `previous === undefined`：会话刚出现，没有旧键可比，不动；
 * - 跑着的那一轮不掐断，等这轮完再换（`stale`）；
 * - 闲着的当场收掉，下一句按新参数重开（历史从会话文件接上）。
 */
export function configChangeAction(
  previous: string | undefined,
  next: string,
  run: Pick<AiRun, 'live' | 'running'> | undefined,
): 'none' | 'stale' | 'recycle' {
  if (previous === undefined || previous === next || !run?.live)
    return 'none'
  return run.running ? 'stale' : 'recycle'
}
