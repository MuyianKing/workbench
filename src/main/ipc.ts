import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain } from 'electron'
import {
  IPC,
  type AddProjectInput,
  type InstallablePackageManager,
  type NodeCheckResult,
  type PackageManagerStatus,
  type PortCheckResult,
  type Project,
  type ProjectGroup,
  type ProjectPatch,
  type Result,
  type RunRecord,
  type TokenUsageResult
} from '../shared/types'
import { satisfiesNodeVersion } from '../shared/node-version'
import { fail, ok, toResult } from '../shared/result'
import { parsePort } from '../shared/port'
import { samePath } from '../shared/project-path'
import { reorderById } from '../shared/reorder'
import { bumpDay, pruneDays } from '../shared/activity'
import { broadcast } from './broadcast'
import { activity, data, save } from './store'
import { detectOutputDir, isNonEmptyDir, scanProject } from './scanner'
import { isDirectory } from './fs-util'
import { resolvePackageManager } from './process-manager'
import { findNodeDir, getNvmStatus, matchInstalledVersion } from './nvm'
import {
  checkPackageManagers,
  checkPort,
  installPackageManager,
  killPortProcess,
  openExternal,
  pickDirectory,
  reveal
} from './system'
import { manager } from './manager'
import { getTokenUsage } from './token-usage'
import { registerCommandsIpc } from './handlers/commands'
import { registerQuickIpc } from './handlers/quick'
import { registerSettingsIpc } from './handlers/settings'
import { registerWindowIpc } from './handlers/window'

/** 每个项目保留的执行记录条数 */
const HISTORY_LIMIT = 10

// ---------- 工具 ----------

function findProject(id: string): Project | undefined {
  return data().projects.find((p) => p.id === id)
}

function nowLabel(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/** 往某个项目的日志面板里补一条系统提示 */
function logTo(
  projectId: string,
  terminal: string,
  stream: 'sys' | 'err',
  text: string
): void {
  broadcast(IPC.eventLog, { terminal, projectId, stream, text, time: nowLabel() })
}

/**
 * 打包产物目录（F-5.1 / F-5.2）：
 * 手动配置 > 构建配置里声明的 outDir > 常见目录名（存在且非空），都没有就回退项目根目录。
 */
async function resolveOutputDir(project: Project): Promise<{ dir: string; detected: boolean }> {
  // 手动配置优先：可能是绝对路径，也可能是相对项目根
  if (project.outputDir) {
    const full = isAbsolute(project.outputDir)
      ? project.outputDir
      : join(project.path, project.outputDir)
    if (await isNonEmptyDir(full)) return { dir: full, detected: true }
  }

  // 其余交给 scanner：构建配置里声明的 outDir 与常见目录名，候选清单只有一份
  const found = await detectOutputDir(project.path)
  if (found) {
    return { dir: isAbsolute(found) ? found : join(project.path, found), detected: true }
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

/** 找到项目，找不到就返回一句可以直接回给渲染层的错误 */
function findProjectOrFail(id: string): { project: Project } | { error: string } {
  const project = findProject(id)
  return project ? { project } : { error: '项目不存在' }
}

/**
 * 「安装 / 启动 / 打包 / 自定义命令」共用的前置检查。
 *
 * 四个 handler 原先各抄一遍同样的四到五步（项目存在 → 无进行中命令 → 可执行 →
 * Node 版本 → 包管理器），新增一项检查就得改四处、很容易漏。收成一个入口后，
 * 各 handler 只负责自己那条脚本的额外校验。
 */
async function prepareRun(
  id: string,
  options: { requirePackageManager?: boolean } = {}
): Promise<{ project: Project } | { error: string }> {
  const found = findProjectOrFail(id)
  if ('error' in found) return found

  const { project } = found
  if (manager.isActive(id)) return { error: '该项目已有命令在执行中' }

  const executable = ensureExecutable(project)
  if (executable) return { error: executable }

  const nodeVersion = ensureNodeVersion(project)
  if (nodeVersion) return { error: nodeVersion }

  if (options.requirePackageManager !== false) {
    const pmError = await ensurePackageManager(project)
    if (pmError) return { error: pmError }
  }

  return { project }
}


// ---------- 子进程事件：需要落盘 / 查数据的部分 ----------
// 纯广播部分（log / status / terminal-open / clear）由 manager.ts 自己接线。

/**
 * 活跃子进程列表落盘：应用被强杀后，这些记录就是下次启动清理残留进程的依据（§7）。
 * 正常退出时 shutdown() 会逐个 finish，列表自然清空。
 */
manager.on('sessions-changed', () => {
  data().activeSessions = manager.liveSessions()
  save()
})

/**
 * 用户每点一次「启动」或「打包」，就往当天的格子里记一次。
 *
 * 只认这两种主动操作：安装依赖、自定义命令，以及停止 / 强制结束 / 启动失败都不算 ——
 * 图回答的是「主动跑了多少次」，不是「进程收尾了几次」。
 * 图只画最近一年，顺手裁掉更旧的计数，数据文件才不会跟着使用年限一直长。
 */
function recordActivity(): void {
  data().activity = pruneDays(bumpDay(activity(), Date.now()), Date.now())
  save()
}

manager.on('run-finished', ({ projectId, record }: { projectId: string; record: RunRecord }) => {
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

manager.on('build-done', async ({ projectId, terminal }: { projectId: string; terminal: string }) => {
  const project = findProject(projectId)
  if (!project) return

  const { dir, detected } = await resolveOutputDir(project)
  if (!detected) {
    logTo(projectId, terminal, 'sys', '未探测到产物目录，已打开项目根目录')
  }

  if (!project.autoOpenExplorer) return

  try {
    await reveal(dir)
  } catch (err) {
    logTo(projectId, terminal, 'err', `打开目录失败：${(err as Error).message}`)
  }
})



/** 新增项目：校验目录、扫描 package.json、落盘 */
export async function addProject(input: AddProjectInput): Promise<Result<Project>> {
  if (!input || typeof input.path !== 'string') return fail('参数不合法')

  const dirPath = input.path.trim()
  if (!(await isDirectory(dirPath))) return fail('目录不存在或不是文件夹')

  // 界面上已经拦过一次，这里是兜底：路径写法不同（盘符大小写、斜杠方向）也算同一个目录
  const existing = data().projects.find((p) => samePath(p.path, dirPath))
  if (existing) return fail(`该目录已经添加过了（「${existing.name}」）`)

  const scan = await scanProject(dirPath)

  // 解析失败的 package.json 允许以「仅管理目录」的方式加入（设计文档 §7）
  if (!scan.ok && !scan.parseError) return fail(scan.error ?? '项目扫描失败')
  if (scan.parseError && input.allowInvalid !== true) {
    return fail(scan.error ?? 'package.json 解析失败')
  }

  const manageOnly = !scan.ok
  const buildList = Array.isArray(input.build) ? input.build : scan.build
  // 界面上传了端口就用它（用户可能改过或清空），没传才回退到自动识别的结果
  const port = 'port' in input ? parsePort(input.port) : parsePort(scan.port)

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
    port,
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
      const found = findProjectOrFail(id)
      if ('error' in found) return fail(found.error)
      const { project } = found

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
      if ('port' in (patch ?? {})) project.port = parsePort(patch.port)
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

  // Token 用量:实读各 AI 工具本地库并合并进快照,失败来源带原因(数据回退快照),不抛错
  ipcMain.handle(IPC.tokenUsage, (): Promise<Result<TokenUsageResult>> =>
    toResult(async () => getTokenUsage())
  )

  ipcMain.handle(
    IPC.relocateProject,
    async (_event, id: string, newPath: string): Promise<Result<Project>> => {
      const found = findProjectOrFail(id)
      if ('error' in found) return fail(found.error)
      const { project } = found

      const target = typeof newPath === 'string' ? newPath.trim() : ''
      if (!(await isDirectory(target))) return fail('目录不存在或不是文件夹')
      if (data().projects.some((p) => p.id !== id && samePath(p.path, target))) {
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
        if (!project.port && scan.port) project.port = scan.port
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
    return toResult(async () => {
      await reveal(targetPath)
      return null
    })
  })

  ipcMain.handle(IPC.openExternal, async (_event, url: string): Promise<Result<null>> => {
    if (typeof url !== 'string' || !url.trim()) return fail('链接为空')
    return toResult(async () => {
      await openExternal(url)
      return null
    })
  })

  ipcMain.handle(IPC.checkPackageManagers, () => checkPackageManagers())

  ipcMain.handle(
    IPC.installPackageManager,
    async (_event, pm: InstallablePackageManager): Promise<Result<PackageManagerStatus>> => {
      if (pm !== 'yarn' && pm !== 'pnpm') return fail('暂不支持安装该包管理器')

      const result = await installPackageManager(pm, (text) =>
        broadcast(IPC.eventPmInstallLog, { pm, text })
      )

      // 装完（或装失败）都重探一次：既顶掉 30 秒缓存，也顺便把 PATH 里新出现的东西认出来。
      // 探测结果无论如何都跟着返回，界面不用再多跑一次往返。
      pmCache = null
      const status = await pmStatus()

      if (!result.ok) return fail(result.error ?? `${pm} 安装失败`)
      if (!status[pm]) {
        return fail(`安装已结束，但 ${pm} 仍不可用，请确认 npm 的全局目录在系统 PATH 中`)
      }
      return ok(status)
    }
  )

  ipcMain.handle(IPC.checkPort, async (_event, port: number): Promise<PortCheckResult> => {
    // 这个通道按约定直接回 PortCheckResult（渲染层读 check.inUse），不是 Result。
    // 非法端口不能交给 net.connect —— 它会同步抛 RangeError 让 invoke reject，
    // 这里退化成「未占用」，与「不知道端口就不检测」的既有策略一致。
    const parsed = parsePort(port)
    if (parsed === undefined) return { port: 0, inUse: false }
    return checkPort(parsed)
  })

  ipcMain.handle(IPC.killPortProcess, async (_event, port: number): Promise<Result<null>> =>
    toResult(async () => {
      await killPortProcess(Number(port))
      return null
    })
  )

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

  // ---------- 设置 / 首页布局 / 壁纸 / 数据位置 ----------
  // 这些通道只碰配置层，注册逻辑在 ipc/settings.ts

  registerSettingsIpc()

  // ---------- 进程操作 ----------

  ipcMain.handle(IPC.install, async (_event, id: string): Promise<Result<null>> => {
    const prepared = await prepareRun(id)
    if ('error' in prepared) return fail(prepared.error)

    const error = manager.install(prepared.project)
    if (error) return fail(error)

    touchProject(prepared.project)
    return ok(null)
  })

  ipcMain.handle(IPC.start, async (_event, id: string): Promise<Result<null>> => {
    const prepared = await prepareRun(id)
    if ('error' in prepared) return fail(prepared.error)
    const { project } = prepared

    const script = project.scripts.serve
    if (!script) return fail('未配置启动命令，请在项目详情中选择')

    const error = manager.start(project, script)
    if (error) return fail(error)

    recordActivity()
    touchProject(project)
    return ok(null)
  })

  ipcMain.handle(IPC.build, async (_event, id: string, script: string): Promise<Result<null>> => {
    const prepared = await prepareRun(id)
    if ('error' in prepared) return fail(prepared.error)
    const { project } = prepared

    const target = script || project.scripts.defaultBuild || project.scripts.build[0]
    if (!target) return fail('未配置打包命令，请在项目详情中选择')

    const error = manager.build(project, target)
    if (error) return fail(error)

    recordActivity()
    touchProject(project)
    return ok(null)
  })

  ipcMain.handle(IPC.runCustom, async (_event, id: string, index: number): Promise<Result<null>> => {
    // 自定义命令是一整行原文，不依赖包管理器，因此跳过那一项检查
    const prepared = await prepareRun(id, { requirePackageManager: false })
    if ('error' in prepared) return fail(prepared.error)
    const { project } = prepared

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

  // ---------- 快捷启动（常用软件） ----------
  // 与项目命令是两套独立模型，注册逻辑在 ipc/quick.ts

  registerQuickIpc()

  // ---------- 首页「命令」卡片 ----------
  // 与项目命令是两套独立模型（没有目录 / 包管理器 / 脚本），注册逻辑在 ipc/commands.ts

  registerCommandsIpc()

  // ---------- 自绘标题栏的窗口控制 ----------
  // 系统叠加层已经关掉，三个按钮的动效与实现都在渲染层，注册逻辑在 ipc/window.ts

  registerWindowIpc()
}
