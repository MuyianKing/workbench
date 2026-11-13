import type { AiModelChoice, AiRunConfig, AiSession } from '@workbench/ai'
import type { ComputedRef, Ref } from 'vue'
import type { AppSettings } from '@/types'
import { aiModelChoices, resolveAiRunConfig, sanitizeAiPermission, sanitizeAiSessions, sanitizeAiThinking } from '@workbench/ai'
import { computed } from 'vue'

/**
 * 配置层：服务与模型清单、每个会话当下生效的那一份、以及 composer 上那三颗选择（模型 / 档位 / 权限）。
 *
 * 从 `stores/ai.ts` 拆出来的叶子。只认「设置里存着的那份」与当前打开的会话 ——
 * 会话自己的配置存在 `aiSessions` 的四个可选字段里，没记过的回落设置默认
 * （规则在 `@workbench/ai` 的 `resolveAiRunConfig`，可单测）。
 */
export function useAiConfig(options: {
  settings: Ref<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<boolean>
  /** 会话清单（落盘的那份） */
  sessions: ComputedRef<AiSession[]>
  activeSession: ComputedRef<AiSession | null>
}) {
  const { settings, updateSettings, sessions, activeSession } = options

  /** 配过的 AI 服务（模型管理弹窗里那一屏）：密钥不在里面，它在凭据管理器里 */
  const providers = computed(() => settings.value.aiProviders)
  /** 页面上那个「模型」下拉里能挑的：启用的服务下启用的那些模型 */
  const choices = computed(() => aiModelChoices(providers.value))

  /**
   * 一个会话（或「还没建的新对话」）当下生效的那份配置。解析规则在
   * `@workbench/ai` 的 `resolveAiRunConfig`（可单测，回落与档位钳制都在那边）；
   * 这里只把两份响应式事实 —— 服务清单与设置里的默认 —— 递进去。
   */
  function configOf(session: AiSession | null): AiRunConfig {
    return resolveAiRunConfig(providers.value, session, {
      provider: settings.value.aiDefaultProvider,
      model: settings.value.aiDefaultModel,
      thinking: settings.value.aiThinking,
      permission: settings.value.aiPermission,
    })
  }

  /** 当前正对着的那份：有会话用会话自己的，起始屏（还没建会话）用设置里的默认 */
  const activeConfig = computed(() => configOf(activeSession.value))
  /**
   * 默认模型（模型管理弹窗顶上那一栏写的、起始屏下拉显示的都是它）：挑的没了
   * （服务停用 / 模型关掉 / 删掉）退回第一个能挑的，一个都没有是 null。
   */
  const activeChoice = computed<AiModelChoice | null>(() => activeConfig.value.choice)
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
   * 工具权限（composer 左边那一栏）：两档，见 packages/ai/src/ai.ts 的 AI_PERMISSION_MODES。
   * **它决定 Pi 那边加不加载那份确认扩展** —— 自动编辑：每次要跑命令都先问一句；
   * 完全访问：不加载扩展，结构上就没有询问。改它要重开进程（见 ai.ts 那个 watch）。
   */
  const permission = computed(() => activeConfig.value.permission)
  /** 能跑一轮的最低配置：挑中的那个服务四样齐了（密钥另算，见 keyReady） */
  const configured = computed(() => !!activeChoice.value && !!providerName.value)

  /**
   * 挑中的这个模型能不能看图（贴图只在它上面成立，见 packages/ai/src/ai.ts 的 AiModelChoice.imageInput）；
   * composer 那边判断「这条能不能发 / 还差什么」时要用它（canRun / blocking 归输入框自己）
   */
  const imageReady = computed(() => activeChoice.value?.imageInput === true)

  /**
   * 页面上那个「模型」下拉的选中项：`<服务 id>/<模型 id>`（与选项的值同一个，
   * 不过这里空串表示「一个能挑的都没有」—— 下拉的 placeholder 就是给那一刻的）。
   */
  const activeChoiceKey = computed(() => activeChoice.value?.key ?? '')

  /**
   * 页面上那个下拉挑了什么：**有会话就记到会话自己身上**（那一刻生效的四样一起快照，
   * 见 AiSession 的可选字段），起始屏（还没建会话）记到设置里的默认 —— 之后新建的
   * 对话用它起步。挑的是 `packages/ai/src/ai.ts` 的 AiModelChoice.key（`<服务 id>/<模型 id>`），
   * 认不出就当没挑过。
   */
  async function setChoice(key: string): Promise<boolean> {
    const choice = choices.value.find(item => item.key === key)
    if (!choice)
      return false
    const session = activeSession.value
    if (!session) {
      return updateSettings({
        aiDefaultProvider: choice.provider,
        aiDefaultModel: choice.model,
      })
    }
    return persistSessionConfig(session, {
      provider: choice.provider,
      model: choice.model,
      thinking: thinking.value,
      permission: permission.value,
    })
  }

  async function setThinking(level: string): Promise<boolean> {
    const session = activeSession.value
    if (!session)
      return updateSettings({ aiThinking: sanitizeAiThinking(level) })
    return persistSessionConfig(session, {
      provider: providerName.value,
      model: runModel.value,
      thinking: sanitizeAiThinking(level),
      permission: permission.value,
    })
  }

  /** 页面上那一栏挑了什么：与模型 / 档位同一条口径（有会话记会话，起始屏记设置默认） */
  async function setPermission(id: string): Promise<boolean> {
    const session = activeSession.value
    if (!session)
      return updateSettings({ aiPermission: sanitizeAiPermission(id) })
    return persistSessionConfig(session, {
      provider: providerName.value,
      model: runModel.value,
      thinking: thinking.value,
      permission: sanitizeAiPermission(id),
    })
  }

  /**
   * 把一份配置记到会话自己身上（数据文件的 aiSessions）：只改这一条、顺序不动，收敛后再落
   * —— 认不出的值在收敛那层就被丢掉，读的时候回落设置里的默认。
   */
  async function persistSessionConfig(
    session: AiSession,
    patch: Partial<Pick<AiSession, 'provider' | 'model' | 'thinking' | 'permission'>>,
  ): Promise<boolean> {
    const next = sessions.value.map(item =>
      item.id === session.id ? { ...item, ...patch } : item,
    )
    return updateSettings({ aiSessions: sanitizeAiSessions(next) })
  }

  return {
    providers,
    choices,
    configOf,
    activeConfig,
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
  }
}
