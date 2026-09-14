/**
 * 系统能力里「探测」这一部分：包管理器、Node 版本。
 *
 * 与 Electron 版一致的判据：能跑通 `<bin> --version` 就算装了，版本号取输出首行。
 * 外部命令的拉起与超时都交给 Rust 的 proc 原语（它已经处理了管道死锁与超时回收），
 * 这里只负责并发探测与结果拼装。
 */
import { fail, ok } from '@shared/result'
import type {
  InstallableGlobalTool,
  InstallablePackageManager,
  PackageManagerStatus,
  Result
} from '@shared/types'
import { invoke } from './bridge'
import { PM_SESSION_PREFIX, abortDetached, runDetached } from './session'

/** 安装包管理器最多等 5 分钟：registry 慢的时候一分钟上下是常态，但也不能无限挂着 */
const PM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/** 探测 `<bin> --version`；不可用或超时返回 null */
async function probeVersion(bin: string): Promise<string | null> {
  try {
    return await invoke<string | null>('probe_version', { bin })
  } catch (error) {
    // 不能静默吞掉：这个 catch 曾经把「通道根本到不了 Rust」伪装成「这四个都没装」，
    // 排查时多花了好几轮才看出区别
    console.warn(`[workbench] 探测 ${bin} 失败`, error)
    return null
  }
}

export async function checkPackageManagers(): Promise<PackageManagerStatus> {
  const [npm, yarn, pnpm, node] = await Promise.all([
    probeVersion('npm'),
    probeVersion('yarn'),
    probeVersion('pnpm'),
    probeVersion('node')
  ])
  return {
    npm: npm !== null,
    yarn: yarn !== null,
    pnpm: pnpm !== null,
    node: node ?? ''
  }
}

/**
 * 用 npm 全局安装一个工具，成功时返回最后一行输出（调用方判「装没装上」时要靠重新探测，
 * 这一行只在探测仍然失败时当提示语用）。
 *
 * 走的是会话通道而不是「跑完再收输出」：npm 装包要几十秒到几分钟，
 * 这期间界面上的「系统状态」卡片要能看到它一行行往下走（`onPmInstallLog`）。
 */
export async function installGlobalTool(tool: InstallableGlobalTool): Promise<Result<string>> {
  const sessionId = `${PM_SESSION_PREFIX}${tool}`
  let lastOutput = ''

  // 超时兜底：registry 慢的时候一分钟上下是常态，但也不能无限挂着
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('安装超时，请检查网络后重试')), PM_INSTALL_TIMEOUT_MS)
  })

  try {
    await Promise.race([
      runDetached(sessionId, `npm install -g ${tool}`, (text) => {
        const trimmed = text.trim()
        if (trimmed) lastOutput = trimmed
      }),
      timeout
    ])
  } catch (error) {
    // 超时或被中断：把还挂着的安装进程按树收掉，别留在后台
    void abortDetached(sessionId)
    return fail(error instanceof Error ? error.message : '安装失败')
  }

  return ok(lastOutput)
}

/**
 * 用 npm 全局安装 yarn / pnpm，装完重新探测并把结果带回去。
 * npm 有时装了包仍返回非 0，所以不看退出码，以重新探测为准。
 */
export async function installPackageManager(
  pm: InstallablePackageManager
): Promise<Result<PackageManagerStatus>> {
  const install = await installGlobalTool(pm)
  if (!install.ok) return fail(install.error ?? '安装失败')

  const status = await checkPackageManagers()
  if (status[pm]) return ok(status)

  return fail(install.data || '安装失败，请查看终端输出')
}
