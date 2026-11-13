import type { AiConfirm, AiImage, AiLogLine, AiSession, AiUsage, PiDelta } from '@workbench/ai'
import type { AiRun } from '@/stores/ai-run-state'
import { aiImagePayload, aiSessionGroups, aiSessionTitle, confirmFrame, pickAiActiveSession, piLaunch, piLaunchForDisplay, rememberAiSession, sanitizeAiSessionId, sessionMessagesToLines, taskPrompt, writtenEntries } from '@workbench/ai'
import { noteRootName, sanitizeNoteRoot } from '@workbench/notes'
import { defineStore } from 'pinia'
/**
 * AI 助手：一个通用的 agent 控制台 —— **在哪个目录里、跟哪一段对话**请内置的 Pi 干活。
 *
 * 左栏是一棵两层的树（见 packages/ai/src/ai.ts 的 aiSessionGroups）：第一层是**项目**（一个工作目录），
 * 第二层是这个目录下的**会话**，一个会话 = 一段连续对话。页面上同时只画一个会话，而
 * **每个会话各有一个 Pi 进程**（`ai:<会话 id>`，见 workbench/ai.ts）—— 所以几个会话可以
 * 同时在跑，切过去看就行。
 *
 * 一轮的流程：写指令 → 拼提示词（packages/ai/src/ai.ts 的 taskPrompt）→ 交给 `aiRun`（Rust 写进
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
 * 输入框里那句指令与贴上的图也归页面（AiView）持有 —— 这里只在发的那一刻收到它们
 * （见 run），「能不能发、还差什么」的判断也长在 composer 上（canRun / blocking）。
 *
 * 叶子模块各管一块（工厂 + 装配，对外形状不变）：`ai-run-state.ts`（每会话运行态与流式收尾）、
 * `ai-config.ts`（服务 / 模型 / 三颗选择）、`ai-runtime.ts`（Pi 与 Node 探测、密钥状态、装 Pi）、
 * `ai-providers.ts`（服务的增删改与 models.json）。这一层只留会话树、一轮的运行与进程收放。
 */
import { computed, ref, watch } from 'vue'
import { confirmAction, notifyError } from '@/notify'
import { useAiConfig } from '@/stores/ai-config'
import { useAiProviders } from '@/stores/ai-providers'
import { configChangeAction, IDLE_RUN, STREAM_TICK, useAiRunState } from '@/stores/ai-run-state'
import { useAiRuntime } from '@/stores/ai-runtime'
import { useAiSkillsStore } from '@/stores/ai-skills'
import { useSettingsStore } from '@/stores/settings'
import { aiAbort, aiMessages, aiRun, aiSend, aiSessionDelete, aiSessionProcessId, aiStop } from '@/workbench/ai'

/** run 收下的那一句：文本与随发的图。输入框那两样归 AiView 持有，发的那一刻才交进来 */
interface AiRunInput {
  text: string
  images: AiImage[]
}

export const useAiStore = defineStore('ai', () => {
  const settings = useSettingsStore()

  // ---------- 会话与项目（左栏那棵树） ----------

  /** 会话清单（落盘的那份：id / 目录 / 标题 / 时间） */
  const sessions = computed(() => settings.settings.aiSessions)
  /** 左栏那棵树：按工作目录分组，最近说过话的排在上面（见 packages/ai/src/ai.ts） */
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
    drafting.value ? '' : pickAiActiveSession(sessions.value, settings.settings.aiActiveSession),
  )
  const activeSession = computed(
    () => sessions.value.find(session => session.id === activeId.value) ?? null,
  )

  // 每会话运行态（与流式 / 思考两段的收尾）
  const { runs, runOf, endStream, endThink, isTurnMarker, noteDuration } = useAiRunState()

  /** 当前那一屏要画的那份运行态 */
  const activeRun = computed<AiRun>(() => runs.get(activeId.value) ?? IDLE_RUN)

  /**
   * 正在按起始那一屏挑的目录建会话（见 run → startSession）：那一下要等一个来回
   * （落设置），这期间再点一次会**建出第二个会话、发出去两句** —— 拿它挡一下。
   */
  const creating = ref(false)

  /** 最近用过的工作目录（挑目录那几处列的就是它）：按树的顺序取，最多三个 */
  const recentDirs = computed(() => groups.value.slice(0, 3).map(group => group.dir))

  /**
   * 还没有会话时那一屏（`AiView` 的起始屏）：**下一个会话在哪个目录里干活**。
   * 它是那一屏上唯一要先定下来的东西 —— 用户在位置那一栏挑过就是挑的那个，没挑过接着
   * 最近用过的那个；**一个都没有（`newDir` 为空）时起始屏不画 composer**（没有落处，
   * 写了也发不出去），会话在发出第一句时才建（见 run）。
   */
  const pickedDir = ref('')
  const newDir = computed(() => pickedDir.value || recentDirs.value[0] || '')

  /** 在起始那一屏上挑一个目录（下拉里最近用过的那几个直接走这里） */
  function setNewDir(dir: string): void {
    const target = sanitizeNoteRoot(dir)
    if (target)
      pickedDir.value = target
  }

  /** 那一屏上的「选择其他目录…」：挑完接着挑下一个会话在哪儿干活（不建会话） */
  async function pickNewDir(): Promise<void> {
    const picked = await window.workbench.pickDirectory('新会话在哪个目录里干活')
    if (picked)
      setNewDir(picked)
  }

  /**
   * 起一段新的（左栏那颗「+」、以及项目行上那颗）：切到起始那一屏。
   * 给了目录就用那个目录（项目行上那颗点的是「在这个目录里起一段」），
   * 没给就接着最近用过的那个 —— 会话都还没建，只是把屏幕切过去。
   */
  function startNew(dir?: string): void {
    if (dir)
      setNewDir(dir)
    drafting.value = true
  }

  /**
   * 位置那一栏说的那个目录：挑中会话就是会话那个（**在会话里定住的**），还没挑中就是
   * 起始那一屏挑的那个 —— 两屏那一栏说的都是「接下来在哪儿干活」。**store 留着它**：
   * 它是这间店「选会话」状态机的一部分（run 建会话、ai-skills 的项目技能根都跟着它走），
   * 页面上那格 git 分支的显示归 AiView 自己（拿着它去探，见 AiView 的 refreshRepo）。
   */
  const watchedDir = computed(() => activeSession.value?.dir ?? newDir.value)

  // ---------- 配置与服务（两个叶子模块） ----------

  const config = useAiConfig({
    settings: computed(() => settings.settings),
    updateSettings: patch => settings.updateSettings(patch),
    sessions,
    activeSession,
  })
  const runtime = useAiRuntime({
    providers: config.providers,
    providerName: config.providerName,
  })

  const {
    providers,
    choices,
    configOf,
    activeChoice,
    activeChoiceKey,
    providerName,
    providerLabel,
    runModel,
    thinkingLevels,
    thinking,
    permission,
    configured,
    imageReady,
    setChoice,
    setThinking,
    setPermission,
  } = config

  const {
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
    installing,
    installLog,
    probe,
    refreshKey,
    installPi,
  } = runtime

  const providersApi = useAiProviders({
    updateSettings: patch => settings.updateSettings(patch),
    providers,
    activeChoice,
    keyStates,
    refreshKey,
    retireProcesses: () => retireProcesses(),
  })
  const { syncModels, saveProvider, removeProvider, toggleProvider, fetchModels, clearProviderKey } = providersApi

  /** 起进程要的东西齐了没有（与 composer 那边的 canRun 比少了「指令」那一条）：打开会话要拿它挡一下 */
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
    if (!target)
      return false

    const now = Date.now()
    const session: AiSession = {
      id: crypto.randomUUID(),
      dir: target,
      title: '',
      createdAt: now,
      updatedAt: now,
    }
    const saved = await settings.updateSettings({
      aiSessions: rememberAiSession(sessions.value, session),
      aiActiveSession: session.id,
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
    const session = sessions.value.find(item => item.id === id)
    if (!session)
      return

    const label = session.title || noteRootName(session.dir)
    const agreed = await confirmAction(
      `「${label}」这段对话的记录会一起删掉，删了就找不回来（目录里的文件不受影响）。`,
      '删除会话',
      { confirmButtonText: '删除', type: 'warning' },
    )
    if (!agreed)
      return

    const removed = await aiSessionDelete(id)
    if (!removed.ok)
      notifyError(removed.error ?? '删除会话失败')

    const rest = sessions.value.filter(item => item.id !== id)
    // 这一段的收尾（流式那口气）先撤掉，再把它的运行态丢掉
    const dropped = runs.get(id)
    if (dropped)
      endStream(dropped)
    runs.delete(id)
    await settings.updateSettings({
      aiSessions: rest,
      aiActiveSession: pickAiActiveSession(rest, ''),
    })
  }

  /**
   * 打开一个会话（点左栏那一行）：读过历史就直接画，没读过先把它接上。
   * **再点一次同一个也照样走一遍接历史**：上一回可能是环境不全（还没配模型）没接成，
   * 那会儿起不了进程 —— 它自己会用 `hydrated` / `hydrating` 两个标记挡住多余的往返。
   */
  async function selectSession(id: string): Promise<void> {
    const target = sanitizeAiSessionId(id)
    if (!target)
      return
    // 点左栏那一行就是「挑中它」：正在起一段新的那个状态先退掉
    drafting.value = false
    if (target !== activeId.value)
      await settings.updateSettings({ aiActiveSession: target })
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
    const session = sessions.value.find(item => item.id === sessionId)
    if (!session)
      return
    const run = runOf(sessionId)
    if (run.hydrated || run.hydrating || run.running)
      return
    if (!session.title) {
      run.hydrated = true
      return
    }
    if (!startable.value)
      return

    run.hydrating = true
    try {
      const processId = aiSessionProcessId(sessionId)
      const launch = launchFor(session)
      const cfg = configOf(session)
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
          provider: cfg.providerName,
          permission: cfg.permission,
          skills: useAiSkillsStore().enabledRefs,
        },
        handlers(sessionId),
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
      }
      else if (!messages.ok) {
        run.runError = messages.error ?? '读不回这段对话的历史'
      }
      run.hydrated = true
    }
    finally {
      run.hydrating = false
    }
  }

  /** 「这一段在哪个进程上」那一条：程序与参数（含绝对路径的 cli.js 与那一串开关）收进 detail */
  function noteProcess(session: AiSession, launch: { program: string, args: string[] }): AiLogLine {
    return {
      kind: 'info',
      text: `在 ${noteRootName(session.dir)} 里工作`,
      detail: `${launch.program} ${piLaunchForDisplay(launch)}`,
    }
  }

  // ---------- 跑一轮 ----------

  /**
   * 这一句要用的程序与参数（模型 / 档位 / 会话都在里面，见 packages/ai/src/ai.ts 的 piLaunch）；
   *参数按**这个会话自己**的生效配置取（configOf），不是当前正对着的那份
   */
  function launchFor(session: AiSession) {
    const cfg = configOf(session)
    return piLaunch(runtimeSource.value === 'bundled' ? cliPath.value : null, {
      provider: cfg.providerName,
      model: cfg.model,
      thinking: cfg.thinking,
    }, session.id)
  }

  /** 一条会话的事件流接到哪儿去：按会话 id 分（几个会话可以同时在跑） */
  function handlers(sessionId: string) {
    return {
      onLine: (line: AiLogLine) => {
        // 这条会话已经被删掉了（进程收尾与删除之间那段）：这几行没地方可去，丢掉就是
        const run = runs.get(sessionId)
        if (!run)
          return
        // `agent_settled`：这一轮完了（**进程留着**，见文件头）。它是信号，不是对话里的一句
        if (line.kind === 'done')
          settle(sessionId)
        if (isTurnMarker(line))
          return
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
        if (!run)
          return

        if (delta.kind === 'text') {
          run.streamBuffer += delta.text
          // 攒够一小会儿再画（见 STREAM_TICK）：每个字都重画一遍是白烧钱
          if (run.streamTimer)
            return
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
        if (run.thinkTimer)
          return
        run.thinkTimer = setTimeout(() => {
          run.thinkTimer = null
          run.thinkText = run.thinkBuffer
        }, STREAM_TICK)
      },
      onUsage: (usage: AiUsage) => {
        const run = runs.get(sessionId)
        if (!run)
          return
        // 一轮里模型说了好几段（中间隔着工具调用），每段带一份 —— 这里累加成这一轮的
        run.usage = {
          input: run.usage.input + usage.input,
          output: run.usage.output + usage.output,
          cacheRead: run.usage.cacheRead + usage.cacheRead,
          cacheWrite: run.usage.cacheWrite + usage.cacheWrite,
        }
      },
      onConfirm: (confirm: AiConfirm) => {
        const run = runs.get(sessionId)
        if (!run)
          return
        run.confirms = [...run.confirms, confirm]
      },
      onExit: (code: number | null) => {
        finish(sessionId, code)
      },
    }
  }

  /**
   * 环境这一环还缺哪一样，按用户要动手的顺序：Node → Pi → 模型 → 密钥。
   * 「还差什么」级联的**唯一顺序口径** —— composer 的 blocking、run 的校验、知识库清洗
   * 的拦路都从这里取（原先三处各排一遍，顺序已经漂移出两种）。文案各归各：悬停里
   * 说得详尽、通知里一句话、清洗面板折中。
   */
  function envGap(): 'node' | 'pi' | 'model' | 'key' | null {
    if (!nodeOk.value)
      return 'node'
    if (!piReady.value)
      return 'pi'
    if (!configured.value)
      return 'model'
    if (!keyReady.value)
      return 'key'
    return null
  }

  /**
   * 在**当前这个会话**里说一句。还没有会话时（起始那一屏）**这一句就是第一句**：
   * 先按那一屏挑好的目录建一个会话，再说下去 —— 「新建会话」不再是发消息之前要单独点的
   * 一步（见下面 startSession）。
   *
   * 返回**这句收下了没有**：校验过了、会话有着落了就算收下（**起进程那一趟还没回来也算**，
   * 见下面那趟拆开的启动）—— 调用方（AiView）据此清空输入框；false 是校验没过或会话没
   * 建成，输入原样留着，用户改一改还能再发。
   *
   * 起进程之前先把「这一轮要跑什么」与用户那句话写进对话：子进程起不来时那是唯一的线索；
   * 用过的指令与会话标题也在这时更新（跑没跑起来都算说过 —— 「试一次没成功」是最常见的
   * 情形，那时更需要留个底）。
   */
  async function run(input: AiRunInput): Promise<boolean> {
    const text = input.text.trim()
    // 一句话要么有字要么有图：只贴了图没写字的那句照样发（图就是那一句的内容）
    const attached = [...input.images]
    if (!text && !attached.length) {
      notifyError('先写一条指令')
      return false
    }
    // 环境那四样的顺序归 envGap（与 composer 的 blocking、知识库清洗同一条级联）
    const gap = envGap()
    if (gap) {
      const notices = {
        node: 'Node 版本太旧：跑内置的 Pi 需要 Node ≥ 22.19',
        pi: '没找到 Pi 运行时：内置那份不在，PATH 上也没有全局安装的',
        model: '先在「模型」里配好端点、模型与密钥',
        key: `还没有配置 ${providerName.value} 的 API Key`,
      } as const
      notifyError(notices[gap])
      return false
    }
    if (attached.length && !imageReady.value) {
      notifyError(`「${activeChoice.value?.name ?? '这个模型'}」看不了图：把图删掉，或者换一个能看图的模型`)
      return false
    }

    // 环境这一趟先验完再建会话：缺模型 / 缺密钥时那句本来也发不出去，
    // 建了只会在左栏多留一行没人说过的「新会话」
    let session = activeSession.value
    if (!session) {
      if (creating.value)
        return false
      creating.value = true
      try {
        session = await ensureSession()
      }
      finally {
        creating.value = false
      }
      if (!session)
        return false
    }
    const runState = runOf(session.id)
    if (runState.running)
      return false

    // 起进程的参数按**这个会话自己**的生效配置取（configOf），不是当前正对着的那份
    const launch = launchFor(session)
    const cfg = configOf(session)
    // 第一次说话时把标题定下来（左栏上那一行）；之后不再改。**只有图没有字的那句**标题
    // 记成「（N 张图）」—— 标题空着等于「还没说过话」，下次打开这段会话就不去读历史了
    // （见 hydrate）
    void settings.updateSettings({
      aiSessions: rememberAiSession(sessions.value, {
        ...session,
        title: session.title || aiSessionTitle(text) || `（${attached.length} 张图）`,
        updatedAt: Date.now(),
      }),
    })

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
        ...(attached.length ? { images: attached.map(image => image.dataUrl) } : {}),
      },
      // 进程还没起过（或换过参数）时把「这一轮跑的是什么」记一行：完整命令行（含绝对路径的
      // cli.js 与那一串开关）收进 detail —— 它是排障用的，摆在一行正文里只会把日志开头堵死
      // （界面拿它当悬停提示，见 AiRunPanel）。同一个进程接着聊时不必每轮都写一遍
      ...(runState.live ? [] : [noteProcess(session, launch)]),
    ]

    // 起进程这一趟与「收下这句」拆开：到这儿输入就算收下了（校验过了、会话有着落了、
    // 这一轮也记进对话了），返回 true 让页面清空输入框 —— 与从前「清空发生在起进程之前」
    // 同一条时序；进程起没起来由 runError 与通知去说
    void (async () => {
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
          provider: cfg.providerName,
          permission: cfg.permission,
          // 已经在跑的进程不会因为这张表变了而变（`--skill` 只认起进程那一趟）；
          // 没在跑时这一句就是起进程那一趟，带的必须是当下这份
          skills: useAiSkillsStore().enabledRefs,
        },
        handlers(session.id),
      )

      if (result.ok) {
        runState.live = true
        return
      }
      runState.running = false
      runState.runError = result.error ?? '启动失败'
      notifyError(runState.runError)
    })()
    return true
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
    if (!(await createSession(dir)))
      return null
    return activeSession.value
  }

  /**
   * 这一轮跑完了（Pi 的 `agent_settled`）：**进程留着** —— 上下文就在它那儿，下一句接着聊
   * 就是接着它。参数改过（模型 / 档位 / 权限）时这一轮跑完顺手把进程收掉，下一句按新参数重开。
   */
  function settle(sessionId: string): void {
    const run = runs.get(sessionId)
    if (!run)
      return
    run.running = false
    run.stopping = false
    run.exitCode = 0
    // 半路停下的那一轮（abort 之后助手那段是空的）：把已经吐出来的字留在对话里
    endStream(run, true)
    // 想了一半就结束的那一段也一样留着（它是收着的一块，不挡阅读）
    endThink(run, '', true)
    noteDuration(run)
    if (run.stale)
      void recycle(sessionId)
    // 这一轮真的跑完了 = 用了一次 AI 助手，记一笔活跃度（首页那张图据此变深）。
    // **挂在 settle 而不是起进程那一趟**：进程起得来不代表跑得完，起完就崩的那些不该进图；
    // 也正因为挂在 store 这一层，它才只认这个页面里的会话 —— 知识库一键清洗走的是自己那条
    // Pi 路子，那一笔在知识库那边记（见 workbench/kb.ts 的 kbIndexBuild），不会重复
    void window.workbench.recordActivity('ai')
  }

  /** 进程退出了（我们收的，或者它自己崩了）：把这一轮的状态收尾 */
  function finish(sessionId: string, code: number | null): void {
    // 会话已经被删掉时不重建条目（`runs.delete` 之后进程才收尾的那一小段）
    const run = runs.get(sessionId)
    if (!run)
      return
    run.live = false
    run.confirms = []
    const wasRunning = run.running
    const intentional = run.stopping || run.stale
    run.running = false
    run.stopping = false
    if (!wasRunning)
      return
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
    if (!session)
      return
    const run = runOf(session.id)
    if (!run.running || run.stopping)
      return

    run.stopping = true
    const processId = aiSessionProcessId(session.id)
    const aborted = await aiAbort(processId)
    if (!aborted.ok)
      await aiStop(processId)
  }

  /**
   * 把一条会话的进程收掉（**会话文件不动**）：下一句会按新参数重开一份，历史从那份文件接上
   * （实测：杀掉进程重开，读回来的消息一条不少）。用在两处：模型 / 档位 / 权限改过之后，
   * 以及这一轮跑完之后才发现的「参数变过」。
   */
  async function recycle(sessionId: string): Promise<void> {
    const run = runOf(sessionId)
    run.stale = false
    if (!run.live)
      return
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
    if (!session)
      return
    const run = runOf(session.id)
    const confirm = run.confirms.find(item => item.id === id)
    if (!confirm)
      return
    run.confirms = run.confirms.filter(item => item.id !== id)

    const sent = await aiSend(aiSessionProcessId(session.id), confirmFrame(id, allowed))
    run.lines = [
      ...run.lines,
      { kind: 'tool', text: `${allowed ? '允许执行' : '拒绝执行'}：${confirm.message}` },
    ]
    if (!sent.ok)
      notifyError(sent.error ?? '答复没能送到 Pi 那边')
  }

  let started = false

  /** 进页面时探一次环境（KeepAlive 下重复进入不再探）；顺带把上次那个会话接上 */
  async function init(): Promise<void> {
    if (started)
      return
    started = true
    await probe()
    // 设置里的服务清单与 Pi 的 models.json 对齐一次：老设置搬到新形状之后，
    // 那份文件里还是上一个版本写的端点（界面看不出这一层，所以每次进来都对一遍）
    await syncModels()
    if (activeId.value)
      void hydrate(activeId.value)
  }

  // 设置里换了模型 / 换了服务（也可能是在别处改的）：密钥状态得重新问一遍
  watch([providerName, providers], () => {
    if (started)
      void refreshKey()
  })

  // 换了一个会话：把它接上（读过的那几段由 hydrate 自己挡掉）
  watch(activeId, () => {
    if (started && activeId.value)
      void hydrate(activeId.value)
  })

  // 环境刚好在这一刻齐了（比如刚配完模型就切回来）：那一条还没接过历史的会话补接一次 ——
  // 那次打开时起不了进程，读历史就没做成
  watch(startable, (ready) => {
    if (started && ready && activeId.value)
      void hydrate(activeId.value)
  })

  // 把技能那两条根注册给技能栏（ai-skills 不反向 import 这里，见它 setRoots 的说明）：
  // 探测运行时带回的 skillRoot 与当前盯着的目录一变，技能栏的两栏根就跟着换、并自动重扫
  watch([skillRoot, watchedDir], ([root, dir]) => {
    useAiSkillsStore().setRoots(root, dir)
  }, { immediate: true })

  /**
   * 模型配置变过了（默认模型 / 思考档位 / 权限这三样，以及下面三个改服务的入口）：
   * **已经开着的会话要用新配置就得把进程换掉** —— 参数与 models.json 都是起进程时
   * 读定死的（`--model` / `--thinking` / 那份权限扩展；模型的能力位长在 models.json 里）。
   * 正在跑的那些等这一轮跑完再换（`stale`），不然一次改设置就把用户干到一半的活掐了；
   * 闲着的当场收掉，下一句重开（历史从会话文件接上，不丢东西）。
   */
  function retireProcesses(): void {
    for (const [sessionId, run] of runs) {
      if (!run.live)
        continue
      if (run.running)
        run.stale = true
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
    const cfg = configOf(session)
    return `${cfg.providerName}|${cfg.model}|${cfg.thinking}|${cfg.permission}`
  }

  const lastConfigKeys = new Map<string, string>()
  watch(
    () => sessions.value.map(session => effectiveKey(session)).join('\n'),
    () => {
      for (const session of sessions.value) {
        const key = effectiveKey(session)
        const previous = lastConfigKeys.get(session.id)
        lastConfigKeys.set(session.id, key)
        // 第一趟（immediate）只是记账；会话刚出现（没有旧键）也不算换配置
        if (!started)
          continue
        const run = runs.get(session.id)
        const action = configChangeAction(previous, key, run)
        if (action === 'stale' && run)
          run.stale = true
        else if (action === 'recycle')
          void recycle(session.id)
      }
    },
    { immediate: true },
  )

  return {
    sessions,
    groups,
    activeId,
    activeSession,
    runs,
    creating,
    recentDirs,
    newDir,
    setNewDir,
    pickNewDir,
    watchedDir,
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
    envGap,
    imageReady,
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
    init,
    probe,
    refreshKey,
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
    installPi,
  }
})
