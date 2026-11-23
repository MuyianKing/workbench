/**
 * `window.workbench` 上的一组通道：项目、分组、快捷启动与命令。
 * 实现见 `workbench/api-project.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type {
  AddProjectInput,
  CommandEntry,
  CommandInput,
  CommandPatch,
  Project,
  ProjectGitPull,
  ProjectGroup,
  ProjectPatch,
  QuickApp,
  QuickAppInput,
  QuickAppList,
  QuickAppPatch,
  ScanResult,
} from '../index'

export interface ProjectChannel {
  scanProject: (dirPath: string) => Promise<Result<ScanResult>>

  listProjects: () => Promise<Result<{ projects: Project[], groups: ProjectGroup[] }>>

  addProject: (input: AddProjectInput) => Promise<Result<Project>>

  updateProject: (id: string, patch: ProjectPatch) => Promise<Result<Project>>

  removeProject: (id: string) => Promise<Result<null>>

  /** 目录被移动或删除后重新绑定路径 */
  relocateProject: (id: string, newPath: string) => Promise<Result<Project>>

  /** 检查所有项目目录是否仍然存在，返回 项目 ID -> 是否有效 */
  checkProjectPaths: () => Promise<Result<Record<string, boolean>>>

  /**
   * 项目卡的 git pull：用户点它才在项目目录里跑一次 `git pull --ff-only`。
   * 返回当前分支与「有没有拉到新提交」；失败原样带回 git 的话（不是仓库 / 分叉 / 有未提交改动）。
   */
  pullProjectGit: (dir: string) => Promise<Result<ProjectGitPull>>

  createGroup: (name: string) => Promise<Result<ProjectGroup>>

  renameGroup: (id: string, name: string) => Promise<Result<ProjectGroup>>

  removeGroup: (id: string) => Promise<Result<null>>

  /** 按给定顺序重排分组（拖动排序） */
  reorderGroups: (ids: string[]) => Promise<Result<ProjectGroup[]>>

  /** 快捷启动：列表 + 哪些程序已经不在原路径上了 */
  listQuickApps: () => Promise<Result<QuickAppList>>

  /** 挑一个要启动的程序（.exe / 快捷方式…），取消返回 null */
  pickQuickTarget: () => Promise<string | null>

  addQuickApp: (input: QuickAppInput) => Promise<Result<QuickApp>>

  updateQuickApp: (id: string, patch: QuickAppPatch) => Promise<Result<QuickApp>>

  removeQuickApp: (id: string) => Promise<Result<null>>

  /** 按给定顺序重排快捷启动项（拖动排序） */
  reorderQuickApps: (ids: string[]) => Promise<Result<QuickApp[]>>

  /** 启动一个常用软件；程序被移动或删除时返回失败原因 */
  launchQuickApp: (id: string) => Promise<Result<null>>

  /** 取程序的系统图标（主进程转成 data URL，取不到时用首字母兜底） */
  quickAppIcon: (target: string) => Promise<Result<string>>

  /** 首页「命令」卡片：独立于项目的一批命令 */
  listCommands: () => Promise<Result<CommandEntry[]>>

  addCommand: (input: CommandInput) => Promise<Result<CommandEntry>>

  updateCommand: (id: string, patch: CommandPatch) => Promise<Result<CommandEntry>>

  removeCommand: (id: string) => Promise<Result<null>>

  onProjectChanged: (fn: (project: Project) => void) => () => void

  /** 快捷启动列表被主进程改过（启动一次会刷新最近使用时间），整份推过来 */
  onQuickApps: (fn: (payload: QuickAppList) => void) => () => void
}
