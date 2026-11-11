import type { GitCommitDetail, GitCommitPage, GitCompare, GitPatch, GitRepoInfo, GitTreePage } from '@workbench/git'
import type { Result } from '@/types'
import { fail, ok } from '@workbench/core'
import { parseCommitDetail, parseCommitPage, parseCompare, parseGitPatch, parseRepoInfo, parseTreePage } from '@workbench/git'
import { errorText, invoke } from './bridge'

/**
 * Git 页的通道：**只读、本地**。
 *
 * 宿主侧只跑 `rev-parse` / `log` / `ls-tree` / `show` / `diff` / `cat-file -s`，
 * 一个字节都不写仓库、不联网（见 repo_git.rs 与 docs/modules/git-client.md）。
 * 与工作日志的 `projectGitLog` 不是同一条：那一条按项目目录起算、只给「从提交生成」用。
 *
 * 每个返回值都经 `@workbench/git` 的 parse 再收一遍：手改过的数据、将来字段改名
 * 都不该把界面弄崩；解析不出来就按失败返回，而不是把半个对象递上去。
 */

export async function openRepo(path: string): Promise<Result<GitRepoInfo>> {
  try {
    const info = parseRepoInfo(await invoke<unknown>('repo_git_open', { path }))
    return info ? ok(info) : fail('读取仓库信息失败')
  }
  catch (error) {
    return fail(errorText(error, '打开仓库失败'))
  }
}

export async function listCommits(
  root: string,
  skip: number,
  limit: number,
): Promise<Result<GitCommitPage>> {
  try {
    return ok(parseCommitPage(await invoke<unknown>('repo_git_commits', { root, skip, limit })))
  }
  catch (error) {
    return fail(errorText(error, '读取提交记录失败'))
  }
}

export async function listFileCommits(
  root: string,
  path: string,
  skip: number,
  limit: number,
): Promise<Result<GitCommitPage>> {
  try {
    return ok(parseCommitPage(
      await invoke<unknown>('repo_git_file_commits', { root, path, skip, limit }),
    ))
  }
  catch (error) {
    return fail(errorText(error, '读取文件历史失败'))
  }
}

export async function listTree(
  root: string,
  dir: string,
): Promise<Result<GitTreePage>> {
  try {
    return ok(parseTreePage(await invoke<unknown>('repo_git_tree', { root, dir })))
  }
  catch (error) {
    return fail(errorText(error, '读取目录失败'))
  }
}

export async function loadCommit(root: string, hash: string): Promise<Result<GitCommitDetail>> {
  try {
    const detail = parseCommitDetail(await invoke<unknown>('repo_git_commit', { root, hash }))
    return detail ? ok(detail) : fail('读取提交详情失败')
  }
  catch (error) {
    return fail(errorText(error, '读取提交详情失败'))
  }
}

export async function compareCommits(
  root: string,
  base: string,
  target: string,
): Promise<Result<GitCompare>> {
  try {
    const result = parseCompare(await invoke<unknown>('repo_git_compare', { root, base, target }))
    return result ? ok(result) : fail('对比提交失败')
  }
  catch (error) {
    return fail(errorText(error, '对比提交失败'))
  }
}

export async function loadPatch(
  root: string,
  base: string,
  target: string,
  path: string,
): Promise<Result<GitPatch>> {
  try {
    return ok(parseGitPatch(await invoke<unknown>('repo_git_patch', { root, base, target, path })))
  }
  catch (error) {
    return fail(errorText(error, '读取文件差异失败'))
  }
}
