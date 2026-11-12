import type { WorkLogEntry, WorkLogFile, WorkLogTombstone } from './work-log'
import type { WorkLogShard } from './work-log-sync'
import { describe, expect, it } from 'vitest'
import { mergeWorkLogShards, sameWorkLogFile, sanitizeWorkLogShard, workLogShardOf } from './work-log-sync'

function entry(
  id: string,
  updatedAt: number,
  by: string,
  content = `内容 ${id}`,
): WorkLogEntry {
  return {
    id,
    date: '2026-09-15',
    content,
    status: 'done',
    createdAt: updatedAt,
    updatedAt,
    by,
  }
}

function tombstone(id: string, updatedAt: number, by: string): WorkLogTombstone {
  return { id, updatedAt, by }
}

function file(entries: WorkLogEntry[] = [], tombstones: WorkLogTombstone[] = []): WorkLogFile {
  return { version: 2, entries, tombstones }
}

function shard(
  device: string,
  entries: WorkLogEntry[] = [],
  tombstones: WorkLogTombstone[] = [],
): WorkLogShard {
  return { version: 1, device, name: device, updatedAt: 0, entries, tombstones }
}

describe('mergeWorkLogShards', () => {
  it('按 id 取并集：两边各自独有的条目都留下', () => {
    const merged = mergeWorkLogShards(
      file([entry('a', 100, 'dev-a')]),
      [shard('dev-b', [entry('b', 100, 'dev-b')])],
    )

    expect(merged.entries.map(item => item.id)).toEqual(['a', 'b'])
    expect(merged.tombstones).toEqual([])
  })

  it('同 id 取 updatedAt 大的；正反传参结果一致', () => {
    const older = entry('x', 100, 'dev-a', '旧内容')
    const newer = entry('x', 200, 'dev-b', '新内容')

    expect(mergeWorkLogShards(file([older]), [shard('dev-b', [newer])]).entries[0].content).toBe('新内容')
    expect(mergeWorkLogShards(file([newer]), [shard('dev-a', [older])]).entries[0].content).toBe('新内容')
  })

  it('时间撞上按 by 破平；正反传参结果一致', () => {
    const left = entry('x', 100, 'dev-a', 'A 的')
    const right = entry('x', 100, 'dev-b', 'B 的')

    expect(mergeWorkLogShards(file([left]), [shard('dev-b', [right])]).entries[0].content).toBe('B 的')
    expect(mergeWorkLogShards(file([right]), [shard('dev-a', [left])]).entries[0].content).toBe('B 的')
  })

  it('墓碑比条目新就按删除算，比条目旧就让位给更晚的编辑', () => {
    const deleted = mergeWorkLogShards(
      file([entry('x', 100, 'dev-a')]),
      [shard('dev-b', [], [tombstone('x', 200, 'dev-b')])],
    )
    expect(deleted.entries).toEqual([])
    expect(deleted.tombstones.map(item => item.id)).toEqual(['x'])

    const edited = mergeWorkLogShards(
      file([entry('x', 300, 'dev-a')]),
      [shard('dev-b', [], [tombstone('x', 200, 'dev-b')])],
    )
    expect(edited.entries.map(item => item.id)).toEqual(['x'])
    expect(edited.tombstones).toEqual([])
  })

  it('离线设备回来不会让删掉的条目复活', () => {
    const local = file([], [tombstone('x', 200, 'dev-a')])
    const stale = shard('dev-b', [entry('x', 100, 'dev-b')])

    const merged = mergeWorkLogShards(local, [stale])
    expect(merged.entries).toEqual([])
    expect(merged.tombstones.map(item => item.id)).toEqual(['x'])
  })

  it('合并幂等、可交换，输出按 id 排序且逐字节一致', () => {
    const local = file([entry('b', 100, 'dev-a')], [tombstone('c', 150, 'dev-a')])
    const remoteA = shard('dev-b', [entry('a', 120, 'dev-b'), entry('b', 90, 'dev-b')])
    const remoteB = shard('dev-c', [entry('d', 130, 'dev-c')], [tombstone('c', 140, 'dev-c')])

    const one = mergeWorkLogShards(local, [remoteA, remoteB])
    const again = mergeWorkLogShards(local, [remoteA, remoteB])
    const reversed = mergeWorkLogShards(local, [remoteB, remoteA])

    expect(one).toEqual(again)
    expect(JSON.stringify(one)).toBe(JSON.stringify(reversed))
    expect(one.entries.map(item => item.id)).toEqual(['a', 'b', 'd'])
    expect(one.tombstones.map(item => item.id)).toEqual(['c'])
  })
})

describe('sanitizeWorkLogShard', () => {
  it('没有设备 id 的分片整份丢掉', () => {
    expect(sanitizeWorkLogShard({ entries: [entry('a', 1, 'dev-a')] })).toBeNull()
    expect(sanitizeWorkLogShard({ device: '  ', entries: [] })).toBeNull()
    expect(sanitizeWorkLogShard(null)).toBeNull()
  })

  it('缺 id 的远端条目直接丢，不补新 UUID', () => {
    const parsed = sanitizeWorkLogShard({
      device: 'dev-b',
      name: ' B ',
      entries: [
        { date: '2026-09-15', content: '没有 id', status: 'done', createdAt: 10, updatedAt: 10 },
        { id: 'ok', date: '2026-09-15', content: '好的', status: 'done', createdAt: 10, updatedAt: 10 },
      ],
      tombstones: [{ id: '', updatedAt: 10 }, { id: 'gone', updatedAt: 20 }],
    })

    expect(parsed?.device).toBe('dev-b')
    expect(parsed?.name).toBe('B')
    expect(parsed?.entries.map(item => item.id)).toEqual(['ok'])
    expect(parsed?.tombstones.map(item => [item.id, item.by])).toEqual([['gone', '']])
  })

  it('分片内同 id 的条目与墓碑先自己比出胜者', () => {
    const parsed = sanitizeWorkLogShard({
      device: 'dev-b',
      entries: [entry('x', 100, 'dev-b')],
      tombstones: [tombstone('x', 200, 'dev-b')],
    })

    expect(parsed?.entries).toEqual([])
    expect(parsed?.tombstones.map(item => item.id)).toEqual(['x'])
  })
})

describe('workLogShardOf / sameWorkLogFile', () => {
  it('分片里节点按 id 排序，updatedAt 取最新的那个', () => {
    const built = workLogShardOf('dev-a', 'A 机', file(
      [entry('b', 100, 'dev-a'), entry('a', 300, 'dev-a')],
      [tombstone('c', 200, 'dev-a')],
    ))

    expect(built.device).toBe('dev-a')
    expect(built.name).toBe('A 机')
    expect(built.updatedAt).toBe(300)
    expect(built.entries.map(item => item.id)).toEqual(['a', 'b'])
    expect(built.tombstones.map(item => item.id)).toEqual(['c'])
  })

  it('内容相同、顺序不同算同一份', () => {
    const one = file([entry('a', 1, 'dev-a'), entry('b', 2, 'dev-a')])
    const two = file([entry('b', 2, 'dev-a'), entry('a', 1, 'dev-a')])

    expect(sameWorkLogFile(one, two)).toBe(true)
    expect(sameWorkLogFile(one, file([entry('a', 1, 'dev-a')]))).toBe(false)
  })
})
