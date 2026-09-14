/**
 * scanner 的生产侧：把 `@shared/scanner` 的 `ScanFs` 接到 Rust 上。
 *
 * 逻辑一行都没有重复——扫描规则留在 shared（那批测试也因此留在 vitest 里跑），
 * 这里只提供「读文件 / 判目录 / 列目录」三个能力，全部经 IPC 落到 Rust。
 */
import {
  resolveOutputDir as resolveWith,
  scanProject as scanWith,
  type ScanFs
} from '@shared/scanner'
import type { ScanResult } from '@shared/types'
import { invoke } from './bridge'

/** 目录条目：只需要名字，其余字段是给别处用的 */
interface DirEntry {
  name: string
}

const rustFs: ScanFs = {
  async readText(path) {
    try {
      return await invoke<string>('fs_read_text', { path })
    } catch {
      // 文件不存在读不出来，与「读取失败」对扫描而言是同一件事
      return null
    }
  },

  async isDirectory(path) {
    try {
      return await invoke<boolean>('fs_is_dir', { path })
    } catch {
      return false
    }
  },

  async listDir(path) {
    try {
      const entries = await invoke<DirEntry[]>('fs_list_dir', { path })
      return entries.map((entry) => entry.name)
    } catch {
      return []
    }
  }
}

export function scan(dirPath: string): Promise<ScanResult> {
  return scanWith(rustFs, dirPath)
}

/** 打包成功后要打开的产物目录；探测规则在 shared，这里只补上 Rust 侧的 fs */
export function outputDirOf(
  root: string,
  configured?: string
): Promise<{ dir: string; detected: boolean }> {
  return resolveWith(rustFs, root, configured)
}
