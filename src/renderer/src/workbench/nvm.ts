/**
 * nvm 相关：探测本身是 fs 活（扫目录、读 settings.txt、解析软链），所以放在 Rust；
 * 但「项目要求的版本是否被满足」用的是 `@shared/node-version.ts` 里的纯函数 —— 那部分有现成测试。
 */
import { satisfiesNodeVersion } from '@shared/node-version'
import type { NodeCheckResult, NvmStatus } from '@shared/types'
import { invoke } from './bridge'
import * as state from './state'

export function status(): Promise<NvmStatus> {
  return invoke<NvmStatus>('nvm_status')
}

/** 项目指定的 nvm 版本对应的安装目录；没指定或没装返回 null */
export async function nodeDirFor(version: string | undefined): Promise<string | null> {
  if (!version?.trim()) return null
  try {
    return await invoke<string | null>('nvm_node_dir', { version })
  } catch {
    return null
  }
}

/**
 * 项目级 Node 版本校验（只提示、不阻断）。
 * 项目选定的 nvm 版本优先，否则看 nvm 软链当前指向的那个；都没有就如实报空，
 * 由 `satisfiesNodeVersion` 决定是否提示。
 */
export async function checkNodeVersion(projectId: string): Promise<NodeCheckResult> {
  const project = state.projects().find((item) => item.id === projectId)
  const required = project?.nodeRequirement

  const selected = project?.nodeVersion?.trim()
  if (selected) {
    return {
      required,
      actual: selected,
      source: 'project',
      ok: satisfiesNodeVersion(required, selected)
    }
  }

  const nvm = await status()
  const actual = nvm.current ?? ''
  return { required, actual, source: 'system', ok: satisfiesNodeVersion(required, actual) }
}
