/**
 * `window.workbench` 上的一组通道：本机环境探测（包管理器、端口、Node、镜像源）。
 * 实现见 `workbench/api-system.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  InstallablePackageManager,
  NodeCheckResult,
  NrmStatus,
  NvmStatus,
  PackageManagerStatus,
  PmInstallLogEvent,
  PortCheckResult,
} from '../index'

export interface EnvironmentChannel {
  checkPackageManagers: () => Promise<Result<PackageManagerStatus>>

  /** 用 npm 全局安装 yarn / pnpm；返回的 status 是装完（或装失败）后重新探测的结果 */
  installPackageManager: (
    pm: InstallablePackageManager,
  ) => Promise<Result<PackageManagerStatus>>

  checkPort: (port: number) => Promise<Result<PortCheckResult>>

  killPortProcess: (port: number) => Promise<Result<null>>

  checkNodeVersion: (id: string) => Promise<Result<NodeCheckResult>>

  /** 读取 nvm 已安装的 Node 版本，用于项目级选择 */
  getNvmStatus: () => Promise<Result<NvmStatus>>

  /** nrm 状态：装没装、当前镜像、可切换的镜像清单 */
  getNrmStatus: () => Promise<Result<NrmStatus>>

  /** 用 npm 全局安装 nrm；返回装完（或装失败）后重新探测的结果 */
  installNrm: () => Promise<Result<NrmStatus>>

  /** 换一个 npm 镜像源（nrm use <name>）；返回切换后重新探测的结果 */
  useNrmRegistry: (name: string) => Promise<Result<NrmStatus>>

  /** 包管理器安装过程中的输出，一行一行推过来 */
  onPmInstallLog: (fn: (e: PmInstallLogEvent) => void) => () => void
}
