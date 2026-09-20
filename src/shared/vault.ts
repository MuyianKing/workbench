/**
 * 密码保险库：条目模型、文件信封、跨设备合并与加解密。
 *
 * **它是一个密码备忘**：一条记录就是「名字 + 密码 + 备注 + 分组」四样，界面上一张卡片。
 * 没有用户名 / 网址那一套字段，也不生成口令 —— 多一个字段就多一份要填的东西，
 * 而这几样本来就是随手记下的东西（见 `VaultEntry`）。
 *
 * **为什么是这套密码学**：一把 ECDH P-256 密钥对，**私钥只住在本机**（Windows 凭据管理器，
 * 见 Rust 的 `vault.rs`），公钥是一段谁拿到都没用的公开信息。每条条目单独走一次 ECIES：
 * 现生成一把临时密钥对 → 与那把公钥做 ECDH → HKDF-SHA256 推出 AES-256-GCM 的密钥 → 加密条目正文。
 * 于是「能加不能解」是真的成立（有公钥就能往里写，没有私钥就读不出来），而仓库里那份
 * 从头到尾只有密文。
 *
 * **为什么不用 Rust 侧的密码学库**：`rust-crypto` / `rsa` / `p256` 这一批都会往编译图里
 * 加进成片的编译单元（项目对新增依赖的判据是「不新增编译单元」，见 AGENTS.md 第 1 节），
 * 而 WebView2 自己就带着一套标准的 WebCrypto。加密在渲染层做，密钥以 base64 过一条 IPC ——
 * 这是**唯一**一处机密进渲染层的地方，理由是解密后的正文本来就要在这儿显示，
 * 而 Rust 侧没有能做这件事的工具（账号的 access_token 不在此列，它给 git 用，仍在 Rust 侧）。
 *
 * **文件只有一份，所有机器共写**（用户的要求）。这打破了仓库里其余几处的「一台机器一个文件、
 * 单写者、因此不需要人工合并」那条约定，所以合并规则必须自己定死，见 `mergeVaultItems`：
 * 按 id 取并集、每条取 `updatedAt` 大的那份（撞上时按设备 id 破平），删除留一个空壳墓碑。
 * 这个函数是纯的、且两边机器的输入集合相同 → 算出来的结果逐字节一致，
 * 于是「两台机器同时改」不需要人工挑边，也不需要 git 去碰它（同步流程见 workbench/vault.ts）。
 *
 * **仓库里那份文件会露出什么**：条目条数、每条的最后改动时刻与设备 id、哪些 id 被删过。
 * 名字、密码、备注、分组全在密文里。
 */

/** 文件格式版本。改了信封结构才动它，动的时候要在 parseVaultFile 里补一条迁移 */
export const VAULT_VERSION = 1

/** HKDF 的 info：把这条曲线上的共享秘密收敛成「只属于本应用这一版保险库」的密钥 */
const HKDF_INFO = 'workbench-vault-v1'

/** 导出密钥串的前缀：粘回来时先认这个头，别把别的 base64 当成密钥 */
const KEY_PREFIX = 'workbench-vault-v1.'

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const
const AES = 'AES-GCM'

/** 公钥的 JWK：只有这三个坐标，没有 d（私钥那一段） */
export interface VaultPublicKey {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

/** 私钥的 JWK：公钥那三个坐标加一个 d。**只在本机、只在渲染层内存与凭据管理器之间流转** */
export interface VaultPrivateKey extends VaultPublicKey {
  d: string
}

/**
 * 磁盘上（以及仓库里）的一条记录：**信封是明文，正文是密文**。
 *
 * 明文那几项不是不小心漏出去的 —— 跨设备合并要在没有密钥的情况下也能算出同一个结果：
 * 认身份靠 `id`、判新旧靠 `updatedAt`、破平靠 `by`、认删除靠 `deleted`。
 * 少了任何一项，两台机器就会各执一词（一个说该留、一个说该删），而那需要人工去合。
 */
export interface VaultItem {
  /** 条目的稳定身份，从建出来到删掉都不变 —— 合并时唯一靠得住的东西 */
  id: string
  /** 最后改动时刻（毫秒）。跨设备合并判新旧就靠它 */
  updatedAt: number
  /** 最后改动的设备 id（`%APPDATA%/Workbench/data/device.json`）。时间撞上时用它破平 */
  by: string
  /** 墓碑：这一条已经被删了。只留个空壳，好让别的机器别把它复活 */
  deleted?: true
  /** 下面三项是密文，墓碑上没有。pub 是这次加密现生成的临时公钥（ECIES 的一半） */
  pub?: string
  iv?: string
  ct?: string
}

/** 一份保险库文件。本机那份与仓库里那份是同一个形状 —— 同步就是把它整份写过去 */
export interface VaultFile {
  version: number
  /** 这份文件是用哪把公钥加的密。换过密钥的机器一眼看得出来，而不是满屏解不开的条目 */
  key: VaultPublicKey
  /** 全部条目。**按 id 升序**：两台机器合并出同一份内容时才能逐字节一样，不产生假提交 */
  items: VaultItem[]
}

/**
 * 一条条目的正文（加密前 / 解密后就是这个）。字段都很短，密文里没有任何结构可认。
 *
 * **它是一个备忘，不是密码管理器**：所以只有「名字、密码、备注」三样加一个分组 ——
 * 没有用户名、没有网址、也不生成口令。多一个字段就多一份要填的东西，
 * 而这几样本来就是随手记下的东西，抄在哪儿都一样。
 */
export interface VaultEntry {
  /** 名字：卡片上那一行，也是认人的那一个。必填 */
  name: string
  password: string
  /** 备注：除了密码之外还想记一句的东西（两段式验证、备用码放在哪…） */
  notes: string
  /**
   * 分组：**自由文本，不是一份要管理的清单** —— 卡片按它归类，筛选标签从现存的取值里现算
   * （见 `vaultGroups`）。所以没有「新建分组 / 改名 / 删除」那一套：想分一组就在这一栏里打一个新名字，
   * 那一组自然就出现了；一组都没了它也自然消失。
   */
  group: string
}

/** 界面用的那条记录：解密出来的正文 + 信封里的元信息 */
export interface VaultRecord extends VaultEntry {
  id: string
  updatedAt: number
  by: string
}

/** 文件里认出来的那些 + 读不出来的条数（不为 0 时界面要如实说一句） */
export interface ParsedVault {
  file: VaultFile
  dropped: number
}

// ---------- base64url 与字节 ----------

/**
 * base64url（RFC 4648 §5）：没有 `+` `/` `=`，可以直接出现在 JSON 字段里。
 * 走 btoa / atob 而不是手写查表 —— 两个环境（WebView2 与 Node）都自带，且是原生实现。
 *
 * 返回类型写死 `Uint8Array<ArrayBuffer>` 而不是裸的 `Uint8Array`：后者的默认泛型参数是
 * `ArrayBufferLike`，而 WebCrypto 那几个参数要的是 `ArrayBufferView<ArrayBuffer>` ——
 * 裸类型在这里过不了类型检查（`SharedArrayBuffer` 那一支被排除掉了）。
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

// ---------- 密钥 ----------

/** 现生成一把保险库密钥。私钥可导出（要存进凭据管理器、也要导出到别的机器） */
export async function createVaultKey(): Promise<VaultPrivateKey> {
  const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return {
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x ?? '',
    y: jwk.y ?? '',
    d: jwk.d ?? ''
  }
}

/**
 * 从私钥上摘出公钥那一段：写进文件、也交给 `seal` 用。
 *
 * 必须逐字段拼出来，**不能把入参整个摊开**：`VaultPrivateKey` 在结构上是
 * `VaultPublicKey` 的子集，所以一把私钥传得进所有收公钥的函数，而带着 `d` 的 JWK
 * 会被 WebCrypto 当成私钥 —— 私钥不接受空 usages，于是报的是
 * 「Usages cannot be empty when importing a private key」，与「密钥不对」看着毫无关系。
 * 收公钥的那几处一律先过这一道。
 */
export function publicKeyOf(key: VaultPublicKey): VaultPublicKey {
  return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }
}

/** 形状对不对。读凭据管理器 / 读用户导入的文件时先过这一关，别把半截 JWK 拿去 import */
export function isVaultPrivateKey(value: unknown): value is VaultPrivateKey {
  if (typeof value !== 'object' || value === null) return false
  const key = value as Record<string, unknown>
  return (
    key.kty === 'EC' &&
    key.crv === 'P-256' &&
    typeof key.x === 'string' &&
    key.x.length > 0 &&
    typeof key.y === 'string' &&
    key.y.length > 0 &&
    typeof key.d === 'string' &&
    key.d.length > 0
  )
}

export function isVaultPublicKey(value: unknown): value is VaultPublicKey {
  if (typeof value !== 'object' || value === null) return false
  const key = value as Record<string, unknown>
  return (
    key.kty === 'EC' &&
    key.crv === 'P-256' &&
    typeof key.x === 'string' &&
    key.x.length > 0 &&
    typeof key.y === 'string' &&
    key.y.length > 0
  )
}

/**
 * 把密钥打成一段可以抄到另一台机器的串（导出密钥文件里存的就是它）。
 *
 * 前缀是给「粘回来」那一刻用的：先认这个头，才谈得上后面的解析，
 * 而不是把随便一段 base64 当成密钥去 import 然后报一句看不懂的错。
 */
export function encodeKeyString(key: VaultPrivateKey): string {
  return KEY_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(key)))
}

/** `encodeKeyString` 的反面：认不出来一律 null，调用方据此给一句人话 */
export function parseKeyString(text: string): VaultPrivateKey | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(KEY_PREFIX)) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(trimmed.slice(KEY_PREFIX.length))))
    return isVaultPrivateKey(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 公钥的指纹（`A1B2-C3D4-E5F6`），用来核对两台机器拿的是不是同一把密钥。
 *
 * 取公钥原始点（65 字节）的 SHA-256 前 6 字节 —— 给的是公钥，不是密钥本身，
 * 所以可以放心上屏：它反过来推不出私钥，两台机器对不上时也只说明「该重新导出一次」。
 */
export async function publicKeyFingerprint(key: VaultPublicKey): Promise<string> {
  const imported = await crypto.subtle.importKey('jwk', publicKeyOf(key), CURVE, true, [])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', imported))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  const hex = Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return hex.toUpperCase().replace(/(.{4})(?=.)/g, '$1-')
}

/** 文件里记的那把公钥与手上这把是不是同一把（坐标逐字比，不做任何归一化） */
export function sameVaultKey(file: VaultFile, key: VaultPublicKey): boolean {
  return file.key.x === key.x && file.key.y === key.y
}

// ---------- 加密与解密（ECIES） ----------

/** 两边各自算一次这个：ECDH 出共享秘密，再 HKDF 收敛成一把 AES-256-GCM 密钥 */
async function sharedAesKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // 盐与 info 都是常量：这里没有「同一把密钥加密多条消息要各自域分离」的需求，
      // 每条条目的密钥来自**每次现场生成的临时密钥对**，本身就已经一次一密
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(HKDF_INFO)
    },
    material,
    { name: AES, length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * 一条信封里属于密文的那三项。单独一个类型（而不是 `Omit<VaultItem, …>`）是为了让它们是必填的：
 * 那个 `Omit` 会把 `pub` / `iv` / `ct` 的可选性一起带过来，于是每个用它的地方都得多写一次非空判断。
 */
export interface SealedEntry {
  pub: string
  iv: string
  ct: string
}

/**
 * 把一条正文封成信封：**只要有公钥就能做，不需要私钥**。
 * 临时密钥对是这次现生成的，用完就丢 —— 于是同一条正文加密两次得到的密文完全不同。
 */
export async function seal(key: VaultPublicKey, entry: VaultEntry): Promise<SealedEntry> {
  const publicKey = await crypto.subtle.importKey('jwk', publicKeyOf(key), CURVE, false, [])
  const ephemeral = await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])

  const aes = await sharedAesKey(ephemeral.privateKey, publicKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(sanitizeVaultEntry(entry)))
  const ct = await crypto.subtle.encrypt({ name: AES, iv }, aes, plaintext)
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))

  return { pub: toBase64Url(pub), iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) }
}

/**
 * 解开一条信封。**要私钥**。
 *
 * 抛错是正常的返回方式：密钥对不上、文件被改过一个字节（GCM 的认证标签会拦下）、
 * 或者那一段 base64 根本不是密文，都在这里失败 —— 调用方按「这一条读不出来」记一笔，
 * 让其余条目照常显示，而不是整份保险库打不开。
 */
export async function open(privateKey: VaultPrivateKey, item: VaultItem): Promise<VaultEntry> {
  if (!item.pub || !item.iv || !item.ct) throw new Error('这条记录里没有密文')

  // 这一处**故意**整个摊开：这里要的正是私钥（`d` 得带上），摊开才对。
  // 反过来，收公钥的那几处必须走 publicKeyOf()，理由见它的说明
  const key = await crypto.subtle.importKey('jwk', { ...privateKey }, CURVE, false, ['deriveBits'])
  const ephemeral = await crypto.subtle.importKey('raw', fromBase64Url(item.pub), CURVE, false, [])
  const aes = await sharedAesKey(key, ephemeral)

  const plaintext = await crypto.subtle.decrypt(
    { name: AES, iv: fromBase64Url(item.iv) },
    aes,
    fromBase64Url(item.ct)
  )
  const parsed: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext)))
  return sanitizeVaultEntry(parsed)
}

/** 读哪几条读不出来：返回 id 清单，界面据此如实说「有 N 条解不开」 */
export async function openAll(
  privateKey: VaultPrivateKey,
  file: VaultFile
): Promise<{ records: VaultRecord[]; failed: string[] }> {
  const records: VaultRecord[] = []
  const failed: string[] = []

  for (const item of file.items) {
    if (item.deleted) continue
    try {
      const entry = await open(privateKey, item)
      records.push({ ...entry, id: item.id, updatedAt: item.updatedAt, by: item.by })
    } catch {
      failed.push(item.id)
    }
  }

  return { records, failed }
}

// ---------- 条目 ----------

export function sanitizeVaultEntry(raw: unknown): VaultEntry {
  if (typeof raw !== 'object' || raw === null) return emptyVaultEntry()
  const value = raw as Record<string, unknown>
  const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string) : '')

  return {
    // 名字这一栏原来叫 title：已经存下的记录读的时候认一下，别让它变成一张没有字的卡片
    name: (text('name') || text('title')).slice(0, 200),
    password: text('password').slice(0, 500),
    notes: text('notes').slice(0, 5000),
    // 分组名去掉首尾空白：`开发 ` 与 `开发` 必须被当成同一组 —— 否则排序认为它们不同、
    // 而筛选标签按名字精确匹配，点进去是空的（分组这一栏本来就是随手打的）
    group: text('group').trim().slice(0, 100)
  }
}

/** 新建一条空条目：名字空着，弹框里填 */
export function emptyVaultEntry(): VaultEntry {
  return { name: '', password: '', notes: '', group: '' }
}

/** 名字是唯一的必填项 —— 卡片上就靠它认人，没有名字的卡片是一块看不出是什么的东西 */
export function vaultEntryProblem(entry: VaultEntry): string | null {
  return entry.name.trim() ? null : '请填一个名字'
}

/** 删掉的条目留下的空壳：只记「什么时候、被哪台机器删的」，正文整段不要 */
export function tombstoneOf(item: Pick<VaultItem, 'id'>, updatedAt: number, by: string): VaultItem {
  return { id: item.id, updatedAt, by, deleted: true }
}

// ---------- 合并 ----------

/** 同一个 id 上取新的那一份：先比时间，再比设备 id（保证两台机器算出同一个赢家） */
function pickNewer(a: VaultItem, b: VaultItem): VaultItem {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
  if (a.by !== b.by) return a.by > b.by ? a : b
  // 时间与设备都撞上：只可能是同一台机器在同一毫秒写下来的同一份内容，留本地那份即可
  return a
}

/**
 * 把本机那份和仓库里那份合成一份。**这个函数是同步的全部** —— 两台机器各自拿
 * (自己的, 对方的) 调一次，算出来的必须是同一份内容，否则就会来回覆盖、永远收敛不了，
 * 所以合并规则里不能有任何「以我为准」的倾向：只认 `updatedAt` 与 `by` 这两个明文事实。
 *
 * 三条：
 *  - **并集**：只在一边出现过的 id 直接留下（另一台机器新增的、或本机还没拉到的）；
 *  - **同 id 取新**：`updatedAt` 大的赢，撞上时 `by` 大的赢（于是「先比时间再比设备」两边算得一样）；
 *  - **墓碑不复活**：删除留下的空壳照常参与比较 —— 删得比改得晚就还是删。
 *    墓碑因此会一直留在文件里（约 90 字节）。不清理是**故意的**：清掉之后，
 *    一台离线很久的机器再回来时，本地那条老记录就成了「只有一边有」的并集项，
 *    于是被原样推回去 —— 用户看到的是删掉的密码自己回来了。
 *
 * 输出的顺序按 id 排：顺序不确定的话，两台机器合并完的文件会有没意义的字节差异，
 * 表现成仓库里堆出一串「什么都没改」的提交。
 */
export function mergeVaultItems(
  local: readonly VaultItem[],
  remote: readonly VaultItem[]
): VaultItem[] {
  const merged = new Map<string, VaultItem>()

  for (const item of local) merged.set(item.id, item)
  for (const item of remote) {
    const existing = merged.get(item.id)
    merged.set(item.id, existing ? pickNewer(existing, item) : item)
  }

  return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ---------- 文件 ----------

/** 用给定的条目凑出一份文件（本机那份与要推上去的那份都是它） */
export function vaultFileOf(key: VaultPublicKey, items: readonly VaultItem[]): VaultFile {
  return {
    version: VAULT_VERSION,
    key: publicKeyOf(key),
    items: mergeVaultItems(items, [])
  }
}

/** 空文件：还没建过保险库、或仓库里那份还不存在时用它当合并的一侧 */
export function emptyVaultFile(key: VaultPublicKey): VaultFile {
  return { version: VAULT_VERSION, key: publicKeyOf(key), items: [] }
}

/** 一条信封能不能用：缺 id / 时间不是数 / 正文三件套不齐的一律不算 */
function normalizeItem(raw: unknown): VaultItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!id) return null
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null

  const by = typeof value.by === 'string' ? value.by : ''
  if (value.deleted === true) return { id, updatedAt: value.updatedAt, by, deleted: true }

  const pub = typeof value.pub === 'string' ? value.pub : ''
  const iv = typeof value.iv === 'string' ? value.iv : ''
  const ct = typeof value.ct === 'string' ? value.ct : ''
  if (!pub || !iv || !ct) return null

  return { id, updatedAt: value.updatedAt, by, pub, iv, ct }
}

/**
 * 读一份文件（本机磁盘上那份、或从仓库里拿回来的那份）。
 *
 * 认不出来返回 null —— 与「文件不存在」是两回事：仓库里那个路径上放着一份别的东西时，
 * 必须如实说「那不是保险库文件」，而不是当成空的然后拿本机这份把它盖掉。
 * 单条坏掉只丢那一条，并在 `dropped` 里报个数：整份作废等于把还能读的密码一起弄丢。
 */
export function parseVaultFile(raw: unknown): ParsedVault | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.version !== 'number') return null
  if (!isVaultPublicKey(value.key)) return null
  if (!Array.isArray(value.items)) return null

  const items: VaultItem[] = []
  let dropped = 0
  for (const candidate of value.items) {
    const item = normalizeItem(candidate)
    if (item) items.push(item)
    else dropped += 1
  }

  return {
    file: {
      version: VAULT_VERSION,
      key: publicKeyOf(value.key),
      items: mergeVaultItems(items, [])
    },
    dropped
  }
}

// ---------- 查找 ----------

/**
 * 卡片过滤：名字、备注、分组里任一处出现关键词即算命中（不分大小写）。
 *
 * 空关键词返回原列表 —— 顺带保证卡片顺序由调用方决定，这里不重排。
 */
export function filterVaultRecords(records: readonly VaultRecord[], query: string): VaultRecord[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...records]

  return records.filter((record) =>
    [record.name, record.notes, record.group].some((field) => field.toLowerCase().includes(needle))
  )
}

/** 按名字比：中文按拼音、数字按大小（`服务器 9` 排在 `服务器 10` 前面） */
function byName(a: VaultRecord, b: VaultRecord): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
}

/**
 * 卡片的顺序：**先按分组、组内按名字**。
 *
 * 分组是自由文本，没有一份「分组顺序」可配，所以按名字排 —— 于是同一组的卡片在「全部」那一档里
 * 也是挨着的，一眼看得出归了哪些组。**未分组排在最后**：它是个兜底，不该挤在正经分组前面。
 * 末了拿 id 兜底，保证顺序是稳的（两台机器看到的排列一样）。
 */
export function sortVaultRecords(records: readonly VaultRecord[]): VaultRecord[] {
  return [...records].sort((a, b) => {
    if (!a.group !== !b.group) return a.group ? -1 : 1
    return (
      a.group.localeCompare(b.group, 'zh-Hans-CN', { numeric: true }) ||
      byName(a, b) ||
      (a.id < b.id ? -1 : 1)
    )
  })
}

/**
 * 现在有哪些分组：从卡片里现算，按名字排。
 *
 * 这里**不再各自去空白**：`group` 的不变量是「已经过 `sanitizeVaultEntry` 收敛」
 * （排序、筛选标签、分段三处都按同一个值比，各自处理一次反而会做出三个不同的判断）。
 *
 * 分组是自由文本（见 `VaultEntry.group`），所以这份清单是**算出来的**、不是存下来的：
 * 某一组最后一条被改到别处或删掉，它自己就没了，不会留下一枚点进去什么都没有的标签。
 */
export function vaultGroups(records: readonly VaultRecord[]): string[] {
  const names = new Set<string>()
  for (const record of records) {
    if (record.group) names.add(record.group)
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))
}

/** 没归类的那一段的标题。与筛选标签上的「未分组」是同一个词 */
export const UNGROUPED_LABEL = '未分组'

/** 卡片墙的一段：一个分组，加它下面的卡片 */
export interface VaultSection {
  /** 分组名；空串是「未分组」那一段 */
  key: string
  label: string
  records: VaultRecord[]
}

/**
 * 把卡片按分组切成一段一段（卡片墙上每一段一个标题、一段一行卡片）。
 *
 * **输入必须已经按分组排好**（`sortVaultRecords` 的输出）：于是相邻的同组卡片自然连成一段，
 * 一个 Map 都不需要。分段与排序拆成两个函数是有意的 —— 排序管「谁先谁后」、分段管「哪儿断开」，
 * 混在一起就得在两处各写一遍比较规则，而它们迟早会不一致。
 */
export function groupVaultRecords(records: readonly VaultRecord[]): VaultSection[] {
  const sections: VaultSection[] = []

  for (const record of records) {
    const last = sections[sections.length - 1]
    if (last && last.key === record.group) last.records.push(record)
    else sections.push({ key: record.group, label: record.group || UNGROUPED_LABEL, records: [record] })
  }

  return sections
}

/** 最近改动的那一条的时间（毫秒），一条都没有时 0 —— 界面上的「更新于」用它 */
export function lastChangeAt(items: readonly VaultItem[]): number {
  return items.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), 0)
}
