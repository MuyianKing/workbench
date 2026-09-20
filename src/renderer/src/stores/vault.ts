/**
 * 密码保险库：密钥状态、卡片清单、增删改与同步的编排。
 *
 * 一条记录就是「名字 + 密码 + 备注 + 分组」四样（见 shared/vault.ts 的 VaultEntry）——
 * 它是**备忘**，不是密码管理器：没有用户名 / 网址那些字段，也不生成口令。
 * 界面上一张卡片，分组是一栏自由文本，筛选标签从现存的取值里现算（见 shared/vault.ts 的 vaultGroups），
 * 所以这里没有「新建分组 / 改名 / 删除」那一套状态。
 *
 * 与其余几个 store 最大的不同：**这里的状态有一半不在磁盘上**。
 * 密钥在本机内存（解锁之后）与 Windows 凭据管理器之间；条目明文只活在内存里 ——
 * 磁盘上那份 `vault.json` 与仓库里那份都只有密文，解密由适配层做（见 workbench/vault.ts）。
 * 所以这一层管的是「什么时候解锁 / 什么时候重新读一遍 / 改动怎么落下去」，
 * 而不是数据本身。
 *
 * **没有主口令这一层**：设计上密钥就存在本机（用户的要求），能打开这个程序就说明已经过了
 * Windows 登录。界面上的「锁定」是把内存里那把丢掉，防的是「开着屏幕走开」，不是防本机。
 *
 * 与其余几条同步同一条口径：**没登录就没有同步**（仓库地址由适配层按登录状态给），
 * 而保险库在没登录时照常能用 —— 本机那份是完整的，只是推不出去，界面会如实说明。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  filterVaultRecords,
  groupVaultRecords,
  sortVaultRecords,
  vaultEntryProblem,
  vaultGroups,
  type VaultEntry,
  type VaultRecord
} from '@shared/vault'
import { notifyError, notifySuccess } from '@/notify'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'

export const useVaultStore = defineStore('vault', () => {
  const settings = useSettingsStore()
  const auth = useAuthStore()

  /** 已登录的账号资料（没登录是 null）。「已登录」以凭据管理器为准，见 stores/auth.ts */
  const account = computed(() => auth.status?.account ?? null)

  /** 这台机器上有没有密钥（凭据管理器里那条记录在不在） */
  const keyExists = ref(false)
  const unlocked = ref(false)
  /** 公钥指纹（`A1B2-C3D4-E5F6`）：核对两台机器拿的是不是同一把密钥 */
  const fingerprint = ref('')

  const records = ref<VaultRecord[]>([])
  /** 本机解不开的条数：密钥换过、或文件被改过。大于 0 时界面必须如实说一句 */
  const unreadable = ref(0)
  /** 文件里认不出来被丢掉的条数 */
  const dropped = ref(0)
  /** 最近一次改动时刻（毫秒） */
  const updatedAt = ref(0)

  const loading = ref(false)
  const saving = ref(false)
  const syncing = ref(false)
  /** 上一次同步的说明（成功那句 / 失败那句），显示在工具带右侧 */
  const syncNote = ref('')
  const syncFailed = ref(false)
  /** 仓库里那份与本机这把密钥对不上 —— 「同步成功却没多出条目」就靠它解释 */
  const keyMismatch = ref(false)

  const query = ref('')

  /** 同步能不能用：与其余几条同步同一个判据（没登录就没有同步） */
  const syncReady = computed(() => Boolean(account.value) && Boolean(settings.settings.tokenSyncRepo.trim()))

  /**
   * 已经有的分组名：**只给弹框那一栏当候选项**（选一下省得打字），不参与界面筛选。
   *
   * 之前这里还有一排分组筛选标签，撤掉了：分组已经在卡片墙上分了段、每段一个标题，
   * 标签把那几个数又摆了一遍（同一屏里「测试 1」出现两次），而且工具栏那一行被它撑得没有重心。
   * 找某一条用搜索框，看某一组用分段 —— 两条路都够了。
   */
  const groups = computed(() => vaultGroups(records.value))

  /** 当前这一屏要画的卡片（搜索过滤 + 排序） */
  const visibleRecords = computed(() => sortVaultRecords(filterVaultRecords(records.value, query.value)))

  /**
   * 卡片墙按分组切段（每一段一个标题 + 一段卡片）。
   *
   * 分段要的是**排好序的那份**（相邻的同组自然连成一段），所以这里接着 `visibleRecords` 算，
   * 不在模板里现折一遍 —— 排序与分段用的是同一个「按分组」的判据，分开写迟早不一致。
   */
  const sections = computed(() => groupVaultRecords(visibleRecords.value))

  /** 卡片墙底下那行小字：几条记录 */
  const summary = computed(() => {
    if (!records.value.length) return '还没有记录'
    return `${records.value.length} 条`
  })

  /**
   * 丢掉「仓库里那份跟本机密钥对不对得上」这个结论。
   *
   * 它只在同步那一下算得出来，而换 / 导入 / 清除密钥都会让上一次的结论失效 ——
   * 留着一条可能已经不成立的警告，比不显示更糟。
   */
  function clearRemoteVerdict(): void {
    keyMismatch.value = false
  }

  /** 把适配层回来的那份结果铺进状态 */
  function applyLoaded(loaded: {
    records: VaultRecord[]
    unreadable: number
    dropped: number
    updatedAt: number
  }): void {
    records.value = loaded.records
    unreadable.value = loaded.unreadable
    dropped.value = loaded.dropped
    updatedAt.value = loaded.updatedAt
  }

  /** 问一次密钥状态（进页面时、以及每个动作之后） */
  async function refreshKey(): Promise<void> {
    const result = await window.workbench.vaultKeyState()
    if (!result.ok) {
      notifyError(result.error ?? '读取密钥状态失败')
      return
    }
    keyExists.value = result.data!.exists
    unlocked.value = result.data!.unlocked
    fingerprint.value = result.data!.fingerprint
  }

  /** 解锁并读出全部条目 */
  async function unlock(): Promise<void> {
    loading.value = true
    const opened = await window.workbench.vaultUnlock()
    if (!opened.ok) {
      loading.value = false
      notifyError(opened.error ?? '解锁失败')
      return
    }
    keyExists.value = opened.data!.exists
    unlocked.value = opened.data!.unlocked
    fingerprint.value = opened.data!.fingerprint
    await reload()
    loading.value = false
  }

  /** 收起：丢掉内存里那把密钥，并把明文从屏幕上撤掉 */
  async function lock(): Promise<void> {
    clearRemoteVerdict()
    await window.workbench.vaultLock()
    unlocked.value = false
    fingerprint.value = ''
    records.value = []
    unreadable.value = 0
    dropped.value = 0
    updatedAt.value = 0
    syncNote.value = ''
    syncFailed.value = false
    query.value = ''
  }

  /** 重新解开本机那份（改动之后、同步之后、切回这一页时） */
  async function reload(): Promise<void> {
    if (!unlocked.value) return
    const result = await window.workbench.vaultLoad()
    if (!result.ok) {
      notifyError(result.error ?? '读取保险库失败')
      return
    }
    applyLoaded(result.data!)
  }

  /** 建一把新密钥。`replace` 为真时会先把现有条目全作废，所以调用方必须先确认 */
  async function createKey(replace: boolean): Promise<boolean> {
    const result = await window.workbench.vaultCreateKey(replace)
    if (!result.ok) {
      notifyError(result.error ?? '创建密钥失败')
      return false
    }
    clearRemoteVerdict()
    keyExists.value = result.data!.exists
    unlocked.value = result.data!.unlocked
    fingerprint.value = result.data!.fingerprint
    await reload()
    notifySuccess(replace ? '已经换上一把新密钥' : '保险库已经建好')
    return true
  }

  /** 导入一把别处导出的密钥：自己弹文件选择框，用户取消时什么都不做 */
  async function importKeyFile(): Promise<void> {
    const result = await window.workbench.vaultImportKeyFile()
    if (!result.ok) {
      notifyError(result.error ?? '导入密钥失败')
      return
    }
    if (!result.data) return // 用户取消了

    // 适配层导入时已经把密钥放进内存，所以这里重问一次状态、再读一遍条目
    clearRemoteVerdict()
    await refreshKey()
    await reload()
    notifySuccess('密钥已导入')
  }

  /** 忘掉本机密钥。仓库里那份数据不动，但本机从此解不开它 */
  async function forgetKey(): Promise<void> {
    const result = await window.workbench.vaultForgetKey()
    if (!result.ok) {
      notifyError(result.error ?? '清除密钥失败')
      return
    }
    await lock()
    keyExists.value = false
    notifySuccess('本机密钥已清除')
  }

  /** 导出密钥到文件（用户自己挑路径，再自己搬到另一台机器） */
  async function exportKey(): Promise<void> {
    const result = await window.workbench.vaultExportKey()
    if (!result.ok) {
      notifyError(result.error ?? '导出密钥失败')
      return
    }
    if (!result.data) return // 用户取消了
    notifySuccess('密钥已导出，把它放到另一台机器上导入即可')
  }

  /** 新增 / 改动一条；回来的是落盘之后的那条记录 */
  async function saveEntry(id: string, entry: VaultEntry): Promise<boolean> {
    const problem = vaultEntryProblem(entry)
    if (problem) {
      notifyError(problem)
      return false
    }

    saving.value = true
    const result = await window.workbench.vaultSaveEntry(id, entry)
    saving.value = false
    if (!result.ok) {
      notifyError(result.error ?? '保存条目失败')
      return false
    }

    const saved = result.data!
    const index = records.value.findIndex((record) => record.id === id)
    if (index >= 0) records.value.splice(index, 1, saved)
    else records.value.push(saved)
    updatedAt.value = Math.max(updatedAt.value, saved.updatedAt)

    notifySuccess(index >= 0 ? '已保存' : '已添加')
    return true
  }

  async function removeEntry(id: string): Promise<void> {
    const result = await window.workbench.vaultRemoveEntry(id)
    if (!result.ok) {
      notifyError(result.error ?? '删除记录失败')
      return
    }
    records.value = records.value.filter((record) => record.id !== id)
    updatedAt.value = Date.now()
    notifySuccess('已删除')
  }

  /**
   * 同步一轮：推本机改动、拉回别的机器的。
   *
   * 与其余几条同步同一个口径 —— 手动点的那次等结果（按钮要给出成功 / 失败），
   * 没有后台自动同步：保险库改动是「用户自己做的事」，替他在后台推上去没有意义。
   */
  async function sync(): Promise<void> {
    if (!syncReady.value) {
      notifyError(account.value ? '还没有填同步仓库地址' : '同步要先登录账号（设置 → 通用 → 账号）')
      return
    }

    syncing.value = true
    const result = await window.workbench.vaultSync()
    syncing.value = false

    if (!result.ok) {
      syncFailed.value = true
      syncNote.value = result.error ?? '同步失败'
      notifyError(syncNote.value)
      return
    }

    applyLoaded(result.data!)
    keyMismatch.value = result.data!.keyMismatch
    syncFailed.value = false
    syncNote.value = result.data!.keyMismatch
      ? '同步完成，但仓库里那份是用别的密钥加的密 —— 这些条目在这台机器上解不开'
      : '同步完成'
    notifySuccess(syncNote.value)
  }

  /** 进页面时调一次：读密钥状态，已经解锁过就直接把条目摆出来 */
  async function init(): Promise<void> {
    await refreshKey()
    if (unlocked.value) await reload()
  }

  return {
    account,
    keyExists,
    unlocked,
    fingerprint,
    records,
    unreadable,
    dropped,
    updatedAt,
    loading,
    saving,
    syncing,
    syncNote,
    syncFailed,
    keyMismatch,
    query,
    groups,
    syncReady,
    visibleRecords,
    sections,
    summary,
    init,
    refreshKey,
    unlock,
    lock,
    reload,
    createKey,
    importKeyFile,
    forgetKey,
    exportKey,
    saveEntry,
    removeEntry,
    sync
  }
})
