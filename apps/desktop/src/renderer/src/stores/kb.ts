import type { AiLogLine } from '@workbench/ai'
import type { KbCleanPhase, KbDanglingGroup, KbEntryMeta, KbLibraryRow, KbManifestEntry, KbRawItem, KbRawViewKind, KbRepoState, KbScanEntry, KbSourceLink, KbStats } from '@workbench/kb'

import { confirmFrame, piLaunch, writtenEntries } from '@workbench/ai'
import { KB_RAW_DIR, kbCleanPrompt, kbDanglingGroups, kbEntryFiles, kbLibraryRows, kbRawDisplayPath, kbRawFiles, kbRawReferencedRels, kbRawSourceNameOf, kbRawViewKind, kbSourceLinkKey, kbSourceRef, kbStats, matchKbRawStatus, normalizeKbSource, parseKbFrontmatter, parseKbManifest, sameKbRoot, sanitizeKbName, sanitizeKbSourceLinks, serializeKbManifest, todayIsoDate } from '@workbench/kb'

import { noteRootName, sanitizeNoteRoot } from '@workbench/notes'
import { defineStore } from 'pinia'
/**
 * 知识库：**仓库里 raw/ + data/ 两层**的编排，外加「添加 / 删除 / 清洗 / 迁移」这些动作的
 * 全程驱动。
 *
 * 知识库就是用户挑的那个文件夹（一个 git 仓库的根）：列表数据来自仓库里的清单文件
 * （`raw/kb.json`，别的设备推上来什么这边就有什么），原始数据物理在 `raw/` 下、清洗写
 * `data/`。本机哪台设备给哪个知识库关联了源头文件夹只落本机设置（`kbRawSources`）——
 * 没有关联的知识库直接用仓库里的 raw 副本（只读）。
 *
 * **清洗的硬前置是把原始文件上传远程仓库**：清洗前先做源头同步（本机改过的文件复制进
 * raw）→ 提交推送（kb_sync）→ 算清单交给内置的 Pi（提示词在 kb-clean.ts，走 ai.rs 那条
 * 通用驱动链路）→ 跑完重建索引、再推一次（把新条目送上去）。任何一步失败都就地拦下，
 * 不让「本地洗了、远端没有」的状态发生。
 *
 * 打开页面会**后台拉取一次远端**（kb_pull，只拉不推）：列表数据来自远程仓库，
 * 自动 pull 让它即开即新；冲突不挑边，只把原因摆到同步那行。检测是**手动**的
 * （工具条那颗「检测更新」= reload + 报一句结果），没有后台轮询、也没有自动清洗。
 */
import { computed, ref, watch } from 'vue'
import { notifyError, notifyInfo, notifySuccess } from '@/notify'
import { useAiStore } from '@/stores/ai'
import { useAiSkillsStore } from '@/stores/ai-skills'
import { useSettingsStore } from '@/stores/settings'
import { aiAbort, aiRun, aiSend, aiSessionProcessId, aiStop } from '@/workbench/ai'

/** 清洗的范围：全库 / 某个知识库 / 某个文件（右键菜单那两条按它过滤清单） */
export type KbCleanScope = { kind: 'all' } | { kind: 'kb', name: string } | { kind: 'file', rel: string }

/** 旧结构的条目目录（迁移前）：「像不像知识库」与「要不要迁移」都认它 */
const KB_LEGACY_DIR = 'kb'

export const useKbStore = defineStore('kb', () => {
  const settings = useSettingsStore()

  /**
   * 知识库文件夹：**用户自己挑的一个目录**（一个 git 仓库的根）。
   * 空串 = 还没选过，整页只给引导。与笔记 / 技能文件夹互不相干。
   */
  const root = computed(() => settings.settings.kbDir)
  /** 本机给这个知识库根关联的源头文件夹（知识库名 → 文件夹；没有关联的就是只读） */
  const sourceLinks = computed<KbSourceLink[]>(() => {
    const key = root.value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (!key)
      return []
    return settings.settings.kbRawSources.filter(
      link => link.root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === key,
    )
  })
  /** 带得出去的关联清单（有源头文件夹的那些）：扫描与读取共用 —— 有关联就认本机那份 */
  const activeLinks = computed(() =>
    sourceLinks.value.filter(link => link.dir).map(link => ({ name: link.name, dir: link.dir })),
  )
  /** 文件夹的 git 状态（探出来的、不落盘）：有没有仓库与远端决定给不给同步入口 */
  const repoState = ref<KbRepoState | null>(null)
  const remoteUrl = computed(() => repoState.value?.origin ?? '')
  const canSync = computed(() => repoState.value?.isRepo === true && remoteUrl.value !== '')

  /** 扫描的原始平铺清单（仓库里读到的：raw、data、生成物） */
  const scanEntries = ref<KbScanEntry[]>([])
  /** 清单文件解析出来的知识库列表（列表数据源；认不出按空清单处理） */
  const manifest = ref<KbManifestEntry[]>([])
  const entries = ref<KbEntryMeta[]>([])
  const rawItems = ref<KbRawItem[]>([])
  /** 列表行（最外层）：清单一条一行，带本机关联与这一库的几个数 */
  const libraries = ref<KbLibraryRow[]>([])
  /**
   * 失联组（次次重扫现算，不落盘）：一个 raw 文件一组，列出指向它的条目。
   * 只在「这一轮扫描成功、且文件不在清单里」时出现（多半是别的设备删了、pull 下来后
   * 条目还在），点开确认后整组删。
   */
  const dangling = ref<KbDanglingGroup[]>([])
  /**
   * 上一次检测报出去的几个数（「检测更新」那颗按钮）：只说**变化**用。它记的是
   * 「上一次报给你的话」，不是数据事实，所以只在内存里、不落盘、也不进设置。
   */
  const lastDetect = ref<KbStats | null>(null)

  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref('')

  /** 当前查看的原始数据（raw 相对路径）与正文；没有查看的就是概览 */
  const activeRawRel = ref('')
  const activeRawContent = ref('')
  const activeRawLoading = ref(false)
  const activeRawError = ref('')

  const syncing = ref(false)
  const syncError = ref('')
  /** 后台拉取远端正在进行（不挡界面，只是防重入） */
  const pulling = ref(false)
  /** 一次性迁移正在进行 */
  const migrating = ref(false)

  /** 正在查看的原始数据（清单里那一条）与它该怎么看（按后缀分：渲染 / 纯文本 / 交出去） */
  const activeRaw = computed(() => rawItems.value.find(item => item.rel === activeRawRel.value) ?? null)
  const activeRawKind = computed<KbRawViewKind>(() =>
    activeRaw.value ? kbRawViewKind(activeRaw.value.name) : 'external',
  )
  const stats = computed(() => kbStats(entries.value, rawItems.value))
  const locationText = computed(() => noteRootName(root.value))
  /**
   * 选的文件夹像不像一个知识库：清单在、两层目录（raw / data）任一在、旧结构的 `kb/`
   * 在，或者**文件夹是空的**（第一次用，添加知识库就从这儿开始）—— 都算。
   * 一个塞满别的项目文件的文件夹不算（那多半是选错了目录）。
   */
  const looksLikeKb = computed(() => {
    if (manifest.value.length > 0)
      return true
    if (scanEntries.value.length === 0)
      return true
    return scanEntries.value.some(
      item =>
        item.rel === KB_RAW_DIR
        || item.rel.startsWith(`${KB_RAW_DIR}/`)
        || item.rel === 'data'
        || item.rel.startsWith('data/')
        || item.rel === KB_LEGACY_DIR
        || item.rel.startsWith(`${KB_LEGACY_DIR}/`),
    )
  })
  /**
   * 要不要迁移：旧结构的 `kb/` 还在、清单还没有 —— 一次性迁移动作只在这种状态下出现。
   * 迁移由用户确认后做（搬文件、改写条目，见 Rust 侧的 kb_migrate）。
   */
  const migrateNeeded = computed(() =>
    scanEntries.value.some(item => item.rel === KB_LEGACY_DIR || item.rel.startsWith(`${KB_LEGACY_DIR}/`))
    && manifest.value.length === 0,
  )

  function reset(): void {
    scanEntries.value = []
    manifest.value = []
    entries.value = []
    rawItems.value = []
    libraries.value = []
    dangling.value = []
    repoState.value = null
    lastDetect.value = null
    closeRaw()
    loaded.value = false
    loadError.value = ''
    syncError.value = ''
  }

  /** 收起原始数据查看（回到概览） */
  function closeRaw(): void {
    activeRawRel.value = ''
    activeRawContent.value = ''
    activeRawError.value = ''
  }

  /** 重扫序号：旧的一轮回来时不覆盖新结果（见 reload） */
  let reloadSeq = 0

  /**
   * 重新扫一遍：扫描 → 解析清单 → 读条目 frontmatter → 算指纹 → 配状态 → 探仓库。
   *
   * 条目是逐个读出来解析的（source 在 frontmatter 里，状态判定绕不开），几十上百个
   * 本地小文件并发读；读不出的（权限 / 刚被删）如实丢掉 —— 少一条只是清单上少一行，
   * 不该让整页读不出来。
   */
  async function reload(): Promise<void> {
    if (!root.value) {
      reset()
      return
    }

    // 每一次重扫都有一个序号：连着的两轮（自动 pull 完 + 用户点检测）旧的那轮回来时
    // 不能把新结果盖掉 —— 这就是「旧结果覆盖新结果」的那个竞态。
    const seq = ++reloadSeq
    loading.value = true
    loadError.value = ''
    // 本机关联随扫描带走：源头文件夹的指纹在 Rust 侧顺路算（状态判定「本地为准」用）
    const result = await window.workbench.kbScan(root.value, activeLinks.value)
    if (seq !== reloadSeq)
      return
    loading.value = false

    if (!result.ok || !result.data) {
      reset()
      loadError.value = result.error ?? '读取知识库失败'
      return
    }

    scanEntries.value = result.data.entries
    manifest.value = parseKbManifest(result.data.manifest) ?? []
    const current = root.value

    const metas = await Promise.all(
      kbEntryFiles(result.data.entries).map(async (file): Promise<KbEntryMeta | null> => {
        const read = await window.workbench.kbRead(current, file.rel)
        if (!read.ok || typeof read.data !== 'string')
          return null
        const fm = parseKbFrontmatter(read.data)
        const stem = file.name.replace(/\.md$/i, '')
        return {
          rel: file.rel,
          title: fm.title || stem,
          tags: fm.tags,
          status: fm.status,
          created: fm.created,
          updated: fm.updated,
          summary: fm.summary,
          source: normalizeKbSource(fm.source),
          sourceHash: fm.sourceHash,
          mtimeMs: file.mtimeMs,
        }
      }),
    )
    // 读完条目的这段时间里又发起了一轮：这份结果作废（否则旧清单会盖掉新的）
    if (seq !== reloadSeq)
      return
    entries.value = metas.filter((meta): meta is KbEntryMeta => meta !== null)

    // 内容指纹只算「有条目指向」的文件（未入库的不参与）；读不到的那几个回落 mtime
    const rawFiles = kbRawFiles(result.data.entries)
    const hashRels = kbRawReferencedRels(rawFiles, entries.value)
    const hashResult = hashRels.length
      ? await window.workbench.kbFingerprints(current, hashRels)
      : null
    if (seq !== reloadSeq)
      return
    const hashes = hashResult?.ok && hashResult.data ? hashResult.data : {}

    rawItems.value = matchKbRawStatus(rawFiles, entries.value, hashes, result.data.local)
    dangling.value = kbDanglingGroups(entries.value, rawItems.value, manifest.value.map(item => item.name))
    libraries.value = kbLibraryRows(manifest.value, sourceLinks.value, rawItems.value, dangling.value)

    // 正在查看的原始数据没了（被删 / 重洗后挪了）：收起来，别挂着一个空壳
    if (activeRawRel.value && !rawItems.value.some(item => item.rel === activeRawRel.value)) {
      closeRaw()
    }
    loaded.value = true

    void probeState()
  }

  // ---------- 检测更新（手动那一下） ----------

  /**
   * 检测更新：全扫一遍（与刷新是同一条路），再挑**变化**说一句。
   *
   * 只读、不写任何文件，也不清洗 —— 清洗是另一个动作、由用户明明白白点出来。
   * 没有变化就说「没有变化」：静默什么都不说，用户没法确认这一下到底跑没跑。
   */
  async function detect(): Promise<void> {
    if (!root.value)
      return
    const before = lastDetect.value
    await reload()
    if (!loaded.value) {
      notifyError(loadError.value || '检测失败')
      return
    }

    const now = stats.value
    lastDetect.value = { ...now }
    if (!before) {
      notifySuccess(`检测完成：原始数据 ${now.raws} 个（未入库 ${now.pending} · 有更新 ${now.stale}）`)
      return
    }

    const parts: string[] = []
    if (now.pending > before.pending)
      parts.push(`未入库 +${now.pending - before.pending}`)
    if (now.stale > before.stale)
      parts.push(`有更新 +${now.stale - before.stale}`)
    if (now.raws > before.raws)
      parts.push(`文件 +${now.raws - before.raws}`)
    if (now.raws < before.raws)
      parts.push(`文件 -${before.raws - now.raws}`)
    notifyInfo(parts.length ? `检测到 ${parts.join(' · ')}` : '没有变化')
  }

  // ---------- 清单（raw/kb.json：列表数据源，应用维护） ----------

  /** 清单落盘（serializeKbManifest 收敛过再写）；成功后本地那一份跟着换 */
  async function writeManifest(next: KbManifestEntry[]): Promise<boolean> {
    const dir = root.value
    if (!dir)
      return false
    const result = await window.workbench.kbConfigWrite(dir, serializeKbManifest(next))
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '保存知识库清单失败')
      return false
    }
    manifest.value = next
    return true
  }

  /** 关联清单落盘（只写设置、不碰文件；收敛函数在 @workbench/kb，与设置读侧同一份口径） */
  async function updateSourceLinks(next: KbSourceLink[]): Promise<boolean> {
    return settings.updateSettings({ kbRawSources: sanitizeKbSourceLinks(next) })
  }

  /** 两个文件夹是不是同一个（Windows 口径：分隔符与大小写不敏感） */
  function sameDir(a: string, b: string): boolean {
    const key = (value: string): string =>
      value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return !!key(a) && key(a) === key(b)
  }

  // ---------- 添加 / 删除知识库 ----------

  /**
   * 添加一个知识库（名称 + 本机源头文件夹）：**二次确认在弹层里** —— 确认后
   * 复制进 raw/ → 写清单 → 写本机关联，随即进入首洗（上传是清洗的硬前置，在
   * startClean 的准备阶段做，面板逐步可见）。用户在弹层里取消清洗时整个添加作废
   * （一个字都不会落盘）；所以这里的拦路（重名 / 环境缺 / 没连远端）都在复制之前。
   */
  async function addLibrary(name: string, dir: string): Promise<boolean> {
    const clean = sanitizeKbName(name)
    const target = sanitizeNoteRoot(dir)
    const current = root.value
    if (!current || !clean || !target)
      return false
    if (manifest.value.some(item => item.name === clean)) {
      notifyError(`已经有叫「${clean}」的知识库了`)
      return false
    }
    // 同一个文件夹不能当两个知识库的源头（内容会被复制两份）—— 但只认**清单里还活着**
    // 的知识库：旧配置的残留（名字不在清单里，失败添加 / 旧模型留下的）不拦，写关联时顶掉
    const conflict = sourceLinks.value.find(link => link.dir && sameDir(link.dir, target))
    if (conflict && manifest.value.some(item => item.name === conflict.name)) {
      notifyError(`这个文件夹已经关联给「${conflict.name}」了`)
      return false
    }
    // 「不清洗就当做不添加」—— 所以清洗缺什么、上传缺什么，都要在复制之前拦住
    const ai = useAiStore()
    if (!ai.probed)
      await ai.probe()
    const blocker = cleanBlocker()
    if (blocker) {
      notifyError(blocker)
      return false
    }
    if (!canSync.value) {
      notifyError('知识库文件夹还没连 git 远端：原始文件必须先上传到远程仓库，现在添加不了')
      return false
    }

    const synced = await window.workbench.kbSourceSync(current, clean, target)
    if (!synced.ok || !synced.data) {
      notifyError(synced.error ?? '复制源头文件夹失败')
      return false
    }
    if (!await writeManifest([...manifest.value, { name: clean, created: todayIsoDate() }]))
      return false
    // 仓库根的 AGENTS.md（给进仓库的 AI 描述结构与用法）：没有就生成，已存在不覆盖
    await window.workbench.kbAgentsDoc(current)
    // 写关联时把残留顶掉：同名的（sanitize 去重保留先出现的，必须先摘掉）、
    // 以及同目录但名字已不在清单里的
    if (!await updateSourceLinks([
      ...settings.settings.kbRawSources.filter(
        link => !(sameKbRoot(link.root, current)
          && (link.name === clean
            || (link.dir && sameDir(link.dir, target) && !manifest.value.some(item => item.name === link.name)))),
      ),
      { root: current, name: clean, dir: target },
    ])) {
      notifyError('保存本机关联失败')
      return false
    }

    // 上传不在这里做：它是清洗的硬前置，交给 startClean 的准备阶段（面板逐步可见，
    // 失败就地拦下）。**不 await**：本地几步一完成就返回（弹窗立刻关），首洗在后台接管
    await reload()
    notifySuccess(`知识库「${clean}」已添加（复制 ${synced.data.copied} 个文件）`)
    void startClean({ kind: 'kb', name: clean })
    return true
  }

  /** 一个知识库名下指向它的全部条目（data 相对路径）：**不管 raw 文件在不在**，删除知识库用 */
  function entryRelsOfLibrary(name: string): string[] {
    return entries.value
      .filter(entry => kbSourceRef(entry.source)?.name === name)
      .map(entry => entry.rel)
  }

  /** 指向某个 raw 文件的全部条目（data 相对路径）：删除文件时一并删 */
  function entryRelsOfRawRel(rel: string): string[] {
    const key = kbSourceLinkKey(rel)
    if (!key)
      return []
    return entries.value.filter(entry => kbSourceLinkKey(entry.source) === key).map(entry => entry.rel)
  }

  /**
   * 删除一个知识库：条目（全部，不管 raw 文件在不在）→ 两层目录（raw/<名>/ 与
   * data/<名>/）→ 清单移除 → 本机关联移除 → 索引重建 → 上传删除。**源头文件夹里的
   * 文件一个都不动**（那是用户自己的目录）。
   */
  async function deleteLibrary(name: string): Promise<boolean> {
    const dir = root.value
    if (!dir || !manifest.value.some(item => item.name === name))
      return false
    if (cleanBusy.value) {
      notifyError('清洗进行中，先停下再删除知识库')
      return false
    }

    const rels = entryRelsOfLibrary(name)
    let deletedEntries = 0
    if (rels.length) {
      const result = await window.workbench.kbEntryDelete(dir, rels)
      if (!result.ok || !result.data) {
        notifyError(result.error ?? '删除条目失败')
        return false
      }
      deletedEntries = result.data.deleted
    }
    const tree = await window.workbench.kbDeleteTree(dir, name)
    if (!tree.ok || !tree.data) {
      notifyError(tree.error ?? '删除知识库失败')
      return false
    }
    if (!await writeManifest(manifest.value.filter(item => item.name !== name)))
      return false
    if (!await updateSourceLinks(
      settings.settings.kbRawSources.filter(
        link => !(sameKbRoot(link.root, dir) && link.name === name),
      ),
    )) {
      notifyError('移除本机关联失败')
      return false
    }

    await window.workbench.kbIndexBuild(dir, todayIsoDate())
    if (canSync.value) {
      const up = await window.workbench.kbSync(dir)
      if (!up.ok || !up.data)
        syncError.value = up.error ?? '同步失败'
    }
    await reload()
    notifySuccess(
      deletedEntries
        ? `已删除知识库「${name}」与它的 ${deletedEntries} 个条目（源头文件夹未动）`
        : `已删除知识库「${name}」（源头文件夹未动）`,
    )
    return true
  }

  /**
   * 删除一个原始文件：仓库里那份与关联的源头文件夹里那份一起删（源头持续关联着，
   * 只删仓库里那份会在下一次源头同步时回来），指向它的条目一并删。确认框在组件里
   * （写明「同时删除本机文件夹中的该文件」）。
   */
  async function deleteFile(rel: string): Promise<boolean> {
    const dir = root.value
    if (!dir)
      return false
    if (cleanBusy.value) {
      notifyError('清洗进行中，先停下再删除文件')
      return false
    }
    const name = kbRawSourceNameOf(rel)
    if (!name)
      return false
    const link = sourceLinks.value.find(item => item.name === name)

    const result = await window.workbench.kbFileDelete(dir, name, link?.dir ?? '', [rel])
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '删除文件失败')
      return false
    }
    const rels = entryRelsOfRawRel(rel)
    if (rels.length) {
      const removed = await window.workbench.kbEntryDelete(dir, rels)
      if (!removed.ok || !removed.data) {
        notifyError(`文件已删除，但条目清理失败：${removed.error ?? '原因不明'}`)
        await reload()
        return false
      }
    }
    await window.workbench.kbIndexBuild(dir, todayIsoDate())
    if (canSync.value) {
      const up = await window.workbench.kbSync(dir)
      if (!up.ok || !up.data)
        syncError.value = up.error ?? '同步失败'
    }
    await reload()
    notifySuccess(link?.dir ? '文件已删除（仓库与源头文件夹）' : '文件已删除')
    return true
  }

  // ---------- 一次性迁移（旧结构 → raw/ + data/） ----------

  /**
   * 迁移旧结构：本机关联的源头文件夹复制进 raw/、`kb/` 搬进 `data/`、条目里的
   * `data/raw/` 前缀改写成 `raw/`、写清单、删旧 index/。确认框在组件里（列出将做的事）。
   * 搬完重建索引并上传（没连远端时只提示，迁移本身已完成）。
   */
  async function migrate(): Promise<boolean> {
    const dir = root.value
    if (!dir || cleanBusy.value)
      return false
    if (!migrateNeeded.value) {
      notifyInfo('这个仓库不需要迁移')
      return false
    }
    if (migrating.value)
      return false
    migrating.value = true
    try {
      // 清单从本机关联造（旧模型里「来源名」就是知识库名的原型）
      const nextManifest: KbManifestEntry[] = manifest.value.length
        ? manifest.value
        : [...new Set(sourceLinks.value.map(link => link.name))].map(name => ({ name, created: '' }))
      const sources = sourceLinks.value
        .filter(link => link.dir)
        .map(link => ({ name: link.name, dir: link.dir }))
      const result = await window.workbench.kbMigrate(dir, sources, serializeKbManifest(nextManifest))
      if (!result.ok || !result.data) {
        notifyError(result.error ?? '迁移失败')
        return false
      }
      await window.workbench.kbAgentsDoc(dir)
      await window.workbench.kbIndexBuild(dir, todayIsoDate())
      if (canSync.value) {
        const up = await window.workbench.kbSync(dir)
        if (!up.ok || !up.data)
          syncError.value = up.error ?? '同步失败'
      }
      await reload()
      notifySuccess(`迁移完成：复制 ${result.data.copied} 个原始文件、改写 ${result.data.rewritten} 个条目`)
      return true
    }
    finally {
      migrating.value = false
    }
  }

  // ---------- git（同步 / 后台拉取 / 仓库探测） ----------

  /** 探一次 git 状态：探不到就当本机文件夹处理（同步入口不出现），不打扰界面 */
  async function probeState(): Promise<void> {
    const current = root.value
    if (!current) {
      repoState.value = null
      return
    }

    const result = await window.workbench.kbRepoState(current)
    repoState.value = result.ok && result.data ? result.data : null
  }

  /**
   * 后台拉一次远端（打开页面 / 换文件夹之后）：列表数据来自远程仓库，pull 下来才有
   * 别的设备推的东西。拉到了新东西就重扫；失败只把原因摆到同步那行 ——
   * 打开页面这件事不该因为网络失败变成一页错误。
   */
  async function pullRemote(): Promise<void> {
    const current = root.value
    if (!current || pulling.value || cleanBusy.value)
      return
    // 现探一次再用：换文件夹 / 别的动作刚跑完时，缓存的仓库状态可能是上一个目录的
    await probeState()
    if (!canSync.value)
      return

    pulling.value = true
    try {
      const result = await window.workbench.kbPull(current)
      if (result.ok && result.data?.received) {
        await reload()
      }
      else if (!result.ok) {
        syncError.value = result.error ?? '拉取远端失败'
      }
    }
    finally {
      pulling.value = false
    }
  }

  /**
   * 与远端同步一次：知识库文件夹自己的那个仓库（提交 → 拉 → 推）。
   * 远端可能刚整理过条目：回来后重扫，正在查看的原始文件也重读。
   */
  async function syncNow(): Promise<void> {
    const current = root.value
    if (!canSync.value) {
      syncError.value = '这个文件夹还没有连 git 远端：没法在这里同步'
      return
    }

    syncing.value = true
    syncError.value = ''
    try {
      const result = await window.workbench.kbSync(current)
      if (!result.ok || !result.data) {
        syncError.value = result.error ?? '同步失败'
        // 常见的一种失败是「用户刚在终端里补上 origin / init 了仓库」：再探一次，让按钮跟上
        void probeState()
        return
      }

      await reload()
      if (activeRawRel.value)
        await openRaw(activeRawRel.value)
    }
    finally {
      syncing.value = false
    }
  }

  let started = false

  /** 首次进页面扫一次（KeepAlive 下来回切页不重挂载，这里挡住重复扫描），扫完后台拉远端 */
  async function init(): Promise<void> {
    if (started)
      return
    started = true
    await reload()
    void pullRemote()
  }

  // 知识库文件夹变了（选了新目录）：全部重新认一遍。正在清洗的话先把它按停 ——
  // 那条 Pi 会话的工作目录还是旧文件夹，让它跑完只会把旧目录的条目写进来
  watch(root, () => {
    if (!started)
      return
    closeRaw()
    if (cleanBusy.value) {
      cleanCancelled = true
      void aiStop(aiSessionProcessId(cleanSessionId))
      cleanPhase.value = 'idle'
      cleanLines.value = []
      cleanError.value = ''
    }
    void reload()
    void pullRemote()
  })

  /**
   * 本机关联变了（加了一个 / 移除了）：列表行的「关联」与清洗范围跟着变，重扫一遍。
   * 比的是**关联的形状**（名字 + 路径），不是数组引用 —— 设置里任何一项改动都会换掉
   * settings 对象，盯着引用就会因为「改了个卡片宽度」去重扫一遍知识库。
   */
  const linkShape = computed(() =>
    sourceLinks.value.map(item => `${item.name}\u0000${item.dir}`).join('\u0001'),
  )
  watch(linkShape, () => {
    if (!started)
      return
    libraries.value = kbLibraryRows(manifest.value, sourceLinks.value, rawItems.value, dangling.value)
  })

  /** 记下用户挑的知识库文件夹（页面那颗「选择知识库文件夹」用它）。不搬动任何文件 */
  async function setRoot(dir: string): Promise<boolean> {
    const target = sanitizeNoteRoot(dir)
    if (!target)
      return false
    return settings.updateSettings({ kbDir: target })
  }

  /**
   * 查看一个原始数据：文本类（md / 认得出的文本后缀）就地读进来预览，其余只摆出
   * 「用系统默认程序打开」的入口（看法的分类在 packages/kb/src/kb.ts 的 kbRawViewKind）。
   * 读失败不关查看区、把原因摆进去 —— 外部打开那条路还在。
   */
  async function openRaw(rel: string): Promise<void> {
    const item = rawItems.value.find(raw => raw.rel === rel)
    activeRawRel.value = rel
    activeRawError.value = ''
    activeRawContent.value = ''

    if (!item || kbRawViewKind(item.name) === 'external')
      return

    activeRawLoading.value = true
    // 带上关联：raw 层的文件本机里有就读本机那份（本机是事实源，副本可能还没同步）
    const result = await window.workbench.kbRead(root.value, rel, activeLinks.value)
    activeRawLoading.value = false
    if (activeRawRel.value !== rel)
      return

    if (!result.ok || typeof result.data !== 'string') {
      activeRawError.value = result.error ?? '读取文件失败'
      return
    }
    activeRawContent.value = result.data
  }

  // ---------- 清洗（应用编排：源头同步 → 上传 → 清单 → Pi → 索引 → 上传） ----------

  /** 清洗流程的阶段（形状见 packages/kb/src/kb-clean.ts） */
  const cleanPhase = ref<KbCleanPhase>('idle')
  /** 清洗的实时日志：与 AI 助手页同一套事件翻译（parsePiEvent），一行一条 */
  const cleanLines = ref<AiLogLine[]>([])
  /** 拦路原因（blocked）或失败原因（failed）：面板里就地说明 */
  const cleanError = ref('')
  /** 本次清洗的会话 id（Pi 的 session-id；进程表里是 `ai:<id>`）。空串 = 还没起过 */
  let cleanSessionId = ''
  /** 起跑前那份条目清单（相对路径）：收据按它分「新建 / 覆盖」 */
  const cleanBefore = ref<string[]>([])
  /** 这一轮洗的范围（面板上说明用） */
  const cleanScope = ref<KbCleanScope>({ kind: 'all' })
  /** 用户点了取消：之后的收尾事件（settle / exit）不再走「完成」那一路 */
  let cleanCancelled = false

  const cleanBusy = computed(() =>
    cleanPhase.value === 'preparing' || cleanPhase.value === 'cleaning' || cleanPhase.value === 'indexing',
  )

  /**
   * 这一轮整理过的**原始文件**（raw 相对路径）：Pi 报出的写入是条目（data/ 下的路径，
   * 用户不关心），拿写入条目 frontmatter 的 source 映射回 raw 层再说 —— 清洗产物的
   * 路径不进界面。「新入库 / 重新入库」拿**起跑前**那份条目清单（cleanBefore）分：
   * 在里面就是覆盖（重新入库）—— 跑完清单已刷新，拿刷新后的比会说全是新建。
   * 条目还没读出来（进行中）或 source 解析不到 raw 文件的，先不进收据。
   */
  const cleanWrites = computed(() => {
    const known = new Set(cleanBefore.value.map(rel => rel.toLowerCase()))
    const created = new Set<string>()
    const updated = new Set<string>()
    for (const rel of writtenEntries(cleanLines.value)) {
      const meta = entries.value.find(item => item.rel.toLowerCase() === rel.toLowerCase())
      const ref = meta ? kbSourceRef(meta.source) : null
      if (!ref)
        continue
      const raw = kbRawDisplayPath(`${KB_RAW_DIR}/${ref.name}/${ref.inner}`)
      ;(known.has(rel.toLowerCase()) ? updated : created).add(raw)
    }
    return {
      created: [...created].sort((a, b) => a.localeCompare(b)),
      updated: [...updated].sort((a, b) => a.localeCompare(b)),
    }
  })

  /**
   * 起跑前还缺什么：顺序归 AI store 的 envGap（与 AI 助手页的 blocking、run 的校验
   * 同一条级联，Node → Pi → 模型 → 密钥），少「工作目录 / 指令」两样 ——
   * 目录就是知识库文件夹，指令是应用拼的。文案是清洗面板自己的折中版。
   */
  function cleanBlocker(): string {
    const ai = useAiStore()
    if (!ai.probed)
      return '正在探测运行环境…'
    switch (ai.envGap()) {
      case 'node':
        return `这台机器的 Node 太旧：跑 ${settings.settings.appName} 需要 Node ≥ 22.19，先把 Node 升上去。`
      case 'pi':
        return `没找到 ${settings.settings.appName} 运行时：随包内置的那份不在，PATH 上也没有全局安装的。`
      case 'model':
        return '还没配模型：添加一个 AI 服务（预设厂商或自定义端点）并选上模型。'
      case 'key':
        return `还没有配置 ${ai.providerLabel} 的 API Key。`
    }
    return ''
  }

  /** 清洗面板的拦截态：原因摆进面板，就地说明 */
  function blocked(message: string): void {
    cleanLines.value = []
    cleanError.value = message
    cleanPhase.value = 'blocked'
  }

  /** 清洗范围里要动的 raw 文件清单（清洗清单以它算） */
  function itemsInScope(scope: KbCleanScope): KbRawItem[] {
    if (scope.kind === 'file')
      return rawItems.value.filter(item => item.rel === scope.rel)
    if (scope.kind === 'kb')
      return rawItems.value.filter(item => kbRawSourceNameOf(item.rel) === scope.name)
    return rawItems.value
  }

  /**
   * 开始清洗（范围由调用方给：全库 / 某个知识库 / 某个文件）。
   *
   * **面板先开（preparing）、每步打日志**：下面这几步是实打实的耗时（上传是三次出网），
   * 不给反馈就是「点了没反应」——
   *
   * 1. **源头同步** —— 本机关联的源头文件夹里改过的文件先复制进 raw（不删）；
   * 2. 有复制就重扫一遍，清单以同步后的 raw 为准；
   * 3. **上传远程（硬前置）** —— 没连远端、提交推送失败都在这里拦下，不让
   *    「本地洗了、远端没有」的状态发生；
   * 4. 算清单（未入库 + 有更新，按范围过滤），没有待洗的就收场明说；
   * 5. 起一条**专用的 Pi 会话**（不在 AI 助手页的会话树里 —— 那棵树认的是设置里的
   *    aiSessions 清单，这里不写入；留档照旧落在 `data\pi\sessions\`，可审计）。
   *
   * 准备阶段可取消（还没有 Pi 进程，直接收）；每步之间都有取消检查，在途的那一步
   * （如上传）做完就停。
   */
  async function startClean(scope: KbCleanScope = { kind: 'all' }): Promise<void> {
    if (cleanBusy.value)
      return
    const dir = root.value
    if (!dir || !loaded.value || !looksLikeKb.value)
      return

    // 面板先开、每步打日志：源头同步与上传远程都是实打实的耗时（上传是三次出网），
    // 不给反馈的话这几秒就是「点了没反应」
    cleanScope.value = scope
    cleanCancelled = false
    cleanError.value = ''
    cleanLines.value = [
      { kind: 'info', text: '准备清洗：同步源头文件夹 → 上传远程仓库 → 算清洗清单…' },
    ]
    cleanPhase.value = 'preparing'

    // 环境没探过先探一次（AI 页开没开过都可能）：缺什么就地明说，面板给得出拦路屏
    const ai = useAiStore()
    if (!ai.probed)
      await ai.probe()
    const blocker = cleanBlocker()
    if (blocker) {
      blocked(blocker)
      return
    }

    // ① 源头同步：清洗范围里有关联的知识库，把本机改过的文件带进 raw
    const inScope = (name: string): boolean => {
      if (scope.kind === 'kb')
        return name === scope.name
      if (scope.kind === 'file')
        return kbRawSourceNameOf(scope.rel) === name
      return true
    }
    const linked = sourceLinks.value.filter(link => link.dir && inScope(link.name))
    let copied = 0
    if (linked.length) {
      cleanLines.value = [
        ...cleanLines.value,
        { kind: 'info', text: '正在同步源头文件夹（本机改过的文件先复制进仓库）…' },
      ]
      for (const link of linked) {
        const synced = await window.workbench.kbSourceSync(dir, link.name, link.dir)
        if (!synced.ok || !synced.data) {
          blocked(synced.error ?? '同步源头文件夹失败')
          return
        }
        copied += synced.data.copied
      }
      if (cleanCancelled) {
        cleanPhase.value = 'cancelled'
        return
      }
    }

    // ② 源头有变化就重扫：状态清单以同步后的 raw 为准（本地改过的文件这才「看得见」）
    if (copied > 0) {
      cleanLines.value = [
        ...cleanLines.value,
        { kind: 'info', text: `源头同步了 ${copied} 个文件，重新扫描…` },
      ]
      await reload()
      if (cleanCancelled) {
        cleanPhase.value = 'cancelled'
        return
      }
    }

    // ③ 上传远程（硬前置）：提交 → 拉取 → 推送三次出网，是这段等待的大头
    if (!canSync.value) {
      blocked('知识库文件夹还没连 git 远端：清洗前必须把原始文件上传到远程仓库。先把它做成仓库并接上远端，再回来清洗。')
      return
    }
    cleanLines.value = [
      ...cleanLines.value,
      { kind: 'info', text: '正在上传远程仓库（提交 → 拉取 → 推送）——清洗前必须把原始文件送上去…' },
    ]
    syncing.value = true
    syncError.value = ''
    try {
      const up = await window.workbench.kbSync(dir)
      if (!up.ok || !up.data) {
        blocked(`原始文件还没上传成功（${up.error ?? '原因不明'}），清洗先停在这里；处理好远端再洗。`)
        void probeState()
        return
      }
      if (cleanCancelled) {
        cleanPhase.value = 'cancelled'
        return
      }
    }
    finally {
      syncing.value = false
    }

    // ④ 算清单：没有待洗的就收场（面板退回，提示一句话）
    const pendingItems = itemsInScope(scope).filter(item => item.status === 'pending')
    const staleItems = itemsInScope(scope).filter(item => item.status === 'stale')
    if (!pendingItems.length && !staleItems.length) {
      cleanPhase.value = 'idle'
      cleanLines.value = []
      notifyInfo('没有要清洗的原始数据')
      return
    }
    const targetItems = [...pendingItems, ...staleItems]
    const hashResult = await window.workbench.kbFingerprints(dir, targetItems.map(item => item.rel))
    const hashes = hashResult.ok && hashResult.data ? hashResult.data : {}
    const targetOf = (item: KbRawItem) => ({
      rel: item.rel,
      abs: item.abs,
      hash: hashes[item.rel] ?? '',
    })
    const pending = pendingItems.map(targetOf)
    const stale = staleItems.map(targetOf)

    const sessionId = crypto.randomUUID()
    cleanSessionId = sessionId
    // 收据的底：这一轮跑完要说清哪些是新建、哪些是覆盖，得先记下跑之前的清单
    cleanBefore.value = entries.value.map(item => item.rel)
    // 准备阶段的日志留着（源头同步 / 上传各花了几步可见），接着进入正式清洗
    cleanLines.value = [
      ...cleanLines.value,
      {
        kind: 'info',
        text: `开始清洗：未入库 ${pending.length} 个、有更新 ${stale.length} 个（模型 ${ai.providerLabel} · ${ai.runModel}）`,
      },
    ]
    cleanError.value = ''
    cleanPhase.value = 'cleaning'

    const procId = aiSessionProcessId(sessionId)
    const launch = piLaunch(
      ai.cliPath || null,
      { provider: ai.providerName, model: ai.runModel, thinking: ai.thinking },
      sessionId,
    )

    // 先挂回调再起进程（事件按进程 id 路由，顺序反了会丢开头那几行），见 workbench/ai.ts
    const result = await aiRun(
      {
        sessionId: procId,
        dir,
        prompt: kbCleanPrompt({ pending, stale, today: todayIsoDate() }),
        // 清洗这条路没有输入框：提示词由应用拼，也就没有随句贴的图
        images: [],
        program: launch.program,
        args: launch.args,
        provider: ai.providerName,
        // 清洗固定「完全访问」：探索目录结构要用只读命令（这版 Pi 的 read 读不了目录，
        // 不给 bash 它连清单里的文件都找不全）；改动性的操作由提示词约束
        permission: 'full',
        // 技能：只带**全局那几条**（开着的）—— 清洗在知识库自己的目录里跑，那里没有
        // 「项目技能」这回事；AI 助手页当前那个目录的项目技能不该漏到这儿来
        skills: useAiSkillsStore().globalRefs,
      },
      {
        onLine: (line) => {
          if (cleanSessionId !== sessionId)
            return
          cleanLines.value = [...cleanLines.value, line]
          // agent_settled：这一轮收工。接下来是应用自己的收尾（收进程 → 重建索引 → 上传）
          if (line.kind === 'done' && !cleanCancelled)
            void finishClean(sessionId)
        },
        // 流式增量不进清洗面板：整段到位时（message_end）自然作为一行出现
        onDelta: () => {},
        // 消耗只在 AI 助手页的收据上记账（清洗面板没有「用时」那一行）
        onUsage: () => {},
        onConfirm: (confirm) => {
          if (cleanSessionId !== sessionId)
            return
          // 「完全访问」不加载权限扩展，确认帧本不该来；真来了（别的扩展源头）还是挡回去，
          // 不让一次没人答的询问把流程吊死
          void aiSend(procId, confirmFrame(confirm.id, false))
          cleanLines.value = [
            ...cleanLines.value,
            {
              kind: 'info',
              text: `${settings.settings.appName} 想执行命令，已自动拒绝`,
              detail: confirm.message,
            },
          ]
        },
        onExit: (code) => {
          if (cleanSessionId !== sessionId)
            return
          // 自己收的进程（取消 / 收尾）不算事；只有「正在清洗时进程自己没了」才是失败
          if (cleanCancelled || cleanPhase.value !== 'cleaning')
            return
          cleanPhase.value = 'failed'
          cleanError.value
            = code === null ? '清洗进程意外退出了' : `清洗进程退出了（退出码 ${code}），可以重试`
        },
      },
    )

    if (!result.ok) {
      cleanPhase.value = 'failed'
      cleanError.value = result.error ?? '启动失败'
      notifyError(cleanError.value)
    }
  }

  /** 清洗的收尾：收掉进程 → 重建索引 → 把新条目推上去 → 刷新清单 */
  async function finishClean(sessionId: string): Promise<void> {
    if (cleanPhase.value !== 'cleaning' || cleanSessionId !== sessionId)
      return
    cleanPhase.value = 'indexing'
    // 一次性任务不留常驻进程：一轮跑完就收（留档在盘上，不跟着进程走）
    await aiStop(aiSessionProcessId(sessionId))

    const current = root.value
    if (!current) {
      cleanPhase.value = 'failed'
      cleanError.value = '清洗已完成，但知识库文件夹读不到了：没法收尾'
      return
    }
    const built = await window.workbench.kbIndexBuild(current, todayIsoDate())
    if (!built.ok || !built.data) {
      cleanPhase.value = 'failed'
      cleanError.value = `清洗完成，但收尾（重建索引）失败：${built.error ?? '原因不明'}`
      notifyError(cleanError.value)
      return
    }
    // 条目推上去（清洗的前半程上传的是 raw，这一步把 data 的新条目也送上去）
    let pushed = true
    if (canSync.value) {
      const up = await window.workbench.kbSync(current)
      if (!up.ok || !up.data) {
        pushed = false
        syncError.value = up.error ?? '同步失败'
      }
    }
    await reload()
    if (activeRawRel.value)
      await openRaw(activeRawRel.value)
    cleanPhase.value = 'done'
    if (pushed) {
      notifySuccess('清洗完成，已上传远程')
    }
    else {
      cleanLines.value = [
        ...cleanLines.value,
        { kind: 'info', text: '清洗完成，但上传远程失败：点工具条上的「同步」补一次。' },
      ]
      notifySuccess('清洗完成；上传失败，点「同步」补一次')
    }
  }

  /** 停下清洗：准备阶段直接收（还没有 Pi 进程）；清洗中先走 Pi 自己的 abort，再按进程树收掉 */
  async function stopClean(): Promise<void> {
    if (cleanPhase.value !== 'cleaning' && cleanPhase.value !== 'preparing')
      return
    cleanCancelled = true
    if (cleanPhase.value === 'cleaning') {
      const procId = aiSessionProcessId(cleanSessionId)
      await aiAbort(procId)
      await aiStop(procId)
    }
    cleanPhase.value = 'cancelled'
    await reload()
  }

  /** 收起清洗面板（回到概览）。正在跑的时候不给收 —— 流程还没完 */
  function closeClean(): void {
    if (cleanBusy.value)
      return
    cleanPhase.value = 'idle'
    cleanLines.value = []
    cleanError.value = ''
  }

  /** 删除失联条目（一个 raw 文件对应的那一组）：确认框在组件里，这里删 → 重建索引 → 刷新 */
  async function purgeEntries(groups: KbDanglingGroup[]): Promise<boolean> {
    const current = root.value
    const rels = [...new Set(groups.flatMap(group => group.entryRels))]
    if (!current || !rels.length)
      return false
    if (cleanBusy.value) {
      notifyError('清洗进行中，先停下再清理失联条目')
      return false
    }

    const result = await window.workbench.kbEntryDelete(current, rels)
    if (!result.ok || !result.data) {
      notifyError(result.error ?? '删除条目失败')
      return false
    }

    // 与清洗收尾同一条路：删完立刻重建索引，再刷新清单（「已删除 N」随重扫消失）
    const built = await window.workbench.kbIndexBuild(current, todayIsoDate())
    if (canSync.value) {
      const up = await window.workbench.kbSync(current)
      if (!up.ok || !up.data)
        syncError.value = up.error ?? '同步失败'
    }
    await reload()
    if (!built.ok) {
      notifyError(`条目已删除（${result.data.deleted} 个），但重建索引失败：${built.error ?? '原因不明'}`)
      return false
    }
    notifySuccess(`已清理 ${result.data.deleted} 个失联条目`)
    return true
  }

  return {
    root,
    sourceLinks,
    repoState,
    remoteUrl,
    canSync,
    scanEntries,
    manifest,
    entries,
    rawItems,
    libraries,
    dangling,
    loading,
    loaded,
    loadError,
    activeRawRel,
    activeRaw,
    activeRawKind,
    activeRawContent,
    activeRawLoading,
    activeRawError,
    syncing,
    pulling,
    syncError,
    migrating,
    stats,
    locationText,
    looksLikeKb,
    migrateNeeded,
    cleanPhase,
    cleanLines,
    cleanError,
    cleanBusy,
    cleanWrites,
    cleanScope,
    init,
    reload,
    detect,
    setRoot,
    addLibrary,
    deleteLibrary,
    deleteFile,
    entryRelsOfLibrary,
    entryRelsOfRawRel,
    purgeEntries,
    migrate,
    openRaw,
    closeRaw,
    syncNow,
    pullRemote,
    startClean,
    stopClean,
    closeClean,
  }
})
