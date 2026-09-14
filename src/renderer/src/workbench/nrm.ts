/**
 * nrm（npm 镜像源管理器）：探测、安装、切换镜像源。
 *
 * 与包管理器一样，nrm 只是个全局 npm 包，所以「装」这件事复用 system 的那条安装通道；
 * 而「有哪些镜像、当前是哪个」只有 nrm 自己知道，一律由 Rust 去问（见 src-tauri/src/nrm.rs），
 * 这一层只做结果拼装与失败收敛。
 */
import { fail, ok } from '@shared/result'
import type { NrmStatus, Result } from '@shared/types'
import { invoke } from './bridge'
import { installGlobalTool } from './system'

export function status(): Promise<NrmStatus> {
  return invoke<NrmStatus>('nrm_status')
}

/**
 * 换一个 npm 镜像源，成功后重新探测一次。
 *
 * 切换是 `nrm use <name>`：改的是 npm 的全局配置，此后所有（不带自己的 .npmrc 的）
 * 项目都走新源，所以界面上要如实显示「当前是哪个」。
 */
export async function useRegistry(name: string): Promise<Result<NrmStatus>> {
  try {
    await invoke<null>('nrm_use', { name })
  } catch (error) {
    // Rust 的 Err(String) 是被 Tauri 直接 reject 的，所以失败值不一定是 Error
    return fail(error instanceof Error ? error.message : '切换镜像源失败')
  }
  return ok(await status())
}

/**
 * 用 npm 全局安装 nrm，装完重新探测并把结果带回去。
 * 与包管理器同一条判据：不看 npm 的退出码，以「重探时 nrm 在不在」为准。
 */
export async function install(): Promise<Result<NrmStatus>> {
  const install = await installGlobalTool('nrm')
  if (!install.ok) return fail(install.error ?? '安装失败')

  const next = await status()
  if (next.available) return ok(next)

  return fail(install.data || '安装失败，请查看终端输出')
}
