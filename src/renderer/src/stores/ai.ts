/**
 * AI 助手：一个通用的 agent 控制台 —— **在一个目录里、按一条指令**，请内置的 Pi 干活。
 *
 * 一轮的流程：选工作目录 → 写指令 → 拼提示词（shared/ai.ts 的 taskPrompt）→ 起子进程
 * （workbench/ai.ts）→ 事件流逐行进日志 → 退出码收尾。
 *
 * **它与知识库无关**：处理知识库只是「把工作目录指到那个仓库、写一条照它规范整理的指令」
 * 的一种用法；页面不内置任何一类任务，也不替用户写提示词。将来要做「知识库专用任务」，
 * 在这一层上面加模板即可，不必动下面这条链路。
 *
 * 不在这里做的事：取密钥、写提示词文件、写 models.json、替 Pi 关掉它自己的遥测 ——
 * 都在 Rust 侧（见 src-tauri/src/ai.rs），因为密钥与提示词都不该经过渲染层。
 * 工作目录与模型配置都住在设置里（用户换了就跟着变），这里不留副本。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { noteRootName, sanitizeNoteRoot } from '@shared/note'
import {
  activeAiModel,
  nodeSatisfiesPi,
  piLaunch,
  piLaunchForDisplay,
  sanitizeAiApiFormat,
  sanitizeAiBaseUrl,
  sanitizeAiModels,
  sanitizeAiName,
  taskPrompt,
  writtenEntries,
  type AiLogLine,
  type AiModelEntry
} from '@shared/ai'
import { notifyError, notifySuccess } from '@/notify'
import { useSettingsStore } from '@/stores/settings'
import { runDetached } from '@/workbench/session'
import {
  AI_INSTALL_SESSION_ID,
  AI_SESSION_ID,
  aiKeyClear,
  aiKeySave,
  aiKeyState,
  aiProviderWrite,
  aiRun,
  aiRuntime,
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

export const useAiStore = defineStore('ai', () => {
  const settings = useSettingsStore()

  // ---------- 在哪儿干活 ----------
  /** 工作目录：**用户自己挑的一个目录**（与知识库的 kbDir 互不相干）。空串 = 还没选过 */
  const workDir = computed(() => settings.settings.aiWorkDir)
  const locationText = computed(() => noteRootName(workDir.value))
  /** 指令原文（用户写的；页面切走再回来还在，重启不保留） */
  const instruction = ref('')

  // ---------- 配置（都在设置里；形状是自定义端点，见 shared/ai.ts） ----------
  const providerName = computed(() => settings.settings.aiProviderName)
  const baseUrl = computed(() => settings.settings.aiBaseUrl)
  const apiFormat = computed(() => settings.settings.aiApiFormat)
  const models = computed(() => settings.settings.aiModels)
  /** 这一轮跑哪个模型：清单里第一个启用的 */
  const runModel = computed(() => activeAiModel(models.value))
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

  // ---------- 这一轮 ----------
  const running = ref(false)
  const lines = ref<AiLogLine[]>([])
  const exitCode = ref<number | null>(null)
  const runError = ref('')
  const installing = ref(false)
  const installLog = ref<string[]>([])

  /** 这一轮写下的文件（从事件流里收的，去重排序） */
  const written = computed(() => writtenEntries(lines.value))
  const piReady = computed(() => runtimeSource.value !== 'none')
  /** 内置 cli.js 要 node ≥ 22.19；不内置 Node，这条是硬门槛 */
  const nodeOk = computed(() => nodeSatisfiesPi(nodeVersion.value))

  const canRun = computed(
    () =>
      !running.value &&
      piReady.value &&
      nodeOk.value &&
      configured.value &&
      keyReady.value &&
      !!workDir.value &&
      !!instruction.value.trim()
  )

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

  /** 记下用户挑的工作目录（页面上那颗按钮用它）。不搬动任何文件 */
  async function setWorkDir(dir: string): Promise<boolean> {
    const target = sanitizeNoteRoot(dir)
    if (!target) return false
    return settings.updateSettings({ aiWorkDir: target })
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

  // ---------- 跑一轮 ----------

  async function run(): Promise<void> {
    if (running.value) return
    const current = providerName.value

    if (!workDir.value) return notifyError('先选一个工作目录')
    if (!instruction.value.trim()) return notifyError('先写一条指令')
    if (!piReady.value) {
      return notifyError('没找到 Pi 运行时：内置那份不在，PATH 上也没有全局安装的')
    }
    if (!nodeOk.value) return notifyError('Node 版本太旧：跑内置的 Pi 需要 Node ≥ 22.19')
    if (!configured.value) return notifyError('先在「模型」里配好端点、模型与密钥')
    if (!keyReady.value) return notifyError(`还没有配置 ${current} 的 API Key`)

    const launch = piLaunch(runtimeSource.value === 'bundled' ? cliPath.value : null)
    running.value = true
    lines.value = [
      // 先把「跑的是什么」写进日志（与终端面板同一条规矩）：子进程起不来时，这是唯一的线索
      {
        kind: 'info',
        text: `在 ${locationText.value} 里工作 · ${launch.program} ${piLaunchForDisplay(launch)}`
      }
    ]
    exitCode.value = null
    runError.value = ''
    installLog.value = []

    const result = await aiRun(
      {
        sessionId: AI_SESSION_ID,
        dir: workDir.value,
        prompt: taskPrompt({ dir: workDir.value, instruction: instruction.value }),
        program: launch.program,
        args: launch.args,
        provider: current,
        model: runModel.value
      },
      {
        onLine: (line) => {
          lines.value = [...lines.value, line]
        },
        onExit: (code) => {
          void finish(code)
        }
      }
    )

    if (!result.ok) {
      running.value = false
      runError.value = result.error ?? '启动失败'
      notifyError(runError.value)
    }
  }

  /**
   * 一轮结束。**不在这一层做收尾动作**：这一页是通用控制台，不做「跑完重建索引」之类
   * 与具体任务绑在一起的事 —— 那些归任务自己（真要自动化，将来按任务加）。
   */
  async function finish(code: number | null): Promise<void> {
    exitCode.value = code
    running.value = false
    if (code !== 0) runError.value = `这一轮没有跑完（退出码 ${code ?? '未知'}）`
  }

  /** 中途停掉：Rust 按进程树杀，随后的 session:exit 会把界面收回去 */
  async function stop(): Promise<void> {
    const result = await aiStop()
    if (!result.ok) notifyError(result.error ?? '停止失败')
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

  /** 进页面时探一次环境（KeepAlive 下重复进入不再探） */
  async function init(): Promise<void> {
    if (started) return
    started = true
    await probe()
  }

  // 设置里换了提供方名（也可能是在别处改的）：密钥状态得重新问
  watch(providerName, () => {
    if (started) void refreshKey()
  })

  return {
    workDir,
    locationText,
    instruction,
    providerName,
    baseUrl,
    apiFormat,
    models,
    runModel,
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
    running,
    lines,
    exitCode,
    runError,
    installing,
    installLog,
    written,
    piReady,
    nodeOk,
    canRun,
    init,
    probe,
    refreshKey,
    setWorkDir,
    saveEndpoint,
    saveKey,
    clearKey,
    run,
    stop,
    installPi
  }
})
