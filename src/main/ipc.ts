import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain } from 'electron'
import {
  IPC,
  type AddProjectInput,
  type AppSettings,
  type DataLocation,
  type DataLocationPick,
  type NodeCheckResult,
  type PackageManagerStatus,
  type Project,
  type ProjectGroup,
  type ProjectPatch,
  type Result,
  type RunRecord
} from '../shared/types'
import { satisfiesNodeVersion } from '../shared/node-version'
import { reorderById } from '../shared/reorder'
import { bumpDay, pruneDays } from '../shared/activity'
import { broadcast } from './broadcast'
import {
  activity,
  data,
  dataFileExistsIn,
  getDataLocation,
  migrateDataDir,
  save,
  settings
} from './store'
import { detectConfiguredOutputDir, isNonEmptyDir, scanProject } from './scanner'
import { ProcessManager, resolvePackageManager } from './process-manager'
import { findNodeDir, getNvmStatus, matchInstalledVersion } from './nvm'
import {
  checkPackageManagers,
  checkPort,
  killPortProcess,
  pickDirectory,
  reveal
} from './system'
import { updateAppSettings } from './app-settings'

const COMMON_OUTPUT_DIRS = ['dist', 'dist_electron', 'build', 'out']

/** 每个项目保留的执行记录条数 */
const HISTORY_LIMIT = 10

export const manager = new ProcessManager()

// ---------- 工具 ----------

function ok<T>(value: T): Result<T> {
  return { ok: true, data: value }
}

function fail<T>(error: string): Result<T> {
  return { ok: false, error }
}

function findProject(id: string): Project | undefined {
  return data().projects.find((p) => p.id === id)
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

function nowLabel(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/** 往某个项目的日志面板里补一条系统提示 */
function logTo(projectId: string, stream: 'sys' | 'err', text: string): void {
  broadcast(IPC.eventLog, { projectId, stream, text, time: nowLabel() })
}

/**
 * 打包产物目录（F-5.1 / F-5.2）：
 * 手动配置 > 构建配置里声明的 outDir > 常见目录名（存在且非空），都没有就回退项目根目录。
 */
async function resolveOutputDir(project: Project): Promise<{ dir: string; detected: boolean }> {
  const candidates: string[] = []
  if (project.outputDir) candidates.push(project.outputDir)

  const configured = await detectConfiguredOutputDir(project.path)
  if (configured) candidates.push(configured)

  candidates.push(...COMMON_OUTPUT_DIRS)

  for (const candidate of candidates) {
    const full = isAbsolute(candidate) ? candidate : join(project.path, candidate)
    if (await isNonEmptyDir(full)) return { dir: full, detected: true }
  }

  // 产物目录还没生成（例如首次打包失败），也不该让用户对着空目录发愣
  return { dir: project.path, detected: false }
}

let pmCache: { at: number; value: PackageManagerStatus } | null = null

async function pmStatus(): Promise<PackageManagerStatus> {
  if (pmCache && Date.now() - pmCache.at < 30_000) return pmCache.value
  const value = await checkPackageManagers()
  pmCache = { at: Date.now(), value }
  return value
}

async function ensurePackageManager(project: Project): Promise<string | null> {
  const pm = resolvePackageManager(project)
  const status = await pmStatus()
  if (!status[pm]) {
    return `未检测到 ${pm}，请先安装并确保它在系统 PATH 中`
  }
  return null
}

/** 「仅管理目录」的项目不允许执行任何命令 */
function ensureExecutable(project: Project): string | null {
  if (project.manageOnly) {
    return '该项目是「仅管理目录」，package.json 不可用，无法执行命令'
  }
  return null
}

/**
 * 项目指定了 nvm 的 Node 版本时，必须真的装在磁盘上。
 * 否则子进程会静默回退到系统 node，用户只会看到「命令跑了但版本不对」。
 */
function ensureNodeVersion(project: Project): string | null {
  const wanted = project.nodeVersion?.trim()
  if (!wanted) return null
  if (findNodeDir(wanted)) return null
  return `未在 nvm 中找到 Node v${wanted}，请在项目详情「环境」里重新选择`
}

// ---------- 子进程事件转发 ----------

manager.on('log', (payload) => broadcast(IPC.eventLog, payload))
manager.on('status', (payload) => broadcast(IPC.eventStatus, payload))
manager.on('terminal-open', (payload) => broadcast(IPC.eventTerminalOpen, payload))
manager.on('clear', (payload) => broadcast(IPC.eventClear, payload))

/**
 * 活跃子进程列表落盘：应用被强杀后，这些记录就是下次启动清理残留进程的依据（§7）。
 * 正常退出时 shutdown() 会逐个 finish，列表自然清空。
 */
manager.on('sessions-changed', () => {
  data().activeSessions = manager.liveSessions()
  save()
})

/**
 * 往当天的格子里记一次执行。
 *
 * 用命令开始的时间而不是结束时间：跨零点跑的构建，人是在前一天点的按钮。
 * 图只画最近一年，顺手裁掉更旧的计数，数据文件才不会跟着使用年限一直长。
 */
function recordActivity(timestamp?: number): void {
  const at = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now()
  data().activity = pruneDays(bumpDay(activity(), at), Date.now())
  save()
}

manager.on('run-finished', ({ projectId, record }: { projectId: string; record: RunRecord }) => {
  // 命令跑完了就算活跃，与结果无关，也与这个项目还在不在列表里无关
  recordActivity(record.startedAt)

  const project = findProject(projectId)
  if (!project) return

  project.history = [record, ...(project.history ?? [])].slice(0, HISTORY_LIMIT)
  save()
  broadcast(IPC.eventProjectChanged, project)
})

/** 记录最近使用时间，并让渲染进程拿到最新的排序依据 */
function touchProject(project: Project): void {
  project.lastUsedAt = Date.now()
  save()
  broadcast(IPC.eventProjectChanged, project)
}

manager.on('build-done', async ({ projectId }: { projectId: string }) => {
  const project = findProject(projectId)
  if (!project) return

  const { dir, detected } = await resolveOutputDir(project)
  if (!detected) {
    logTo(projectId, 'sys', '未探测到产物目录，已打开项目根目录')
  }

  if (!project.autoOpenExplorer) return

  try {
    await reveal(dir)
  } catch (err) {
    logTo(projectId, 'err', `打开目录失败：${(err as Error).message}`)
  }
})

/** dev server 就绪事件保留：日志里解析出的地址/端口仍会推到界面，但不再自动拉起浏览器 */
manager.on('server-ready', ({ projectId, url }: { projectId: string; url: string }) => {
  const project = findProject(projectId)
  if (!project) return
  logTo(projectId, 'sys', `服务地址 ${url}`)
})

/** 新增项目：校验目录、扫描 package.json、落盘 */
export async function addProject(input: AddProjectInput): Promise<Result<Project>> {
  if (!input || typeof input.path !== 'string') return fail('参数不合法')

  const dirPath = input.path.trim()
  if (!(await isDirectory(dirPath))) return fail('目录不存在或不是文件夹')
  if (data().projects.some((p) => p.path === dirPath)) return fail('该目录已经添加过了')

  const scan = await scanProject(dirPath)

  // 解析失败的 package.json 允许以「仅管理目录」的方式加入（设计文档 §7）
  if (!scan.ok && !scan.parseError) return fail(scan.error ?? '项目扫描失败')
  if (scan.parseError && input.allowInvalid !== true) {
    return fail(scan.error ?? 'package.json 解析失败')
  }

  const manageOnly = !scan.ok
  const buildList = Array.isArray(input.build) ? input.build : scan.build

  const project: Project = {
    id: randomUUID(),
    name: input.name?.trim() || scan.name,
    path: dirPath,
    packageManager: 'auto',
    detectedPackageManager: scan.detectedPackageManager,
    framework: scan.framework || 'Node',
    version: scan.version || '0.0.0',
    scripts: {
      serve: input.serve || scan.serve,
      build: manageOnly ? [] : buildList,
      defaultBuild: manageOnly ? undefined : input.defaultBuild || buildList[0]
    },
    outputDir: scan.outputDir ?? '',
    nodeRequirement: scan.enginesNode,
    autoOpenExplorer: true,
    manageOnly: manageOnly || undefined,
    groupId: input.groupId,
    order: data().projects.length,
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  }

  data().projects.push(project)
  save()
  return ok(project)
}

// ---------- IPC ----------

export function registerIpc(): void {
  ipcMain.handle(IPC.pickDirectory, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return pickDirectory(win)
  })

  ipcMain.handle(IPC.scanProject, async (_event, dirPath: string) => {
    if (typeof dirPath !== 'string' || !dirPath.trim()) return fail('目录路径为空')
    return ok(await scanProject(dirPath))
  })

  ipcMain.handle(IPC.listProjects, () => {
    const { projects, groups } = data()
    return { projects, groups }
  })

  ipcMain.handle(IPC.addProject, async (_event, input: AddProjectInput) => addProject(input))

  ipcMain.handle(
    IPC.updateProject,
    async (_event, id: string, patch: ProjectPatch): Promise<Result<Project>> => {
      const project = findProject(id)
      if (!project) return fail('项目不存在')

      if (typeof patch?.name === 'string' && patch.name.trim()) project.name = patch.name.trim()
      if (patch?.packageManager) project.packageManager = patch.packageManager
      if (patch?.scripts) {
        project.scripts = {
          ...project.scripts,
          ...patch.scripts,
          build: Array.isArray(patch.scripts.build) ? patch.scripts.build : project.scripts.build
        }
        if (!project.scripts.defaultBuild && project.scripts.build.length) {
          project.scripts.defaultBuild = project.scripts.build[0]
        }
      }
      if (typeof patch?.outputDir === 'string') project.outputDir = patch.outputDir
      if (typeof patch?.autoOpenExplorer === 'boolean') project.autoOpenExplorer = patch.autoOpenExplorer
      if ('nodeVersion' in (patch ?? {})) {
        const next = typeof patch.nodeVersion === 'string' ? patch.nodeVersion.trim() : ''
        project.nodeVersion = next || undefined
      }
      if ('groupId' in (patch ?? {})) project.groupId = patch.groupId

      save()
      return ok(project)
    }
  )

  ipcMain.handle(IPC.removeProject, async (_event, id: string): Promise<Result<null>> => {
    if (manager.isActive(id)) manager.stop(id)

    const index = data().projects.findIndex((p) => p.id === id)
    if (index === -1) return fail('项目不存在')

    data().projects.splice(index, 1)
    save()
    return ok(null)
  })

  ipcMain.handle(IPC.checkProjectPaths, async (): Promise<Record<string, boolean>> => {
    const entries = await Promise.all(
      data().projects.map(async (project) => [project.id, await isDirectory(project.path)] as const)
    )
    return Object.fromEntries(entries)
  })

  ipcMain.handle(IPC.activity, () => activity())

  ipcMain.handle(
    IPC.relocateProject,
    async (_event, id: string, newPath: string): Promise<Result<Project>> => {
      const project = findProject(id)
      if (!project) return fail('项目不存在')

      const target = typeof newPath === 'string' ? newPath.trim() : ''
      if (!(await isDirectory(target))) return fail('目录不存在或不是文件夹')
      if (data().projects.some((p) => p.id !== id && p.path === target)) {
        return fail('该目录已经被其他项目使用')
      }

      project.path = target

      // 重新识别，但用户手动配置过的命令与产物目录保持优先
      const scan = await scanProject(target)
      if (scan.ok) {
        project.detectedPackageManager = scan.detectedPackageManager
        project.framework = scan.framework
        project.version = scan.version
        project.nodeRequirement = scan.enginesNode
        if (!project.scripts.serve && scan.serve) project.scripts.serve = scan.serve
        if (!project.scripts.build.length && scan.build.length) {
          project.scripts.build = scan.build
          project.scripts.defaultBuild = scan.build[0]
        }
        if (!project.outputDir && scan.outputDir) project.outputDir = scan.outputDir
        // 新目录的 package.json 是好的，就解除「仅管理目录」
        if (project.manageOnly) project.manageOnly = undefined
      }

      save()
      return ok(project)
    }
  )

  ipcMain.handle(IPC.createGroup, async (_event, name: string): Promise<Result<ProjectGroup>> => {
    const trimmed = (name ?? '').trim()
    if (!trimmed) return fail('分组名不能为空')
    if (data().groups.some((g) => g.name === trimmed)) return fail('同名分组已存在')

    const group: ProjectGroup = { id: randomUUID(), name: trimmed, order: data().groups.length }
    data().groups.push(group)
    save()
    return ok(group)
  })

  // 拖动排序：按传入的 id 顺序重排，顺序即 order
  ipcMain.handle(
    IPC.reorderGroups,
    async (_event, ids: string[]): Promise<Result<ProjectGroup[]>> => {
      if (!Array.isArray(ids)) return fail('参数不合法')

      const ordered = reorderById(data().groups, ids)
      ordered.forEach((group, index) => {
        group.order = index
      })
      data().groups = ordered

      save()
      return ok(ordered)
    }
  )

  ipcMain.handle(
    IPC.renameGroup,
    async (_event, id: string, name: string): Promise<Result<ProjectGroup>> => {
      const group = data().groups.find((g) => g.id === id)
      if (!group) return fail('分组不存在')

      const trimmed = (name ?? '').trim()
      if (!trimmed) return fail('分组名不能为空')
      if (data().groups.some((g) => g.id !== id && g.name === trimmed)) {
        return fail('同名分组已存在')
      }

      group.name = trimmed
      save()
      return ok(group)
    }
  )

  ipcMain.handle(IPC.removeGroup, async (_event, id: string): Promise<Result<null>> => {
    const groups = data().groups
    const index = groups.findIndex((g) => g.id === id)
    if (index === -1) return fail('分组不存在')

    groups.splice(index, 1)
    for (const project of data().projects) {
      if (project.groupId === id) project.groupId = undefined
    }
    save()
    return ok(null)
  })

  ipcMain.handle(IPC.reveal, async (_event, targetPath: string): Promise<Result<null>> => {
    if (typeof targetPath !== 'string' || !targetPath.trim()) return fail('路径为空')
    try {
      await reveal(targetPath)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipcMain.handle(IPC.checkPackageManagers, () => checkPackageManagers())

  ipcMain.handle(IPC.checkPort, async (_event, port: number) => checkPort(Number(port)))

  ipcMain.handle(IPC.killPortProcess, async (_event, port: number): Promise<Result<null>> => {
    try {
      await killPortProcess(Number(port))
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipcMain.handle(IPC.checkNodeVersion, async (_event, id: string): Promise<NodeCheckResult> => {
    const project = findProject(id)

    // 项目选定了 nvm 版本时，真正生效的是它；没选才轮到系统 PATH 里的 node
    const status = await pmStatus()
    const systemNode = (status.node || process.versions.node).replace(/^v/, '')
    const selected = project?.nodeVersion?.trim()
    const actual = selected
      ? matchInstalledVersion(selected, getNvmStatus().versions) ?? selected
      : systemNode
    const source: NodeCheckResult['source'] = selected ? 'project' : 'system'

    const required = project?.nodeRequirement?.trim()
    if (!required) return { actual, source, ok: true }
    return { required, actual, source, ok: satisfiesNodeVersion(required, actual) }
  })

  // 只读探测 nvm：已安装版本、当前软链指向的版本（切换靠项目级注入 PATH，不改全局）
  ipcMain.handle(IPC.nvmStatus, () => getNvmStatus())

  // ---------- 设置 ----------

  ipcMain.handle(IPC.getSettings, () => settings())

  ipcMain.handle(
    IPC.updateSettings,
    async (_event, patch: Partial<AppSettings>): Promise<Result<AppSettings>> => {
      if (!patch || typeof patch !== 'object') return fail('参数不合法')
      return ok(updateAppSettings(patch))
    }
  )

  // ---------- 进程操作 ----------

  ipcMain.handle(IPC.install, async (_event, id: string): Promise<Result<null>> => {
    const project = findProject(id)
    if (!project) return fail('项目不存在')
    if (manager.isActive(id)) return fail('该项目已有命令在执行中')

    const guard = ensureExecutable(project)
    if (guard) return fail(guard)

    const nodeGuard = ensureNodeVersion(project)
    if (nodeGuard) return fail(nodeGuard)

    const pmError = await ensurePackageManager(project)
    if (pmError) return fail(pmError)

    const error = manager.install(project)
    if (error) return fail(error)

    touchProject(project)
    return ok(null)
  })

  ipcMain.handle(IPC.start, async (_event, id: string): Promise<Result<null>> => {
    const project = findProject(id)
    if (!project) return fail('项目不存在')
    if (manager.isActive(id)) return fail('该项目已有命令在执行中')

    const guard = ensureExecutable(project)
    if (guard) return fail(guard)

    const nodeGuard = ensureNodeVersion(project)
    if (nodeGuard) return fail(nodeGuard)

    const script = project.scripts.serve
    if (!script) return fail('未配置启动命令，请在项目详情中选择')

    const pmError = await ensurePackageManager(project)
    if (pmError) return fail(pmError)

    const error = manager.start(project, script)
    if (error) return fail(error)

    touchProject(project)
    return ok(null)
  })

  ipcMain.handle(IPC.build, async (_event, id: string, script: string): Promise<Result<null>> => {
    const project = findProject(id)
    if (!project) return fail('项目不存在')
    if (manager.isActive(id)) return fail('该项目已有命令在执行中')

    const guard = ensureExecutable(project)
    if (guard) return fail(guard)

    const nodeGuard = ensureNodeVersion(project)
    if (nodeGuard) return fail(nodeGuard)

    const target = script || project.scripts.defaultBuild || project.scripts.build[0]
    if (!target) return fail('未配置打包命令，请在项目详情中选择')

    const pmError = await ensurePackageManager(project)
    if (pmError) return fail(pmError)

    const error = manager.build(project, target)
    if (error) return fail(error)

    touchProject(project)
    return ok(null)
  })

  ipcMain.handle(IPC.runCustom, async (_event, id: string, index: number): Promise<Result<null>> => {
    const project = findProject(id)
    if (!project) return fail('项目不存在')
    if (manager.isActive(id)) return fail('该项目已有命令在执行中')

    const guard = ensureExecutable(project)
    if (guard) return fail(guard)

    const nodeGuard = ensureNodeVersion(project)
    if (nodeGuard) return fail(nodeGuard)

    const list = project.scripts.custom ?? []
    const position = Number(index)
    const target = list[position]
    if (!target) return fail('自定义命令不存在')

    const error = manager.runCustom(project, target.command, position, target.name)
    if (error) return fail(error)

    touchProject(project)
    return ok(null)
  })

  ipcMain.handle(IPC.stop, async (_event, id: string): Promise<Result<null>> => {
    if (!manager.isActive(id)) return fail('该项目没有正在运行的进程')
    manager.stop(id)
    return ok(null)
  })

  // ---------- 数据存储位置 ----------

  ipcMain.handle(IPC.getDataLocation, () => getDataLocation())

  ipcMain.handle(IPC.pickDataDir, async (event): Promise<DataLocationPick> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dir = await pickDirectory(win, '选择 Workbench 数据目录')
    if (!dir) return { dir: null, conflict: false }
    return { dir, conflict: dataFileExistsIn(dir) }
  })

  ipcMain.handle(IPC.migrateDataDir, async (_event, dir: string): Promise<Result<DataLocation>> => {
    if (typeof dir !== 'string' || !dir.trim()) return fail('目录为空')
    if (manager.activeProjectIds().length > 0) {
      return fail('还有项目在运行，请先全部停止再迁移数据')
    }

    try {
      await migrateDataDir(dir)
      // 数据文件换了位置，渲染层需要整份重新加载
      broadcast(IPC.eventDataReload, null)
      return ok(getDataLocation())
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
