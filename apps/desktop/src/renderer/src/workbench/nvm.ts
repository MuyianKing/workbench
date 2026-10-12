import type { NodeCheckResult, NvmStatus } from '@/types'
/**
 * nvm 相关：探测本身是 fs 活（扫目录、读 settings.txt、解析软链），所以放在 Rust；
 * 但「项目要求的版本是否被满足」用的是 `@workbench/core.ts` 里的纯函数 —— 那部分有现成测试。
 */
import { satisfiesNodeVersion } from '@workbench/core'
import { invoke } from './bridge'
import * as state from './state'

export function status(): Promise<NvmStatus> {
  return invoke<NvmStatus>('nvm_status')
}

/** 项目指定的 nvm 版本对应的安装目录；没指定或没装返回 null */
export async function nodeDirFor(version: string | undefined): Promise<string | null> {
  if (!version?.trim())
    return null
  try {
    return await invoke<string | null>('nvm_node_dir', { version })
  }
  catch (error) {
    // 不能静默吞掉：失败与「这个版本没装」都会得到 null，而前者会让命令带着错误的
    // Node 版本跑起来（与 probeVersion 同一条口径：至少留一句能在控制台查到的记录）
    console.warn('[workbench] 解析 nvm 版本目录失败', error)
    return null
  }
}

/**
 * 项目级 Node 版本校验（只提示、不阻断）。
 * 项目选定的 nvm 版本优先，否则看 nvm 软链当前指向的那个；都没有就如实报空，
 * 由 `satisfiesNodeVersion` 决定是否提示。
 *
 * **签名说不会失败，就得真不失败**：探测本身在 IPC 层面出问题时返回「不提示」
 * （ok: true）—— 「拿不到版本」与「版本不满足」是两件事，不该把前者吓成一次警告。
 */
export async function checkNodeVersion(projectId: string): Promise<NodeCheckResult> {
  const project = state.projects().find(item => item.id === projectId)
  const required = project?.nodeRequirement

  const selected = project?.nodeVersion?.trim()
  if (selected) {
    return {
      required,
      actual: selected,
      source: 'project',
      ok: satisfiesNodeVersion(required, selected),
    }
  }

  let actual = ''
  try {
    actual = (await status()).current ?? ''
  }
  catch (error) {
    console.warn('[workbench] 探测 nvm 失败', error)
    return { required, actual: '', source: 'system', ok: true }
  }
  return { required, actual, source: 'system', ok: satisfiesNodeVersion(required, actual) }
}
