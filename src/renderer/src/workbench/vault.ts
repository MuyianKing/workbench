/**
 * 密码保险库的适配层：加解密、合并、同步编排。
 *
 * 分工（与其余几处同步同一条口径：Rust 只做「取原始数据 / 落盘 / 调系统能力」）：
 *  - Rust（`vault.rs`）管三件事：本机那份 JSON 的落盘、本机密钥在 Windows 凭据管理器里的存取、
 *    以及同步仓库里 `vault/vault.json` 的读写。它一行密码学都没有。
 *  - **加解密与合并全在这里**，算式来自 `@shared/vault`（纯函数，带单测）。
 *
 * **同步为什么不是一个命令就完事**：那份文件是所有机器共写的，而合并要拿「本机那份」与
 * 「远端那份」一起算。所以一轮同步是三步，且**可能要走两遍**：
 *
 *   pull（读回远端） → merge（合并，纯函数） → 落盘 / 加密 → push（写回远端）
 *
 * push 之前会核对远端还是不是合并时的那个基准 —— 变过（另一台机器在这一轮里推过）就不写，
 * 把远端那份交回来重走一遍。绝大多数情况一遍就成，最多走三遍；三遍还撞上就如实报失败，
 * 让用户再点一次，而不是猜一个结果写下去。
 *
 * `push` 写的是**整份合并结果**：两台机器各自 merge 出的内容逐字节一致（合并规则里没有
 * 「以我为准」这一项，见 shared/vault.ts），所以谁先推都一样，后推的那台会认出来「没变化」
 * 而不产生空提交。
 *
 * **同步受登录限制**：仓库地址由调用方给（与用量 / 外观那两条一样经 `syncRepo()`，
 * 没登录一律当没填）。保险库本身在没登录时照常能用 —— 本机那份是完整的，
 * 只是推不出去，界面会如实说明。
 */
import {
  createVaultKey,
  emptyVaultFile,
  encodeKeyString,
  lastChangeAt,
  mergeVaultItems,
  open,
  openAll,
  sanitizeVaultEntry,
  parseKeyString,
  parseVaultFile,
  publicKeyFingerprint,
  publicKeyOf,
  sameVaultKey,
  seal,
  tombstoneOf,
  vaultFileOf,
  type VaultEntry,
  type VaultFile,
  type VaultItem,
  type VaultPrivateKey,
  type VaultPublicKey,
  type VaultRecord
} from '@shared/vault'
import { fail, ok } from '@shared/result'
import type { Result, VaultKeyState, VaultLoaded, VaultPushOutcome, VaultSyncOutcome } from '@shared/types'
import { invoke, guard } from './bridge'
import { localDevice } from './token'

/** 一轮同步最多走几遍（每遍都是「远端又变了，重新合一次」）；走完还撞上就报失败 */
const SYNC_ROUNDS = 3

/** 本机这把密钥在内存里。**只在本进程里活着** —— 落盘那份在 Windows 凭据管理器里 */
let cachedKey: VaultPrivateKey | null = null

/** 当前密钥状态（界面据此显示「还没建库 / 已解锁 / 锁着」） */
export async function keyState(): Promise<Result<VaultKeyState>> {
  if (cachedKey) {
    return ok({
      exists: true,
      unlocked: true,
      fingerprint: await publicKeyFingerprint(cachedKey)
    })
  }

  const stored = await guard(invoke<string | null>('vault_key_read'), '读取本机密钥失败')
  if (!stored.ok) return fail(stored.error ?? '读取本机密钥失败')

  const key = stored.data ? parseKeyString(stored.data) : null
  return ok({
    exists: Boolean(key),
    unlocked: false,
    /*
     * 指纹**没解锁也算得出来**：它就是公钥的摘要（公开信息），而这条通道本来已经把凭据读出来了，
     * 只是不把它放进内存。收起那一屏上要显示的正是它 —— 让用户核对两台机器拿的是不是同一把，
     * 而那时界面恰恰是锁着的。之前这里返回空串，界面上就是「公钥指纹 —」，等于没说。
     */
    fingerprint: key ? await publicKeyFingerprint(key) : ''
  })
}

/**
 * 解锁：把密钥从凭据管理器取进内存。
 *
 * **不做口令校验这一层**：设计上密钥就存在本机（用户的要求），能打开这个程序就说明
 * 已经通过了 Windows 的登录 —— 再加一道口令是在本地多存一份可以忘掉的东西，
 * 而它并不能挡住已经坐在这台机器前的人。
 */
export async function unlock(): Promise<Result<VaultKeyState>> {
  const stored = await guard(invoke<string | null>('vault_key_read'), '读取本机密钥失败')
  if (!stored.ok) return fail(stored.error ?? '读取本机密钥失败')

  const key = stored.data ? parseKeyString(stored.data) : null
  if (!key) return fail('这台机器上还没有保险库密钥，先创建或导入一把')

  cachedKey = key
  return ok({ exists: true, unlocked: true, fingerprint: await publicKeyFingerprint(key) })
}

/** 锁上：把内存里那把丢掉。**不动凭据管理器**，下次解锁照样能进来 */
export function lock(): Result<VaultKeyState> {
  cachedKey = null
  return ok({ exists: true, unlocked: false, fingerprint: '' })
}

/** 手上这把密钥（没解锁时是 null）。合并与落盘都要它 */
function currentKey(): VaultPrivateKey | null {
  return cachedKey
}

/**
 * 换密钥（新建 / 导入）之后把本机那份挪到新密钥下。
 *
 * 两条，缺一不可：
 *  - **能读出来的条目解开再用新密钥封回去** —— 换密钥不该顺手把密码弄丢；
 *  - **读不出来的留墓碑** —— 那些条目在任何机器上都解不开了，不清掉的话下一次同步
 *    会把它们当成本机内容并进去（合并只认 id 与时间，看不见密文），界面上就是一堆
 *    永远解不开、也删不掉的条目。
 *
 * `previous` 是换之前那把；没解锁时它是 null，那就只剩留墓碑这一条路（正常走不到：
 * 密钥那一屏只在解锁之后才进得去）。
 */
async function adoptKey(next: VaultPrivateKey, previous: VaultPrivateKey | null): Promise<Result<null>> {
  const file = await loadFile(next)
  if (!file.ok) return fail(file.error ?? '读取保险库失败')

  const device = await localDevice()
  const updatedAt = Date.now()
  const kept: VaultItem[] = []

  if (previous) {
    for (const item of file.data!.items) {
      if (item.deleted) continue
      try {
        const entry = await open(previous, item)
        kept.push({ id: item.id, updatedAt, by: device.id, ...(await seal(publicKeyOf(next), entry)) })
      } catch {
        // 旧密钥也解不开这一条：它本来就没救了，下面按墓碑处理
      }
    }
  }

  const readable = new Set(kept.map((item) => item.id))
  const tombstones = file.data!.items
    .filter((item) => !readable.has(item.id))
    .map((item) => tombstoneOf(item, updatedAt, device.id))

  return saveFile(vaultFileOf(next, [...tombstones, ...kept]))
}

/**
 * 建一把新密钥并落进凭据管理器，同时把本机那份挪到新密钥下。
 *
 * `replace` 为假时**已有密钥就不动**（避免把现有条目全废掉）。
 */
export async function createKey(replace: boolean): Promise<Result<VaultKeyState>> {
  const stored = await guard(invoke<string | null>('vault_key_read'), '读取本机密钥失败')
  if (!stored.ok) return fail(stored.error ?? '读取本机密钥失败')
  if (stored.data && !replace) return fail('这台机器上已经有一把密钥了')

  const previous = currentKey()
  const key = await createVaultKey()
  const written = await guard(
    invoke<null>('vault_key_write', { key: encodeKeyString(key) }),
    '保存本机密钥失败'
  )
  if (!written.ok) return fail(written.error ?? '保存本机密钥失败')

  cachedKey = key
  const adopted = await adoptKey(key, previous)
  if (!adopted.ok) return fail(adopted.error ?? '保存保险库失败')

  return ok({ exists: true, unlocked: true, fingerprint: await publicKeyFingerprint(key) })
}

/**
 * 导入一把别处导出的密钥（凭据管理器里存起来），并把本机那份挪到它下面。
 *
 * 正常用法是在**新机器**上导入：本机还没有文件，导入完同步一次就把仓库里那些条目拉下来了。
 * 在一台已经有保险库的机器上导入另一把密钥，等于换成另一份保险库 ——
 * 本机原来那些条目（用旧密钥加的密）按墓碑处理，见 `adoptKey`。
 */
export async function importKey(text: string): Promise<Result<VaultKeyState>> {
  const key = parseKeyString(text)
  if (!key) return fail('这段内容不是一把保险库密钥')

  const previous = currentKey()
  const written = await guard(
    invoke<null>('vault_key_write', { key: encodeKeyString(key) }),
    '保存本机密钥失败'
  )
  if (!written.ok) return fail(written.error ?? '保存本机密钥失败')

  cachedKey = key
  const adopted = await adoptKey(key, previous)
  if (!adopted.ok) return fail(adopted.error ?? '保存保险库失败')

  return ok({ exists: true, unlocked: true, fingerprint: await publicKeyFingerprint(key) })
}

/** 忘掉本机密钥（换密钥、或要把这台机器彻底退出保险库时用） */
export async function forgetKey(): Promise<Result<VaultKeyState>> {
  const cleared = await guard(invoke<null>('vault_key_clear'), '清除本机密钥失败')
  if (!cleared.ok) return fail(cleared.error ?? '清除本机密钥失败')

  cachedKey = null
  return ok({ exists: false, unlocked: false, fingerprint: '' })
}

/** 导出成文件：先挑存到哪儿，再把密钥串写进去 */
export async function exportKey(path: string): Promise<Result<null>> {
  if (!cachedKey) return fail('先解锁再导出')
  return guard(
    invoke<null>('vault_key_export', { path, key: encodeKeyString(cachedKey) }),
    '导出密钥失败'
  )
}

/** 读一个导出的密钥文件，认得出是密钥就存进凭据管理器 */
export async function importKeyFile(path: string): Promise<Result<VaultKeyState>> {
  const text = await guard(invoke<string>('vault_key_import', { path }), '读取密钥文件失败')
  if (!text.ok) return fail(text.error ?? '读取密钥文件失败')
  return importKey(text.data ?? '')
}

// ---------- 条目 ----------

/** 本机那份文件（原样返回，收敛交给 shared/vault.ts） */
async function loadFile(key: VaultPublicKey): Promise<Result<VaultFile>> {
  const raw = await guard(invoke<unknown>('vault_load'), '读取保险库失败')
  if (!raw.ok) return fail(raw.error ?? '读取保险库失败')

  // 还没有文件（第一次用）时后端给的是 null，那不是错误
  if (raw.data === null || raw.data === undefined) return ok(emptyVaultFile(key))

  const parsed = parseVaultFile(raw.data)
  if (!parsed) return fail('本机那份 vault.json 认不出来（可能被手工改坏了）')
  return ok(parsed.file)
}

async function saveFile(file: VaultFile): Promise<Result<null>> {
  return guard(invoke<null>('vault_save', { value: file }), '保存保险库失败')
}

/**
 * 读出全部条目。**解密在渲染层**：密钥在这儿拿到，明文也在这儿出现，之后只活在内存里。
 */
export async function load(): Promise<Result<VaultLoaded>> {
  const key = currentKey()
  if (!key) return fail('保险库还没有解锁')

  const raw = await guard(invoke<unknown>('vault_load'), '读取保险库失败')
  if (!raw.ok) return fail(raw.error ?? '读取保险库失败')

  const parsed =
    raw.data === null || raw.data === undefined
      ? { file: emptyVaultFile(publicKeyOf(key)), dropped: 0 }
      : parseVaultFile(raw.data)
  if (!parsed) return fail('本机那份 vault.json 认不出来（可能被手工改坏了）')

  const { records, failed } = await openAll(key, parsed.file)
  return ok({
    records,
    unreadable: failed.length,
    dropped: parsed.dropped,
    updatedAt: lastChangeAt(parsed.file.items)
  })
}

/** 一条条目的元信息（更新与删除都要用 id / updatedAt / by） */
export interface VaultWriteInput {
  id: string
  entry: VaultEntry
}

/**
 * 写一条（新增或改动）。
 *
 * **只重封这一条**：其余条目的密文原样留着 —— 重新加密一遍会让字节也全变，
 * 于是「内容没变就不产生提交」这条约定失效，仓库里会堆出一串无意义的提交。
 *
 * `by` 取本机设备标识（与 Token 分片、笔记图片目录同一个）：合并时时间撞上要靠它破平，
 * 而它的判据是「两台机器算得一样」，所以必须是那个稳定 id，不能用机器名。
 */
export async function save(input: VaultWriteInput): Promise<Result<VaultRecord>> {
  const key = currentKey()
  if (!key) return fail('保险库还没有解锁')

  const file = await loadFile(key)
  if (!file.ok) return fail(file.error ?? '读取保险库失败')

  const device = await localDevice()
  const updatedAt = Date.now()
  // **收敛之后再封**，回来的那条也用收敛后的值：`seal` 自己也会过一遍 sanitize，
  // 于是不收敛的话，界面上拿到的（`开发 `）与磁盘上存下的（`开发`）会差一个空白 ——
  // 刷新一次分组标签就换了个写法
  const entry = sanitizeVaultEntry(input.entry)
  const sealed = await seal(publicKeyOf(key), entry)
  const item: VaultItem = { id: input.id, updatedAt, by: device.id, ...sealed }

  const items = [...file.data!.items.filter((existing) => existing.id !== input.id), item]
  const written = await saveFile(vaultFileOf(key, items))
  if (!written.ok) return fail(written.error ?? '保存保险库失败')

  return ok({ ...entry, id: input.id, updatedAt, by: device.id })
}

/** 删一条：换成墓碑。空壳留着是为了让别的机器别把它复活（见 shared/vault.ts 的 mergeVaultItems） */
export async function remove(id: string): Promise<Result<null>> {
  const key = currentKey()
  if (!key) return fail('保险库还没有解锁')

  const file = await loadFile(key)
  if (!file.ok) return fail(file.error ?? '读取保险库失败')

  const device = await localDevice()
  const items = [
    ...file.data!.items.filter((existing) => existing.id !== id),
    tombstoneOf({ id }, Date.now(), device.id)
  ]
  return saveFile(vaultFileOf(key, items))
}

// ---------- 同步 ----------

/** 读回远端那份（仓库里还没有时是 null） */
async function pullRemote(repo: string): Promise<Result<VaultFile | null>> {
  const raw = await guard(invoke<unknown>('vault_pull', { repo }), '读取仓库失败')
  if (!raw.ok) return fail(raw.error ?? '读取仓库失败')
  if (raw.data === null || raw.data === undefined) return ok(null)

  const parsed = parseVaultFile(raw.data)
  if (!parsed) return fail('仓库里那个路径上放的不是一份保险库文件')
  return ok(parsed.file)
}

/**
 * 把合出来的那份写回远端。`base` 是这次合并依据的远端那份（远端还没有时传 null）。
 *
 * 回来的 `remote` 已经收敛成本地认的那份文件（那一段 JSON 认不出来时给 null，
 * 下一轮的 pull 会重新取一遍），调用方不必再判形状。
 */
async function pushRemote(
  repo: string,
  content: VaultFile,
  base: VaultFile | null
): Promise<Result<{ pushed: boolean; remote: VaultFile | null; reason?: string }>> {
  const outcome = await guard(
    invoke<VaultPushOutcome>('vault_push', { repo, content, base }),
    '推送到仓库失败'
  )
  if (!outcome.ok) return fail(outcome.error ?? '推送到仓库失败')

  const value = outcome.data
  if (!value) return fail('推送到仓库失败')

  return ok({
    pushed: value.pushed,
    // 远端被别的机器改过时它交回一份新的；那份认不出来就当作没拿到
    remote: value.remote === null || value.remote === undefined ? null : (parseVaultFile(value.remote)?.file ?? null),
    reason: value.reason
  })
}

/**
 * 同步一轮：拉回远端 → 与本机那份合并 → 落盘 → 推上去。
 *
 * 远端被别的机器改过时（push 交回来一份新的）重走一遍，最多 `SYNC_ROUNDS` 遍 ——
 * 每走一遍都会把那份新内容合进来，所以正常的并发同步一两遍就收敛了。
 *
 * **本机那份先落盘再推**：即使推送失败，合并的结果也已经在本机了，
 * 下次同步不会因为「上次那半截没保存」而重来。
 */
export async function sync(repo: string): Promise<Result<VaultSyncOutcome>> {
  const key = currentKey()
  if (!key) return fail('保险库还没有解锁')
  if (!repo.trim()) return fail('还没有登录账号并填同步仓库地址')

  const local = await loadFile(key)
  if (!local.ok) return fail(local.error ?? '读取保险库失败')

  let merged = local.data!
  let base: VaultFile | null = null
  let remoteItems: VaultItem[] = []
  let remoteKeyMismatch = false

  for (let round = 0; round < SYNC_ROUNDS; round += 1) {
    const remote = await pullRemote(repo)
    if (!remote.ok) return fail(remote.error ?? '读取仓库失败')
    base = remote.data ?? null
    remoteItems = remote.data?.items ?? []

    // 仓库里那份是用别的密钥加的密：能合并、能推，但那些条目在这台机器上永远解不开。
    // 这不能悄悄过去 —— 用户会看到「同步成功，但一条都没多出来」。
    if (remote.data && !sameVaultKey(remote.data, publicKeyOf(key))) remoteKeyMismatch = true

    merged = vaultFileOf(key, mergeVaultItems(merged.items, remoteItems))

    const saved = await saveFile(merged)
    if (!saved.ok) return fail(saved.error ?? '保存保险库失败')

    const pushed = await pushRemote(repo, merged, base)
    if (!pushed.ok) return fail(pushed.error ?? '推送到仓库失败')
    if (pushed.data!.pushed) {
      const loaded = await load()
      if (!loaded.ok) return fail(loaded.error ?? '读取保险库失败')
      return ok({
        rounds: round + 1,
        remoteItems: remoteItems.length,
        keyMismatch: remoteKeyMismatch,
        ...loaded.data!
      })
    }

    // 远端在这一轮里又被推过：拿它交回来的那份当新的本机内容，重走一遍
    if (pushed.data!.remote) merged = vaultFileOf(key, mergeVaultItems(merged.items, pushed.data!.remote.items))
  }

  return fail(`同步撞了三轮都没落定（仓库里那份一直在被改动），稍后再试一次`)
}

/** 仓库里那份与本机这把密钥对不对得上（给界面提前说一句「两边密钥不一样」） */
export async function remoteKeyStatus(repo: string): Promise<Result<'none' | 'match' | 'mismatch'>> {
  const key = currentKey()
  if (!key) return fail('保险库还没有解锁')

  const remote = await pullRemote(repo)
  if (!remote.ok) return fail(remote.error ?? '读取仓库失败')
  if (!remote.data) return ok('none')
  return ok(sameVaultKey(remote.data, publicKeyOf(key)) ? 'match' : 'mismatch')
}
