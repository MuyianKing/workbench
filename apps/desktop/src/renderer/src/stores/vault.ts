import type { VaultEntry, VaultRecord } from '@workbench/vault'
import type { Result, VaultHelloState, VaultKeyState } from '@/types'
import { filterVaultRecords, groupVaultRecords, orderedVaultGroups, sortVaultRecords, vaultEntryProblem, vaultGroups, withoutHiddenGroups } from '@workbench/vault'
import { defineStore } from 'pinia'
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
 * **解锁交给 Windows 认**：默认走 Windows Hello（弹系统自己的验证框，PIN / 指纹 / 人脸），
 * 机器没配 Hello 才退回输本机账户密码（Rust 侧 `LogonUserW`）。应用不存任何凭据，
 * 也不拿它派生任何东西，所以改 Windows 密码不会让保险库打不开。收起（`lock`）仍然只是把内存里
 * 那把丢掉、把明文从屏幕上撤掉；区别是**再解锁不是点一下的事** —— 冷启动之后这一页也是锁着的，
 * 每次打开应用都要过一遍验证。
 *
 * 与其余几条同步同一条口径：**没登录就没有同步**（仓库地址由适配层按登录状态给），
 * 而保险库在没登录时照常能用 —— 本机那份是完整的，只是推不出去，界面会如实说明。
 */
import { computed, ref } from 'vue'
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
  /**
   * 密钥状态问过没有：`keyExists` 初值是 false，状态查询又是异步的 ——
   * 没这个标志的话，进页面先闪一帧「创建保险库」的引导再跳成真的样子。
   */
  const keyChecked = ref(false)
  /** 公钥指纹（`A1B2-C3D4-E5F6`）：核对两台机器拿的是不是同一把密钥 */
  const fingerprint = ref('')

  /**
   * 这台机器的 Windows 验证（Hello）配没配好。锁着的那一屏靠它分流：
   * `available` 只摆一颗「解锁」（点了弹系统验证框），其余两档摆密码框 ——
   * `unconfigured` 多说一句去哪儿配（微软账户的机器上，密码那条路永远走不通）。
   */
  const hello = ref<VaultHelloState>('unavailable')

  const records = ref<VaultRecord[]>([])
  /** 本机解不开的条数：密钥换过、或文件被改过。大于 0 时界面必须如实说一句 */
  const unreadable = ref(0)
  /** 文件里认不出来被丢掉的条数 */
  const dropped = ref(0)
  /** 最近一次改动时刻（毫秒） */
  const updatedAt = ref(0)

  const loading = ref(false)
  /**
   * 解锁那一步的失败原因（密码不对、账户被禁用…）。**就地显示在密码框下面**，不走消息提示 ——
   * 那一刻用户的注意力就在那个框上（与弹层里的字段校验同一条口径）。
   */
  const unlockError = ref('')
  const saving = ref(false)
  const syncing = ref(false)
  /** 建密钥 / 换密钥进行中：全部条目要重新加密一遍再落盘，期间按钮必须转圈禁点 */
  const creating = ref(false)
  /** 上一次同步的说明（成功那句 / 失败那句），显示在工具带右侧 */
  const syncNote = ref('')
  const syncFailed = ref(false)
  /** 仓库里那份与本机这把密钥对不上 —— 「同步成功却没多出条目」就靠它解释 */
  const keyMismatch = ref(false)

  const query = ref('')

  /**
   * 分组那两样 —— 用户拖出来的顺序、藏起来的那几组（都在「分组设置」那个弹窗里改）。
   *
   * 两样都是**行为记忆**（住本机数据文件、不进 theme.json、不参与外观同步，见 types.ts），
   * 也**不进 vault.json 那份会跨设备合并的文件**：那份只装条目本身，往信封里加视图偏好
   * 会牵动合并口径（见 packages/vault/src/vault.ts 的文件头）。
   *
   * 单源就是设置，这里不再各存一份 ref —— 存一份就多一处会与磁盘漂移的副本，
   * 写入一律经 `settings.updateSettings`（与项目页的 sortBy 同一条路）。
   */
  const groupOrder = computed(() => settings.settings.vaultGroupOrder)
  const hiddenGroups = computed(() => settings.settings.vaultHiddenGroups)

  /**
   * 弹窗里那一行行：全部分组、按用户拖出来的先后（未分组不在里面，它不是一个组）。
   *
   * 拖动要的那份名单就是它 —— 藏起来的分组也在里面（它的开关是关的），所以拖动落盘的那份
   * 名单一直是完整的：藏一下再放出来，位次还是原来那个。
   */
  const orderedGroups = computed(() => orderedVaultGroups(records.value, groupOrder.value))

  /**
   * 整份落一次顺序（「分组设置」弹窗里拖完之后写的）。
   *
   * 拖动那边算好的是**完整一份名单**（它自己那份本地顺序就是拖动时的实时样子），
   * 所以这里收整份，而不是「从哪儿挪到哪儿」—— 收一对 from / to 的话，两边还得各算一遍
   * 「没上名单的分组排在哪」，迟早对不上。
   */
  async function setGroupOrder(names: string[]): Promise<void> {
    await settings.updateSettings({ vaultGroupOrder: names })
  }

  /**
   * 藏起一组（弹窗里那个开关关掉）：整段不画、也不进搜索。
   *
   * **未分组藏不了**（空串直接挡掉）：它是个兜底的口袋，藏掉之后新加一条没归类的记录
   * 就等于凭空消失 —— 弹窗里也不列它。
   */
  function hideGroup(key: string): void {
    if (!key || hiddenGroups.value.includes(key))
      return
    void settings.updateSettings({ vaultHiddenGroups: [...hiddenGroups.value, key] })
  }

  /** 放出一组（开关打开）：它回到墙上原来的位次（顺序名单里一直留着它） */
  function showGroup(key: string): void {
    if (!hiddenGroups.value.includes(key))
      return
    void settings.updateSettings({
      vaultHiddenGroups: hiddenGroups.value.filter(name => name !== key),
    })
  }

  /** 全放出来：一段都不剩时那个空态上的按钮 */
  function showAllGroups(): void {
    if (hiddenGroups.value.length)
      void settings.updateSettings({ vaultHiddenGroups: [] })
  }

  /** 同步能不能用：与其余几条同步同一个判据（没登录就没有同步） */
  const syncReady = computed(() => Boolean(account.value) && Boolean(settings.settings.tokenSyncRepo.trim()))

  /**
   * 已经有的分组名：**只给编辑弹框那一栏当候选项**（选一下省得打字），不参与界面筛选。
   *
   * 之前这里还有一排分组筛选标签，撤掉了：分组已经在卡片墙上分了段、每段一个标题，
   * 标签把那几个数又摆了一遍（同一屏里「测试 1」出现两次），而且工具栏那一行被它撑得没有重心。
   * 找某一条用搜索框，看某一组用分段 —— 两条路都够了。
   */
  const groups = computed(() => vaultGroups(records.value))

  /** 当前这一屏要画的卡片（搜索过滤 → 摘掉藏起来的那几组 → 按用户拖出来的顺序排） */
  const visibleRecords = computed(() =>
    sortVaultRecords(
      withoutHiddenGroups(filterVaultRecords(records.value, query.value), hiddenGroups.value),
      groupOrder.value,
    ),
  )

  /**
   * 卡片墙按分组切段（每一段一个标题 + 一段卡片）。
   *
   * 分段要的是**排好序的那份**（相邻的同组自然连成一段），所以这里接着 `visibleRecords` 算，
   * 不在模板里现折一遍 —— 排序与分段用的是同一个「按分组」的判据，分开写迟早不一致。
   */
  const sections = computed(() => groupVaultRecords(visibleRecords.value))

  /** 卡片墙底下那行小字：几条记录 */
  const summary = computed(() => {
    if (!records.value.length)
      return '还没有记录'
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

  /** 问一次密钥状态（进页面时、以及每个动作之后）；锁着时顺带问一遍 Hello 配没配好 */
  async function refreshKey(): Promise<void> {
    try {
      const result = await window.workbench.vaultKeyState()
      if (!result.ok) {
        notifyError(result.error ?? '读取密钥状态失败')
        return
      }
      keyExists.value = result.data!.exists
      unlocked.value = result.data!.unlocked
      fingerprint.value = result.data!.fingerprint
      if (!unlocked.value)
        await refreshHello()
    }
    finally {
      // 放在 finally：Hello 状态那一路出问题时也不能让这一页停在「没查过」的引导帧上
      keyChecked.value = true
    }
  }

  /** 问一遍 Windows 验证（Hello）配没配好。只影响解锁屏长什么样，失败就当没有验证手段 */
  async function refreshHello(): Promise<void> {
    const result = await window.workbench.vaultHello()
    hello.value = result.ok ? result.data! : 'unavailable'
  }

  /**
   * 解锁（输本机账户密码那条路）。
   *
   * 失败就地显示一句（`unlockError`），不弹消息 —— 那一刻用户正盯着那个框。
   */
  async function unlock(password: string): Promise<boolean> {
    loading.value = true
    const opened = await window.workbench.vaultUnlock(password)
    loading.value = false
    return applyUnlock(opened)
  }

  /**
   * 解锁（Windows Hello 那条路）：点下去弹系统自己的验证框，等用户给结论。
   * 用户把框关掉（返回 null）不算失败也不报错，锁着的那一屏原样留着。
   */
  async function unlockHello(): Promise<boolean> {
    loading.value = true
    const opened = await window.workbench.vaultUnlockHello()
    loading.value = false
    return applyUnlock(opened)
  }

  /** 两条解锁路共用的一段：把结果铺进状态、读出条目 */
  async function applyUnlock(opened: Result<VaultKeyState | null>): Promise<boolean> {
    unlockError.value = ''
    if (!opened.ok) {
      unlockError.value = opened.error ?? '解锁失败'
      return false
    }
    // null = 用户在 Windows 的验证框里取消了：安静地回到锁着的那一屏
    if (!opened.data)
      return false

    keyExists.value = opened.data.exists
    unlocked.value = opened.data.unlocked
    fingerprint.value = opened.data.fingerprint
    await reload()
    return true
  }

  /** 收起：丢掉内存里那把密钥，并把明文从屏幕上撤掉 */
  async function lock(): Promise<void> {
    clearRemoteVerdict()
    await window.workbench.vaultLock()
    unlocked.value = false
    unlockError.value = ''
    fingerprint.value = ''
    records.value = []
    unreadable.value = 0
    dropped.value = 0
    updatedAt.value = 0
    syncNote.value = ''
    syncFailed.value = false
    query.value = ''
    // 解锁屏马上就要摆出来，分流靠 hello：收起前问过的是什么状态已经不作数了
    await refreshHello()
  }

  /** 重新解开本机那份（改动之后、同步之后、切回这一页时） */
  async function reload(): Promise<void> {
    if (!unlocked.value)
      return
    const result = await window.workbench.vaultLoad()
    if (!result.ok) {
      notifyError(result.error ?? '读取保险库失败')
      return
    }
    applyLoaded(result.data!)
  }

  /** 建一把新密钥。`replace` 为真时会先把现有条目全作废，所以调用方必须先确认 */
  async function createKey(replace: boolean): Promise<boolean> {
    creating.value = true
    try {
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
    finally {
      creating.value = false
    }
  }

  /** 导入一把别处导出的密钥：自己弹文件选择框，用户取消时什么都不做 */
  async function importKeyFile(): Promise<void> {
    const result = await window.workbench.vaultImportKeyFile()
    if (!result.ok) {
      notifyError(result.error ?? '导入密钥失败')
      return
    }
    if (!result.data)
      return // 用户取消了

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
    if (!result.data)
      return // 用户取消了
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
    const index = records.value.findIndex(record => record.id === id)
    if (index >= 0)
      records.value.splice(index, 1, saved)
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
    records.value = records.value.filter(record => record.id !== id)
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
    if (unlocked.value)
      await reload()
  }

  return {
    account,
    keyExists,
    keyChecked,
    unlocked,
    fingerprint,
    hello,
    records,
    unreadable,
    dropped,
    updatedAt,
    loading,
    unlockError,
    saving,
    syncing,
    creating,
    syncNote,
    syncFailed,
    keyMismatch,
    query,
    groupOrder,
    hiddenGroups,
    groups,
    orderedGroups,
    syncReady,
    visibleRecords,
    sections,
    summary,
    init,
    refreshKey,
    unlock,
    unlockHello,
    lock,
    reload,
    createKey,
    importKeyFile,
    forgetKey,
    exportKey,
    saveEntry,
    removeEntry,
    sync,
    setGroupOrder,
    hideGroup,
    showGroup,
    showAllGroups,
  }
})
