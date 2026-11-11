/**
 * Git 页的数据形状：宿主（`repo_git.rs`）返回什么、渲染层吃什么。
 *
 * 这里只有「读」：仓库信息、提交、目录树、文件历史、两个提交之间的改动与单文件补丁。
 * 没有暂存 / 提交 / 分支这些写操作的类型 —— Git 页是只读浏览器（见 docs/modules/git-client.md）。
 *
 * 时间一律是**毫秒**（宿主把 git 的 `%at` 秒换成毫秒再回来），与全应用其余时间字段一致。
 */

export interface GitRepoInfo {
  /** 仓库根目录（git 的 `--show-toplevel`，可能和用户选中的子目录不同） */
  root: string
  /** 根目录的末段，界面上显示的名字 */
  name: string
  /** 当前 HEAD 的完整提交号；空仓库时为空串 */
  head: string
  /** 短提交号（7 位左右）；空仓库时为空串 */
  shortHead: string
  /** 当前分支名；detached HEAD 时是 `HEAD`，空仓库时为空串 */
  branch: string
  /** HEAD 是否处于 detached 状态 */
  detached: boolean
  /** 还没有第一次提交（仍可打开，只是没有历史与目录树） */
  empty: boolean
}

export interface GitCommit {
  hash: string
  /** 作者时间（毫秒） */
  time: number
  author: string
  authorEmail: string
  /** 父提交；根提交是空数组，合并提交有两个以上 */
  parents: string[]
  /** `%D` 带的引用（分支 / 标签），空串表示没有 */
  refs: string
  subject: string
}

export interface GitCommitPage {
  commits: GitCommit[]
  hasMore: boolean
}

export type GitTreeEntryType = 'dir' | 'file' | 'symlink' | 'submodule'

export interface GitTreeEntry {
  name: string
  /** 仓库内相对路径（`/` 分隔） */
  path: string
  type: GitTreeEntryType
  /** 文件字节数；目录 / 子模块为 0 */
  size: number
}

export interface GitTreePage {
  entries: GitTreeEntry[]
  /** 单个目录太大，只回了前一部分 */
  truncated: boolean
}

/** git 的 name-status 首字母：新增 / 修改 / 删除 / 重命名 / 复制 / 类型变化 */
export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | string

export interface GitChangedFile {
  path: string
  status: GitFileStatus
  added: number
  deleted: number
  /** 二进制文件：行数没有意义，界面显示「二进制」 */
  binary: boolean
}

export interface GitCommitDetail {
  hash: string
  time: number
  author: string
  authorEmail: string
  parents: string[]
  /** 完整提交说明（标题 + 正文） */
  body: string
  /** 第一行标题；空提交说明时为空串 */
  subject: string
  isMerge: boolean
  isRoot: boolean
  /** 对比的基准提交；根提交为空串 */
  base: string
  files: GitChangedFile[]
  filesTruncated: boolean
}

export interface GitCompare {
  base: string
  target: string
  files: GitChangedFile[]
  filesTruncated: boolean
}

export interface GitPatch {
  /** `git diff -U3` 输出的原文；二进制 / 过大时为空串 */
  patch: string
  binary: boolean
  /** 单侧文件超过上限，宿主没有取补丁 */
  tooLarge: boolean
  /** 文件内容不是 UTF-8，补丁里的非 UTF-8 字节被替换成了 � */
  lossy: boolean
  /** 补丁过长，宿主截断过 */
  truncated: boolean
}
