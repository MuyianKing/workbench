/**
 * AI 助手：一个通用的 agent 控制台 —— **在哪个目录里、跟哪一段对话**请内置的 Pi 干活。
 *
 * 左栏是一棵两层的树（见 shared/ai.ts 的 aiSessionGroups）：第一层是**项目**（一个工作目录），
 * 第二层是这个目录下的**会话**，一个会话 = 一段连续对话。页面上同时只画一个会话，而
 * **每个会话各有一个 Pi 进程**（`ai:<会话 id>`，见 workbench/ai.ts）—— 所以几个会话可以
 * 同时在跑，切过去看就行。
 *
 * 一轮的流程：写指令 → 拼提示词（shared/ai.ts 的 taskPrompt）→ 交给 `aiRun`（Rust 写进
 * 那个进程的 stdin）→ 事件流一段段接进这个会话的对话里 → `agent_settled` 表示这一轮跑完。
 * **跑完不收进程**：上下文就在那个进程里，接着说不必重放历史；盘上那份会话文件（Pi 自己写）
 * 则让应用重启后还接得上同一段（打开会话时经 RPC 的 `get_messages` 读回来画）。
 * **自动编辑**那一档下，模型要执行命令时 Pi 会回头问一句：那条询问进 `confirms`，
 * 画在运行面板里，用户答完才往下走（见 answerConfirm）。
 *
 * **它与知识库无关**：处理知识库只是「把目录指到那个仓库、写一条照它规范整理的指令」
 * 的一种用法；页面不内置任何一类任务，也不替用户写提示词。
 *
 * 不在这里做的事：取密钥、写提示词、写权限扩展、写 models.json、替 Pi 关掉它自己的出网开关、
 * 会话文件的落点 —— 都在 Rust 侧（见 src-tauri/src/ai.rs），因为密钥与提示词都不该经过渲染层。
 */
import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { noteRootName, sanitizeNoteRoot } from '@shared/note'
import {
  aiSessionGroups,
  aiSessionTitle,
  confirmFrame,
  formatDuration,
  nodeSatisfiesPi,
  piLaunch,
  piLaunchForDisplay,
  pickAiActiveSession,
  pickAiModel,
  rememberAiInstruction,
  rememberAiSession,
  sanitizeAiModelId,
  sanitizeAiName,
  sanitizeAiPermission,
  sanitizeAiSessionId,
  sanitizeAiThinking,
  sanitizeAiApiFormat,
  sanitizeAiBaseUrl,
  sanitizeAiModels,
  sessionMessagesToLines,
  taskPrompt,
  writtenEntries,
  type AiConfirm,
  type AiLogLine,
  type AiModelEntry,
  type AiSession
} from '@shared/ai'
import { confirmAction, notifyError, notifySuccess } from '@/notify'
import { useSettingsStore } from '@/stores/settings'
import { runDetached } from '@/workbench/session'
import {
  AI_INSTALL_SESSION_ID,
  aiAbort,
  aiKeyClear,
  aiKeySave,
  aiKeyState,
  aiMessages,
  aiProviderWrite,
  aiRepoState,
  aiRun,
  aiRuntime,
  aiSend,
  aiSessionDelete,
  aiSessionProcessId,
  aiStop
} from '@/workbench/ai'

/** Pi 的 npm 包名（它官方给的安装方式就是全局装一个包） */
const PI_PACKAGE = '@earendil-works/pi-coding-agent'

/** 模型配置弹层里编辑的草稿：与设置项一比一，另加一层未收敛的输入 */
export interface AiEndpointDraft {
  name: string
  baseUrl: string
  apiFormat: string
  models: AiModelEntry[]
}

/**
 * 一个会话的运行态（内存，不落盘）：一段对话从这里长出来。
 * 落盘的那份只是调度用的记录（id / 目录 / 标题 / 时间，见 AiSession），对话本身在 Pi 那边。
 */
interface AiRun {
  /** 这个会话的对话（历史 + 之后一轮轮接上来的） */
  lines: AiLogLine[]
  /** 这一轮在跑（Pi 在干活） */
  running: boolean
  /** 进程起过、还活着：连续对话靠它（跑完不收，见文件头） */
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
}

/** 还没建过运行态时读到的那一份（只读，永远不写进去） */
const IDLE_RUN: AiRun = Object.freeze({
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
  streamTimer: null
})

/**
 * 流式增量发布的最小间隔（ms）：模型一个字一个字往外吐，每个字都重画一遍对话区
 * （还要重跑一遍 markdown）是白烧钱 —— 攒够这么一小会儿再画，看着仍是连续长出来的
 * （与 session.rs 那边按窗口攒批同一个思路）。
 */
const STREAM_TICK = 80

export const useAiStore = defineStore('ai', () => {
  const settings = useSettingsStore()

  // ---------- 会话与项目（左栏那棵树） ----------

  /** 会话清单（落盘的那份：id / 目录 / 标题 / 时间） */
  const sessions = computed(() => settings.settings.aiSessions)
  /** 左栏那棵树：按工作目录分组，最近说过话的排在上面（见 shared/ai.ts） */
  const groups = computed(() => aiSessionGroups(sessions.value))
  /** 当前打开的会话：用户点过的那个，被删了回最近说过话的那个，一个都没有是空串 */
  const activeId = computed(() =>
    pickAiActiveSession(sessions.value, settings.settings.aiActiveSession)
  )
  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeId.value) ?? null
  )

  /** 每个会话的运行态：key 是会话 id（界面只画当前那个，但每个都在跑自己的） */
  const runs = reactive(new Map<string, AiRun>())
  /** 取一条会话的运行态（没有就建一个空的） */
  function runOf(sessionId: string): AiRun {
    const existing = runs.get(sessionId)
    if (existing) return existing
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
      streamTimer: null
    }
    runs.set(sessionId, created)
    return created
  }

  const activeRun = computed<AiRun>(
    () => runs.get(activeId.value) ?? IDLE_RUN
  )

  /** 指令原文（用户写的；切走再回来还在，重启不保留） */
  const instruction = ref('')

  /** 用过的指令（最新的在前，记在设置里）：页面下那排 chips */
  const history = computed(() => settings.settings.aiHistory)
  /** 页面上只摆最近这几条 */
  const recentInstructions = computed(() => history.value.slice(0, 4))
  /** 最近用过的工作目录（新会话那一栏的快速入口）：按树的顺序取，最多三个 */
  const recentDirs = computed(() => groups.value.slice(0, 3).map((group) => group.dir))

  /** 当前会话在哪个目录里干活（位置栏用它显示目录名） */
  const locationText = computed(() => (activeSession.value ? noteRootName(activeSession.value.dir) : ''))
  /**
   * 当前会话的工作目录的 git 状态（只读探测）：**只用来在页面上说清在哪个分支上干活**。
   * 探不到不是错误 —— 没仓库、没装 git 都照常干活，那一截只是不显示。
   */
  const repoBranch = ref('')

  /** 探一次当前会话那个目录的分支；没会话或探不到就清空（那截不显示） */
  async function refreshRepo(): Promise<void> {
    const dir = activeSession.value?.dir ?? ''
    if (!dir) {
      repoBranch.value = ''
      return
    }
    const state = await aiRepoState(dir)
    repoBranch.value = state.ok && state.data && state.data.isRepo ? state.data.branch : ''
  }

  // ---------- 配置（都在设置里；形状是自定义端点，见 shared/ai.ts） ----------
  const providerName = computed(() => settings.settings.aiProviderName)
  const baseUrl = computed(() => settings.settings.aiBaseUrl)
  const apiFormat = computed(() => settings.settings.aiApiFormat)
  const models = computed(() => settings.settings.aiModels)
  /** 页面上那个「模型」下拉里能挑的：清单里启用的那些 */
  const enabledModels = computed(() => models.value.filter((entry) => entry.enabled).map((entry) => entry.id))
  /** 这一轮跑哪个模型：页面上挑的那颗（挑的没了就退回第一个启用的，见 pickAiModel） */
  const runModel = computed(() => pickAiModel(models.value, settings.settings.aiRunModel))
  /** 思考档位：Pi 的 `--thinking` 那一档，页面上也是一个下拉 */
  const thinking = computed(() => sanitizeAiThinking(settings.settings.aiThinking))
  /**
   * 工具权限（composer 左边那一栏）：两档，见 shared/ai.ts 的 AI_PERMISSION_MODES。
   * **它决定 Pi 那边加不加载那份确认扩展** —— 自动编辑：每次要跑命令都先问一句；
   * 完全访问：不加载扩展，结构上就没有询问。改它要重开进程（见下面那个 watch）。
   */
  const permission = computed(() => sanitizeAiPermission(settings.settings.aiPermission))
  const providerLabel = computed(() => providerName.value || '还没配置')
  /** 能跑一轮的最低配置：名称 + Base URL + API 形态 + 至少一个启用的模型（密钥另算） */
  const configured = computed(
    () => !!providerName.value && !!baseUrl.value && !!apiFormat.value && !!runModel.value
  )

  // ---------- 这台机器上的环境 ----------
  /** 运行时来源：bundled = 随包内置的那份（resources/pi），path = 全局安装的，none = 都没有 */
  const runtimeSource = ref<'bundled' | 'path' | 'none'>('none')
  /** 内置 cli.js 的绝对路径（仅 bundled 模式有值；拼命令时交给 node） */
  const cliPath = ref('')
  /** 都没有时的原因（ai_runtime 的 detail）：排障用，界面不展示 */
  const runtimeDetail = ref('')
  const piVersion = ref('')
  const nodeVersion = ref('')
  const probed = ref(false)
  const probing = ref(false)
  const keyReady = ref(false)

  const piReady = computed(() => runtimeSource.value !== 'none')
  /** 内置 cli.js 要 node ≥ 22.19；不内置 Node，这条是硬门槛 */
  const nodeOk = computed(() => nodeSatisfiesPi(nodeVersion.value))
  /** 起进程要的东西齐了没有（与 canRun 比少了「指令」那一条）：打开会话要拿它挡一下 */
  const startable = computed(() => piReady.value && nodeOk.value && configured.value)

  // ---------- 当前画的这一屏 ----------
  const lines = computed(() => activeRun.value.lines)
  /** 助手正在流式吐出来的那段文字（画在对话末尾，接在已落地的那几行后面） */
  const streaming = computed(() => activeRun.value.streamText)
  const running = computed(() => activeRun.value.running)
  const hydrating = computed(() => activeRun.value.hydrating)
  const stopping = computed(() => activeRun.value.stopping)
  const confirms = computed(() => activeRun.value.confirms)
  const pendingConfirm = computed(() => activeRun.value.confirms[0] ?? null)
  const exitCode = computed(() => activeRun.value.exitCode)
  const runError = computed(() => activeRun.value.runError)
  /** 这个会话写下的文件（从对话里收的，去重排序） */
  const written = computed(() => writtenEntries(activeRun.value.lines))

  const installing = ref(false)
  const installLog = ref<string[]>([])

  const canRun = computed(
    () =>
      !!activeSession.value &&
      !running.value &&
      // 正在读回历史的那一会儿不让发：这一段的对话还没落地，发出去会把读回来的那段挤掉
      !hydrating.value &&
      piReady.value &&
      nodeOk.value &&
      configured.value &&
      keyReady.value &&
      !!instruction.value.trim()
  )

  /**
   * 还差什么才能跑。一次只说第一件缺的事 —— 按用户要动手的顺序排：
   * 会话 → Node → Pi → 模型 → 密钥 → 指令。空串表示都齐了。
   *
   * **它只出现在发送按钮的悬停里**：页面不摆提示行（这个工具是作者自己用的，页面上把控件
   * 已经说清的事再讲一遍就是噪音），那颗按钮按不动时才是它该说话的时候。
   */
  const blocking = computed(() => {
    if (!probed.value) return ''
    if (!activeSession.value)
      return '左栏还没有会话：点上面的「新建会话」挑一个目录 —— 那个目录就是这个子进程干活的地方。'
    if (hydrating.value) return '正在接上这段对话…等它读完就能接着说。'
    if (!nodeOk.value) return '这台机器的 Node 太旧：跑 Pi 需要 Node ≥ 22.19，先把 Node 升上去。'
    if (!piVersion.value)
      return '没找到 Pi 运行时：随包内置的那份不在（开发态先跑一次 npm run vendor:pi），PATH 上也没有全局安装的 —— 点右边的「安装 Pi」全局装一个。'
    if (!configured.value)
      return '还没配模型：点「模型」下拉里的「模型配置」，填 Base URL、API 格式与至少一个模型。'
    if (!keyReady.value) return `${providerLabel.value} 还没配 API Key：点「模型」下拉里的「模型配置」。`
    if (!instruction.value.trim()) return '还没写指令：接着这段对话说点什么。'
    return ''
  })

  // ---------- 环境探测 ----------

  /** 探一次运行时（内置 → 全局 pi → 都没有）与 node 版本；顺带查一下密钥配没配 */
  async function probe(): Promise<void> {
    probing.value = true
    try {
      const runtime = await aiRuntime()
      runtimeSource.value = runtime.source
      cliPath.value = runtime.cli
      runtimeDetail.value = runtime.detail
      piVersion.value = runtime.pi
      nodeVersion.value = runtime.node
    } finally {
      probed.value = true
      probing.value = false
    }
    await refreshKey()
  }

  /** 当前提供方有没有配过 Key（只回有没有，界面不显示内容） */
  async function refreshKey(): Promise<void> {
    const current = providerName.value
    if (!current) {
      keyReady.value = false
      return
    }
    const result = await aiKeyState(current)
    keyReady.value = result.ok && result.data === true
  }

  // ---------- 会话的增删选 ----------

  /**
   * 新建一个会话：挑一个工作目录（**项目就是它** —— 左栏的第一层），
   * 会话 id 现生成一个 uuid（同时就是 Pi 认的 session-id）。
   */
  async function createSession(dir: string): Promise<boolean> {
    const target = sanitizeNoteRoot(dir)
    if (!target) return false

    const now = Date.now()
    const session: AiSession = {
      id: crypto.randomUUID(),
      dir: target,
      title: '',
      createdAt: now,
      updatedAt: now
    }
    const saved = await settings.updateSettings({
      aiSessions: rememberAiSession(sessions.value, session),
      aiActiveSession: session.id
    })
    if (!saved) {
      notifyError('新建会话失败')
      return false
    }
    // 打开就把这一段接上（新会话没有历史，等于把进程先备好；环境不全时它自己会跳过）
    void hydrate(session.id)
    return true
  }

  /** 挑一个目录再新建（左栏那几个入口用的都是它） */
  async function pickSessionDir(title: string): Promise<void> {
    const picked = await window.workbench.pickDirectory(title)
    if (picked) await createSession(picked)
  }

  /**
   * 删掉一个会话：**对话记录一起删**（Pi 写在数据目录下的那份会话文件）——
   * 先问一句，用户点了确认才动手；进程由适配层先收掉，再删文件。
   */
  async function deleteSession(id: string): Promise<void> {
    const session = sessions.value.find((item) => item.id === id)
    if (!session) return

    const label = session.title || noteRootName(session.dir)
    const agreed = await confirmAction(
      `「${label}」这段对话的记录会一起删掉，删了就找不回来（目录里的文件不受影响）。`,
      '删除会话',
      { confirmButtonText: '删除', type: 'warning' }
    )
    if (!agreed) return

    const removed = await aiSessionDelete(id)
    if (!removed.ok) notifyError(removed.error ?? '删除会话失败')

    const rest = sessions.value.filter((item) => item.id !== id)
    // 这一段的收尾（流式那口气）先撤掉，再把它的运行态丢掉
    const dropped = runs.get(id)
    if (dropped) endStream(dropped)
    runs.delete(id)
    await settings.updateSettings({
      aiSessions: rest,
      aiActiveSession: pickAiActiveSession(rest, '')
    })
  }

  /**
   * 打开一个会话（点左栏那一行）：读过历史就直接画，没读过先把它接上。
   * **再点一次同一个也照样走一遍接历史**：上一回可能是环境不全（还没配模型）没接成，
   * 那会儿起不了进程 —— 它自己会用 `hydrated` / `hydrating` 两个标记挡住多余的往返。
   */
  async function selectSession(id: string): Promise<void> {
    const target = sanitizeAiSessionId(id)
    if (!target) return
    if (target !== activeId.value) await settings.updateSettings({ aiActiveSession: target })
    void hydrate(target)
  }

  /**
   * 把一段会话接上：**会话要跑着才读得回历史**（RPC 的 `get_messages` 得有一根活的 stdin），
   * 所以先让 Rust 把那个进程起起来（不发提示词），再问它要消息 —— 顺带这一段的进程也就备好了。
   *
   * 只在这次打开应用之后第一次打开它时做（读过就不再读）：之后这一段的对话由事件流
   * 一段段接在后面。环境不全时不起进程（界面上会说缺什么）。
   *
   * **还没说过话的会话直接跳过**（标题为空就是「没说过话」，见 run() 里写标题那一段）：
   * 它没有任何历史可读，为它起一次进程等于白花一两秒，还会在对话里落下 Pi 那句
   * 「没找到这个 id 的会话，就用它建一份」的启动提示（新会话本来就是这么建的）。
   * 第一句发出去时进程自然会起来。
   */
  async function hydrate(sessionId: string): Promise<void> {
    const session = sessions.value.find((item) => item.id === sessionId)
    if (!session) return
    const run = runOf(sessionId)
    if (run.hydrated || run.hydrating || run.running) return
    if (!session.title) {
      run.hydrated = true
      return
    }
    if (!startable.value) return

    run.hydrating = true
    try {
      const processId = aiSessionProcessId(sessionId)
      const launch = launchFor(session)
      const started = await aiRun(
        {
          sessionId: processId,
          dir: session.dir,
          // 空提示词 = 只把进程起起来（读历史要一根活的 stdin）
          prompt: '',
          program: launch.program,
          args: launch.args,
          provider: providerName.value,
          permission: permission.value
        },
        handlers(sessionId)
      )
      if (!started.ok) {
        run.runError = started.error ?? '这一个会话起不来'
        return
      }
      run.live = true

      const messages = await aiMessages(processId)
      // 读历史这一趟回来时，这一段要是已经开始说了（用户手快），就别把对话重写一遍 ——
      // 实时那条流已经在往下接了（发不出去的那段时间见 canRun 里的 hydrating）
      if (messages.ok && !run.running && run.lines.length === 0) {
        run.lines = [
          ...sessionMessagesToLines(messages.data),
          // 这一段挂在哪个进程上（命令行收在悬停里）：换过模型 / 重启过应用之后，
          // 「读回来的历史」与「现在跑的是什么」是两件事，这行把它说清楚
          noteProcess(session, launch)
        ]
      } else if (!messages.ok) {
        run.runError = messages.error ?? '读不回这段对话的历史'
      }
      run.hydrated = true
    } finally {
      run.hydrating = false
    }
  }

  /** 「这一段在哪个进程上」那一条：程序与参数（含绝对路径的 cli.js 与那一串开关）收进 detail */
  function noteProcess(session: AiSession, launch: { program: string; args: string[] }): AiLogLine {
    return {
      kind: 'info',
      text: `在 ${noteRootName(session.dir)} 里工作`,
      detail: `${launch.program} ${piLaunchForDisplay(launch)}`
    }
  }

  // ---------- 跑一轮 ----------

  /** 这一句要用的程序与参数（模型 / 档位 / 会话都在里面，见 shared/ai.ts 的 piLaunch） */
  function launchFor(session: AiSession) {
    return piLaunch(runtimeSource.value === 'bundled' ? cliPath.value : null, {
      provider: providerName.value,
      model: runModel.value,
      thinking: thinking.value
    }, session.id)
  }

  /** 一条会话的事件流接到哪儿去：按会话 id 分（几个会话可以同时在跑） */
  function handlers(sessionId: string) {
    return {
      onLine: (line: AiLogLine) => {
        // 这条会话已经被删掉了（进程收尾与删除之间那段）：这几行没地方可去，丢掉就是
        const run = runs.get(sessionId)
        if (!run) return
        // `agent_settled`：这一轮完了（**进程留着**，见文件头）。它是信号，不是对话里的一句
        if (line.kind === 'done') settle(sessionId)
        if (isTurnMarker(line)) return
        // 助手的整段正文到了（`message_end`）：它是权威版本 —— 流式那段到这儿换成它，
        // 一个字都不差（增量拼起来只是给人看着长出来的过程版）
        if (line.kind === 'text') endStream(run)
        run.lines = [...run.lines, line]
      },
      onDelta: (delta: string) => {
        const run = runs.get(sessionId)
        if (!run) return
        run.streamBuffer += delta
        // 攒够一小会儿再画（见 STREAM_TICK）：每个字都重画一遍是白烧钱
        if (run.streamTimer) return
        run.streamTimer = setTimeout(() => {
          run.streamTimer = null
          run.streamText = run.streamBuffer
        }, STREAM_TICK)
      },
      onConfirm: (confirm: AiConfirm) => {
        const run = runs.get(sessionId)
        if (!run) return
        run.confirms = [...run.confirms, confirm]
      },
      onExit: (code: number | null) => {
        finish(sessionId, code)
      }
    }
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
    if (keep && text.trim()) run.lines = [...run.lines, { kind: 'text', text }]
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
   * 在**当前这个会话**里说一句（没有会话时什么也不做，发送那颗按钮也按不动）。
   *
   * 起进程之前先把「这一轮要跑什么」与用户那句话写进对话：子进程起不来时那是唯一的线索；
   * 用过的指令与会话标题也在这时更新（跑没跑起来都算说过 —— 「试一次没成功」是最常见的
   * 情形，那时更需要留个底）。
   */
  async function run(): Promise<void> {
    const session = activeSession.value
    if (!session) return notifyError('先在左栏挑一个会话（或者新建一个）')
    const runState = runOf(session.id)
    if (runState.running) return

    const text = instruction.value.trim()
    if (!text) return notifyError('先写一条指令')
    if (!piReady.value) {
      return notifyError('没找到 Pi 运行时：内置那份不在，PATH 上也没有全局安装的')
    }
    if (!nodeOk.value) return notifyError('Node 版本太旧：跑内置的 Pi 需要 Node ≥ 22.19')
    if (!configured.value) return notifyError('先在「模型」里配好端点、模型与密钥')
    if (!keyReady.value) return notifyError(`还没有配置 ${providerName.value} 的 API Key`)

    const launch = launchFor(session)
    // 记一条用过的指令：**起进程之前**记（跑没跑起来都算用过 —— 「试一次没成功」是最常见的
    // 情形，那时更需要留个底）。页面下那排 chips 读的就是这份历史
    void settings.updateSettings({
      aiHistory: rememberAiInstruction(history.value, text),
      // 第一次说话时把标题定下来（左栏上那一行）；之后不再改
      aiSessions: rememberAiSession(sessions.value, {
        ...session,
        title: session.title || aiSessionTitle(text),
        updatedAt: Date.now()
      })
    })

    instruction.value = ''
    runState.running = true
    runState.stopping = false
    runState.startedAt = Date.now()
    // 上一轮万一还留着没冲掉的流式尾巴（正常路径下不会有）：这一轮开场前清掉，别串到新话里
    endStream(runState)
    runState.exitCode = null
    runState.runError = ''
    runState.confirms = []
    runState.lines = [
      ...runState.lines,
      { kind: 'user', text },
      // 进程还没起过（或换过参数）时把「这一轮跑的是什么」记一行：完整命令行（含绝对路径的
      // cli.js 与那一串开关）收进 detail —— 它是排障用的，摆在一行正文里只会把日志开头堵死
      // （界面拿它当悬停提示，见 AiRunPanel）。同一个进程接着聊时不必每轮都写一遍
      ...(runState.live
        ? []
        : [
            {
              kind: 'info' as const,
              text: `在 ${noteRootName(session.dir)} 里工作`,
              detail: `${launch.program} ${piLaunchForDisplay(launch)}`
            }
          ])
    ]

    const result = await aiRun(
      {
        sessionId: aiSessionProcessId(session.id),
        dir: session.dir,
        prompt: taskPrompt({ dir: session.dir, instruction: text }),
        program: launch.program,
        args: launch.args,
        provider: providerName.value,
        permission: permission.value
      },
      handlers(session.id)
    )

    if (result.ok) {
      runState.live = true
      return
    }
    runState.running = false
    runState.runError = result.error ?? '启动失败'
    notifyError(runState.runError)
  }

  /**
   * 这一轮跑完了（Pi 的 `agent_settled`）：**进程留着** —— 上下文就在它那儿，下一句接着聊
   * 就是接着它。参数改过（模型 / 档位 / 权限）时这一轮跑完顺手把进程收掉，下一句按新参数重开。
   */
  function settle(sessionId: string): void {
    const run = runs.get(sessionId)
    if (!run) return
    run.running = false
    run.stopping = false
    run.exitCode = 0
    // 半路停下的那一轮（abort 之后助手那段是空的）：把已经吐出来的字留在对话里
    endStream(run, true)
    noteDuration(run)
    if (run.stale) void recycle(sessionId)
  }

  /**
   * 在这一轮末尾补一行「用时 …」：回复长的时候用户就想知道它到底跑了多久
   * （也是「这一轮到这儿完了」的一个安静的句号 —— 那两条进度行不画，见 isTurnMarker）。
   */
  function noteDuration(run: AiRun): void {
    if (!run.startedAt) return
    const text = formatDuration(Date.now() - run.startedAt)
    run.startedAt = 0
    run.lines = [...run.lines, { kind: 'duration', text: `用时 ${text}` }]
  }

  /** 进程退出了（我们收的，或者它自己崩了）：把这一轮的状态收尾 */
  function finish(sessionId: string, code: number | null): void {
    // 会话已经被删掉时不重建条目（`runs.delete` 之后进程才收尾的那一小段）
    const run = runs.get(sessionId)
    if (!run) return
    run.live = false
    run.confirms = []
    const wasRunning = run.running
    const intentional = run.stopping || run.stale
    run.running = false
    run.stopping = false
    if (!wasRunning) return
    // 进程没了而整段还没等到（被杀 / 崩了）：已经吐出来的字留在对话里，再补用时
    endStream(run, true)
    noteDuration(run)
    run.exitCode = code
    // 我们让它停的（用户点了停止 / 换了参数）不算失败；它自己退的非零退出码要如实说
    if (code !== 0 && !intentional) {
      run.runError = `这一轮没有跑完（退出码 ${code ?? '未知'}）`
    }
  }

  /**
   * 停下当前这一轮：先发 RPC 的 `abort`（Pi 自己的停止路径 —— 进程留着、上下文留着，
   * 这一轮正常收尾）。**应答没回来**（它卡在某个请求上答不出来）就按进程树杀：
   * 那颗按钮什么时候都得有用。
   */
  async function stop(): Promise<void> {
    const session = activeSession.value
    if (!session) return
    const run = runOf(session.id)
    if (!run.running || run.stopping) return

    run.stopping = true
    const processId = aiSessionProcessId(session.id)
    const aborted = await aiAbort(processId)
    if (!aborted.ok) await aiStop(processId)
  }

  /**
   * 把一条会话的进程收掉（**会话文件不动**）：下一句会按新参数重开一份，历史从那份文件接上
   * （实测：杀掉进程重开，读回来的消息一条不少）。用在两处：模型 / 档位 / 权限改过之后，
   * 以及这一轮跑完之后才发现的「参数变过」。
   */
  async function recycle(sessionId: string): Promise<void> {
    const run = runOf(sessionId)
    run.stale = false
    if (!run.live) return
    run.stopping = true
    await aiStop(aiSessionProcessId(sessionId))
  }

  /**
   * 答一条命令的确认：答复写成一行 JSON 回子进程的 stdin（Pi 那边正等着它才往下走）。
   * 按 id 认（不是无脑弹队首）：答的是用户点的那一条，界面重画错位也不会答错人。
   * 顺手在对话里留一行 —— 这条命令最后跑没跑，事后要看得出来（确认条答完就没了）。
   */
  async function answerConfirm(id: string, allowed: boolean): Promise<void> {
    const session = activeSession.value
    if (!session) return
    const run = runOf(session.id)
    const confirm = run.confirms.find((item) => item.id === id)
    if (!confirm) return
    run.confirms = run.confirms.filter((item) => item.id !== id)

    const sent = await aiSend(aiSessionProcessId(session.id), confirmFrame(id, allowed))
    run.lines = [
      ...run.lines,
      { kind: 'tool', text: `${allowed ? '允许执行' : '拒绝执行'}：${confirm.message}` }
    ]
    if (!sent.ok) notifyError(sent.error ?? '答复没能送到 Pi 那边')
  }

  /**
   * 页面上那两个下拉挑了什么就是什么（都落设置，下次打开还是它）：
   * 模型是**清单里的 id**（关掉 / 删掉之后自动回退，见 pickAiModel），档位必落在那七档里。
   */
  async function setRunModel(id: string): Promise<boolean> {
    return settings.updateSettings({ aiRunModel: sanitizeAiModelId(id) })
  }

  async function setThinking(level: string): Promise<boolean> {
    return settings.updateSettings({ aiThinking: sanitizeAiThinking(level) })
  }

  /** 页面上那一栏挑了什么就记进设置（与模型 / 档位同一条口径：行为记忆） */
  async function setPermission(id: string): Promise<boolean> {
    return settings.updateSettings({ aiPermission: sanitizeAiPermission(id) })
  }

  // ---------- 配置与密钥 ----------

  /**
   * 保存模型配置：收敛校验 → 落设置 → 把 models.json 写给 Pi（agent 目录下）。
   * 三步都过了才算成功 —— Pi 是照那份文件认端点的，设置存下了而文件没写等于没配。
   */
  async function saveEndpoint(draft: AiEndpointDraft): Promise<boolean> {
    const name = sanitizeAiName(draft.name)
    const url = sanitizeAiBaseUrl(draft.baseUrl)
    const api = sanitizeAiApiFormat(draft.apiFormat)
    const list = sanitizeAiModels(draft.models)
    const enabled = list.filter((entry) => entry.enabled)

    if (!name) {
      notifyError('提供方名称要填：小写字母、数字与连字符')
      return false
    }
    if (!/^https?:\/\//.test(url)) {
      notifyError('Base URL 要以 http:// 或 https:// 开头')
      return false
    }
    if (!api) {
      notifyError('先选一个 API 形态')
      return false
    }
    if (!enabled.length) {
      notifyError('至少要启用一个模型')
      return false
    }

    const saved = await settings.updateSettings({
      aiProviderName: name,
      aiBaseUrl: url,
      aiApiFormat: api,
      aiModels: list
    })
    if (!saved) {
      notifyError('保存设置失败')
      return false
    }

    const written = await aiProviderWrite(
      name,
      url,
      api,
      enabled.map((entry) => entry.id)
    )
    if (!written.ok) {
      notifyError(written.error ?? '写入模型配置失败')
      return false
    }

    // 提供方名可能刚变过（改了名字 = 换了凭据名）：密钥状态重新问一次
    await refreshKey()
    notifySuccess('模型配置已保存')
    return true
  }

  async function saveKey(secret: string): Promise<boolean> {
    const current = providerName.value
    if (!current) {
      notifyError('先保存模型配置（提供方名称）')
      return false
    }
    const result = await aiKeySave(current, secret)
    if (!result.ok) {
      notifyError(result.error ?? '保存 Key 失败')
      return false
    }
    keyReady.value = true
    notifySuccess(`已保存 ${current} 的 API Key`)
    return true
  }

  async function clearKey(): Promise<void> {
    const current = providerName.value
    if (!current) return
    const result = await aiKeyClear(current)
    if (!result.ok) {
      notifyError(result.error ?? '清除 Key 失败')
      return
    }
    keyReady.value = false
    notifySuccess(`已清除 ${current} 的 API Key`)
  }

  /** 装 Pi（全局装那一个包）。输出进安装日志，装完自动重探一次 */
  async function installPi(): Promise<void> {
    if (installing.value) return

    installing.value = true
    installLog.value = []
    try {
      const code = await runDetached(
        AI_INSTALL_SESSION_ID,
        `npm install -g ${PI_PACKAGE}`,
        (text) => {
          installLog.value = [...installLog.value, text]
        }
      )
      if (code === 0) {
        notifySuccess('Pi 装好了')
        await probe()
      } else {
        notifyError(`安装没有成功（退出码 ${code ?? '未知'}）`)
      }
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '安装失败')
    } finally {
      installing.value = false
    }
  }

  let started = false

  /** 进页面时探一次环境（KeepAlive 下重复进入不再探）；顺带把上次那个会话接上 */
  async function init(): Promise<void> {
    if (started) return
    started = true
    await probe()
    await refreshRepo()
    if (activeId.value) void hydrate(activeId.value)
  }

  // 设置里换了提供方名（也可能是在别处改的）：密钥状态得重新问
  watch(providerName, () => {
    if (started) void refreshKey()
  })

  // 换了一个会话：看它那个目录的分支（挑目录那条路自己会刷，这里兜住左栏那几下点击）
  watch(activeId, () => {
    if (started) {
      void refreshRepo()
      if (activeId.value) void hydrate(activeId.value)
    }
  })

  // 环境刚好在这一刻齐了（比如刚配完模型就切回来）：那一条还没接过历史的会话补接一次 ——
  // 那次打开时起不了进程，读历史就没做成
  watch(startable, (ready) => {
    if (started && ready && activeId.value) void hydrate(activeId.value)
  })

  /**
   * 模型 / 档位 / 权限改过之后：**已经开着的会话要用新参数就得把进程换掉** ——
   * 这三样是起进程时定死的（`--model` / `--thinking` / 那份权限扩展加不加载）。
   * 正在跑的那些等这一轮跑完再换（`stale`），不然一次改设置就把用户干到一半的活掐了；
   * 闲着的当场收掉，下一句重开（历史从会话文件接上，不丢东西）。
   */
  watch([runModel, thinking, permission], () => {
    if (!started) return
    for (const [sessionId, run] of runs) {
      if (!run.live) continue
      if (run.running) run.stale = true
      else void recycle(sessionId)
    }
  })

  return {
    sessions,
    groups,
    activeId,
    activeSession,
    runs,
    instruction,
    history,
    recentInstructions,
    recentDirs,
    locationText,
    repoBranch,
    providerName,
    baseUrl,
    apiFormat,
    models,
    enabledModels,
    runModel,
    thinking,
    permission,
    providerLabel,
    configured,
    runtimeSource,
    cliPath,
    runtimeDetail,
    piVersion,
    nodeVersion,
    probed,
    probing,
    keyReady,
    piReady,
    nodeOk,
    lines,
    streaming,
    running,
    hydrating,
    stopping,
    confirms,
    pendingConfirm,
    exitCode,
    runError,
    written,
    installing,
    installLog,
    canRun,
    blocking,
    init,
    probe,
    refreshKey,
    refreshRepo,
    createSession,
    pickSessionDir,
    deleteSession,
    selectSession,
    hydrate,
    run,
    stop,
    answerConfirm,
    setRunModel,
    setThinking,
    setPermission,
    saveEndpoint,
    saveKey,
    clearKey,
    installPi
  }
})
