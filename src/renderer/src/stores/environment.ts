/**
 * 本机环境：包管理器、Node 版本（nvm）、npm 镜像（nrm），以及数据目录的位置。
 *
 * 这几项的共同点是**探测出来的**而不是用户配的：它们由 Rust 侧扫目录 / 起 `--version`
 * 得到，界面只负责展示与触发刷新。安装类动作（npm 全局装包管理器 / nrm）也在这里，
 * 因为它们都要开系统终端、都要把最后一行输出顶在系统状态卡片上。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  InstallableGlobalTool,
  InstallablePackageManager,
  NrmStatus,
  NvmStatus,
  PackageManagerStatus
} from '@/types'
import { notifyError, notifySuccess } from '@/notify'
import { useTerminalStore, SYSTEM_PM_TERMINAL } from './terminal'

export const useEnvironmentStore = defineStore('environment', () => {
  const terminal = useTerminalStore()

  const packageManagers = ref<PackageManagerStatus | null>(null)
  /** 正在通过 npm 全局安装的全局工具（包管理器 / nrm），null 表示空闲 */
  const pmInstalling = ref<InstallableGlobalTool | null>(null)
  /** 安装过程的最新一行 npm 输出，仅安装期间有值 */
  const pmInstallLog = ref('')
  /** nvm 探测结果：可选的项目级 Node 版本来自这里 */
  const nvm = ref<NvmStatus | null>(null)
  /** nrm 探测结果：当前 npm 镜像与可切换的清单来自这里 */
  const nrm = ref<NrmStatus | null>(null)
  /** 正在切换的镜像名，null 表示空闲 */
  const nrmSwitching = ref<string | null>(null)
  /**
   * 数据目录：固定在 `%APPDATA%\Workbench\data`（宿主侧唯一真源）。
   * 界面只在「关于」那一屏如实显示它 —— 没有「换目录」这回事。
   */
  const dataDir = ref('')

  /** 重新探测包管理器。装上东西之后界面上那一列状态就靠它刷新 */
  async function refreshPackageManagers(): Promise<void> {
    packageManagers.value = await window.workbench.checkPackageManagers()
  }

  /** 重新探测 nrm：装完 / 换完镜像后那一行状态靠它刷新 */
  async function refreshNrm(): Promise<void> {
    nrm.value = await window.workbench.getNrmStatus()
  }

  /** 重新探测 nvm（装上 / 卸载了 Node 版本后手动刷新用） */
  async function refreshNvm(): Promise<void> {
    nvm.value = await window.workbench.getNvmStatus()
  }

  /** 首屏三项探测一起跑（各自要起子进程 / 扫目录，不挡首屏） */
  function refreshAll(): void {
    void refreshPackageManagers()
    void refreshNvm()
    void refreshNrm()
  }

  async function loadDataDir(): Promise<void> {
    dataDir.value = await window.workbench.getDataDir()
  }

  /**
   * 把配置里的版本映射到 nvm 里真实装了的版本：
   * 精确匹配优先，「20」/「20.20」这类段前缀落到该段内最高的版本（与主进程判定一致）。
   */
  function installedNodeVersion(wanted?: string): string | null {
    const target = (wanted ?? '').trim().replace(/^v/i, '')
    if (!target) return null

    const versions = nvm.value?.versions ?? []
    if (versions.includes(target)) return target
    if (!/^\d+(\.\d+)*$/.test(target)) return null
    // versions 已按版本号降序，find 命中的就是符合前缀的最高版本
    return versions.find((v) => v.startsWith(`${target}.`)) ?? null
  }

  /**
   * 用 npm 全局安装一个工具（yarn / pnpm / nrm）。
   *
   * 三个包共一条通道：都要开系统终端、都要把 npm 的输出顶在系统状态卡片上，
   * 区别只在装完刷哪一项探测结果。装的事交给适配层（它知道走哪条命令），
   * 这里只负责界面上的状态与提示。
   *
   * 安装结果以「重新探测」为准而不是 npm 的退出码：npm 有时装了包仍返回非 0。
   * 失败的情况也照样刷一遍 —— 例如装成功了但 PATH 还没生效，至少状态是准的。
   */
  async function installGlobalTool(tool: InstallableGlobalTool): Promise<boolean> {
    if (pmInstalling.value) return false

    const target = terminal.openSystemTerminal(`安装 ${tool}`)
    // 同一轮接一轮地装不同的包时，日志从零开始，别把上一次的输出混进来
    terminal.clearTerminalLogs(SYSTEM_PM_TERMINAL)

    const startedAt = Date.now()
    target.status = 'installing'
    target.currentCommand = `npm install -g ${tool}`
    target.startedAt = startedAt
    terminal.appendSystemLog(`npm install -g ${tool}`, 'cmd')

    pmInstalling.value = tool
    pmInstallLog.value = ''

    const settle = (status: 'success' | 'failed', note?: string): void => {
      target.status = status
      target.startedAt = undefined
      target.durationMs = Date.now() - startedAt
      if (note) terminal.appendSystemLog(note, status === 'failed' ? 'err' : 'sys')
    }

    const refresh = (): Promise<void> =>
      tool === 'nrm' ? refreshNrm() : refreshPackageManagers()

    try {
      const result =
        tool === 'nrm'
          ? await window.workbench.installNrm()
          : await window.workbench.installPackageManager(tool)
      await refresh()
      if (!result.ok) {
        settle('failed', result.error ?? `${tool} 安装失败`)
        notifyError(result.error ?? `安装 ${tool} 失败`)
        return false
      }
      settle('success', `${tool} 安装完成，已刷新环境状态`)
      notifySuccess(`${tool} 安装完成`)
      return true
    } catch (err) {
      await refresh()
      const message = (err as Error).message || `安装 ${tool} 失败`
      settle('failed', message)
      notifyError(message)
      return false
    } finally {
      pmInstalling.value = null
      pmInstallLog.value = ''
    }
  }

  function installPackageManager(pm: InstallablePackageManager): Promise<boolean> {
    return installGlobalTool(pm)
  }

  /** 一键安装 nrm；与包管理器共用一条安装通道，一次只装一个 */
  function installNrm(): Promise<boolean> {
    return installGlobalTool('nrm')
  }

  /**
   * 换一个 npm 镜像源（nrm use）。
   *
   * 改的是 npm 的全局配置，此后所有不带自己的 .npmrc 的项目都走新源，
   * 所以成功与失败都给一句明确反馈，并把重新探测的结果落回 nrm 那一行。
   */
  async function useNrmRegistry(name: string): Promise<boolean> {
    if (nrmSwitching.value || !name) return false

    nrmSwitching.value = name
    try {
      const result = await window.workbench.useNrmRegistry(name)
      if (!result.ok) {
        notifyError(result.error ?? `切换到 ${name} 失败`)
        return false
      }
      nrm.value = result.data ?? nrm.value
      notifySuccess(`npm 镜像已切到 ${name}`)
      return true
    } finally {
      nrmSwitching.value = null
    }
  }

  /** 安装过程的那一行 npm 输出由主进程推过来（完整过程进终端由 terminal store 订阅） */
  function installListeners(): void {
    window.workbench.onPmInstallLog((event) => {
      pmInstallLog.value = event.text
    })
  }

  return {
    packageManagers,
    pmInstalling,
    pmInstallLog,
    nvm,
    nrm,
    nrmSwitching,
    dataDir,
    refreshPackageManagers,
    refreshNvm,
    refreshNrm,
    refreshAll,
    loadDataDir,
    installedNodeVersion,
    installGlobalTool,
    installPackageManager,
    installNrm,
    useNrmRegistry,
    installListeners
  }
})
