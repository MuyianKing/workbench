import { describe, expect, it } from 'vitest'
import {
  createVaultKey,
  emptyVaultEntry,
  encodeKeyString,
  filterVaultRecords,
  groupVaultRecords,
  isVaultPrivateKey,
  isVaultPublicKey,
  lastChangeAt,
  mergeVaultItems,
  open,
  openAll,
  parseKeyString,
  parseVaultFile,
  publicKeyFingerprint,
  publicKeyOf,
  sameVaultKey,
  sanitizeVaultEntry,
  seal,
  sortVaultRecords,
  tombstoneOf,
  vaultEntryProblem,
  vaultFileOf,
  vaultGroups,
  type VaultEntry,
  type VaultItem,
  type VaultRecord
} from './vault'

/** 一份固定的正文，避免每个用例各写一遍 */
const ENTRY: VaultEntry = {
  name: 'GitHub',
  password: '正确的马电池订书钉',
  notes: '两段式验证开着',
  group: '开发'
}

/** 造一条信封：只填合并逻辑关心的那几个字段 */
function item(id: string, updatedAt: number, by: string, extra: Partial<VaultItem> = {}): VaultItem {
  return { id, updatedAt, by, pub: 'p', iv: 'i', ct: 'c', ...extra }
}

describe('加密与解密', () => {
  it('有公钥就能加密，只有私钥才解得开', async () => {
    const key = await createVaultKey()
    const sealed = await seal(publicKeyOf(key), ENTRY)
    const opened = await open(key, { id: 'a', updatedAt: 1, by: 'me', ...sealed })

    expect(opened).toEqual(ENTRY)
  })

  it('密文里看不出正文，同一条加密两次也不一样', async () => {
    const key = await createVaultKey()
    const first = await seal(key, ENTRY)
    const second = await seal(key, ENTRY)

    // 每次现场生成临时密钥对，于是连密文长度都不必相同
    expect(first.ct).not.toBe(second.ct)
    for (const field of ['name', 'password', 'notes', 'group', 'GitHub', '开发']) {
      expect(JSON.stringify(first)).not.toContain(field)
    }
  })

  it('换一把密钥解不开 —— 这正是「有公钥能写、没私钥不能读」的另一面', async () => {
    const key = await createVaultKey()
    const other = await createVaultKey()
    const sealed = await seal(publicKeyOf(key), ENTRY)

    await expect(open(other, { id: 'a', updatedAt: 1, by: 'me', ...sealed })).rejects.toThrow()
  })

  it('密文被改过一个字节也解不开（GCM 的认证标签）', async () => {
    const key = await createVaultKey()
    const sealed = await seal(key, ENTRY)
    const bytes = atob(sealed.ct.replace(/-/g, '+').replace(/_/g, '/'))
    const flipped = String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1)
    const ct = btoa(flipped).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    await expect(open(key, { id: 'a', updatedAt: 1, by: 'me', ...sealed, ct })).rejects.toThrow()
  })

  it('解不开的条目只算那一条失败，其余照常读出来', async () => {
    const key = await createVaultKey()
    const other = await createVaultKey()
    const good = await seal(key, ENTRY)
    const bad = await seal(other, ENTRY)

    const file = vaultFileOf(publicKeyOf(key), [
      { id: 'good', updatedAt: 1, by: 'a', ...good },
      { id: 'bad', updatedAt: 2, by: 'a', ...bad },
      { id: 'gone', updatedAt: 3, by: 'a', deleted: true }
    ])

    const { records, failed } = await openAll(key, file)
    expect(records.map((record) => record.id)).toEqual(['good'])
    expect(failed).toEqual(['bad'])
  })
})

describe('合并（两台机器各算一次必须得到同一份）', () => {
  it('只在一边出现过的直接留下', () => {
    const merged = mergeVaultItems([item('a', 1, 'x')], [item('b', 2, 'y')])
    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('同一个 id 取改动时间新的那份', () => {
    const older = item('a', 100, 'x', { ct: 'old' })
    const newer = item('a', 200, 'y', { ct: 'new' })

    expect(mergeVaultItems([older], [newer])).toEqual([newer])
    // 反过来传也一样：合并里没有「以本机为准」这一说
    expect(mergeVaultItems([newer], [older])).toEqual([newer])
  })

  it('时间撞上时按设备 id 破平 —— 两台机器算得出同一个赢家', () => {
    const fromX = item('a', 100, 'xxx', { ct: 'x' })
    const fromY = item('a', 100, 'yyy', { ct: 'y' })

    expect(mergeVaultItems([fromX], [fromY])).toEqual([fromY])
    expect(mergeVaultItems([fromY], [fromX])).toEqual([fromY])
  })

  it('墓碑比改动新就还是删，两种情况算出同一个结果', () => {
    const changed = item('a', 100, 'x', { ct: 'edited' })
    const removed = tombstoneOf({ id: 'a' }, 200, 'y')

    expect(mergeVaultItems([changed], [removed])).toEqual([removed])
    expect(mergeVaultItems([removed], [changed])).toEqual([removed])
  })

  it('空的墓碑**不会**盖掉更晚的改动（撤销不了别人的编辑，但也不会复活）', () => {
    const removed = tombstoneOf({ id: 'a' }, 100, 'y')
    const changed = item('a', 200, 'x', { ct: 'edited' })

    expect(mergeVaultItems([removed], [changed])).toEqual([changed])
  })

  it('结果是并集且按 id 排序：两台机器合并完逐字节一样', () => {
    const local = [item('c', 1, 'a'), item('a', 5, 'a')]
    const remote = [item('b', 9, 'b'), item('a', 2, 'b')]

    const one = mergeVaultItems(local, remote)
    const other = mergeVaultItems(remote, local)

    expect(one.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(JSON.stringify(one)).toBe(JSON.stringify(other))
  })

  it('墓碑也参与排序，不因为它是墓碑就飘到别处', () => {
    const merged = mergeVaultItems([item('b', 1, 'x'), tombstoneOf({ id: 'a' }, 2, 'x')], [])
    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('文件解析', () => {
  const key = { kty: 'EC' as const, crv: 'P-256' as const, x: 'xx', y: 'yy' }

  it('认不出来的返回 null —— 与「文件不存在」是两回事', () => {
    expect(parseVaultFile(null)).toBeNull()
    expect(parseVaultFile('nope')).toBeNull()
    expect(parseVaultFile({})).toBeNull()
    // 有 version / items，但 key 不是一把公钥
    expect(parseVaultFile({ version: 1, items: [], key: { kty: 'RSA' } })).toBeNull()
    expect(parseVaultFile({ version: 1, key, items: 'nope' })).toBeNull()
  })

  it('单条坏掉只丢那一条，并报出丢了几条', () => {
    const parsed = parseVaultFile({
      version: 1,
      key,
      items: [
        item('a', 1, 'x'),
        { id: '', updatedAt: 1, by: 'x', pub: 'p', iv: 'i', ct: 'c' },
        { id: 'b', updatedAt: 'nope', by: 'x' },
        { id: 'c', updatedAt: 1, by: 'x', pub: '', iv: 'i', ct: 'c' },
        item('d', 2, 'x')
      ]
    })

    expect(parsed?.file.items.map((entry) => entry.id)).toEqual(['a', 'd'])
    expect(parsed?.dropped).toBe(3)
  })

  it('墓碑不需要正文三件套', () => {
    const parsed = parseVaultFile({ version: 1, key, items: [tombstoneOf({ id: 'a' }, 1, 'x')] })
    expect(parsed?.dropped).toBe(0)
    expect(parsed?.file.items).toHaveLength(1)
  })

  it('读进来就顺手排好序（磁盘上那份手改乱了也不影响合并）', () => {
    const parsed = parseVaultFile({
      version: 1,
      key,
      items: [item('c', 1, 'x'), item('a', 1, 'x'), item('b', 1, 'x')]
    })
    expect(parsed?.file.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('密钥串与指纹', () => {
  it('导出的串能原样读回来', async () => {
    const key = await createVaultKey()
    const parsed = parseKeyString(encodeKeyString(key))
    expect(parsed).toEqual(key)
    expect(isVaultPrivateKey(parsed)).toBe(true)
  })

  it('认不出前缀、或里面不是密钥的一律 null', async () => {
    const key = await createVaultKey()
    expect(parseKeyString('')).toBeNull()
    expect(parseKeyString('aGVsbG8=')).toBeNull()
    // 前缀对、内容也解得出 base64，但它不是一把密钥
    expect(parseKeyString('workbench-vault-v1.' + btoa('{"kty":"RSA"}'))).toBeNull()
    // 公钥那半（没有 d）不能当私钥用
    expect(parseKeyString('workbench-vault-v1.' + btoa(JSON.stringify(publicKeyOf(key))))).toBeNull()
  })

  it('指纹只看公钥：同一把密钥稳定，换一把就不同', async () => {
    const key = await createVaultKey()
    const other = await createVaultKey()

    const once = await publicKeyFingerprint(publicKeyOf(key))
    expect(once).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    expect(await publicKeyFingerprint(publicKeyOf(key))).toBe(once)
    expect(await publicKeyFingerprint(publicKeyOf(other))).not.toBe(once)
  })

  it('公钥形状的判据不含 d —— 文件里那份没有私钥也认', async () => {
    const key = await createVaultKey()
    expect(isVaultPublicKey(publicKeyOf(key))).toBe(true)
    expect(isVaultPublicKey(key)).toBe(true)
    expect(isVaultPublicKey({ kty: 'EC', crv: 'P-256', x: 'a' })).toBe(false)
  })

  it('文件里记的公钥与手上这把是不是同一把', async () => {
    const key = await createVaultKey()
    const other = await createVaultKey()
    const file = vaultFileOf(publicKeyOf(key), [])

    expect(sameVaultKey(file, publicKeyOf(key))).toBe(true)
    expect(sameVaultKey(file, publicKeyOf(other))).toBe(false)
  })
})

describe('条目收敛', () => {
  it('名字是唯一的必填项（密码、备注、分组都可以空着）', () => {
    expect(vaultEntryProblem(emptyVaultEntry())).toBe('请填一个名字')
    expect(vaultEntryProblem({ ...emptyVaultEntry(), name: '   ' })).toBe('请填一个名字')
    expect(vaultEntryProblem({ ...emptyVaultEntry(), name: '知乎' })).toBeNull()
    // 只记一个名字也算一条（备忘嘛）
    expect(vaultEntryProblem({ name: '宽带账号', password: '', notes: '', group: '' })).toBeNull()
  })

  it('缺字段补空串，非字符串当没填', () => {
    expect(sanitizeVaultEntry(null)).toEqual(emptyVaultEntry())
    expect(sanitizeVaultEntry({ name: 'a', password: 42 })).toEqual({ ...emptyVaultEntry(), name: 'a' })
  })

  it('名字这一栏认一下旧字段名 title：已经存下的记录不该变成一张没有字的卡片', () => {
    expect(sanitizeVaultEntry({ title: '老记录', password: 'p' })).toEqual({
      ...emptyVaultEntry(),
      name: '老记录',
      password: 'p'
    })
    // 两个都有时以 name 为准
    expect(sanitizeVaultEntry({ name: '新的', title: '老的' }).name).toBe('新的')
  })

  it('超长的字段截断，不因为手改出来的离谱内容把界面撑爆', () => {
    const long = sanitizeVaultEntry({ name: 'x'.repeat(500), notes: 'y'.repeat(9000), group: 'z'.repeat(500) })
    expect(long.name).toHaveLength(200)
    expect(long.notes).toHaveLength(5000)
    expect(long.group).toHaveLength(100)
  })
})

describe('查找、分组与排序', () => {
  /** 每一条都从空白条目起，免得 fixture 之间互相漏字段（漏了会让「只在备注里出现」的用例假通过） */
  const record = (id: string, fields: Partial<VaultRecord>): VaultRecord => ({
    ...emptyVaultEntry(),
    id,
    updatedAt: 1,
    by: 'me',
    ...fields
  })

  const records = [
    record('1', { name: 'GitHub', group: '开发', notes: '两段式验证开着' }),
    record('2', { name: '知乎', group: '日常' }),
    record('3', { name: '内网 OA' }),
    record('4', { name: '宽带账号', group: '日常', password: 'abc123' })
  ]

  it('名字、备注、分组里任一处命中都算', () => {
    expect(filterVaultRecords(records, 'github').map((entry) => entry.id)).toEqual(['1'])
    expect(filterVaultRecords(records, '两段式').map((entry) => entry.id)).toEqual(['1'])
    expect(filterVaultRecords(records, '日常').map((entry) => entry.id)).toEqual(['2', '4'])
    // 密码**不参与搜索**：它是拿来复制的，不是拿来当关键词的（搜密码等于把明文打进搜索框）
    expect(filterVaultRecords(records, 'abc123')).toEqual([])
  })

  it('关键词空（或只有空白）时原样返回，且不重排', () => {
    expect(filterVaultRecords(records, '  ').map((entry) => entry.id)).toEqual(['1', '2', '3', '4'])
  })

  it('分组取值现算：按名字排，空分组不进清单', () => {
    expect(vaultGroups(records)).toEqual(['开发', '日常'])
    expect(vaultGroups([])).toEqual([])
  })

  it('分组名收敛时去掉首尾空白（排序、标签、分段三处按同一个值比）', () => {
    // 不收敛的话 `开发 ` 与 `开发` 会被排序当成两组，而筛选标签按名字精确匹配 —— 点进去是空的
    expect(sanitizeVaultEntry({ name: 'x', group: '  开发  ' }).group).toBe('开发')
    expect(sanitizeVaultEntry({ name: 'x', group: '   ' }).group).toBe('')

    // 收敛之后它们就是同一组（夹具这里直接给收敛过的值，与生产路径一致）
    const same = [record('1', { group: '开发' }), record('2', { group: '开发' })]
    expect(vaultGroups(same)).toEqual(['开发'])
    expect(groupVaultRecords(sortVaultRecords(same))).toHaveLength(1)
  })

  it('分段：相邻的同组连成一段，标题空组叫「未分组」', () => {
    const sections = groupVaultRecords(sortVaultRecords(records))
    expect(sections.map((section) => [section.label, section.records.length])).toEqual([
      ['开发', 1],
      ['日常', 2],
      ['未分组', 1]
    ])
    // key 是分组名本身（空串代表未分组），label 才是给人看的那个
    expect(sections.map((section) => section.key)).toEqual(['开发', '日常', ''])
  })

  it('分段保留传进来的顺序，一段都不漏', () => {
    const sections = groupVaultRecords(sortVaultRecords(records))
    const flat = sections.flatMap((section) => section.records.map((entry) => entry.id))
    expect(flat).toEqual(sortVaultRecords(records).map((entry) => entry.id))
    expect(groupVaultRecords([])).toEqual([])
  })

  it('卡片顺序：先按分组、组内按名字，未分组排最后', () => {
    const sorted = sortVaultRecords(records)
    expect(sorted.map((entry) => entry.name)).toEqual(['GitHub', '宽带账号', '知乎', '内网 OA'])
    // 未分组垫底，即使它的名字排在最前
    expect(sorted[sorted.length - 1].group).toBe('')
  })

  it('名字里的数字按大小排，不逐字比', () => {
    const sorted = sortVaultRecords([record('1', { name: '服务器 10' }), record('2', { name: '服务器 9' })])
    expect(sorted.map((entry) => entry.name)).toEqual(['服务器 9', '服务器 10'])
  })

  it('顺序是稳的：分组与名字都一样时按 id 兜底', () => {
    const same = [record('b', { name: '同名' }), record('a', { name: '同名' })]
    expect(sortVaultRecords(same).map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('最近改动时间取最大的那条，一条都没有时是 0', () => {
    expect(lastChangeAt([item('a', 5, 'x'), item('b', 9, 'x'), item('c', 1, 'x')])).toBe(9)
    expect(lastChangeAt([])).toBe(0)
  })
})
