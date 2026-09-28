/**
 * 知识库：清单、条目、原始数据与入库状态的编排。
 *
 * 与笔记 / 技能 store 同一个思路：知识库就是用户挑的那个文件夹（一个独立项目的根），
 * 这里没有内存副本 ——「条目」是扫出来再逐个读 frontmatter 的、「原始数据」是扫出来的，
 * 应用对它**只读**：没有任何写内容的动作，整理这件事由用户拿着「整理指令」去 Agent 里做。
 *
 * 状态判定的口径（source 配对 + mtime 比较）在 shared/kb.ts 的纯函数里，这边只编排：
 * 扫描 → 拆三部分（条目 / 原始数据 / 索引）→ 配状态 → 界面取用。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { noteRootName, sanitizeNoteRoot } from '@shared/note'
import {
  KB_DIR,
  KB_INDEX_REL,
  KB_RAW_DIR,
  kbEntryFiles,
  kbOrganizeInstruction,
  kbRawFiles,
  kbStats,
  kbTagCounts,
  matchKbRawStatus,
  normalizeKbSource,
  parseKbFrontmatter,
  parseKbIndex,
  todayIsoDate,
  type KbEntryMeta,
  type KbIndexInfo,
  type KbRawItem,
  type KbRepoState,
  type KbScanEntry
} from '@shared/kb'
import { notifyError, notifySuccess } from '@/notify'
import { useSettingsStore } from '@/stores/settings'

export const useKbStore = defineStore('kb', () => {
  const settings = useSettingsStore()

  /**
   * 知识库文件夹：**用户自己挑的一个目录**（一个独立项目的根）。
   * 空串 = 还没选过，整页只给引导。与笔记 / 技能文件夹互不相干。
   */
  const root = computed(() => settings.settings.kbDir)
  /** 文件夹的 git 状态（探出来的、不落盘）：有没有仓库与远端决定给不给同步按钮 */
  const repoState = ref<KbRepoState | null>(null)
  const remoteUrl = computed(() => repoState.value?.origin ?? '')
  const canSync = computed(() => repoState.value?.isRepo === true && remoteUrl.value !== '')

  /** 扫描的原始平铺清单（布局长什么样用它判断：选了个不像知识库的文件夹时要提醒） */
  const scanEntries = ref<KbScanEntry[]>([])
  const entries = ref<KbEntryMeta[]>([])
  const rawItems = ref<KbRawItem[]>([])
  const indexInfo = ref<KbIndexInfo | null>(null)

  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref('')

  /** 当前打开的条目（kb 相对路径）与它的正文；没有打开的就是概览 */
  const activeRel = ref('')
  const activeContent = ref('')
  const activeLoading = ref(false)
  const activeError = ref('')

  const syncing = ref(false)
  const syncError = ref('')
  /** 重建索引正在进行（那颗按钮转圈用） */
  const rebuilding = ref(false)

  const activeEntry = computed(() => entries.value.find((item) => item.rel === activeRel.value) ?? null)
  const stats = computed(() => kbStats(entries.value, rawItems.value))
  const tagCounts = computed(() => kbTagCounts(entries.value))
  const locationText = computed(() => noteRootName(root.value))
  /** 复制给 Agent 的整理指令：待处理计数随状态现算 */
  const organizeInstruction = computed(() =>
    kbOrganizeInstruction(stats.value.pending, stats.value.stale)
  )
  /** 选的文件夹像不像一个知识库：两块布局（data/raw、kb）一块都没有就不是 */
  const looksLikeKb = computed(
    () =>
      scanEntries.value.some((item) => item.rel === KB_DIR || item.rel.startsWith(`${KB_DIR}/`)) ||
      scanEntries.value.some(
        (item) => item.rel === KB_RAW_DIR || item.rel.startsWith(`${KB_RAW_DIR}/`)
      )
  )

  function reset(): void {
    scanEntries.value = []
    entries.value = []
    rawItems.value = []
    indexInfo.value = null
    repoState.value = null
    closeActive()
    loaded.value = false
    loadError.value = ''
    syncError.value = ''
  }

  function closeActive(): void {
    activeRel.value = ''
    activeContent.value = ''
    activeError.value = ''
  }

  /**
   * 重新扫一遍：扫描 → 拆三部分 → 读条目 frontmatter → 配状态 → 读索引 → 探仓库。
   *
   * 条目是逐个读出来解析的（source 在 frontmatter 里，状态判定绕不开），几十上百个
   * 本地小文件并发读，量级与笔记首扫相当；读不出的（权限 / 刚被删）如实丢掉 ——
   * 少一条只是清单上少一行，不该让整页读不出来。
   */
  async function reload(): Promise<void> {
    if (!root.value) {
      reset()
      return
    }

    loading.value = true
    loadError.value = ''
    const result = await window.workbench.kbScan(root.value)
    loading.value = false

    if (!result.ok || !result.data) {
      reset()
      loadError.value = result.error ?? '读取知识库失败'
      return
    }

    scanEntries.value = result.data
    const current = root.value

    const metas = await Promise.all(
      kbEntryFiles(result.data).map(async (file): Promise<KbEntryMeta | null> => {
        const read = await window.workbench.kbRead(current, file.rel)
        if (!read.ok || typeof read.data !== 'string') return null
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
          mtimeMs: file.mtimeMs
        }
      })
    )
    entries.value = metas.filter((meta): meta is KbEntryMeta => meta !== null)
    rawItems.value = matchKbRawStatus(kbRawFiles(result.data), entries.value)

    // 索引：读不到 / 认不出都按「还没生成」处理，不是错误（清单不依赖它）
    const indexRead = await window.workbench.kbRead(current, KB_INDEX_REL)
    indexInfo.value =
      indexRead.ok && typeof indexRead.data === 'string' ? parseKbIndex(indexRead.data) : null

    // 打开着的条目没了（整理重排 / 换了文件夹）：收起来，别挂着一个空壳
    if (activeRel.value && !entries.value.some((item) => item.rel === activeRel.value)) {
      closeActive()
    }
    loaded.value = true

    void probeState()
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
    if (started && ready) return
    started = true
    await reload()
  }

  // 知识库文件夹变了（选了新目录）：全部重新认一遍
  watch(root, () => {
    if (!started) return
    ready = false
    closeActive()
    void reload()
  })

  /** 记下用户挑的知识库文件夹（页面那颗「选择知识库文件夹」用它）。不搬动任何文件 */
  async function setRoot(dir: string): Promise<boolean> {
    const target = sanitizeNoteRoot(dir)
    if (!target) return false
    return settings.updateSettings({ kbDir: target })
  }

  /**
   * 打开一个条目：读正文进阅读区。慢一步回来的旧结果直接丢掉（连点两行时各回各的）。
   * 读失败留在概览并提示，不挂一个空壳阅读区。
   */
  async function openEntry(rel: string): Promise<void> {
    activeRel.value = rel
    activeError.value = ''
    activeContent.value = ''

    activeLoading.value = true
    const result = await window.workbench.kbRead(root.value, rel)
    activeLoading.value = false
    if (activeRel.value !== rel) return

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
      if (activeRel.value) await openEntry(activeRel.value)
    } finally {
      syncing.value = false
    }
  }

  /**
   * 重建目录与索引（`kb/_catalog.md` 与 `index/index.json`）。
   *
   * 这是应用**唯一直接写知识库的地方**，写的是生成物、不是内容。两处会用到它：
   * 用户自己点这颗按钮（手改过条目、或从别处拉回了新的条目），以及 AI 助手跑完一轮的收尾
   * （见 stores/ai.ts）。输出与仓库脚本逐字节一致（见 kb.rs 的 index_build）。
   */
  async function rebuildIndex(): Promise<void> {
    const current = root.value
    if (!current) return

    rebuilding.value = true
    try {
      const result = await window.workbench.kbIndexBuild(current, todayIsoDate())
      if (!result.ok || !result.data) {
        notifyError(result.error ?? '重建索引失败')
        return
      }
      notifySuccess(`目录与索引已重建（${result.data.count} 条）`)
      await reload()
    } finally {
      rebuilding.value = false
    }
  }

  /** 把整理指令复制出去（丢给知识库仓库里的 Agent）。剪贴板在 WebView 的安全上下文里可用 */
  async function copyInstruction(): Promise<void> {
    try {
      await navigator.clipboard.writeText(organizeInstruction.value)
      notifySuccess('整理指令已复制，粘贴给 Agent 即可')
    } catch {
      notifyError('复制失败')
    }
  }

  return {
    root,
    repoState,
    remoteUrl,
    canSync,
    scanEntries,
    entries,
    rawItems,
    indexInfo,
    loading,
    loaded,
    loadError,
    activeRel,
    activeEntry,
    activeContent,
    activeLoading,
    activeError,
    syncing,
    syncError,
    rebuilding,
    stats,
    tagCounts,
    locationText,
    organizeInstruction,
    looksLikeKb,
    init,
    reload,
    setRoot,
    openEntry,
    backToOverview,
    syncNow,
    rebuildIndex,
    copyInstruction
  }
})
