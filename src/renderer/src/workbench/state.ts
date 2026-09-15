/**
 * 渲染层持有的持久化状态：项目 / 分组 / 快捷启动 / 命令 / 设置 / 首页布局 / 活跃度。
 *
 * 这是「逻辑留在 TS」这条架构选择的落点：Rust 只负责把 JSON 安全地读写到磁盘，
 * 收敛（sanitize）、默认值合并、字段增删都在这里，与 `src/shared/persisted-data.ts` 共用一份实现，
 * 所以 Electron 时代那批纯逻辑单测可以原样保留，改起来也还是 HMR 秒级。
 *
 * **设置分两个文件**:外观与首页布局住在 theme.json,其余(快捷键 / 开机自启 / 数据目录 /
 * 同步仓库地址…)住在 workbench-data.json。渲染层只认一份完整的 `AppSettings` ——
 * 读的时候在这里合（`settings()`）、写的时候在这里分（`updateSettings` 按白名单分流）。
 */
import { withSessionRecorded, withoutSession } from '@shared/orphan'
import { emptyData, parseData, sanitizeSettings } from '@shared/persisted-data'
import {
  mergeSettingsAppearance,
  migrateAppearanceIntoTheme,
  splitSettingsPatch,
  type AppearanceSettings
} from '@shared/appearance'
import { DEFAULT_THEME, sameThemeContent, sanitizeTheme, type ThemeConfig } from '@shared/theme'
import type {
  AccountProfile,
  ActiveSession,
  AppSettings,
  CommandEntry,
  CommandInput,
  CommandPatch,
  DataLocation,
  IconCacheEntry,
  PersistedData,
  Project,
  ProjectGroup,
  ProjectPatch,
  QuickApp,
  QuickAppInput,
  QuickAppList,
  QuickAppPatch
} from '@shared/types'
import { invoke } from './bridge'
import * as workLog from './work-log'

let data: PersistedData = emptyData()
let theme: ThemeConfig = DEFAULT_THEME
let loaded = false

/** 主进程在页面加载前注入的原始快照（未 sanitize） */
interface RawBootstrap {
  settings?: unknown
  themeConfig?: unknown
}

function rawBootstrap(): RawBootstrap | null {
  const raw = window.__WB_BOOTSTRAP__
  if (typeof raw !== 'object' || raw === null) return null
  return raw as RawBootstrap
}

/**
 * 首屏设置：用同步注入的快照，拿不到就落默认值。
 * 与 Electron 版走的是同一条退化路径（见 src/renderer/src/bootstrap.ts）。
 *
 * 快照是两份原始数据（数据文件的 settings + 主题文件），这里要按同一条规则合成渲染层认的那一份：
 * 先把老数据里还在 settings 中的外观搬进主题，再合起来。
 */
export function initialSettings(): AppSettings {
  const raw = rawBootstrap()
  const theme = sanitizeTheme(migrateAppearanceIntoTheme(raw?.themeConfig, raw?.settings))
  return mergeSettingsAppearance(sanitizeSettings(raw?.settings), theme.appearance)
}

export function initialTheme(): ThemeConfig {
  const raw = rawBootstrap()
  return sanitizeTheme(migrateAppearanceIntoTheme(raw?.themeConfig, raw?.settings))
}

/** 载入磁盘数据。收敛逻辑与首屏快照完全同源，两条路径不会给出不一样的结果。 */
export async function initState(): Promise<void> {
  const [rawData, rawTheme] = await Promise.all([
    invoke<unknown>('data_load'),
    invoke<unknown>('theme_load')
  ])

  data = parseData(rawData, () => crypto.randomUUID())

  // 老数据：外观那几项原本住在数据文件的 settings 里，主题文件里还没有它们。
  // 搬过去之后**立刻落盘主题文件**：数据文件那边下一次落盘就会把这些键摘掉
  // （见 sanitizeSettings），中间要是被关掉，用户的主题色 / 背景就再也没处可搬了。
  const rawSettings = (rawData as { settings?: unknown } | null)?.settings
  const migrated = migrateAppearanceIntoTheme(rawTheme, rawSettings)
  theme = sanitizeTheme(migrated)
  if (migrated !== rawTheme) void invoke('theme_save', { value: theme })

  loaded = true
}

/** 变更即写（落盘防抖在 Rust 侧，300ms 合并一次） */
function persist(): void {
  if (loaded) void invoke('data_save', { value: data })
}

function persistTheme(): void {
  if (loaded) void invoke('theme_save', { value: theme })
}

// ---------- 读取 ----------

/**
 * 交给渲染层的值一律是快照。
 *
 * 这条边界在 Electron 版是 IPC，结构化克隆是顺手就有的：渲染层拿到的列表就是它自己的，
 * 在数组上 push、展开追加都不会牵动主进程的账本。适配层把这条边界搬进了同一个 JS 上下文，
 * 而「跨进程复制」不会自己出现 —— 直接把内部数组递出去，渲染层的乐观追加
 * （`[...list, created]`）就会叠在适配层刚刚 push 进去的那一条上：
 * 表现是「刚添加的条目先变成两个，过一会儿刷新又合成一个」，项目那边更糟，push 会直接写进落盘数据。
 *
 * 适配层内部的读取（`projects()` / `quickApps()` 这些，给 nvm、启动、事件构造用）不走这里，
 * 它们要的就是同一份数据。
 */
function copy<T>(value: T): T {
  return structuredClone(value)
}

export function snapshot(): PersistedData {
  return copy(data)
}

export function projects(): Project[] {
  return data.projects
}

export function groups(): ProjectGroup[] {
  return data.groups
}

/**
 * 渲染层看到的那份完整设置：数据文件里的设置 + 主题文件里的外观。
 *
 * 快照（copy）是为了守住「适配层与渲染层之间是进程边界」这条约定（见下面 copy 的注释）：
 * 直接递出内部对象的话，渲染层改 `settings.appName` 就会绕过 updateSettings 写进落盘数据。
 */
export function settings(): AppSettings {
  return copy(mergeSettingsAppearance(data.settings, theme.appearance))
}

// ---------- 账号资料 ----------

/**
 * 登录账号的显示资料（昵称头像那几项）。
 *
 * **这不是「是否已登录」的判据**：token 在 Windows 凭据管理器里，权威来源是
 * `authStatus().providers`。这里存着的资料在凭据被清掉之后只是残留，
 * 由适配层在启动时对账清掉（见 workbench/auth.ts）。
 */
export function account(): AccountProfile | null {
  return data.account ? copy(data.account) : null
}

export function setAccount(next: AccountProfile | null): void {
  data.account = next
  persist()
}

export function themeConfig(): ThemeConfig {
  return copy(theme)
}

export function listProjects(): { projects: Project[]; groups: ProjectGroup[] } {
  return copy({ projects: data.projects, groups: data.groups })
}

// ---------- 设置与布局 ----------

/**
 * 主题文件只在**内容真的变过**时才刷新时间戳。
 *
 * 同步那边是「内容没变就不产生提交」（见 sync.rs 的 publish_at），而时间戳本身就在文件里：
 * 每轮都刷一下的话，仓库里会堆出一串只改了时间的提交；反过来一直不刷，别的机器读到的
 * 「更新于」就永远停在第一次同步那一刻。
 */
function touchTheme(next: ThemeConfig, before: ThemeConfig): ThemeConfig {
  return sameThemeContent(before, next) ? next : { ...next, updatedAt: Date.now() }
}

/** 只改外观那几项（补丁来自 updateSettings 的分流） */
function updateAppearance(patch: Partial<AppearanceSettings>): void {
  const before = theme
  const merged = sanitizeTheme({ ...theme, appearance: { ...theme.appearance, ...patch } })
  theme = touchTheme(merged, before)
  persistTheme()
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  // 先 sanitize 再落盘：手改过的数据文件不会把非法取值带进内存（与主进程版同一函数）
  const { settings: stored, appearance } = splitSettingsPatch(patch)
  if (Object.keys(appearance).length) updateAppearance(appearance)

  data.settings = sanitizeSettings({ ...data.settings, ...stored })
  persist()
  return settings()
}

export function updateThemeConfig(patch: Partial<ThemeConfig>): ThemeConfig {
  const before = theme
  // 时间戳不认调用方给的（它是同步用的推导值），外观按字段合并 —— 调用方给的是补丁，
  // 直接替换整段会把没提到的外观项打回默认值
  const merged = sanitizeTheme({
    ...theme,
    ...patch,
    appearance: { ...theme.appearance, ...(patch.appearance ?? {}) },
    updatedAt: before.updatedAt
  })
  theme = touchTheme(merged, before)
  persistTheme()
  return copy(theme)
}

// ---------- 项目 ----------

export function updateProject(id: string, patch: ProjectPatch): Project | null {
  const target = data.projects.find((project) => project.id === id)
  if (!target) return null
  Object.assign(target, patch)
  persist()
  return copy(target)
}

export function removeProject(id: string): void {
  data.projects = data.projects.filter((project) => project.id !== id)
  persist()
}

/**
 * 追加一个项目并落盘。
 * 项目对象的组装留在适配层——只有那里才知道这次扫描的结果与「仅管理目录」的判定。
 */
export function addProject(project: Project): void {
  data.projects.push(project)
  persist()
}

export function relocateProject(id: string, newPath: string): Project | null {
  return updateProject(id, { path: newPath } as ProjectPatch)
}

/**
 * 检查项目目录是否还在。逐项问 Rust 的 fs_exists —— 一次 IPC 换一个确定答案，
 * 比把整个目录树拉回渲染层划算。
 */
export async function checkProjectPaths(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    data.projects.map(async (project) => {
      const exists = await invoke<boolean>('fs_exists', { path: project.path })
      return [project.id, exists] as const
    })
  )
  return Object.fromEntries(entries)
}

export function persistProjects(): void {
  persist()
}

// ---------- 分组 ----------

export function createGroup(name: string): ProjectGroup {
  const group: ProjectGroup = { id: crypto.randomUUID(), name, order: data.groups.length }
  data.groups.push(group)
  persist()
  return copy(group)
}

export function renameGroup(id: string, name: string): void {
  const group = data.groups.find((item) => item.id === id)
  if (!group) return
  group.name = name
  persist()
}

export function removeGroup(id: string): void {
  data.groups = data.groups.filter((group) => group.id !== id)
  // 组没了，组内项目回落到未分组，不能留下指向已删分组的悬空引用
  for (const project of data.projects) {
    if (project.groupId === id) project.groupId = undefined
  }
  persist()
}

export function reorderGroups(ids: string[]): void {
  const byId = new Map(data.groups.map((group) => [group.id, group]))
  data.groups = ids.map((id) => byId.get(id)).filter((group): group is ProjectGroup => !!group)
  persist()
}

// ---------- 活跃度 ----------

export function activityCounts(): PersistedData['activity'] {
  return copy(data.activity ?? {})
}

// ---------- 快捷启动 ----------

/**
 * 快捷启动列表 + 哪些程序已经不在原路径上。
 *
 * 必须逐个问 fs_exists：程序会被移动或卸载，界面要能把它标出来而不是点了没反应。
 * 这个接口是数组形状，绝不能落到「未移植」兜底 —— 那边返回对象，store 会当数组用直接抛错。
 */
export async function quickAppList(): Promise<QuickAppList> {
  // 先取快照再逐个问：下面那串 await 期间列表可能又被改过，两半要来自同一时刻
  const apps = copy(data.quickApps)
  const flags = await Promise.all(
    apps.map(async (app) => [app.id, !(await invoke<boolean>('fs_exists', { path: app.target }))] as const)
  )
  return {
    apps,
    missing: Object.fromEntries(flags.filter(([, missing]) => missing))
  }
}

export function quickApps(): QuickApp[] {
  return data.quickApps
}

/** 记一次启动：只动最近使用时间（它不在 QuickAppPatch 的可编辑字段里） */
export function touchQuickApp(id: string, at: number): void {
  const target = data.quickApps.find((app) => app.id === id)
  if (!target) return
  target.lastUsedAt = at
  persist()
}

export function addQuickApp(input: QuickAppInput): QuickApp {
  const app: QuickApp = {
    ...input,
    id: crypto.randomUUID(),
    order: data.quickApps.length,
    createdAt: Date.now()
  }
  data.quickApps.push(app)
  persist()
  return copy(app)
}

export function updateQuickApp(id: string, patch: QuickAppPatch): QuickApp | null {
  const target = data.quickApps.find((app) => app.id === id)
  if (!target) return null
  Object.assign(target, patch)
  persist()
  return copy(target)
}

export function removeQuickApp(id: string): void {
  data.quickApps = data.quickApps.filter((app) => app.id !== id)
  persist()
}

export function reorderQuickApps(ids: string[]): QuickApp[] {
  const byId = new Map(data.quickApps.map((app) => [app.id, app]))
  data.quickApps = ids
    .map((id) => byId.get(id))
    .filter((app): app is QuickApp => !!app)
    // order 是落盘的一部分，重排后必须重新编号，否则下次载入顺序又回到旧值
    .map((app, index) => ({ ...app, order: index }))
  persist()
  return copy(data.quickApps)
}

// ---------- 程序图标缓存 ----------

/**
 * 图标的落盘缓存（key = 程序路径）。
 *
 * 放在数据文件里而不是单独开一份：图标实测只有几 KB（每个 1.5~4.4 KB），
 * 为它单开一条通道 + 一个 Rust store 不划算。适配层读它来跳过重复抽取。
 */
export function iconCache(): Record<string, IconCacheEntry> {
  return data.iconCache ?? {}
}

/**
 * 记一条图标缓存并落盘。
 *
 * 内容和已存的一致就不写：`data_save` 每次都要把整份数据送过 IPC，
 * 同一次启动里同一个程序被问两遍（界面渲染 + 别的调用方）时不该白写一遍。
 */
export function setIconCacheEntry(target: string, entry: IconCacheEntry): void {
  const current = data.iconCache ?? (data.iconCache = {})
  const existing = current[target]
  if (existing && existing.mtime === entry.mtime && existing.dataUrl === entry.dataUrl) return

  current[target] = entry
  persist()
}

// ---------- 独立命令 ----------

export function commandList(): CommandEntry[] {
  return copy(data.commands)
}

export function addCommand(input: CommandInput): CommandEntry {
  const { port, ...rest } = input
  const entry: CommandEntry = {
    ...rest,
    id: crypto.randomUUID(),
    order: data.commands.length,
    createdAt: Date.now(),
    // 表单清空端口时给的是 null，落盘口径统一成「字段不存在」
    ...(port == null ? {} : { port })
  }
  data.commands.push(entry)
  persist()
  return copy(entry)
}

export function updateCommand(id: string, patch: CommandPatch): CommandEntry | null {
  const target = data.commands.find((item) => item.id === id)
  if (!target) return null

  const { port, ...rest } = patch
  Object.assign(target, rest)
  // 同上：null 表示「清空端口」，要真把字段删掉而不是留一个 null
  if (port === null) delete target.port
  else if (port !== undefined) target.port = port

  persist()
  return copy(target)
}

export function removeCommand(id: string): void {
  data.commands = data.commands.filter((item) => item.id !== id)
  persist()
}

// ---------- 残留进程记录 ----------

/**
 * 上层记录的「起过但还没确认结束」的子进程。
 *
 * 存在的意义是应用被强杀之后还能找回它们：记录里带 ownerPid，
 * 下次启动时如果那个应用进程已经没了，就说明这些是残留。
 */
export function activeSessions(): ActiveSession[] {
  return data.activeSessions ?? []
}

export function setActiveSessions(sessions: ActiveSession[]): void {
  data.activeSessions = sessions
  persist()
}

export function recordSession(session: ActiveSession): void {
  data.activeSessions = withSessionRecorded(data.activeSessions, session)
  persist()
}

/** 进程正常结束就把它从记录里摘掉（按 pid 匹配，一个会话一条） */
export function dropSession(pid: number): void {
  const current = data.activeSessions
  if (!current) return

  const next = withoutSession(current, pid)
  if (next.length === current.length) return

  data.activeSessions = next
  persist()
}

// ---------- 数据目录 ----------

export async function dataLocation(): Promise<DataLocation> {
  return invoke<DataLocation>('data_location')
}

export async function dataFileExistsIn(dir: string): Promise<boolean> {
  return invoke<boolean>('data_file_exists_in', { dir })
}

/** 迁移数据目录：先把内存态落盘，再让 Rust 搬文件并改写指针 */
export async function migrateDataDir(dir: string): Promise<void> {
  await invoke('data_save', { value: data })
  await invoke('theme_save', { value: theme })
  // 工作日志是另一份文件，但它同属本地数据：不先落盘，Rust 搬走的是上一次写盘时的样子
  await workLog.flush()
  await invoke('data_migrate', { dir })
  // 搬完丢掉内存里那一份：它来自旧目录，下次打开工作页会从新目录重新读
  workLog.reset()
}
