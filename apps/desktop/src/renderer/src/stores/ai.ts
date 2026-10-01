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
import { noteRootName, sanitizeNoteRoot } from '@workbench/notes'
import {
  AI_IMAGE_MAX,
  aiImagePayload,
  aiModelChoices,
  aiProviderPayload,
  aiSessionGroups,
  aiSessionTitle,
  confirmFrame,
  formatDuration,
  formatUsageSummary,
  nodeSatisfiesPi,
  piLaunch,
  piLaunchForDisplay,
  pickAiActiveSession,
  pickAiChoice,
  pickAiThinking,
  rememberAiSession,
  sanitizeAiApiFormat,
  sanitizeAiBaseUrl,
  sanitizeAiLabel,
  sanitizeAiModels,
  sanitizeAiName,
  sanitizeAiPermission,
  sanitizeAiPreset,
  sanitizeAiSessionId,
  sanitizeAiSessions,
  sanitizeAiThinking,
  sessionMessagesToLines,
  taskPrompt,
  writtenEntries,
  type AiConfirm,
  type AiFetchedModel,
  type AiImage,
  type AiLogLine,
  type AiModelChoice,
  type AiProvider,
  type AiSession,
  type AiUsage,
  type PiDelta
} from '@workbench/ai'
import type { Result } from '@/types'
import { confirmAction, notifyError, notifySuccess, notifyWarning } from '@/notify'
import { useAiSkillsStore } from '@/stores/ai-skills'
import { useSettingsStore } from '@/stores/settings'
import { runDetached } from '@/workbench/session'
import {
  AI_INSTALL_SESSION_ID,
  aiAbort,
  aiKeyClear,
  aiKeySave,
  aiKeyState,
  aiMessages,
  aiModelsFetch,
  aiModelsWrite,
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
  streamTimer: null,
  thinkText: '',
  thinkBuffer: '',
  thinkTimer: null,
  thinking: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
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
  /**
   * 正在起一段新的（左栏那颗「+」点过了）：**右栏画起始那一屏**，与一段会话都还没有时
   * 同一屏 —— 挑目录、写第一句，会话在发出那一句时才建（见 run）。它不改设置里的
   * `aiActiveSession`：那一位记的是「上次打开的是哪一个」，起一段新的不该把它冲掉。
   */
  const drafting = ref(false)

  /**
   * 打开的那个会话：用户点过的那个，被删了回最近说过话的那个，一个都没有（或者正在起
   * 一段新的）是空串 —— 空串就是右栏画起始那一屏、左栏哪一行都不铺底色。
   */
  const activeId = computed(() =>
    drafting.value ? '' : pickAiActiveSession(sessions.value, settings.settings.aiActiveSession)
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
      streamTimer: null,
      thinkText: '',
      thinkBuffer: '',
      thinkTimer: null,
      thinking: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
    runs.set(sessionId, created)
    // 回**代理**而不是 created 本体：reactive Map 的 get 才会把对象包成响应式代理，
    // 拿本体写的字段（hydrate 里的 hydrating / hydrated / lines）不触发任何依赖 ——
    // 界面就会永远停在旧值上（首次打开旧会话挂在「正在接上这段对话…」、对话迟迟不画，
    // 就是这批写入丢了响应式）
    return runs.get(sessionId) ?? created
  }

  const activeRun = computed<AiRun>(
    () => runs.get(activeId.value) ?? IDLE_RUN
  )

  /** 指令原文（用户写的；切走再回来还在，重启不保留） */
  const instruction = ref('')

  /**
   * 贴在输入框里的图（还没发出去的那几张，一次最多 AI_IMAGE_MAX 张）：**它们随这一句
   * 一起发出去**（与提示词同一条命令，见 workbench/ai.ts 的 aiRun），发出去就清空。
   * 与 `instruction` 同一条口径：切走再回来还在，重启不保留。
   */
  const images = ref<AiImage[]>([])

  /**
   * 收下几张刚贴进来的图：超量的当场说清楚（**别攒着让用户以为发出去了** ——
   * 模型收不到的那种，Pi 会把它换成一句「图被略去」的占位）。
   */
  function addImages(incoming: AiImage[]): void {
    const room = AI_IMAGE_MAX - images.value.length
    if (room <= 0) {
      notifyWarning(`一条消息最多贴 ${AI_IMAGE_MAX} 张图`)
      return
    }
    images.value = [...images.value, ...incoming.slice(0, room)]
    if (incoming.length > room) {
      notifyWarning(`一条消息最多贴 ${AI_IMAGE_MAX} 张图，多出来的没收`)
    }
  }

  /** 删掉贴上的第几张（缩略图角上那颗 ×） */
  function removeImage(at: number): void {
    images.value = images.value.filter((_, index) => index !== at)
  }

  /** 清空贴上的图（这一句发出去了） */
  function clearImages(): void {
    images.value = []
  }

  /**
   * 正在按起始那一屏挑的目录建会话（见 run → startSession）：那一下要等一个来回
   * （落设置），这期间再点一次会**建出第二个会话、发出去两句** —— 拿它挡一下。
   */
  const creating = ref(false)

  /** 最近用过的工作目录（挑目录那几处列的就是它）：按树的顺序取，最多三个 */
  const recentDirs = computed(() => groups.value.slice(0, 3).map((group) => group.dir))

  /**
   * 还没有会话时那一屏（`AiView` 的起始屏）：**下一个会话在哪个目录里干活**。
   * 它是那一屏上唯一要先定下来的东西 —— 用户在位置那一栏挑过就是挑的那个，没挑过接着
   * 最近用过的那个，一进页面就能直接写（会话在发出第一句时才建，见 run）。
   */
  const pickedDir = ref('')
  const newDir = computed(() => pickedDir.value || recentDirs.value[0] || '')

  /** 在起始那一屏上挑一个目录（下拉里最近用过的那几个直接走这里） */
  function setNewDir(dir: string): void {
    const target = sanitizeNoteRoot(dir)
    if (target) pickedDir.value = target
  }

  /** 那一屏上的「选择其他目录…」：挑完接着挑下一个会话在哪儿干活（不建会话） */
  async function pickNewDir(): Promise<void> {
    const picked = await window.workbench.pickDirectory('新会话在哪个目录里干活')
    if (picked) setNewDir(picked)
  }

  /**
   * 起一段新的（左栏那颗「+」、以及项目行上那颗）：切到起始那一屏。
   * 给了目录就用那个目录（项目行上那颗点的是「在这个目录里起一段」），
   * 没给就接着最近用过的那个 —— 会话都还没建，只是把屏幕切过去。
   */
  function startNew(dir?: string): void {
    if (dir) setNewDir(dir)
    drafting.value = true
  }

  /**
   * 位置那一栏说的那个目录：挑中会话就是会话那个（**在会话里定住的**），还没挑中就是
   * 起始那一屏挑的那个 —— 两屏那一栏说的都是「接下来在哪儿干活」。
   */
  const watchedDir = computed(() => activeSession.value?.dir ?? newDir.value)

  /**
   * 那个目录的 git 状态（只读探测）：**只用来在页面上说清在哪个分支上干活**。
   * 探不到不是错误 —— 没仓库、没装 git 都照常干活，那一截只是不显示。
   */
  const repoBranch = ref('')

  /** 探一次那个目录的分支；没目录或探不到就清空（那截不显示） */
  async function refreshRepo(): Promise<void> {
    const dir = watchedDir.value
    if (!dir) {
      repoBranch.value = ''
      return
    }
    const state = await aiRepoState(dir)
    repoBranch.value = state.ok && state.data?.isRepo ? (state.data.branch ?? '') : ''
  }

  // ---------- 配置（都在设置里；形状是「服务 + 模型清单」，见 shared/ai.ts） ----------
  /** 配过的 AI 服务（模型管理弹窗里那一屏）：密钥不在里面，它在凭据管理器里 */
  const providers = computed(() => settings.settings.aiProviders)
  /** 页面上那个「模型」下拉里能挑的：启用的服务下启用的那些模型 */
  const choices = computed(() => aiModelChoices(providers.value))

  /** 一个会话（或「还没建的新对话」）当下生效的那份配置：composer 画的、起进程带的就是它 */
  interface AiRunConfig {
    choice: AiModelChoice | null
    providerName: string
    model: string
    thinking: string
    permission: string
  }

  /**
   * **每个会话的配置是独立的**（模型 / 思考档位 / 权限记在会话自己身上，见 AiSession 的
   * 可选字段）：记过就用它，没记过的回落设置里的默认 —— 老会话不用迁移；模型管理里把
   * 那个服务删了 / 停了也在这里回落（pickAiChoice 退回第一个能挑的）。
   */
  function configOf(session: AiSession | null): AiRunConfig {
    const choice = pickAiChoice(
      providers.value,
      session?.provider ?? settings.settings.aiDefaultProvider,
      session?.model ?? settings.settings.aiDefaultModel
    )
    return {
      choice,
      providerName: choice?.provider ?? '',
      model: choice?.model ?? '',
      thinking: pickAiThinking(
        choice?.levels ?? ['off'],
        session?.thinking ?? settings.settings.aiThinking
      ),
      permission: sanitizeAiPermission(session?.permission ?? settings.settings.aiPermission)
    }
  }

  /** 当前正对着的那份：有会话用会话自己的，起始屏（还没建会话）用设置里的默认 */
  const activeConfig = computed(() => configOf(activeSession.value))
  /**
   * 默认模型（模型管理弹窗顶上那一栏写的、起始屏下拉显示的都是它）：挑的没了
   * （服务停用 / 模型关掉 / 删掉）退回第一个能挑的，一个都没有是 null。
   */
  const activeChoice = computed(() => activeConfig.value.choice)
  /** 这个模型挂在哪个服务上（Pi 的 `--provider`，也是取密钥用的那个名字） */
  const providerName = computed(() => activeConfig.value.providerName)
  const providerLabel = computed(() => activeChoice.value?.providerLabel ?? '还没配置')
  /** 这一轮跑哪个模型（`--model`） */
  const runModel = computed(() => activeConfig.value.model)
  /** 这个模型支持哪几档思考（界面上的下拉只列这些，Pi 那边也会按它收敛） */
  const thinkingLevels = computed(() => activeChoice.value?.levels ?? ['off'])
  /** 思考档位：Pi 的 `--thinking` 那一档；挑的不被这个模型支持就退默认档（见 pickAiThinking） */
  const thinking = computed(() => activeConfig.value.thinking)
  /**
   * 工具权限（composer 左边那一栏）：两档，见 shared/ai.ts 的 AI_PERMISSION_MODES。
   * **它决定 Pi 那边加不加载那份确认扩展** —— 自动编辑：每次要跑命令都先问一句；
   * 完全访问：不加载扩展，结构上就没有询问。改它要重开进程（见下面那个 watch）。
   */
  const permission = computed(() => activeConfig.value.permission)
  /** 能跑一轮的最低配置：挑中的那个服务四样齐了（密钥另算，见 keyReady） */
  const configured = computed(() => !!activeChoice.value && !!providerName.value)

  // ---------- 这台机器上的环境 ----------
  /** 运行时来源：bundled = 随包内置的那份（resources/pi），path = 全局安装的，none = 都没有 */
  const runtimeSource = ref<'bundled' | 'path' | 'none'>('none')
  /** 内置 cli.js 的绝对路径（仅 bundled 模式有值；拼命令时交给 node） */
  const cliPath = ref('')
  /** 都没有时的原因（ai_runtime 的 detail）：排障用，界面不展示 */
  const runtimeDetail = ref('')
  const piVersion = ref('')
  const nodeVersion = ref('')
  /**
   * 全局技能根（`%USERPROFILE%\.agents\skills`，由 ai_runtime 报回来）：技能弹窗那两栏里
   * 靠上那一栏就是它。拿不到用户目录时是空串，那一栏显示「用不了」。
   */
  const skillRoot = ref('')
  const probed = ref(false)
  const probing = ref(false)
  /**
   * 每个服务配没配 API Key（key 是服务 id）。**只回有没有** —— 密钥本身不进渲染层，
   * 界面显示的是「已配置 / 未配置」。
   */
  const keyStates = reactive<Record<string, boolean>>({})
  /** 挑中的那个服务配过 Key 没有（跑一轮的硬条件之一） */
  const keyReady = computed(() => {
    const current = providerName.value
    return !!current && keyStates[current] === true
  })

  const piReady = computed(() => runtimeSource.value !== 'none')
  /** 内置 cli.js 要 node ≥ 22.19；不内置 Node，这条是硬门槛 */
  const nodeOk = computed(() => nodeSatisfiesPi(nodeVersion.value))
  /** 起进程要的东西齐了没有（与 canRun 比少了「指令」那一条）：打开会话要拿它挡一下 */
  const startable = computed(() => piReady.value && nodeOk.value && configured.value)

  // ---------- 当前画的这一屏 ----------
  const lines = computed(() => activeRun.value.lines)
  /** 助手正在流式吐出来的那段文字（画在对话末尾，接在已落地的那几行后面） */
  const streaming = computed(() => activeRun.value.streamText)
  /**
   * 模型正在想的那一段（画在对话末尾那块「思考中…」里）：**loading 长在这一块上**，
   * 不在顶部那行状态里 —— 那行说的是整轮（等确认 / 在停 / 装 Pi / 出错），
   * 而「还在想」是某一段思考自己的事（见 AiThinking.vue）。
   */
  const thinkingText = computed(() => activeRun.value.thinkText)
  /** 这一刻正在思考（没有正文可画时它把那一块立起来：光有转圈与「思考中…」） */
  const thinkingLive = computed(() => activeRun.value.thinking)
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

  /** 挑中的这个模型能不能看图（贴图只在它上面成立，见 shared/ai.ts 的 AiModelChoice.imageInput） */
  const imageReady = computed(() => activeChoice.value?.imageInput === true)

  const canRun = computed(
    () =>
      // 有会话就说在那个会话里；还没有会话（起始那一屏）时，挑好的那个目录就是它的落处
      (!!activeSession.value || !!newDir.value) &&
      !running.value &&
      // 正在建那一个会话的当口不能再发（见 creating）
      !creating.value &&
      // 正在读回历史的那一会儿不让发：这一段的对话还没落地，发出去会把读回来的那段挤掉
      !hydrating.value &&
      piReady.value &&
      nodeOk.value &&
      configured.value &&
      keyReady.value &&
      // 贴了图就得是能看图的模型：不然 Pi 会把图换成一句「图被略去」的占位发出去
      (images.value.length === 0 || imageReady.value) &&
      // 一句话要么有字要么有图 —— 只有图的那句照样发得出去
      (!!instruction.value.trim() || images.value.length > 0)
  )

  /**
   * 还差什么才能跑。一次只说第一件缺的事 —— 按用户要动手的顺序排：
   * 工作目录 → Node → Pi → 模型 → 密钥 → 指令 → 贴的图。空串表示都齐了。
   *
   * **它只出现在发送按钮的悬停里**：页面不摆提示行（这个工具是作者自己用的，页面上把控件
   * 已经说清的事再讲一遍就是噪音），那颗按钮按不动时才是它该说话的时候。
   */
  const blocking = computed(() => {
    if (!probed.value) return ''
    if (!activeSession.value && !newDir.value)
      return '先挑一个工作目录：位置那一栏那个下拉 —— 对话就在它里面干活，一个目录就是一个「项目」。'
    if (hydrating.value) return '正在接上这段对话…等它读完就能接着说。'
    if (!nodeOk.value) return '这台机器的 Node 太旧：跑 Pi 需要 Node ≥ 22.19，先把 Node 升上去。'
    if (!piVersion.value)
      return '没找到 Pi 运行时：随包内置的那份不在（开发态先跑一次 npm run vendor:pi），PATH 上也没有全局安装的 —— 点页面上那颗「安装 Pi」全局装一个。'
    if (!configured.value)
      return '还没配模型：点「模型」下拉里的「模型管理」，添加一个 AI 服务（预设厂商或自定义端点）并选上模型。'
    if (!keyReady.value) return `${providerLabel.value} 还没配 API Key：点「模型」下拉里的「模型管理」。`
    if (!instruction.value.trim() && images.value.length === 0)
      return '还没写指令：接着这段对话说点什么。'
    if (images.value.length > 0 && !imageReady.value)
      return `贴了 ${images.value.length} 张图，但「${activeChoice.value?.name ?? '这个模型'}」看不了图：把图删掉，或者在「模型管理」里给它勾上「图片」、换一个能看图的模型。`
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
      skillRoot.value = runtime.skillRoot
    } finally {
      probed.value = true
      probing.value = false
    }
    await refreshKey()
  }

  /** 每个服务有没有配过 Key（一次问一遍：凭据管理器里一条一次，很便宜） */
  async function refreshKey(): Promise<void> {
    for (const provider of providers.value) {
      const result = await aiKeyState(provider.id)
      keyStates[provider.id] = result.ok && result.data === true
    }
    // 删掉的服务不留残影（它已经不在这张表里了，界面不该还记着「已配置」）
    const alive = new Set(providers.value.map((provider) => provider.id))
    for (const id of Object.keys(keyStates)) {
      if (!alive.has(id)) delete keyStates[id]
    }
  }

  // ---------- 会话的增删选 ----------

  /**
   * 建一个会话并打开它：一个工作目录（**项目就是它** —— 左栏的第一层），
   * 会话 id 现生成一个 uuid（同时就是 Pi 认的 session-id）。
   *
   * **只在起始那一屏发出第一句时才走到这里**（run → ensureSession）：没说过话的会话
   * 不该在左栏占一行，所以「起一段新的」那一步只是切到那一屏（见 startNew），不建会话。
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
    // 建出来了就不在「起一段新的」那个状态里了：右栏从起始那一屏切到这一段对话
    drafting.value = false
    // 打开就把这一段接上（新会话没有历史，等于把进程先备好；环境不全时它自己会跳过）
    void hydrate(session.id)
    return true
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
    // 点左栏那一行就是「挑中它」：正在起一段新的那个状态先退掉
    drafting.value = false
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
      const config = configOf(session)
      // 技能：起进程这一趟才给（`--skill`，见 ai.rs 的 run）—— 先保证那张表是**当下**的
      // （换过目录、别处刚装过技能都算），再取开着的那些
      await useAiSkillsStore().ensure()
      const started = await aiRun(
        {
          sessionId: processId,
          dir: session.dir,
          // 空提示词 = 只把进程起起来（读历史要一根活的 stdin）；这一趟不带任何图
          prompt: '',
          images: [],
          program: launch.program,
          args: launch.args,
          provider: config.providerName,
          permission: config.permission,
          skills: useAiSkillsStore().enabledRefs
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
        const history = sessionMessagesToLines(messages.data)
        // 这一段挂在哪个进程上（命令行收在悬停里）：换过模型 / 重启过应用之后，
        // 「读回来的历史」与「现在跑的是什么」是两件事，这行把它说清楚。
        // **插在最后一句用户消息之后**，与实时那趟「起进程先记一行再跑」同一处 ——
        // 接在末尾不行：aiTurns 拿「轮尾那段正文」当答案，注脚排在它后面就把答案
        // 顶进了过程块，重开一看整段回话都收在折叠的「过程」里（踩过）
        let at = history.length
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].kind === 'user') {
            at = i + 1
            break
          }
        }
        history.splice(at, 0, noteProcess(session, launch))
        run.lines = history
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

  /** 这一句要用的程序与参数（模型 / 档位 / 会话都在里面，见 shared/ai.ts 的 piLaunch）；
   ** 参数按**这个会话自己**的生效配置取（configOf），不是当前正对着的那份 */
  function launchFor(session: AiSession) {
    const config = configOf(session)
    return piLaunch(runtimeSource.value === 'bundled' ? cliPath.value : null, {
      provider: config.providerName,
      model: config.model,
      thinking: config.thinking
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
        if (line.kind === 'text') {
          endStream(run)
          // 有的提供方不发 `thinking_end`：正文都已经整段到了，还没收的那段思考
          // 就按已经吐出来的部分收掉（不丢字）
          endThink(run, '', true)
        }
        run.lines = [...run.lines, line]
      },
      onDelta: (delta: PiDelta) => {
        const run = runs.get(sessionId)
        if (!run) return

        if (delta.kind === 'text') {
          run.streamBuffer += delta.text
          // 攒够一小会儿再画（见 STREAM_TICK）：每个字都重画一遍是白烧钱
          if (run.streamTimer) return
          run.streamTimer = setTimeout(() => {
            run.streamTimer = null
            run.streamText = run.streamBuffer
          }, STREAM_TICK)
          return
        }

        // 一段思考想完了：**这一段以它为准**（增量只是过程版），落成一行「思考过程」
        if (delta.kind === 'thinkingEnd') {
          endThink(run, delta.text, true)
          return
        }

        // 正在想：与正文同一套节流（面板上那块「思考中…」跟着长）
        run.thinking = true
        run.thinkBuffer += delta.text
        if (run.thinkTimer) return
        run.thinkTimer = setTimeout(() => {
          run.thinkTimer = null
          run.thinkText = run.thinkBuffer
        }, STREAM_TICK)
      },
      onUsage: (usage: AiUsage) => {
        const run = runs.get(sessionId)
        if (!run) return
        // 一轮里模型说了好几段（中间隔着工具调用），每段带一份 —— 这里累加成这一轮的
        run.usage = {
          input: run.usage.input + usage.input,
          output: run.usage.output + usage.output,
          cacheRead: run.usage.cacheRead + usage.cacheRead,
          cacheWrite: run.usage.cacheWrite + usage.cacheWrite
        }
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
    if (keep && text) run.lines = [...run.lines, { kind: 'thinking', text }]
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
   * 在**当前这个会话**里说一句。还没有会话时（起始那一屏）**这一句就是第一句**：
   * 先按那一屏挑好的目录建一个会话，再说下去 —— 「新建会话」不再是发消息之前要单独点的
   * 一步（见下面 startSession）。
   *
   * 起进程之前先把「这一轮要跑什么」与用户那句话写进对话：子进程起不来时那是唯一的线索；
   * 用过的指令与会话标题也在这时更新（跑没跑起来都算说过 —— 「试一次没成功」是最常见的
   * 情形，那时更需要留个底）。
   */
  async function run(): Promise<void> {
    const text = instruction.value.trim()
    // 一句话要么有字要么有图：只贴了图没写字的那句照样发（图就是那一句的内容）
    const attached = [...images.value]
    if (!text && !attached.length) return notifyError('先写一条指令')
    if (!piReady.value) {
      return notifyError('没找到 Pi 运行时：内置那份不在，PATH 上也没有全局安装的')
    }
    if (!nodeOk.value) return notifyError('Node 版本太旧：跑内置的 Pi 需要 Node ≥ 22.19')
    if (!configured.value) return notifyError('先在「模型」里配好端点、模型与密钥')
    if (!keyReady.value) return notifyError(`还没有配置 ${providerName.value} 的 API Key`)
    if (attached.length && !imageReady.value) {
      return notifyError(`「${activeChoice.value?.name ?? '这个模型'}」看不了图：把图删掉，或者换一个能看图的模型`)
    }

    // 环境这一趟先验完再建会话：缺模型 / 缺密钥时那句本来也发不出去，
    // 建了只会在左栏多留一行没人说过的「新会话」
    let session = activeSession.value
    if (!session) {
      if (creating.value) return
      creating.value = true
      try {
        session = await ensureSession()
      } finally {
        creating.value = false
      }
      if (!session) return
    }
    const runState = runOf(session.id)
    if (runState.running) return

    // 起进程的参数按**这个会话自己**的生效配置取（configOf），不是当前正对着的那份
    const launch = launchFor(session)
    const config = configOf(session)
    // 第一次说话时把标题定下来（左栏上那一行）；之后不再改。**只有图没有字的那句**标题
    // 记成「（N 张图）」—— 标题空着等于「还没说过话」，下次打开这段会话就不去读历史了
    // （见 hydrate）
    void settings.updateSettings({
      aiSessions: rememberAiSession(sessions.value, {
        ...session,
        title: session.title || aiSessionTitle(text) || `（${attached.length} 张图）`,
        updatedAt: Date.now()
      })
    })

    instruction.value = ''
    clearImages()
    runState.running = true
    runState.stopping = false
    runState.startedAt = Date.now()
    // 消耗从零攒起：这一轮自己的账（上一轮的已经跟「用时」落在那一行了）
    runState.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    // 上一轮万一还留着没冲掉的流式尾巴（正常路径下不会有）：这一轮开场前清掉，别串到新话里
    endStream(runState)
    endThink(runState)
    runState.exitCode = null
    runState.runError = ''
    runState.confirms = []
    runState.lines = [
      ...runState.lines,
      // 用户那句：贴的图跟着它一起落进对话（只贴了图的就是一条没有字的气泡）
      {
        kind: 'user',
        text,
        ...(attached.length ? { images: attached.map((image) => image.dataUrl) } : {})
      },
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

    // 这张表要是还没扫过（刚从别的页面进来）就先扫一遍：起进程那一趟必须带当下那份技能表
    await useAiSkillsStore().ensure()
    const result = await aiRun(
      {
        sessionId: aiSessionProcessId(session.id),
        dir: session.dir,
        prompt: taskPrompt({ dir: session.dir, instruction: text }),
        images: aiImagePayload(attached),
        program: launch.program,
        args: launch.args,
        provider: config.providerName,
        permission: config.permission,
        // 已经在跑的进程不会因为这张表变了而变（`--skill` 只认起进程那一趟）；
        // 没在跑时这一句就是起进程那一趟，带的必须是当下这份
        skills: useAiSkillsStore().enabledRefs
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
   * 起始那一屏发出的**第一句**：按那一屏挑好的工作目录建一个会话（那句接着就发在它里面）。
   * 别人都是先有会话再说话，只有这条路是**先说话再建** —— 起一段新的那一步只切屏幕
   * （见 startNew），没说过话的会话不该在左栏占一行（它连标题都没有）。
   */
  async function ensureSession(): Promise<AiSession | null> {
    const dir = newDir.value
    if (!dir) {
      notifyError('先挑一个工作目录：位置那一栏那个下拉')
      return null
    }
    if (!(await createSession(dir))) return null
    return activeSession.value
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
    // 想了一半就结束的那一段也一样留着（它是收着的一块，不挡阅读）
    endThink(run, '', true)
    noteDuration(run)
    if (run.stale) void recycle(sessionId)
  }

  /**
   * 在这一轮末尾补一行「用时 …」：回复长的时候用户就想知道它到底跑了多久
   * （也是「这一轮到这儿完了」的一个安静的句号 —— 那两条进度行不画，见 isTurnMarker）。
   * 端点报了消耗的话把 token 也带上（`输入 … · 输出 …`，这一轮各段消息累加的账）；
   * 没报就只有用时 —— 自定义端点不保证都有。
   */
  function noteDuration(run: AiRun): void {
    if (!run.startedAt) return
    const text = formatDuration(Date.now() - run.startedAt)
    run.startedAt = 0
    const usage = formatUsageSummary(run.usage)
    run.lines = [
      ...run.lines,
      { kind: 'duration', text: usage ? `用时 ${text} · ${usage}` : `用时 ${text}` }
    ]
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
    endThink(run, '', true)
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
   * 页面上那个「模型」下拉的选中项：`<服务 id>/<模型 id>`（与选项的值同一个，
   * 不过这里空串表示「一个能挑的都没有」—— 下拉的 placeholder 就是给那一刻的）。
   */
  const activeChoiceKey = computed(() => activeChoice.value?.key ?? '')

  /**
   * 页面上那个下拉挑了什么：**有会话就记到会话自己身上**（那一刻生效的四样一起快照，
   * 见 AiSession 的可选字段），起始屏（还没建会话）记到设置里的默认 —— 之后新建的
   * 对话用它起步。挑的是 `shared/ai.ts` 的 AiModelChoice.key（`<服务 id>/<模型 id>`），
   * 认不出就当没挑过。
   */
  async function setChoice(key: string): Promise<boolean> {
    const choice = choices.value.find((item) => item.key === key)
    if (!choice) return false
    const session = activeSession.value
    if (!session) {
      return settings.updateSettings({
        aiDefaultProvider: choice.provider,
        aiDefaultModel: choice.model
      })
    }
    return persistSessionConfig(session, {
      provider: choice.provider,
      model: choice.model,
      thinking: thinking.value,
      permission: permission.value
    })
  }

  async function setThinking(level: string): Promise<boolean> {
    const session = activeSession.value
    if (!session) return settings.updateSettings({ aiThinking: sanitizeAiThinking(level) })
    return persistSessionConfig(session, {
      provider: providerName.value,
      model: runModel.value,
      thinking: sanitizeAiThinking(level),
      permission: permission.value
    })
  }

  /** 页面上那一栏挑了什么：与模型 / 档位同一条口径（有会话记会话，起始屏记设置默认） */
  async function setPermission(id: string): Promise<boolean> {
    const session = activeSession.value
    if (!session) return settings.updateSettings({ aiPermission: sanitizeAiPermission(id) })
    return persistSessionConfig(session, {
      provider: providerName.value,
      model: runModel.value,
      thinking: thinking.value,
      permission: sanitizeAiPermission(id)
    })
  }

  /**
   * 把一份配置记到会话自己身上（数据文件的 aiSessions）：只改这一条、顺序不动，收敛后再落
   * —— 认不出的值在收敛那层就被丢掉，读的时候回落设置里的默认。
   */
  async function persistSessionConfig(
    session: AiSession,
    patch: Partial<Pick<AiSession, 'provider' | 'model' | 'thinking' | 'permission'>>
  ): Promise<boolean> {
    const next = sessions.value.map((item) =>
      item.id === session.id ? { ...item, ...patch } : item
    )
    return settings.updateSettings({ aiSessions: sanitizeAiSessions(next) })
  }

  // ---------- AI 服务（模型管理弹窗里那一屏） ----------

  /**
   * 把当前设置里的服务清单写成 Pi 的 models.json（agent 目录下那份）。
   *
   * Pi 是照这份文件认端点的：设置存下了而文件没写等于没配，所以每次改完服务都要走一遍，
   * 进页面时也补一次（老设置搬到新形状之后那句「还没写」是看不出来的）。停用的服务与模型
   * 不进这份文件 —— 见 shared/ai.ts 的 aiProviderPayload。
   */
  async function syncModels(): Promise<boolean> {
    const payload = aiProviderPayload(providers.value)
    // 一个能跑的服务都没有（还没配过，或者都停用了）：models.json 留着上一次那份也无妨 ——
    // 起进程时 --provider 是显式给的，没挑中就没有那一轮，残留的端点不会被用上
    if (!payload.length) return true
    const written = await aiModelsWrite(payload)
    if (!written.ok) {
      notifyError(written.error ?? '写入模型配置失败')
      return false
    }
    return true
  }

  /**
   * 保存一个服务（新增或改一个现有的）：收敛校验 → 落设置 → 重写 models.json →
   * （给了密钥就）存密钥。**四步都过了才算成功** —— 只落后半截会让界面显示「配好了」而
   * Pi 那边跑不起来。
   *
   * `secret` 空串 = 不动已有的密钥（编辑一个已经保存过的服务时不必重填）；
   * `previousId` 是编辑前那个名字 —— 改过名字时旧名字下那条凭据要清掉（它已经没人认领）。
   */
  async function saveProvider(input: AiProvider, secret = '', previousId = ''): Promise<boolean> {
    const id = sanitizeAiName(input.id)
    const baseUrl = sanitizeAiBaseUrl(input.baseUrl)
    const apiFormat = sanitizeAiApiFormat(input.apiFormat)
    const models = sanitizeAiModels(input.models)
    if (!id) {
      notifyError('服务名称要填：小写字母、数字与连字符（它进凭据名，不能有别的字符）')
      return false
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      notifyError('Base URL 要以 http:// 或 https:// 开头')
      return false
    }
    if (!apiFormat) {
      notifyError('先选一个 API 形态')
      return false
    }
    if (!models.some((entry) => entry.enabled)) {
      notifyError('至少要启用一个模型')
      return false
    }

    const provider: AiProvider = {
      id,
      label: sanitizeAiLabel(input.label) || id,
      baseUrl,
      apiFormat,
      preset: sanitizeAiPreset(input.preset),
      enabled: input.enabled !== false,
      models
    }
    // 编辑的是哪一条：**按原名找**（改名之后那一条还在清单里，只是换了键）
    const target = previousId || id
    const taken = providers.value
      .filter((item) => item.id !== target && item.id !== id)
      .map((item) => item.id)
    if (taken.includes(id)) {
      notifyError(`已经有一个叫 ${id} 的服务了：换一个名字`)
      return false
    }

    const next = providers.value.some((item) => item.id === target)
      ? providers.value.map((item) => (item.id === target ? provider : item))
      : [...providers.value, provider]
    const saved = await settings.updateSettings({
      aiProviders: next,
      // 一个都没挑过（或者挑的那个刚被这次编辑弄没了）：默认模型就落到它身上
      ...(activeChoice.value
        ? {}
        : { aiDefaultProvider: provider.id, aiDefaultModel: provider.models[0]?.id ?? '' })
    })
    if (!saved) {
      notifyError('保存设置失败')
      return false
    }

    // 密钥与模型配置是两个独立的落点：**密钥没存进去不该把配置卡在半路** ——
    // models.json 照写（它本来就不含密钥，密钥只在起进程时进环境变量），
    // 密钥那条失败在结尾当警告说出来。之前这里写失败就整体返回，设置落了而
    // models.json 没写，弹窗里只飘一条 toast —— 用户以为保存成功了，改的东西没生效
    let keyWarning = ''
    if (secret.trim()) {
      const stored = await aiKeySave(id, secret.trim())
      if (!stored.ok) keyWarning = stored.error ?? '保存 Key 失败'
    }

    // 设置已经落下去了：models.json 照**它**重写一遍（两边永远对得上）。
    // 能力位（能看图 / 上下文 / 档位）都长在这份文件里，写完就把进程退掉 ——
    // 否则改完的配置对已经在聊的会话不生效（Pi 起进程时读一次，不重读）
    if (!(await syncModels())) return false
    retireProcesses()

    // 改过名字：旧名字下那条凭据（API Key）已经没人认领了，清掉 —— 留着的只是一条密文
    if (previousId && previousId !== id) await aiKeyClear(previousId)

    await refreshKey()
    if (keyWarning) notifyWarning(`已保存 ${provider.label}，但 API Key 没存进去：${keyWarning}`)
    else notifySuccess(`已保存 ${provider.label}`)
    return true
  }

  /** 删掉一个服务：设置里去掉、models.json 重写；**密钥一起清掉**（留着它就是一条没人认领的密文） */
  async function removeProvider(id: string): Promise<void> {
    const provider = providers.value.find((item) => item.id === id)
    if (!provider) return

    const agreed = await confirmAction(
      `「${provider.label}」这个服务会从模型管理里删掉，里面的 ${provider.models.length} 个模型与它的 API Key 一起清掉。`,
      '删除服务',
      { confirmButtonText: '删除', type: 'warning' }
    )
    if (!agreed) return

    const next = providers.value.filter((item) => item.id !== id)
    const saved = await settings.updateSettings({ aiProviders: next })
    if (!saved) {
      notifyError('保存设置失败')
      return
    }
    await aiKeyClear(id)
    await syncModels()
    retireProcesses()
    await refreshKey()
    notifySuccess(`已删除 ${provider.label}`)
  }

  /** 打开 / 停用一个服务（停用的不进 models.json，也当不了默认模型） */
  async function toggleProvider(id: string, enabled: boolean): Promise<void> {
    const next = providers.value.map((item) => (item.id === id ? { ...item, enabled } : item))
    const saved = await settings.updateSettings({ aiProviders: next })
    if (!saved) return
    await syncModels()
    retireProcesses()
  }

  /**
   * 从端点拉一份模型列表（「添加服务」里粘完 Key / 点「获取列表」那一下）。
   * 打的是用户自己那个端点（`{baseUrl}/models`），密钥优先用草稿里刚粘的那把。
   */
  async function fetchModels(input: {
    provider: string
    baseUrl: string
    api: string
    secret?: string
  }): Promise<Result<AiFetchedModel[]>> {
    return aiModelsFetch(input.provider, input.baseUrl, input.api, input.secret ?? '')
  }

  /** 清掉某个服务的密钥 */
  async function clearProviderKey(id: string): Promise<void> {
    const result = await aiKeyClear(id)
    if (!result.ok) {
      notifyError(result.error ?? '清除 Key 失败')
      return
    }
    keyStates[id] = false
    notifySuccess('已清除 API Key')
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
    // 设置里的服务清单与 Pi 的 models.json 对齐一次：老设置搬到新形状之后，
    // 那份文件里还是上一个版本写的端点（界面看不出这一层，所以每次进来都对一遍）
    await syncModels()
    await refreshRepo()
    if (activeId.value) void hydrate(activeId.value)
  }

  // 设置里换了模型 / 换了服务（也可能是在别处改的）：密钥状态得重新问一遍
  watch([providerName, providers], () => {
    if (started) void refreshKey()
  })

  // 位置那一栏说的那个目录换了（换会话、或在起始那一屏换目录）：看那个目录的分支
  watch(watchedDir, () => {
    if (started) void refreshRepo()
  })

  // 换了一个会话：把它接上（读过的那几段由 hydrate 自己挡掉）
  watch(activeId, () => {
    if (started && activeId.value) void hydrate(activeId.value)
  })

  // 环境刚好在这一刻齐了（比如刚配完模型就切回来）：那一条还没接过历史的会话补接一次 ——
  // 那次打开时起不了进程，读历史就没做成
  watch(startable, (ready) => {
    if (started && ready && activeId.value) void hydrate(activeId.value)
  })

  /**
   * 模型配置变过了（默认模型 / 思考档位 / 权限这三样，以及下面三个改服务的入口）：
   * **已经开着的会话要用新配置就得把进程换掉** —— 参数与 models.json 都是起进程时
   * 读定死的（`--model` / `--thinking` / 那份权限扩展；模型的能力位长在 models.json 里）。
   * 正在跑的那些等这一轮跑完再换（`stale`），不然一次改设置就把用户干到一半的活掐了；
   * 闲着的当场收掉，下一句重开（历史从会话文件接上，不丢东西）。
   */
  function retireProcesses(): void {
    for (const [sessionId, run] of runs) {
      if (!run.live) continue
      if (run.running) run.stale = true
      else void recycle(sessionId)
    }
  }

  /**
   * **按会话精确收**：每个会话自己那份配置变了（在它的 composer 上换模型 / 档位 / 权限，
   * 或者模型管理那边把它正用着的服务弄没了），只收它的进程 —— 别的会话各自独立，
   * 不陪着重启。改服务那种整份 models.json 都重写的入口（saveProvider 等）仍旧全收
   * （retireProcesses，上面的旧口径）。
   */
  function effectiveKey(session: AiSession): string {
    const config = configOf(session)
    return `${config.providerName}|${config.model}|${config.thinking}|${config.permission}`
  }

  const lastConfigKeys = new Map<string, string>()
  watch(
    () => sessions.value.map((session) => effectiveKey(session)).join('\n'),
    () => {
      for (const session of sessions.value) {
        const key = effectiveKey(session)
        const previous = lastConfigKeys.get(session.id)
        lastConfigKeys.set(session.id, key)
        // 第一趟（immediate）只是记账；会话刚出现（没有旧键）也不算换配置
        if (!started || previous === undefined || previous === key) continue
        const run = runs.get(session.id)
        if (!run?.live) continue
        if (run.running) run.stale = true
        else void recycle(session.id)
      }
    },
    { immediate: true }
  )

  return {
    sessions,
    groups,
    activeId,
    activeSession,
    runs,
    instruction,
    recentDirs,
    newDir,
    setNewDir,
    pickNewDir,
    watchedDir,
    repoBranch,
    providers,
    choices,
    activeChoice,
    activeChoiceKey,
    providerName,
    runModel,
    thinking,
    thinkingLevels,
    permission,
    providerLabel,
    configured,
    runtimeSource,
    cliPath,
    runtimeDetail,
    piVersion,
    nodeVersion,
    skillRoot,
    probed,
    probing,
    keyStates,
    keyReady,
    piReady,
    nodeOk,
    lines,
    streaming,
    thinkingText,
    thinkingLive,
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
    images,
    addImages,
    removeImage,
    init,
    probe,
    refreshKey,
    refreshRepo,
    startNew,
    deleteSession,
    selectSession,
    hydrate,
    run,
    stop,
    recycle,
    answerConfirm,
    setChoice,
    setThinking,
    setPermission,
    syncModels,
    saveProvider,
    removeProvider,
    toggleProvider,
    fetchModels,
    clearProviderKey,
    installPi
  }
})
