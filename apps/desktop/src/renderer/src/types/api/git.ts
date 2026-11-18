/**
 * `window.workbench` 上的一组通道：Git 页（只读、本地）。
 * 实现见 `workbench/git.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  GitAuthorList,
  GitBranchList,
  GitCommitDetail,
  GitCommitPage,
  GitCompare,
  GitPatch,
  GitRepoInfo,
  GitTreePage,
} from '../index'

export interface GitChannel {
  // ---------- Git 页（只读、本地：打开仓库 / 提交 / 文件历史 / 差异） ----------
  //
  // 与上面 projectGitLog 不是同一条：那一条按项目目录起算、只给「从提交生成」用；
  // 这一组按仓库根解释路径，还会读目录树与补丁。全部只跑读命令，不写仓库、不联网。
  /** 打开一个文件夹（返回仓库根；选中的是子目录时 scope 是它相对根的位置） */
  openGitRepo: (path: string) => Promise<Result<GitRepoInfo>>

  /** 本地分支清单（只用于看哪条分支的历史，不切工作区） */
  listGitBranches: (root: string) => Promise<Result<GitBranchList>>

  /** 当前分支上出现过的提交作者（按作者筛选下拉用；当前分支跟随 rev，空串 = HEAD） */
  listGitAuthors: (root: string, rev: string) => Promise<Result<GitAuthorList>>

  /** 一条分支（空串 = 当前分支）的提交列表；`since` / `until` 是 YYYY-MM-DD（空串 = 不限），`author` 是提交作者名（空串 = 不限），分页取 */
  listGitCommits: (root: string, rev: string, since: string, until: string, author: string, skip: number, limit: number) => Promise<Result<GitCommitPage>>

  /** 一条分支上一个文件的提交历史（不做 rename 跟踪：改名前的历史不显示；时间范围与作者筛选同上） */
  listGitFileCommits: (root: string, path: string, rev: string, since: string, until: string, author: string, skip: number, limit: number) => Promise<Result<GitCommitPage>>

  /** 一条分支上一个目录的内容（空串 = 根目录） */
  listGitTree: (root: string, dir: string, rev: string) => Promise<Result<GitTreePage>>

  /** 一个提交的元信息 + 改动文件清单 */
  loadGitCommit: (root: string, hash: string) => Promise<Result<GitCommitDetail>>

  /** 任意两个提交之间的改动文件清单 */
  compareGitCommits: (root: string, base: string, target: string) => Promise<Result<GitCompare>>

  /** 一个文件的补丁（base 为空串 = 根提交） */
  loadGitPatch: (root: string, base: string, target: string, path: string) => Promise<Result<GitPatch>>
}
