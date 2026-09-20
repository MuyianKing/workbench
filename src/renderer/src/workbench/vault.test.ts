/**
 * 保险库适配层：加解密、合并、以及同步那几轮编排。
 *
 * 这里盯的是**单测测不到的那一半** —— `shared/vault.ts` 那边是纯函数（合并规则、信封格式、
 * 密码学），而这一层管的是「拉 → 合 → 推」怎么走、远端在中间被改过怎么办、两台机器怎么收敛。
 * 桩照 token.test.ts / index.test.ts 那套：补一个假的 Tauri 桥，每条用例 `vi.resetModules()`
 * 重新导入（模块级缓存着本机那把密钥，不重置就会串味）。
 *
 * 桩里的 `remote` 是**两台机器共用**的那一份文件，`local` / `storedKey` 按机器分开 ——
 * 于是下面那个「两台机器共写一个文件」的用例走的就是真实的形状：同一把密钥、
 * 各自的 `vault.json`、一个共用的远端。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createVaultKey,
  encodeKeyString,
  parseKeyString,
  parseVaultFile,
  publicKeyOf,
  seal,
  type VaultEntry
} from '@shared/vault'

/** 当前是哪台机器（决定 local / storedKey 读哪一份） */
let machine = 'dev-a'
/** 各机器的本机那份文件 */
let local: Record<string, unknown | null> = {}
/** 各机器的凭据管理器 */
let keys: Record<string, string | null> = {}
/** 两台机器共用的远端（`vault/vault.json`） */
let remote: unknown = null
/** 让接下来 n 次 push 被挡下来（模拟「远端在这一轮里被另一台机器推过」） */
let refuseNextPush = 0
/**
 * 被挡下的那一次 push 之前要做什么 —— 用它复现「远端在拉与推之间被改了」：
 * 拉的时候还看不到那条，推的时候才出现，而那正是 `base` 那道闸要拦的窗口。
 * 只在桩里跑一次（跑完就摘掉）。
 */
let beforeRefusal: (() => Promise<void>) | null = null
/** 每次 push 收到的 base（断言「拿合并时的基准去核对」用） */
let pushBases: unknown[] = []

function bridge(): void {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        switch (command) {
          case 'token_device':
            return Promise.resolve({ id: machine, name: machine })
          case 'vault_load':
            return Promise.resolve(local[machine] ?? null)
          case 'vault_save':
            local[machine] = args?.value as Record<string, unknown>
            return Promise.resolve(null)
          case 'vault_key_read':
            return Promise.resolve(keys[machine] ?? null)
          case 'vault_key_write':
            keys[machine] = String(args?.key ?? '')
            return Promise.resolve(null)
          case 'vault_key_clear':
            keys[machine] = null
            return Promise.resolve(null)
          case 'vault_pull':
            return Promise.resolve(remote)
          case 'vault_push': {
            pushBases.push(args?.base ?? null)
            if (refuseNextPush > 0) {
              refuseNextPush -= 1
              const hook = beforeRefusal
              beforeRefusal = null
              return (hook ? hook() : Promise.resolve()).then(() => ({
                pushed: false,
                remote
              }))
            }
            remote = args?.content ?? null
            return Promise.resolve({ pushed: true, remote })
          }
          default:
            return Promise.resolve(null)
        }
      }
    }
  }
}

/** 每次用例都拿一份全新的模块状态（本机密钥缓存在模块里） */
async function freshModule(): Promise<typeof import('./vault')> {
  vi.resetModules()
  return import('./vault')
}

/** 一条记录：名字必填，其余三项按需给 —— 夹具之间不该互相漏字段 */
function entry(name: string, extra: Partial<VaultEntry> = {}): VaultEntry {
  return { name, password: '', notes: '', group: '', ...extra }
}

beforeAll(bridge)

beforeEach(() => {
  machine = 'dev-a'
  local = {}
  keys = {}
  remote = null
  refuseNextPush = 0
  beforeRefusal = null
  pushBases = []
})

describe('密钥', () => {
  it('建库：密钥落进凭据管理器，条目一开始是空的', async () => {
    const vault = await freshModule()
    const state = await vault.createKey(false)

    expect(state.ok).toBe(true)
    expect(state.data!.exists).toBe(true)
    expect(state.data!.unlocked).toBe(true)
    expect(state.data!.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    // 存的是「能粘回来」的那串，不是裸 JWK
    expect(keys['dev-a']).toMatch(/^workbench-vault-v1\./)
    expect(parseVaultFile(local['dev-a'])?.file.items).toEqual([])
  })

  it('已有密钥时 createKey(false) 不动它；replace 为真才换', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    const before = keys['dev-a']

    const again = await vault.createKey(false)
    expect(again.ok).toBe(false)
    expect(keys['dev-a']).toBe(before)

    const replaced = await vault.createKey(true)
    expect(replaced.ok).toBe(true)
    expect(keys['dev-a']).not.toBe(before)
  })

  it('锁上只丢内存里那把：凭据管理器里那条还在，重新解锁照样进得来', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    const saved = keys['dev-a']

    vault.lock()
    expect((await vault.keyState()).data!.unlocked).toBe(false)
    expect((await vault.keyState()).data!.exists).toBe(true)

    await vault.unlock()
    expect((await vault.keyState()).data!.unlocked).toBe(true)
    expect(keys['dev-a']).toBe(saved)
  })

  it('没解锁时读不出条目（密钥不在手上）', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    vault.lock()

    const loaded = await vault.load()
    expect(loaded.ok).toBe(false)
  })

  it('清除本机密钥之后这台机器解不开自己的保险库', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    await vault.forgetKey()

    expect((await vault.keyState()).data!.exists).toBe(false)
    // 文件还在，但密钥没了 —— 这正是「清除密钥」的语义，界面上要先确认一次
    expect(local['dev-a']).not.toBeNull()
  })
})

describe('条目', () => {
  it('写进去再读出来，五个字段逐字一样', async () => {
    const vault = await freshModule()
    await vault.createKey(false)

    const first = entry('GitHub', { password: '正确的马电池订书钉', notes: '两段式验证开着', group: '开发' })
    const saved = await vault.save({ id: 'e1', entry: first })
    expect(saved.ok).toBe(true)

    const loaded = await vault.load()
    expect(loaded.ok).toBe(true)
    expect(loaded.data!.records).toHaveLength(1)
    expect(loaded.data!.records[0]).toMatchObject({ id: 'e1', ...first })
    expect(loaded.data!.unreadable).toBe(0)
  })

  it('磁盘上那份里没有明文（标题、密码都在密文里）', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    await vault.save({ id: 'e1', entry: entry('内网 OA', { password: 'hunter2', group: '公司' }) })

    const text = JSON.stringify(local['dev-a'])
    for (const secret of ['内网 OA', 'hunter2', '公司']) expect(text).not.toContain(secret)
  })

  it('改一条只重封那一条：另一条的密文一个字节都不动', async () => {
    const vault = await freshModule()
    await vault.createKey(false)

    await vault.save({ id: 'a', entry: entry('A') })
    await vault.save({ id: 'b', entry: entry('B') })

    const before = parseVaultFile(local['dev-a'])!.file.items.find((item) => item.id === 'b')!
    await vault.save({ id: 'a', entry: entry('A 改过') })
    const after = parseVaultFile(local['dev-a'])!.file.items.find((item) => item.id === 'b')!

    expect(after.ct).toBe(before.ct)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it('删一条留墓碑：清单里没有了，文件里那个空壳还在（别的机器靠它别复活）', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    await vault.save({ id: 'e1', entry: entry('X') })

    await vault.remove('e1')
    expect((await vault.load()).data!.records).toHaveLength(0)

    const items = parseVaultFile(local['dev-a'])!.file.items
    expect(items).toHaveLength(1)
    expect(items[0].deleted).toBe(true)
    expect(items[0].ct).toBeUndefined()
  })
})

/** 建好库并写一条，返回适配层 */
async function machineWithOneEntry(id: string, name: string): Promise<typeof import('./vault')> {
  const vault = await freshModule()
  await vault.createKey(false)
  await vault.save({ id, entry: entry(name) })
  return vault
}

describe('同步', () => {
  it('远端还空着时直接推上去', async () => {
    const vault = await machineWithOneEntry('e1', '第一条')
    const result = await vault.sync('git@example.com:me/sync.git')

    expect(result.ok).toBe(true)
    expect(result.data!.rounds).toBe(1)
    expect(result.data!.keyMismatch).toBe(false)
    expect(parseVaultFile(remote)!.file.items).toHaveLength(1)
  })

  it('没解锁、或没填仓库地址时如实报错，一次 git 都不碰', async () => {
    const vault = await freshModule()
    expect((await vault.sync('')).ok).toBe(false)

    await vault.createKey(false)
    vault.lock()
    expect((await vault.sync('git@example.com:me/sync.git')).ok).toBe(false)
  })

  it('**两台机器共写一个文件**：各自新增的条目在两边都留得住', async () => {
    const repo = 'git@example.com:me/sync.git'

    // A 建库、写一条、推上去
    const a = await machineWithOneEntry('e1', 'A 的条目')
    expect((await a.sync(repo)).ok).toBe(true)
    const keyText = keys['dev-a']!

    // B 是另一台机器：导入同一把密钥（本机还没有文件），同步一次把 A 那条拉下来
    machine = 'dev-b'
    const b = await freshModule()
    await b.importKey(keyText)
    const first = await b.sync(repo)
    expect(first.ok).toBe(true)
    expect(first.data!.records.map((record) => record.name)).toEqual(['A 的条目'])

    // B 再加一条推上去
    await b.save({ id: 'e2', entry: entry('B 的条目') })
    expect((await b.sync(repo)).ok).toBe(true)

    // A 再同步一次：两条都在（谁先推都一样，合并规则里没有「以我为准」）
    machine = 'dev-a'
    const back = await a.sync(repo)
    expect(back.ok).toBe(true)
    expect(back.data!.records.map((record) => record.name).sort()).toEqual(['A 的条目', 'B 的条目'])
    expect(back.data!.unreadable).toBe(0)
  })

  it('远端在拉与推之间被改过：一个字都不写，拿回来的那份重新合一遍（rounds = 2）', async () => {
    const repo = 'git@example.com:me/sync.git'
    const a = await machineWithOneEntry('e1', 'A 的条目')
    expect((await a.sync(repo)).ok).toBe(true)
    pushBases = [] // 上面那次是铺垫，只数这一轮里的

    const first = parseVaultFile(remote)!.file
    const intruder = async (id: string, name: string, offset: number): Promise<void> => {
      const sealed = await seal(first.key, entry(name))
      remote = {
        ...first,
        items: [...parseVaultFile(remote)!.file.items, { id, updatedAt: Date.now() + offset, by: 'dev-z', ...sealed }]
      }
    }

    // 远端在 A 拉到之后、推上去之前被另一台机器推了一条 —— 这正是 `base` 那道闸要拦的窗口。
    // 桩里靠 `beforeRefusal` 复现：拉到的是旧那份，推的时候才发现远端已经多了一条。
    refuseNextPush = 1
    beforeRefusal = () => intruder('e9', '别人的条目', 1000)

    const result = await a.sync(repo)
    expect(result.ok).toBe(true)
    expect(result.data!.rounds).toBe(2)
    expect(result.data!.records.map((record) => record.name).sort()).toEqual(['A 的条目', '别人的条目'])

    // 两轮各自的基准：第一轮是拉回来的那份（一条），第二轮是**第一轮交回来的那份**（两条）
    // —— 走的不是最初那个 base，否则第二轮还会再被挡一次
    expect(pushBases).toHaveLength(2)
    expect(parseVaultFile(pushBases[0])!.file.items).toHaveLength(1)
    expect(parseVaultFile(pushBases[1])!.file.items).toHaveLength(2)

    // 最终仓库里两条都在
    expect(parseVaultFile(remote)!.file.items).toHaveLength(2)
  })

  it('仓库里那份是用别的密钥加的密：如实报 keyMismatch，条目照常推上去', async () => {
    const repo = 'git@example.com:me/sync.git'
    const a = await machineWithOneEntry('e1', 'A 的条目')

    // 远端那份是另一把密钥加的（换过密钥、或两台机器各建了库）
    const otherKey = await createVaultKey()
    const sealed = await seal(publicKeyOf(otherKey), {
      name: '解不开的条目',
      password: '',
      notes: '',
      group: ''
    })
    remote = {
      version: 1,
      key: publicKeyOf(otherKey),
      items: [{ id: 'x1', updatedAt: 1, by: 'dev-z', ...sealed }]
    }

    const result = await a.sync(repo)
    expect(result.ok).toBe(true)
    expect(result.data!.keyMismatch).toBe(true)
    // 那条读不出来，但**不是**错误：它照样被并进文件推回去（不然对面机器会以为它被删了）
    expect(result.data!.unreadable).toBe(1)
    expect(parseVaultFile(remote)!.file.items).toHaveLength(2)
  })

  it('远端路径上放的不是保险库文件时给一句人话，而不是当成空的把它盖掉', async () => {
    const repo = 'git@example.com:me/sync.git'
    const a = await machineWithOneEntry('e1', 'A 的条目')
    remote = { hello: 'world' }

    const result = await a.sync(repo)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不是一份保险库文件')
    expect(pushBases).toHaveLength(0)
  })
})

describe('换密钥', () => {
  it('换密钥不丢条目：旧密钥能读出来的解开后用新密钥封回去', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    await vault.save({ id: 'e1', entry: entry('留下来的', { password: 'p', notes: 'n', group: 'g' }) })

    const before = keys['dev-a']
    expect((await vault.createKey(true)).ok).toBe(true)
    expect(keys['dev-a']).not.toBe(before)

    const loaded = await vault.load()
    expect(loaded.ok).toBe(true)
    expect(loaded.data!.records).toHaveLength(1)
    expect(loaded.data!.records[0]).toMatchObject({ name: '留下来的', password: 'p', notes: 'n', group: 'g' })
    expect(loaded.data!.unreadable).toBe(0)
  })

  it('换密钥时读不出来的条目留墓碑 —— 不能以「只在远端有」的身份被并回来', async () => {
    const vault = await freshModule()
    await vault.createKey(false)

    // 手工塞一条用别的密钥加的条目（模拟密钥丢了之后又换了一把）
    const otherKey = await createVaultKey()
    const sealed = await seal(publicKeyOf(otherKey), {
      name: '读不出来的',
      password: '',
      notes: '',
      group: ''
    })
    local['dev-a'] = {
      version: 1,
      key: publicKeyOf(otherKey),
      items: [{ id: 'orphan', updatedAt: 1, by: 'dev-z', ...sealed }]
    }

    await vault.createKey(true)
    const items = parseVaultFile(local['dev-a'])!.file.items
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('orphan')
    expect(items[0].deleted).toBe(true)
    expect(items[0].ct).toBeUndefined()
  })

  it('在一台已有保险库的机器上导入另一把密钥：本机原来那些条目跟着过来，不丢', async () => {
    const a = await machineWithOneEntry('e1', 'A 的条目')
    expect((await a.sync('git@example.com:me/sync.git')).ok).toBe(true)
    const keyText = keys['dev-a']!

    // B 自己先建了一个库，再导入 A 的密钥 —— 从「B 那份保险库」换到「A 那份」上。
    // B 原来那条**能读出来**（上一把密钥就在手上），所以解开后用新密钥封回去、跟着走，
    // 而不是被丢掉：导入是个换密钥的动作，不是「清空本机」。
    machine = 'dev-b'
    const b = await freshModule()
    await b.createKey(false)
    await b.save({ id: 'own', entry: entry('B 自己的') })

    expect((await b.importKey(keyText)).ok).toBe(true)
    const items = parseVaultFile(local['dev-b'])!.file.items
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('own')
    expect(items[0].deleted).toBeUndefined()
    expect((await b.load()).data!.records[0].name).toBe('B 自己的')

    // 同步一次把 A 那份也拉下来：两边合成一份
    const synced = await b.sync('git@example.com:me/sync.git')
    expect(synced.ok).toBe(true)
    expect(synced.data!.records.map((record) => record.name).sort()).toEqual(['A 的条目', 'B 自己的'])
    expect(synced.data!.unreadable).toBe(0)
  })

  it('导入时读不出来的那些条目才留墓碑（上一把密钥也不在手上）', async () => {
    const a = await machineWithOneEntry('e1', 'A 的条目')
    expect((await a.sync('git@example.com:me/sync.git')).ok).toBe(true)
    const keyText = keys['dev-a']!

    // B 建了库、锁上（内存里那把没了），此时再导入 A 的密钥：
    // 本机那条用 B 自己的密钥加的密，而 B 的密钥已经不在手上了 —— 只能留墓碑
    machine = 'dev-b'
    const b = await freshModule()
    await b.createKey(false)
    await b.save({ id: 'own', entry: entry('B 自己的') })
    b.lock()

    expect((await b.importKey(keyText)).ok).toBe(true)
    const items = parseVaultFile(local['dev-b'])!.file.items
    expect(items.map((item) => [item.id, item.deleted === true])).toEqual([['own', true]])

    const synced = await b.sync('git@example.com:me/sync.git')
    expect(synced.ok).toBe(true)
    expect(synced.data!.records.map((record) => record.name)).toEqual(['A 的条目'])
  })

  it('密钥文件里的内容不是一把密钥时如实报错，不动凭据管理器', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    const before = keys['dev-a']

    const result = await vault.importKey('这不是密钥')
    expect(result.ok).toBe(false)
    expect(keys['dev-a']).toBe(before)
  })

  it('导出的密钥串能原样导入回来（另一台机器认得出是同一把）', async () => {
    const vault = await freshModule()
    await vault.createKey(false)
    const fingerprint = (await vault.keyState()).data!.fingerprint
    // 凭据管理器里存的就是「导出的那串」—— 导出文件里写的是同一个字符串
    const exported = keys['dev-a']!
    expect(exported).toBe(encodeKeyString(parseKeyString(exported)!))

    machine = 'dev-b'
    const b = await freshModule()
    expect((await b.importKey(exported)).ok).toBe(true)
    expect((await b.keyState()).data!.fingerprint).toBe(fingerprint)
  })
})
