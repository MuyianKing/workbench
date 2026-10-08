import type { AiLogLine } from '@workbench/ai'
import type { KbCleanPhase, KbEntryMeta, KbIndexInfo, KbIssue, KbRawItem, KbRawSource, KbRawSourceRow, KbRawViewKind, KbRepoState, KbScanEntry, KbStats } from '@workbench/kb'

import { confirmFrame, piLaunch, writtenEntries } from '@workbench/ai'
import { KB_DIR, KB_INDEX_REL, KB_RAW_DIR, kbCleanPrompt, kbEntryFiles, kbEntryLinks, kbLint, kbRawFiles, kbRawSourceRows, kbRawSourcesFor, kbRawViewKind, kbStats, kbTagCounts, kbVisibleRawEntries, matchKbRawStatus, normalizeKbSource, parseKbFrontmatter, parseKbIndex, resolveKbLink, sameKbRoot, sanitizeKbRawSources, sanitizeKbSourceName, splitCleanWrites, todayIsoDate } from '@workbench/kb'

import { noteRootName, sanitizeNoteRoot } from '@workbench/notes'
import { defineStore } from 'pinia'
/**
 * 知识库：清单、条目、原始数据与入库状态的编排，外加**清洗**这件事的全程驱动。
 *
 * 与笔记 / 技能 store 同一个思路：知识库就是用户挑的那个文件夹（一个独立项目的根），
 * 这里没有内存副本 ——「条目」是扫出来再逐个读 frontmatter 的、「原始数据」是扫出来的，
 * 应用对条目内容**只读**。清洗由应用编排：扫描出的待处理清单 + kb-clean.ts 里的提示词
 * 交给内置的 Pi（走 ai.rs 那条通用驱动链路），盯完一轮自动重建索引、刷新状态 ——
 * 用户不写指令、不碰提示词。
 *
 * 状态判定的口径（source 配对 + mtime 比较）在 shared/kb.ts 的纯函数里，这边只编排：
 * 扫描 → 拆三部分（条目 / 原始数据 / 索引）→ 配状态 → 界面取用。另有两件「库内一致性」
 * 的事也在这里收口：**巡检**（shared/kb-lint.ts 的 kbLint，只读报告，算着但界面不展示）与
 * **站内链接**（条目正文里点一条 → followLink 解析成条目或原始数据，再走上面那两条开口）。
 *
 * **原始数据的来源**（来源名 → 本机一个文件夹）也归这里编：映射住在设置里、只对本机成立，
 * 应用不搬运任何文件。检测是**手动**的（工具条那颗「检测更新」= reload + 报一句结果），
 * 不设后台轮询、也没有自动清洗 —— 这一页的动作都由用户点出来。
 */
import { computed, ref, watch } from 'vue'
import { notifyError, notifyInfo, notifySuccess } from '@/notify'
import { useAiStore } from '@/stores/ai'
import { useAiSkillsStore } from '@/stores/ai-skills'
import { useSettingsStore } from '@/stores/settings'
import { aiAbort, aiRun, aiSend, aiSessionProcessId, aiStop } from '@/workbench/ai'

export const useKbStore = defineStore('kb', () => {
  const settings = useSettingsStore()

  /**
   * 知识库文件夹：**用户自己挑的一个目录**（一个独立项目的根）。
   * 空串 = 还没选过，整页只给引导。与笔记 / 技能文件夹互不相干。
   */
  const root = computed(() => settings.settings.kbDir)
  /** 当前知识库配的原始数据来源（别的知识库配的不串过来） */
  const sources = computed<KbRawSource[]>(() =>
    kbRawSourcesFor(settings.settings.kbRawSources, root.value),
  )
  /** 文件夹的 git 状态（探出来的、不落盘）：有没有仓库与远端决定给不给同步按钮 */
  const repoState = ref<KbRepoState | null>(null)
  const remoteUrl = computed(() => repoState.value?.origin ?? '')
  const canSync = computed(() => repoState.value?.isRepo === true && remoteUrl.value !== '')

  /** 扫描的原始平铺清单（**全量**：来源行要看库里那份副本还在不在，所以不在这里摘） */
  const scanEntries = ref<KbScanEntry[]>([])
  const entries = ref<KbEntryMeta[]>([])
  const rawItems = ref<KbRawItem[]>([])
  /** 来源行（最外层那一格）：配置与库里 data/raw 的顶层目录合起来，带每个来源的几个数 */
  const rawSources = ref<KbRawSourceRow[]>([])
  /**
   * 上一次检测报出去的几个数（「检测更新」那颗按钮）：只说**变化**用（「发现了 2 处更新」
   * 比把总数再说一遍有用）。它记的是「上一次报给你的话」，不是数据事实，所以只在内存里、
   * 不落盘、也不进设置 —— 进设置就成了第二份真源。
   */
  const lastDetect = ref<KbStats | null>(null)
  const indexInfo = ref<KbIndexInfo | null>(null)

  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref('')

  /** 当前打开的条目（kb 相对路径）与它的正文；没有打开的就是概览 */
  const activeRel = ref('')
  const activeContent = ref('')
  const activeLoading = ref(false)
  const activeError = ref('')

  /** 当前查看的原始数据（data/raw 相对路径）与正文；没有查看的就是概览。与条目查看互斥 */
  const activeRawRel = ref('')
  const activeRawContent = ref('')
  const activeRawLoading = ref(false)
  const activeRawError = ref('')

  const syncing = ref(false)
  const syncError = ref('')
  /** 重建索引正在进行（那颗按钮转圈用） */
  const rebuilding = ref(false)

  const activeEntry = computed(() => entries.value.find(item => item.rel === activeRel.value) ?? null)
  /** 正在查看的原始数据（清单里那一条）与它该怎么看（按后缀分：渲染 / 纯文本 / 交出去） */
  const activeRaw = computed(() => rawItems.value.find(item => item.rel === activeRawRel.value) ?? null)
  const activeRawKind = computed<KbRawViewKind>(() =>
    activeRaw.value ? kbRawViewKind(activeRaw.value.name) : 'external',
  )
  const stats = computed(() => kbStats(entries.value, rawItems.value))
  const tagCounts = computed(() => kbTagCounts(entries.value))
  /** 巡检：库内一致性的**只读**检查（孤儿 / 断链 / 元数据 / 出处 / 主题目录） */
  const lintIssues = computed<KbIssue[]>(() =>
    kbLint(
      entries.value,
      // 被映射顶掉的库里那份不进巡检的「库里有什么」：以映射为准，与清单、与状态同一口径
      kbVisibleRawEntries(scanEntries.value, sources.value),
      rawSources.value,
    ),
  )
  const locationText = computed(() => noteRootName(root.value))
  /**
   * 选的文件夹像不像一个知识库：有 `kb/`、有库里的 `data/raw/`、或者配过来源都算
   * （原始资料现在多半在库外，「只有 kb/」也是一种正常的摆法）。
   */
  const looksLikeKb = computed(
    () =>
      scanEntries.value.some(item => item.rel === KB_DIR || item.rel.startsWith(`${KB_DIR}/`))
      || scanEntries.value.some(
        item => item.rel === KB_RAW_DIR || item.rel.startsWith(`${KB_RAW_DIR}/`),
      )
      || sources.value.length > 0,
  )

  function reset(): void {
    scanEntries.value = []
    entries.value = []
    rawItems.value = []
    rawSources.value = []
    indexInfo.value = null
    repoState.value = null
    lastDetect.value = null
    closeActive()
    closeRaw()
    loaded.value = false
    loadError.value = ''
    syncError.value = ''
  }

  function closeActive(): void {
    activeRel.value = ''
    activeContent.value = ''
    activeError.value = ''
  }

  /** 收起原始数据查看（回到概览） */
  function closeRaw(): void {
    activeRawRel.value = ''
    activeRawContent.value = ''
    activeRawError.value = ''
  }

  /**
   * 重新扫一遍：扫描 → 拆三部分 → 读条目 frontmatter → 配状态 → 读索引 → 探仓库。
   *
   * 条目是逐个读出来解析的（source 在 frontmatter 里，状态判定绕不开），几十上百个
   * 本地小文件并发读，量级与笔记首扫相当；读不出的（权限 / 刚被删）如实丢掉 ——
   * 少一条只是清单上少一行，不该让整页读不出来。
   *
   * 来源清单一起带过去（Rust 不缓存它）：回来的 rel 一律是**逻辑路径**，来源里的文件
   * 落在 `data/raw/<来源名>/…` 下，真实位置在每条的 abs 里。配了路径却读不到的来源
   * 只在自己的结果里报原因，界面把它摆到那一行上。
   */
  async function reload(): Promise<void> {
    if (!root.value) {
      reset()
      return
    }

    loading.value = true
    loadError.value = ''
    const result = await window.workbench.kbScan(root.value, sources.value)
    loading.value = false

    if (!result.ok || !result.data) {
      reset()
      loadError.value = result.error ?? '读取知识库失败'
      return
    }

    // 全量清单留着（来源行要看库里那份副本还在不在）；被映射顶掉的那部分在取用处分流
    scanEntries.value = result.data.entries
    const visible = kbVisibleRawEntries(result.data.entries, sources.value)
    const current = root.value

    const metas = await Promise.all(
      kbEntryFiles(visible).map(async (file): Promise<KbEntryMeta | null> => {
        const read = await window.workbench.kbRead(current, file.rel, sources.value)
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
          // 正文里的站内链接在这里一次读出来带着走：巡检与站内跳转都不必再读一遍文件
          links: kbEntryLinks(read.data),
          mtimeMs: file.mtimeMs,
        }
      }),
    )
    entries.value = metas.filter((meta): meta is KbEntryMeta => meta !== null)
    rawItems.value = matchKbRawStatus(kbRawFiles(visible), entries.value)
    rawSources.value = kbRawSourceRows(
      sources.value,
      result.data.sources,
      result.data.entries,
      rawItems.value,
    )

    // 索引：读不到 / 认不出都按「还没生成」处理，不是错误（清单不依赖它）
    const indexRead = await window.workbench.kbRead(current, KB_INDEX_REL, sources.value)
    indexInfo.value
      = indexRead.ok && typeof indexRead.data === 'string' ? parseKbIndex(indexRead.data) : null

    // 打开着的条目没了（整理重排 / 换了文件夹）：收起来，别挂着一个空壳。
    // 正在查看的原始数据同理 —— 它清走 / 重洗后文件可能就没了
    if (activeRel.value && !entries.value.some(item => item.rel === activeRel.value)) {
      closeActive()
    }
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
   * 只读、不写任何文件，也不清洗 —— 清洗是另一颗按钮、由用户明明白白点出来。
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

  // ---------- 来源（原始数据最外层对到本机一个文件夹） ----------
  //
  // 映射只落设置、只对本机成立；**应用不搬运 / 不复制 / 不删除任何文件** —— 换路径、
  // 移除来源动的都只是这条配置（库里那份副本还在原处，移除后会照旧读它）。

  /** 来源名与路径都收敛过再落盘（收敛函数在 @workbench/kb，与设置读侧同一份口径） */
  async function updateSources(next: KbRawSource[]): Promise<boolean> {
    return settings.updateSettings({ kbRawSources: sanitizeKbRawSources(next) })
  }

  /**
   * 加一个来源（名称 + 文件夹）。同名已经在清单里时不重复加：名字是条目 source 的契约，
   * 悄悄换一个名字下挂的文件夹会让状态判定说不清。
   */
  async function addSource(name: string, dir: string): Promise<boolean> {
    const clean = sanitizeKbSourceName(name)
    const target = sanitizeNoteRoot(dir)
    if (!root.value || !clean || !target)
      return false
    if (sources.value.some(source => source.name.toLowerCase() === clean.toLowerCase())) {
      notifyError(`已经有叫「${clean}」的来源了`)
      return false
    }
    return updateSources([...settings.settings.kbRawSources, { root: root.value, name: clean, dir: target }])
  }

  /** 给一个来源指定 / 更换文件夹（「还没有配置路径」的那一行就是它再指定一次） */
  async function setSourceDir(name: string, dir: string): Promise<boolean> {
    const current = root.value
    const target = sanitizeNoteRoot(dir)
    if (!current || !target)
      return false

    const next = settings.settings.kbRawSources.filter(
      item => !(sameKbRoot(item.root, current) && item.name.toLowerCase() === name.toLowerCase()),
    )
    next.push({ root: current, name, dir: target })
    return updateSources(next)
  }

  /**
   * 移除一个来源：**只删这条配置**（库里那份副本、来源文件夹里的东西都不动）。
   * 库里没有副本时这一行就从树上消失；有副本时它会退回「读库里那份」的样子。
   */
  async function removeSource(name: string): Promise<boolean> {
    const current = root.value
    if (!current)
      return false
    return updateSources(
      settings.settings.kbRawSources.filter(
        item => !(sameKbRoot(item.root, current) && item.name.toLowerCase() === name.toLowerCase()),
      ),
    )
  }

  /** 在资源管理器里打开一个来源的文件夹（未配置路径的行没有落点，界面不给这个入口） */
  function revealSource(row: KbRawSourceRow): void {
    if (!row.dir)
      return
    void window.workbench.reveal(row.dir)
  }

  /** 探一次 git 状态：探不到就当本机文件夹处理（同步按钮不出现），不打扰界面 */
  async function probeState(): Promise<void> {
    const current = root.value
    if (!current) {
      repoState.value = null
      return
    }

    const result = await window.workbench.kbRepoState(current)
    repoState.value = result.ok && result.data ? result.data : null
  }

  let started = false
  let ready = false

  /** 首次进页面扫一次（KeepAlive 下来回切页不重挂载，这里挡住重复扫描） */
  async function init(): Promise<void> {
    if (started && ready)
      return
    started = true
    await reload()
  }

  // 知识库文件夹变了（选了新目录）：全部重新认一遍。正在清洗的话先把它按停 ——
  // 那条 Pi 会话的工作目录还是旧文件夹，让它跑完只会把旧目录的条目写进来
  watch(root, () => {
    if (!started)
      return
    ready = false
    closeActive()
    closeRaw()
    if (cleanBusy.value) {
      cleanCancelled = true
      void aiStop(aiSessionProcessId(cleanSessionId))
      cleanPhase.value = 'idle'
      cleanLines.value = []
      cleanError.value = ''
    }
    void reload()
  })

  /**
   * 来源映射变了（加了一个 / 换了路径 / 移除了）：重新扫一遍。
   *
   * 比的是**映射的形状**（名字 + 路径），不是数组引用 —— 设置里任何一项改动都会换掉
   * settings 对象，盯着引用就会因为「改了个卡片宽度」去重扫一遍知识库。
   */
  const sourceShape = computed(() => JSON.stringify(sources.value.map(item => [item.name, item.dir])))
  watch(sourceShape, () => {
    if (!started)
      return
    void reload()
  })

  /** 记下用户挑的知识库文件夹（页面那颗「选择知识库文件夹」用它）。不搬动任何文件 */
  async function setRoot(dir: string): Promise<boolean> {
    const target = sanitizeNoteRoot(dir)
    if (!target)
      return false
    return settings.updateSettings({ kbDir: target })
  }

  /**
   * 打开一个条目：读正文进阅读区。慢一步回来的旧结果直接丢掉（连点两行时各回各的）。
   * 读失败留在概览并提示，不挂一个空壳阅读区。与原始数据查看互斥：打开条目就收起它。
   */
  async function openEntry(rel: string): Promise<void> {
    closeRaw()
    activeRel.value = rel
    activeError.value = ''
    activeContent.value = ''

    activeLoading.value = true
    const result = await window.workbench.kbRead(root.value, rel, sources.value)
    activeLoading.value = false
    if (activeRel.value !== rel)
      return

    if (!result.ok || typeof result.data !== 'string') {
      activeError.value = result.error ?? '读取条目失败'
      notifyError(activeError.value)
      closeActive()
      return
    }
    activeContent.value = result.data
  }

  function backToOverview(): void {
    closeActive()
  }

  /**
   * 条目正文里点了一个站内链接：把地址解析成仓库里的一条路径（口径在 shared/kb-lint.ts），
   * 再按它是什么开条目或原始数据 —— 链接指到原始资料上也照样跳（`../../data/raw/x.md`）。
   * 库里没有这一份就一句话说清，不静默什么都不做（点了没反应最让人犯嘀咕）。
   */
  async function followLink(fromRel: string, href: string): Promise<void> {
    const rel = resolveKbLink(fromRel, href)
    if (!rel) {
      notifyInfo('这个链接跳不到知识库里')
      return
    }
    if (entries.value.some(item => item.rel === rel)) {
      await openEntry(rel)
      return
    }
    if (rawItems.value.some(item => item.rel === rel)) {
      await openRaw(rel)
      return
    }
    notifyInfo(`库里没有这一份：${rel}`)
  }

  /**
   * 查看一个原始数据：文本类（md / 认得出的文本后缀）就地读进来预览，其余只摆出
   * 「用系统默认程序打开」的入口（看法的分类在 shared/kb.ts 的 kbRawViewKind）。
   * 读失败不关查看区、把原因摆进去 —— 外部打开那条路还在。与条目查看互斥。
   */
  async function openRaw(rel: string): Promise<void> {
    closeActive()
    const item = rawItems.value.find(raw => raw.rel === rel)
    activeRawRel.value = rel
    activeRawError.value = ''
    activeRawContent.value = ''

    if (!item || kbRawViewKind(item.name) === 'external')
      return

    activeRawLoading.value = true
    const result = await window.workbench.kbRead(root.value, rel, sources.value)
    activeRawLoading.value = false
    if (activeRawRel.value !== rel)
      return

    if (!result.ok || typeof result.data !== 'string') {
      activeRawError.value = result.error ?? '读取文件失败'
      return
    }
    activeRawContent.value = result.data
  }

  /**
   * 与远端同步一次：知识库文件夹自己的那个仓库（提交 → 拉 → 推）。
   * 远端可能刚整理过条目：回来后重扫，打开着的那篇也重读。
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
      const result = await window.workbench.kbSync({ dir: current })
      if (!result.ok || !result.data) {
        syncError.value = result.error ?? '同步失败'
        // 常见的一种失败是「用户刚在终端里补上 origin / init 了仓库」：再探一次，让按钮跟上
        void probeState()
        return
      }

      await reload()
      // 打开着的东西重读一遍：远端 / 清洗可能刚改过它们
      if (activeRel.value)
        await openEntry(activeRel.value)
      else if (activeRawRel.value)
        await openRaw(activeRawRel.value)
    }
    finally {
      syncing.value = false
    }
  }

  /**
   * 重建目录与索引（`kb/_catalog.md` 与 `index/index.json`）。
   *
   * 这是应用**唯一直接写知识库的地方**，写的是生成物、不是内容。两处会用到它：
   * 用户自己点这颗按钮（手改过条目、或从别处拉回了新的条目），以及清洗跑完的收尾
   * （见 finishClean）。索引只由应用生成（见 kb.rs 的 index_build）。
   */
  async function rebuildIndex(): Promise<void> {
    const current = root.value
    if (!current)
      return

    rebuilding.value = true
    try {
      const result = await window.workbench.kbIndexBuild(current, todayIsoDate())
      if (!result.ok || !result.data) {
        notifyError(result.error ?? '重建索引失败')
        return
      }
      notifySuccess(`目录与索引已重建（${result.data.count} 条）`)
      await reload()
    }
    finally {
      rebuilding.value = false
    }
  }

  // ---------- 清洗（应用编排：清单 → Pi → 重建索引 → 刷新） ----------

  /** 清洗流程的阶段（形状见 shared/kb-clean.ts） */
  const cleanPhase = ref<KbCleanPhase>('idle')
  /** 清洗的实时日志：与 AI 助手页同一套事件翻译（parsePiEvent），一行一条 */
  const cleanLines = ref<AiLogLine[]>([])
  /** 拦路原因（blocked）或失败原因（failed）：面板里就地说明 */
  const cleanError = ref('')
  /** 本次清洗的会话 id（Pi 的 session-id；进程表里是 `ai:<id>`）。空串 = 还没起过 */
  let cleanSessionId = ''
  /** 起跑前那份条目清单（相对路径）：收据按它分「新建 / 覆盖」 */
  const cleanBefore = ref<string[]>([])
  /** 用户点了取消：之后的收尾事件（settle / exit）不再走「完成」那一路 */
  let cleanCancelled = false

  const cleanBusy = computed(() => cleanPhase.value === 'cleaning' || cleanPhase.value === 'indexing')

  /**
   * 这一轮动过的条目：Pi 报出的写入路径（工具行里带着的）分成新建与覆盖两组。
   * 与旧清单比对的是**起跑前**那份（cleanBefore）—— 跑完清单已经刷新过，拿它比会说全是新建。
   */
  const cleanWrites = computed(() =>
    splitCleanWrites(root.value, writtenEntries(cleanLines.value), cleanBefore.value),
  )

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
        return '这台机器的 Node 太旧：跑 Pi 需要 Node ≥ 22.19，先把 Node 升上去。'
      case 'pi':
        return '没找到 Pi 运行时：随包内置的那份不在，PATH 上也没有全局安装的。'
      case 'model':
        return '还没配模型：添加一个 AI 服务（预设厂商或自定义端点）并选上模型。'
      case 'key':
        return `还没有配置 ${ai.providerLabel} 的 API Key。`
    }
    return ''
  }

  /**
   * 开始清洗：把扫描出的待处理清单拼进提示词，起一条**专用的 Pi 会话**（不在 AI 助手页的
   * 会话树里 —— 那棵树认的是设置里的 aiSessions 清单，这里不写入；留档照旧落在
   * `data\pi\sessions\`，可审计）。跑完自动重建索引并刷新状态。
   */
  async function startClean(): Promise<void> {
    if (cleanBusy.value)
      return
    const dir = root.value
    if (!dir || !loaded.value || !looksLikeKb.value)
      return

    // 环境没探过先探一次（AI 页开没开过都可能）：缺什么就地明说，面板给得出拦路屏
    const ai = useAiStore()
    if (!ai.probed)
      await ai.probe()
    const blocker = cleanBlocker()
    if (blocker) {
      cleanLines.value = []
      cleanError.value = blocker
      cleanPhase.value = 'blocked'
      return
    }

    // 清单里两个地址都给：rel 是逻辑路径（条目 source 写它），abs 是资料实际在哪儿
    // （来源多半在知识库文件夹外面，只有逻辑路径 Pi 读不到）
    const pending = rawItems.value
      .filter(item => item.status === 'pending')
      .map(item => ({ rel: item.rel, abs: item.abs }))
    const stale = rawItems.value
      .filter(item => item.status === 'stale')
      .map(item => ({ rel: item.rel, abs: item.abs }))
    if (!pending.length && !stale.length) {
      notifyInfo('当前没有待处理的原始数据')
      return
    }

    const sessionId = crypto.randomUUID()
    cleanSessionId = sessionId
    cleanCancelled = false
    // 收据的底：这一轮跑完要说清哪些是新建、哪些是覆盖，得先记下跑之前的清单
    cleanBefore.value = entries.value.map(item => item.rel)
    cleanLines.value = [
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
          // agent_settled：这一轮收工。接下来是应用自己的收尾（收进程 → 重建索引）
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
              text: 'Pi 想执行命令，已自动拒绝',
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

  /** 清洗的收尾：收掉进程 → 重建目录与索引 → 刷新清单（打开着的条目一并重读） */
  async function finishClean(sessionId: string): Promise<void> {
    if (cleanPhase.value !== 'cleaning' || cleanSessionId !== sessionId)
      return
    cleanPhase.value = 'indexing'
    // 一次性任务不留常驻进程：一轮跑完就收（留档在盘上，不跟着进程走）
    await aiStop(aiSessionProcessId(sessionId))

    const current = root.value
    if (!current) {
      cleanPhase.value = 'failed'
      cleanError.value = '条目已整理，但知识库文件夹读不到了：没法重建索引'
      return
    }
    const built = await window.workbench.kbIndexBuild(current, todayIsoDate())
    if (!built.ok || !built.data) {
      cleanPhase.value = 'failed'
      cleanError.value = `条目已整理，但重建索引失败：${built.error ?? '原因不明'}`
      notifyError(cleanError.value)
      return
    }
    await reload()
    if (activeRel.value)
      await openEntry(activeRel.value)
    else if (activeRawRel.value)
      await openRaw(activeRawRel.value)
    cleanPhase.value = 'done'
    notifySuccess(`清洗完成，目录与索引已重建（${built.data.count} 条）`)
  }

  /** 停下清洗：先走 Pi 自己的 abort（留档收得完整），不管成没成都按进程树收掉 */
  async function stopClean(): Promise<void> {
    if (cleanPhase.value !== 'cleaning')
      return
    cleanCancelled = true
    const procId = aiSessionProcessId(cleanSessionId)
    await aiAbort(procId)
    await aiStop(procId)
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

  return {
    root,
    sources,
    repoState,
    remoteUrl,
    canSync,
    scanEntries,
    entries,
    rawItems,
    rawSources,
    indexInfo,
    loading,
    loaded,
    loadError,
    activeRel,
    activeEntry,
    activeContent,
    activeLoading,
    activeError,
    activeRawRel,
    activeRaw,
    activeRawKind,
    activeRawContent,
    activeRawLoading,
    activeRawError,
    syncing,
    syncError,
    rebuilding,
    stats,
    tagCounts,
    lintIssues,
    locationText,
    looksLikeKb,
    cleanPhase,
    cleanLines,
    cleanError,
    cleanBusy,
    cleanWrites,
    init,
    reload,
    detect,
    setRoot,
    addSource,
    setSourceDir,
    removeSource,
    revealSource,
    openEntry,
    openRaw,
    closeRaw,
    backToOverview,
    followLink,
    syncNow,
    rebuildIndex,
    startClean,
    stopClean,
    closeClean,
  }
})
