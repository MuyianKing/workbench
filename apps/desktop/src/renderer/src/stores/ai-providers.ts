import type { AiFetchedModel, AiModelChoice, AiProvider } from '@workbench/ai'
import type { ComputedRef } from 'vue'
import type { AppSettings, Result } from '@/types'
import { aiProviderPayload, sanitizeAiApiFormat, sanitizeAiBaseUrl, sanitizeAiLabel, sanitizeAiModels, sanitizeAiName, sanitizeAiPreset } from '@workbench/ai'
import { confirmAction, notifyError, notifySuccess, notifyWarning } from '@/notify'
import { aiKeyClear, aiKeySave, aiModelsFetch, aiModelsWrite } from '@/workbench/ai'

/**
 * AI 服务（模型管理弹窗里那一屏）：增删改、启停、拉模型列表、清密钥，以及把它们写进 Pi 的 models.json。
 *
 * 从 `stores/ai.ts` 拆出来的叶子。收进程与重探密钥是编排层的动作，由宿主以回调递进来
 * （`retireProcesses` / `refreshKey`）—— 这里只负责把设置与 models.json 两边对齐。
 */
export function useAiProviders(options: {
  updateSettings: (patch: Partial<AppSettings>) => Promise<boolean>
  providers: ComputedRef<AiProvider[]>
  activeChoice: ComputedRef<AiModelChoice | null>
  keyStates: Record<string, boolean>
  refreshKey: () => Promise<void>
  /** 整份 models.json 重写之后，把已经开着的会话进程收掉 */
  retireProcesses: () => void
}) {
  const { updateSettings, providers, activeChoice, keyStates, refreshKey, retireProcesses } = options

  /**
   * 把当前设置里的服务清单写成 Pi 的 models.json（agent 目录下那份）。
   *
   * Pi 是照这份文件认端点的：设置存下了而文件没写等于没配，所以每次改完服务都要走一遍，
   * 进页面时也补一次（老设置搬到新形状之后那句「还没写」是看不出来的）。停用的服务与模型
   * 不进这份文件 —— 见 packages/ai/src/ai.ts 的 aiProviderPayload。
   */
  async function syncModels(): Promise<boolean> {
    const payload = aiProviderPayload(providers.value)
    // 一个能跑的服务都没有（还没配过，或者都停用了）：models.json 留着上一次那份也无妨 ——
    // 起进程时 --provider 是显式给的，没挑中就没有那一轮，残留的端点不会被用上
    if (!payload.length)
      return true
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
    if (!models.some(entry => entry.enabled)) {
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
      models,
    }
    // 编辑的是哪一条：**按原名找**（改名之后那一条还在清单里，只是换了键）
    const target = previousId || id
    const taken = providers.value
      .filter(item => item.id !== target && item.id !== id)
      .map(item => item.id)
    if (taken.includes(id)) {
      notifyError(`已经有一个叫 ${id} 的服务了：换一个名字`)
      return false
    }

    const next = providers.value.some(item => item.id === target)
      ? providers.value.map(item => (item.id === target ? provider : item))
      : [...providers.value, provider]
    const saved = await updateSettings({
      aiProviders: next,
      // 一个都没挑过（或者挑的那个刚被这次编辑弄没了）：默认模型就落到它身上
      ...(activeChoice.value
        ? {}
        : { aiDefaultProvider: provider.id, aiDefaultModel: provider.models[0]?.id ?? '' }),
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
      if (!stored.ok)
        keyWarning = stored.error ?? '保存 Key 失败'
    }

    // 设置已经落下去了：models.json 照**它**重写一遍（两边永远对得上）。
    // 能力位（能看图 / 上下文 / 档位）都长在这份文件里，写完就把进程退掉 ——
    // 否则改完的配置对已经在聊的会话不生效（Pi 起进程时读一次，不重读）
    if (!(await syncModels()))
      return false
    retireProcesses()

    // 改过名字：旧名字下那条凭据（API Key）已经没人认领了，清掉 —— 留着的只是一条密文
    if (previousId && previousId !== id)
      await aiKeyClear(previousId)

    await refreshKey()
    if (keyWarning)
      notifyWarning(`已保存 ${provider.label}，但 API Key 没存进去：${keyWarning}`)
    else notifySuccess(`已保存 ${provider.label}`)
    return true
  }

  /** 删掉一个服务：设置里去掉、models.json 重写；**密钥一起清掉**（留着它就是一条没人认领的密文） */
  async function removeProvider(id: string): Promise<void> {
    const provider = providers.value.find(item => item.id === id)
    if (!provider)
      return

    const agreed = await confirmAction(
      `「${provider.label}」这个服务会从模型管理里删掉，里面的 ${provider.models.length} 个模型与它的 API Key 一起清掉。`,
      '删除服务',
      { confirmButtonText: '删除', type: 'warning' },
    )
    if (!agreed)
      return

    const next = providers.value.filter(item => item.id !== id)
    const saved = await updateSettings({ aiProviders: next })
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
    const next = providers.value.map(item => (item.id === id ? { ...item, enabled } : item))
    const saved = await updateSettings({ aiProviders: next })
    if (!saved)
      return
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

  return {
    syncModels,
    saveProvider,
    removeProvider,
    toggleProvider,
    fetchModels,
    clearProviderKey,
  }
}
