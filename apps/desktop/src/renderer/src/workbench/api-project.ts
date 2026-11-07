import type { AddProjectInput, CommandEntry, Project, Result, TerminalKind, WorkbenchApi } from '@/types'
import { fail, nextProjectColor, ok, samePath } from '@workbench/core'
import { openDialog } from './api-system'
import { guard, invoke } from './bridge'
import { emit } from './events'
import * as quick from './quick-launch'
import * as scanner from './scanner'
import * as session from './session'
import * as state from './state'

/**
 * 项目这一侧的通道：项目 CRUD、分组、快捷启动、独立命令，以及进程十件事。
 *
 * 「起什么命令由这一层决定（后端只认整行命令）」——所以项目 / 命令的查找
 * （withProject / withCommand）也必须在这一层，后端拿不到这份数据。
 */

/** 起命令要先找到对象：命令构造在这一层，后端拿不到项目/命令数据 */
function withProject(
  id: string,
  task: (project: Project) => Promise<Result<null>>,
): Promise<Result<null>> {
  const project = state.projects().find(item => item.id === id)
  return project ? task(project) : Promise.resolve(fail('找不到该项目'))
}

function withCommand(
  id: string,
  task: (entry: CommandEntry) => Promise<Result<null>>,
): Promise<Result<null>> {
  const entry = state.commandList().find(item => item.id === id)
  return entry ? task(entry) : Promise.resolve(fail('找不到该命令'))
}

export const projectApi = {
  // ---------- 项目 ----------
  scanProject: (dirPath: string) =>
    guard(Promise.resolve(scanner.scan(dirPath)), '扫描项目失败'),

  /**
   * 新增项目：校验目录 → 扫描 package.json → 组装并落盘。
   * 组装规则照着 Electron 版 ipc.ts 的 addProject 搬过来（含「仅管理目录」那条分支）。
   */
  addProject: async (input: AddProjectInput): Promise<Result<Project>> => {
    if (!input || typeof input.path !== 'string')
      return fail('参数不合法')

    const dirPath = input.path.trim()
    if (!(await invoke<boolean>('fs_is_dir', { path: dirPath }))) {
      return fail('目录不存在或不是文件夹')
    }

    // 界面已经拦过一次，这里是兜底：路径写法不同（盘符大小写、斜杠方向）也算同一个目录
    const existing = state.projects().find(project => samePath(project.path, dirPath))
    if (existing)
      return fail(`该目录已经添加过了（「${existing.name}」）`)

    const scan = await scanner.scan(dirPath)

    // 解析失败的 package.json 允许以「仅管理目录」的方式加入（设计文档 §7）
    if (!scan.ok && !scan.parseError)
      return fail(scan.error ?? '项目扫描失败')
    if (scan.parseError && input.allowInvalid !== true) {
      return fail(scan.error ?? 'package.json 解析失败')
    }

    const manageOnly = !scan.ok
    const buildList = Array.isArray(input.build) ? input.build : scan.build

    const project: Project = {
      id: crypto.randomUUID(),
      name: input.name?.trim() || scan.name,
      path: dirPath,
      // 标识色：自动取一个当前用得最少的颜色，前五个项目因此两两不同（见 packages/core/src/project-color.ts）
      color: nextProjectColor(state.projects().map(item => item.color)),
      packageManager: 'auto',
      detectedPackageManager: scan.detectedPackageManager,
      framework: scan.framework || 'Node',
      version: scan.version || '0.0.0',
      scripts: {
        serve: input.serve || scan.serve,
        build: manageOnly ? [] : buildList,
        defaultBuild: manageOnly ? undefined : input.defaultBuild || buildList[0],
      },
      outputDir: scan.outputDir ?? '',
      nodeRequirement: scan.enginesNode,
      autoOpenExplorer: true,
      manageOnly: manageOnly || undefined,
      // 首页展示：只有界面明确勾了才写 true —— 缺省与老项目都是不展示（见 Project.home）
      home: input.home === true || undefined,
      groupId: input.groupId,
      order: state.projects().length,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    }

    state.addProject(project)
    emit('projectChanged', project)
    return ok(project)
  },

  listProjects: () => Promise.resolve(state.listProjects()),
  updateProject: (id: string, patch: Parameters<WorkbenchApi['updateProject']>[1]) =>
    guard(Promise.resolve(state.updateProject(id, patch)), '更新项目失败'),
  removeProject: (id: string) => {
    state.removeProject(id)
    return Promise.resolve(ok(null))
  },
  relocateProject: (id: string, newPath: string) =>
    guard(Promise.resolve(state.relocateProject(id, newPath)), '重新绑定路径失败'),
  checkProjectPaths: () => state.checkProjectPaths(),

  // ---------- 分组 ----------
  createGroup: (name: string) =>
    guard(Promise.resolve(state.createGroup(name)), '创建分组失败'),
  renameGroup: (id: string, name: string) =>
    guard(Promise.resolve(state.renameGroup(id, name)), '重命名分组失败'),
  removeGroup: (id: string) => {
    state.removeGroup(id)
    return Promise.resolve(ok(null))
  },
  reorderGroups: (ids: string[]) =>
    guard(Promise.resolve(state.reorderGroups(ids)), '重排分组失败'),

  // ---------- 快捷启动 ----------
  // 这几个是数组 / 对象形状的取值接口，必须真实现：落到「未移植」兜底会返回 Result 对象，
  // 而 store 会当数组遍历，直接抛错并把整条 init() 打断（系统状态探测就因此一直没跑起来）。
  listQuickApps: () => state.quickAppList(),
  pickQuickTarget: () =>
    openDialog({
      directory: false,
      multiple: false,
      title: '选择要启动的程序',
      filters: [
        { name: '程序', extensions: ['exe', 'lnk', 'bat', 'cmd'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    }),
  addQuickApp: (input: Parameters<WorkbenchApi['addQuickApp']>[0]) =>
    guard(Promise.resolve(state.addQuickApp(input)), '添加快捷启动失败'),
  updateQuickApp: (id: string, patch: Parameters<WorkbenchApi['updateQuickApp']>[1]) =>
    guard(Promise.resolve(state.updateQuickApp(id, patch)), '更新快捷启动失败'),
  removeQuickApp: (id: string) => {
    state.removeQuickApp(id)
    return Promise.resolve(ok(null))
  },
  reorderQuickApps: (ids: string[]) =>
    guard(Promise.resolve(state.reorderQuickApps(ids)), '重排快捷启动失败'),

  /** 启动：走 ShellExecute，进程不归 Workbench 管 */
  launchQuickApp: (id: string) => quick.launch(id),

  /** 取程序图标（data URL）；取不到就失败，界面用首字母兜底 */
  quickAppIcon: (target: string) => quick.icon(target),

  // ---------- 独立命令 ----------
  listCommands: () => Promise.resolve(state.commandList()),
  addCommand: (input: Parameters<WorkbenchApi['addCommand']>[0]) =>
    guard(Promise.resolve(state.addCommand(input)), '添加命令失败'),
  updateCommand: (id: string, patch: Parameters<WorkbenchApi['updateCommand']>[1]) =>
    guard(Promise.resolve(state.updateCommand(id, patch)), '更新命令失败'),
  removeCommand: (id: string) => {
    state.removeCommand(id)
    return Promise.resolve(ok(null))
  },

  // ---------- 进程：项目十件事 ----------
  // 起什么命令由这里决定（后端只认整行命令），所以项目查找也要在这一层做
  install: (id: string) => withProject(id, project => session.installProject(project)),
  start: (id: string) => withProject(id, project => session.startProject(project)),
  build: (id: string, script: string) =>
    withProject(id, project => session.buildProject(project, script)),
  runCustom: (id: string, index: number) =>
    withProject(id, project => session.runCustom(project, index)),
  stop: (id: string, kind?: TerminalKind) => session.stopOwner(id, kind),
  startCommand: (id: string) => withCommand(id, entry => session.startCommand(entry)),
  stopCommand: (id: string) => session.stopCommand(id),
} as Partial<WorkbenchApi>
