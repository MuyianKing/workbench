import type { AiProvider } from '@workbench/ai'
import type { ComputedRef } from 'vue'
import { nodeSatisfiesPi } from '@workbench/ai'
import { computed, reactive, ref } from 'vue'
import { notifyError, notifySuccess } from '@/notify'
import { AI_INSTALL_SESSION_ID, aiKeyState, aiRuntime } from '@/workbench/ai'
import { runDetached } from '@/workbench/session'

/** Pi 的 npm 包名（它官方给的安装方式就是全局装一个包） */
const PI_PACKAGE = '@earendil-works/pi-coding-agent'

/**
 * 这台机器上的运行时：Pi 在不在（内置 / 全局）、Node 版本够不够、每个服务配没配密钥，以及装 Pi。
 *
 * 从 `stores/ai.ts` 拆出来的叶子。只认服务清单与「当前挑中哪个服务」两样输入 ——
 * 密钥状态是凭据管理器问回来的布尔值，密钥本身不进渲染层。
 */
export function useAiRuntime(options: {
  providers: ComputedRef<AiProvider[]>
  /** 当前挑中的那个服务（keyReady / 错误文案要用） */
  providerName: ComputedRef<string>
}) {
  const { providers, providerName } = options

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

  const installing = ref(false)
  const installLog = ref<string[]>([])

  /** 探一次运行时（内置 → 全局 pi → 都没有）与 node 版本；顺带查一下密钥配没配 */
  async function probe(): Promise<void> {
    probing.value = true
    try {
      const result = await aiRuntime()
      if (!result.ok || !result.data) {
        // 探测没做成 ≠ 两个都没有：状态先按「没有」画，但原因要说出
        runtimeSource.value = 'none'
        cliPath.value = ''
        runtimeDetail.value = result.error ?? '探测运行时失败'
        notifyError(runtimeDetail.value)
      }
      else {
        const runtime = result.data
        runtimeSource.value = runtime.source
        cliPath.value = runtime.cli
        runtimeDetail.value = runtime.detail
        piVersion.value = runtime.pi
        nodeVersion.value = runtime.node
        skillRoot.value = runtime.skillRoot
      }
    }
    finally {
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
    const alive = new Set(providers.value.map(provider => provider.id))
    for (const id of Object.keys(keyStates)) {
      if (!alive.has(id))
        delete keyStates[id]
    }
  }

  /** 装 Pi（全局装那一个包）。输出进安装日志，装完自动重探一次 */
  async function installPi(): Promise<void> {
    if (installing.value)
      return

    installing.value = true
    installLog.value = []
    try {
      const code = await runDetached(
        AI_INSTALL_SESSION_ID,
        `npm install -g ${PI_PACKAGE}`,
        (text) => {
          installLog.value = [...installLog.value, text]
        },
      )
      if (code === 0) {
        notifySuccess('Pi 装好了')
        await probe()
      }
      else {
        notifyError(`安装没有成功（退出码 ${code ?? '未知'}）`)
      }
    }
    catch (error) {
      notifyError(error instanceof Error ? error.message : '安装失败')
    }
    finally {
      installing.value = false
    }
  }

  return {
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
  }
}
