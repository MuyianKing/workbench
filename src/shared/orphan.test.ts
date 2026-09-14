import { describe, expect, it, vi } from 'vitest'
import {
  isSameOwner,
  isSameProcess,
  reapOrphanSessions,
  withSessionRecorded,
  withoutSession,
  type ReapDeps
} from './orphan'
import type { ActiveSession } from './types'

/** 进程创建时间：测试里用固定值，它只需要「能不能区分两个进程」 */
const CREATED = 1_700_000_000_000
const OWNER_CREATED = 1_699_000_000_000

describe('isSameOwner', () => {
  it('创建时间一致才认宿主还在', () => {
    expect(isSameOwner({ ownerCreatedAt: OWNER_CREATED }, OWNER_CREATED)).toBe(true)
  })

  it('宿主 PID 被复用时认出来（创建时间不同）', () => {
    expect(isSameOwner({ ownerCreatedAt: OWNER_CREATED }, OWNER_CREATED + 1)).toBe(false)
  })

  it('问不到或老记录没有这个字段时都当作认不出', () => {
    expect(isSameOwner({ ownerCreatedAt: OWNER_CREATED }, null)).toBe(false)
    expect(isSameOwner({}, OWNER_CREATED)).toBe(false)
  })
})

describe('isSameProcess', () => {
  it('创建时间一致才认', () => {
    expect(isSameProcess({ processCreatedAt: CREATED }, CREATED)).toBe(true)
  })

  it('创建时间不同就不认（PID 被复用的情况）', () => {
    // PID 一样，但创建时间差了一截 —— 原来那个进程早就没了
    expect(isSameProcess({ processCreatedAt: CREATED }, CREATED + 5_000)).toBe(false)
  })

  it('问不到创建时间时不认', () => {
    expect(isSameProcess({ processCreatedAt: CREATED }, null)).toBe(false)
  })

  it('老数据文件没有这个字段时不认（宁可漏清，不可杀错）', () => {
    expect(isSameProcess({}, CREATED)).toBe(false)
    expect(isSameProcess({ processCreatedAt: undefined }, CREATED)).toBe(false)
  })
})

function depsOf(created: Record<number, number>, killTree = vi.fn()): ReapDeps {
  return {
    createdAt: async (pid) => created[pid] ?? null,
    killTree
  }
}

function session(patch: Partial<ActiveSession> = {}): ActiveSession {
  return {
    projectId: 'p1',
    pid: 200,
    command: 'npm run dev',
    cwd: 'D:\\proj\\admin-web',
    startedAt: 1,
    ownerPid: 100,
    ownerCreatedAt: OWNER_CREATED,
    processCreatedAt: CREATED,
    ...patch
  }
}

describe('reapOrphanSessions', () => {
  it('没有记录时什么都不做', async () => {
    const result = await reapOrphanSessions([], depsOf({}))
    expect(result).toEqual({ killed: 0, kept: [], notes: [] })
  })

  it('记录为脏数据时不抛错', async () => {
    const result = await reapOrphanSessions([null as never, undefined as never], depsOf({}))
    expect(result.killed).toBe(0)
  })

  it('派生它的应用进程还活着就保留记录、不动进程', async () => {
    const killTree = vi.fn()
    const deps = depsOf({ 100: OWNER_CREATED, 200: CREATED }, killTree)

    const result = await reapOrphanSessions([session()], deps)
    expect(result.killed).toBe(0)
    expect(result.kept).toHaveLength(1)
    expect(killTree).not.toHaveBeenCalled()
  })

  it('宿主 PID 被复用时不当作「有主」，照常清理子进程', async () => {
    // 100 这个 PID 现在属于另一个进程（创建时间对不上）——
    // 只判 PID 存不存在的话，这条记录会被误当成有主而永远保留
    const killTree = vi.fn().mockResolvedValue(undefined)
    const deps = depsOf({ 100: OWNER_CREATED + 777, 200: CREATED }, killTree)

    const result = await reapOrphanSessions([session()], deps)
    expect(result.killed).toBe(1)
    expect(result.kept).toHaveLength(0)
    expect(killTree).toHaveBeenCalledWith(200)
  })

  it('老记录没有宿主创建时间时按「认不出宿主」处理，仍会清掉确认为残留的子进程', async () => {
    const killTree = vi.fn().mockResolvedValue(undefined)
    const deps = depsOf({ 100: OWNER_CREATED, 200: CREATED }, killTree)

    const result = await reapOrphanSessions([session({ ownerCreatedAt: undefined })], deps)
    expect(result.killed).toBe(1)
    expect(killTree).toHaveBeenCalledWith(200)
  })

  it('创建时间对不上时跳过，并说明可能被系统复用', async () => {
    const killTree = vi.fn()
    // 同一个 PID，但创建时间是另一个进程的
    const deps = depsOf({ 200: CREATED + 9_999 }, killTree)

    const result = await reapOrphanSessions([session()], deps)
    expect(result.killed).toBe(0)
    expect(result.kept).toHaveLength(0)
    expect(result.notes.join()).toContain('复用')
    expect(killTree).not.toHaveBeenCalled()
  })

  it('记录里没有创建时间时跳过，不冒险下手', async () => {
    const killTree = vi.fn()
    const deps = depsOf({ 200: CREATED }, killTree)

    const result = await reapOrphanSessions([session({ processCreatedAt: undefined })], deps)
    expect(result.killed).toBe(0)
    expect(killTree).not.toHaveBeenCalled()
  })

  it('进程已消失时只丢记录，不报错', async () => {
    const result = await reapOrphanSessions([session()], depsOf({}))
    expect(result.killed).toBe(0)
    expect(result.notes).toEqual([])
  })

  it('确认是残留就按进程树结束', async () => {
    const killTree = vi.fn().mockResolvedValue(undefined)
    const deps = depsOf({ 200: CREATED }, killTree)

    const result = await reapOrphanSessions([session()], deps)
    expect(result.killed).toBe(1)
    expect(killTree).toHaveBeenCalledWith(200)
  })

  it('结束失败只记一笔，不影响其余', async () => {
    const killTree = vi.fn().mockRejectedValue(new Error('taskkill 退出码 1'))
    const deps = depsOf({ 200: CREATED }, killTree)

    const result = await reapOrphanSessions([session()], deps)
    expect(result.killed).toBe(0)
    expect(result.notes.join()).toContain('失败')
  })
})

describe('会话记录的增删', () => {
  it('记一条：新记录附加到末尾，旧记录不动', () => {
    const first = session({ pid: 200 })
    const second = session({ pid: 300 })

    const list = withSessionRecorded([first], second)
    expect(list.map((item) => item.pid)).toEqual([200, 300])
  })

  it('同一个 PID 重复记录时只保留最新的一条', () => {
    const stale = session({ pid: 200, command: 'npm run serve' })
    const fresh = session({ pid: 200, command: 'npm run dev' })

    const list = withSessionRecorded([stale], fresh)
    expect(list).toHaveLength(1)
    expect(list[0].command).toBe('npm run dev')
  })

  it('老数据文件没有这个字段时也能安全追加', () => {
    expect(withSessionRecorded(undefined, session({ pid: 7 })).map((item) => item.pid)).toEqual([7])
  })

  it('按 PID 摘掉记录', () => {
    const list = withoutSession([session({ pid: 200 }), session({ pid: 300 })], 200)
    expect(list.map((item) => item.pid)).toEqual([300])
  })

  it('摘一个不存在的 PID 时列表不变', () => {
    const list = [session({ pid: 200 })]
    expect(withoutSession(list, 999)).toHaveLength(1)
    expect(withoutSession(undefined, 999)).toEqual([])
  })
})
