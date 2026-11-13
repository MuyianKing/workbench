import type { AppSettings, AuthProvider, MailNotifyPayload, Result, ThemeConfig, WorkbenchApi } from '@/types'
/**
 * `window.workbench` 的 Tauri 实现 —— **装配根**。
 *
 * 这一层替代了 Electron 主进程 + preload：preload 已随 Electron 一起删除，
 * 而渲染层仍然只认同一个契约，所以 78 处调用一行都不用改。
 *
 * 通道实现按域分文件：`api-sync.ts`（同步门禁那几组）、`api-project.ts`（项目与进程）、
 * `api-domains.ts`（域模块的薄转发，就在本文件）、`api-background.ts`（背景图与图片授权）、
 * `api-system.ts`（系统 / 窗口 / 对话框 / 系统集成）、`api-events.ts`（事件订阅与跨窗口通道）；
 * 网关、Qoder、独立视频窗口与独立 Markdown 编辑窗口各自的整组通道住在
 * `gateway.ts` / `qoder.ts` / `video-window.ts` / `markdown-window.ts`。
 * 本文件只做 spreads、未移植兜底与安装时序。
 *
 * 尚未移植的通道由 `createApi` 的兜底接管：返回 `Result` 形状的失败值并打一次警告，
 * 界面降级成空态而不是崩掉 —— 迁移期间的缺口因此可见、可控。
 * 通道补齐后应当去掉兜底（那时 `as` 断言也就不需要了）。
 */
import { fail, ok } from '@workbench/core'
import * as activity from './activity'
import * as ai from './ai'
import * as aiNews from './ai-news'
import { backgroundApi } from './api-background'
import { eventsApi } from './api-events'
import { projectApi } from './api-project'
import { syncApi, syncRepo } from './api-sync'
import { openDialog, saveDialog, syncSystemIntegration, systemApi } from './api-system'
import * as auth from './auth'
import { guard, hasTauri, listen } from './bridge'
import * as design from './design'
import { emit } from './events'
import * as events from './events'
import { gatewayApi } from './gateway'
import * as git from './git'
import * as kb from './kb'
import { markdownWindowApi } from './markdown-window'
import * as note from './note'
import * as orphan from './orphan'
import * as piSkill from './pi-skill'
import { qoderApi } from './qoder'
import * as session from './session'
import * as skill from './skill'
import * as state from './state'
import * as vault from './vault'
import * as video from './video'
import { videoWindowApi } from './video-window'
import * as workLog from './work-log'
import * as zentao from './zentao'

/** 域模块的薄转发：一个域一组通道，实现都在各自的适配文件里（注释也留在那边） */
const domainsApi = {
  // ---------- 工作日志（本地文件；配了同步仓库时按设备分片共享） ----------
  listWorkLogs: () => workLog.listWorkLogs(),
  addWorkLog: (input: Parameters<WorkbenchApi['addWorkLog']>[0]) => workLog.addWorkLog(input),
  updateWorkLog: (id: string, patch: Parameters<WorkbenchApi['updateWorkLog']>[1]) =>
    workLog.updateWorkLog(id, patch),
  removeWorkLog: (id: string) => workLog.removeWorkLog(id),
  projectGitLog: (dir: string, since?: number, until?: number) => workLog.projectGitLog(dir, since, until),
  importGitDrafts: (
    drafts: Parameters<WorkbenchApi['importGitDrafts']>[0],
    deviceId?: string,
  ) => workLog.importGitDrafts(drafts, deviceId),

  // ---------- Git 页（只读、本地；实现见 workbench/git.ts） ----------
  openGitRepo: (path: string) => git.openRepo(path),
  listGitBranches: (root: string) => git.listBranches(root),
  listGitCommits: (root: string, rev: string, since: string, until: string, skip: number, limit: number) =>
    git.listCommits(root, rev, since, until, skip, limit),
  listGitFileCommits: (root: string, path: string, rev: string, since: string, until: string, skip: number, limit: number) =>
    git.listFileCommits(root, path, rev, since, until, skip, limit),
  listGitTree: (root: string, dir: string, rev: string) => git.listTree(root, dir, rev),
  loadGitCommit: (root: string, hash: string) => git.loadCommit(root, hash),
  compareGitCommits: (root: string, base: string, target: string) =>
    git.compareCommits(root, base, target),
  loadGitPatch: (root: string, base: string, target: string, path: string) =>
    git.loadPatch(root, base, target, path),

  // ---------- AI 热点（本地缓存 + 宿主侧的内置源白名单） ----------
  getAiNews: () => aiNews.getAiNews(),
  refreshAiNews: () => aiNews.refreshAiNews(),
  loadAiNewsArticle: (url: string) => aiNews.loadAiNewsArticle(url),

  // ---------- 笔记（用户自己挑的一个文件夹里的 markdown 文件） ----------
  listNotes: (root: string) => note.listNotes(root),
  readNote: (root: string, rel: string) => note.readNote(root, rel),
  writeNote: (root: string, rel: string, content: string, expectedMtimeMs?: number) =>
    note.writeNote(root, rel, content, expectedMtimeMs),
  createNote: (root: string, input: Parameters<WorkbenchApi['createNote']>[1]) =>
    note.createNote(root, input),
  renameNote: (root: string, rel: string, name: string) => note.renameNote(root, rel, name),
  removeNote: (root: string, rel: string) => note.removeNote(root, rel),
  moveNote: (root: string, rel: string, targetDir: string) =>
    note.moveNote(root, rel, targetDir),
  syncNotes: (input: Parameters<WorkbenchApi['syncNotes']>[0]) => note.syncNotes(input),
  noteRepoState: (dir: string) => note.noteRepoState(dir),
  uploadNoteImage: (input: Parameters<WorkbenchApi['uploadNoteImage']>[0]) =>
    note.uploadNoteImage(input),
  listNoteImages: (input: Parameters<WorkbenchApi['listNoteImages']>[0]) =>
    note.listNoteImages(input),
  deleteNoteImages: (input: Parameters<WorkbenchApi['deleteNoteImages']>[0]) =>
    note.deleteNoteImages(input),
  scanNoteTexts: (root: string) => note.scanNoteTexts(root),

  // ---------- 视频（用户自己挑的一个文件夹里的 MP4） ----------
  listVideos: (root: string) => video.listVideos(root),
  loadVideo: (root: string, rel: string) => video.loadVideo(root, rel),

  // ---------- 技能（住在笔记仓库的一个子目录里，见 packages/skills/src/skills.ts） ----------
  listSkills: (root: string, dir: string) => skill.listSkills(root, dir),
  skillState: (dir: string) => skill.skillState(dir),
  skillSync: (root: string, dir: string) => skill.skillSync(root, dir),
  createSkill: (root: string, dir: string, input: Parameters<WorkbenchApi['createSkill']>[2]) =>
    skill.createSkill(root, dir, input),
  saveSkillFile: (root: string, dir: string, id: string, rel: string, content: string) =>
    skill.saveSkillFile(root, dir, id, rel, content),
  listSkillFiles: (root: string, dir: string, id: string) => skill.listSkillFiles(root, dir, id),
  readSkillFile: (root: string, dir: string, id: string, rel: string) =>
    skill.readSkillFile(root, dir, id, rel),
  removeSkill: (root: string, dir: string, id: string) => skill.removeSkill(root, dir, id),
  importSkill: (root: string, dir: string, source: string, id: string) =>
    skill.importSkill(root, dir, source, id),
  skillHistory: (root: string, dir: string, id: string, limit?: number) =>
    skill.skillHistory(root, dir, id, limit),
  restoreSkill: (root: string, dir: string, id: string, hash: string) =>
    skill.restoreSkill(root, dir, id, hash),
  compareSkillVersion: (root: string, dir: string, id: string, hash: string) =>
    skill.compareSkillVersion(root, dir, id, hash),
  installSkill: (root: string, dir: string, id: string, projectDir: string, overwrite: boolean) =>
    skill.installSkill(root, dir, id, projectDir, overwrite),
  scanSkillCopies: (root: string, dir: string, id: string, projectDirs: string[]) =>
    skill.scanSkillCopies(root, dir, id, projectDirs),

  // ---------- 密码保险库 ----------
  // 密钥与条目都在适配层那边（workbench/vault.ts）：Rust 只管落盘、凭据管理器与 git。
  // 同步仓库地址与其余几条同步同一个入口 —— 没登录一律当没填（见 api-sync 的 syncRepo）。
  vaultKeyState: () => vault.keyState(),
  vaultCreateKey: (replace: boolean) => vault.createKey(replace),
  vaultHello: () => vault.helloState(),
  vaultUnlock: (password: string) => vault.unlock(password),
  vaultUnlockHello: () => vault.unlockHello(),
  vaultLock: () => Promise.resolve(vault.lock()),
  // 导出 / 导入都自己弹对话框：密钥是一段三百来字符的 base64，让人手抄错一个字符的后果
  // 是另一台机器上一条都解不开，所以只走文件这条路（取消返回 false，不是失败）
  vaultExportKey: async (): Promise<Result<boolean>> => {
    const path = await saveDialog({
      title: '导出保险库密钥',
      defaultPath: 'workbench-vault-key.txt',
      filters: [{ name: '密钥文件', extensions: ['txt'] }],
    })
    if (!path)
      return ok(false)

    const written = await vault.exportKey(path)
    return written.ok ? ok(true) : fail(written.error ?? '导出密钥失败')
  },
  vaultImportKeyFile: async (): Promise<Result<boolean>> => {
    const path = await openDialog({
      directory: false,
      multiple: false,
      title: '选择密钥文件',
      filters: [
        { name: '密钥文件', extensions: ['txt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    if (!path)
      return ok(false)

    const imported = await vault.importKeyFile(path)
    return imported.ok ? ok(true) : fail(imported.error ?? '导入密钥失败')
  },
  vaultForgetKey: () => vault.forgetKey(),
  vaultLoad: () => vault.load(),
  vaultSaveEntry: (id: string, entry: Parameters<WorkbenchApi['vaultSaveEntry']>[1]) =>
    vault.save({ id, entry }),
  vaultRemoveEntry: (id: string) => vault.remove(id),
  vaultSync: () => vault.sync(syncRepo()),
  vaultRemoteKeyStatus: () => vault.remoteKeyStatus(syncRepo()),

  // ---------- 知识库（仓库里 raw/ + data/ 两层的独立项目，见 workbench/kb.ts） ----------
  kbScan: (root: string, links: Parameters<WorkbenchApi['kbScan']>[1]) => kb.kbScan(root, links),
  kbRead: (root: string, rel: string, links?: Parameters<WorkbenchApi['kbRead']>[2]) =>
    kb.kbRead(root, rel, links),
  // 目录与索引的重建由应用自己做；条目的内容由 AI 那一轮清洗写入
  kbIndexBuild: (root: string, generatedAt: string) => kb.kbIndexBuild(root, generatedAt),
  // 内容指纹（跨设备判「已入库 / 有更新」）与那几件受控的写动作（见 workbench/kb.ts）
  kbFingerprints: (root: string, rels: string[]) => kb.kbFingerprints(root, rels),
  kbEntryDelete: (root: string, rels: string[]) => kb.kbEntryDelete(root, rels),
  kbSourceSync: (root: string, name: string, dir: string) => kb.kbSourceSync(root, name, dir),
  kbDeleteTree: (root: string, name: string) => kb.kbDeleteTree(root, name),
  kbFileDelete: (root: string, name: string, dir: string, rels: string[]) =>
    kb.kbFileDelete(root, name, dir, rels),
  kbAgentsDoc: (root: string) => kb.kbAgentsDoc(root),
  kbConfigWrite: (root: string, content: string) => kb.kbConfigWrite(root, content),
  kbMigrate: (root: string, sources: Parameters<WorkbenchApi['kbMigrate']>[1], manifest: string) =>
    kb.kbMigrate(root, sources, manifest),
  // 知识库仓库自己的 git 通道（提交拉推 / 只拉不推）；仓库探测复用笔记那条通用通道
  kbSync: (dir: string) => kb.kbSync(dir),
  kbPull: (dir: string) => kb.kbPull(dir),
  kbRepoState: (dir: string) => kb.kbRepoState(dir),
  // AI 助手那几条不在这里：它们要回传进程输出、按会话 id 认领事件，
  // 与 spawn_session 同一条路子住在适配层（见 workbench/ai.ts）

  // ---------- Pi 的技能（AI 助手页那颗「技能」按钮，见 workbench/pi-skill.ts） ----------
  // 与上面技能页那组不是一回事：那组管「技能库 + 装到项目 + 版本提交」，
  // 这一组只管 AI 助手页那两个 `.agents/skills` 根里的目录
  piSkillList: (root: string) => piSkill.piSkillList(root),
  piSkillInstallZip: (root: string, zip: string, id: string | null, overwrite: boolean) =>
    piSkill.piSkillInstallZip(root, zip, id, overwrite),
  piSkillInstallDir: (root: string, source: string, id: string | null, overwrite: boolean) =>
    piSkill.piSkillInstallDir(root, source, id, overwrite),
  piSkillInstallUrl: (root: string, url: string, id: string | null, overwrite: boolean) =>
    piSkill.piSkillInstallUrl(root, url, id, overwrite),
  piSkillRemove: (root: string, id: string) => piSkill.piSkillRemove(root, id),

  // ---------- 统计：活跃度（token 用量 / 外观 / ETF 那几条在 api-sync） ----------
  // 本机账本 + 同步仓库里别的机器那份（没登录 / 没配仓库时只有本机，见 activity.ts）
  getActivity: () => guard(activity.activityView(syncRepo()), '读取活跃度失败'),
  /**
   * 记一次活跃度。适配层内部那几个来源直接调 `activity.recordActivity`，
   * 这条通道只给渲染层里那一处 —— AI 助手跑完一轮是在 store 里才知道的（见 stores/ai.ts 的 settle）。
   */
  recordActivity: async (kind: Parameters<WorkbenchApi['recordActivity']>[0]) => {
    activity.recordActivity(kind)
    return ok(null)
  },

  // ---------- 设置与布局 ----------
  getSettings: () => Promise.resolve(ok(state.settings())),
  updateSettings: (patch: Partial<AppSettings>) => {
    const next = state.updateSettings(patch)
    // 开机自启与全局快捷键是「设置即系统状态」：改完要立刻落到系统上
    void syncSystemIntegration(next)
    return Promise.resolve(ok(next))
  },
  getThemeConfig: () => Promise.resolve(ok(state.themeConfig())),
  /**
   * 首页布局与外观同一个文件（theme.json），所以改主题也可能改了设置 ——
   * 把合并后的那份推一遍，渲染层的 settings 才会跟着刷新（应用别的机器的配置就走这条路）。
   */
  updateThemeConfig: (patch: Partial<ThemeConfig>) => {
    const next = state.updateThemeConfig(patch)
    emit('settingsChanged', state.settings())
    return Promise.resolve(ok(next))
  },

  // ---------- 数据目录 ----------
  getDataDir: () => guard(state.dataDir(), '读取数据目录失败'),

  // ---------- 样式参考库（token 是随包静态资源，导出到项目时只往后端递内容） ----------
  writeDesign: (projectDir: string, content: string) => design.writeDesign(projectDir, content),

  // ---------- 禅道 ----------
  zentaoSession: zentao.session,
  zentaoLogin: zentao.login,
  zentaoLogout: zentao.logout,
  zentaoBugs: zentao.bugs,
  zentaoWatch: zentao.watch,
  zentaoNotify: zentao.notify,
  onZentaoCheck: zentao.onCheck,
  zentaoOpenSite: zentao.openSite,

  // ---------- 账号 ----------
  // 换 token、回环监听、凭据落盘都在 Rust 侧；这里只驱动轮询并落显示资料，
  // 全程不会有 token 回到渲染层（见 workbench/auth.ts）
  authStatus: () => guard(auth.authStatus(), '读取登录状态失败'),
  authRefreshAccount: (provider: AuthProvider) => auth.refreshAccount(provider),
  authLogin: (provider: AuthProvider, onAuthUrl?: (authUrl: string, opened: boolean) => void) =>
    auth.login(provider, onAuthUrl),
  authLoginSubmit: (url: string) => auth.submit(url),
  authLoginCancel: () => auth.cancel(),
  authLogout: (provider: AuthProvider) => auth.logout(provider),
} as Partial<WorkbenchApi>

const implementedApi = {
  ...gatewayApi,
  ...qoderApi,
  ...syncApi,
  ...projectApi,
  ...domainsApi,
  ...videoWindowApi,
  ...markdownWindowApi,
  ...backgroundApi,
  ...systemApi,
  ...eventsApi,
}

/**
 * 通道覆盖的**编译期**闸：`WorkbenchApi` 里有哪个通道没被上面装配进来，这里就报错并把名字列出来。
 *
 * 以前靠一层 Proxy 在运行时兜底（缺的通道返回「尚未移植」）—— 那层兜底有两个毛病：
 * 漏实现要到运行时才发现；而且它给 `then` 也编了一个函数，`await window.workbench`
 * 会被当成 thenable 永远不落地。现在缺通道是编译错误，运行期只剩真实实现。
 */
type MissingChannels = Exclude<keyof WorkbenchApi, keyof typeof implementedApi>
const channelsCovered: [MissingChannels] extends [never] ? true : ['未实现的通道', MissingChannels] = true

function createApi(): WorkbenchApi {
  // 断言只在上面那道编译期检查通过之后才成立（缺通道会先在 typescript 里报错）
  void channelsCovered
  return implementedApi as unknown as WorkbenchApi
}

/** 只在 Tauri 里接管；浏览器预览（vite.preview）下没有后端，保持 undefined 让调用方走退化路径 */
export function installTauriWorkbench(): void {
  if (!hasTauri())
    return
  // 先接上后端的原始事件（日志 / 退出 / AI 的事件流），再暴露 API：否则第一帧产生的日志会丢
  session.installSessionListeners()
  ai.installAiListeners()
  // 退出确认：后端问「还有项目在跑，要不要先停掉」，转成渲染层认识的事件
  listen<{ count: number }>('app:quit-confirm', payload => events.emit('quitConfirm', payload))
  // 邮件通知点击：Rust 弹的系统 toast 被点了，载荷是（账户, uid）
  listen<MailNotifyPayload>('mail:notify-click', payload => events.emit('mailNotifyClick', payload))
  window.workbench = createApi()
}

export { initState } from './state'

/**
 * 启动收尾：收掉上次被强杀后留下的 dev server。
 *
 * 放在界面挂载之后调用 —— 它要挨个问进程的创建时间，不该挡首屏。
 * 只在 Tauri 里做：浏览器预览下没有后端。
 */
export async function reapOrphansOnStart(): Promise<void> {
  if (!hasTauri())
    return

  // 顺带把系统集成项对齐一次（开机自启 / 快捷键可能在应用之外被改过）
  void syncSystemIntegration(state.settings())

  try {
    const result = await orphan.reap()
    for (const note of result.notes) console.warn(`[workbench] ${note}`)
  }
  catch (error) {
    // 清理是尽力而为：失败不能让应用起不来
    console.warn('[workbench] 清理残留进程失败', error)
  }
}
