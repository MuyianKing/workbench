import { describe, expect, it } from 'vitest'
import {
  mailContactShardOf,
  mergeMailContactShards,
  projectContacts,
  sameMailContacts,
  sanitizeMailContactShard,
  stampMissingContacts,
} from './contacts-sync'

describe('通讯录多机合并', () => {
  const shard = (device: string, contacts: Parameters<typeof mailContactShardOf>[2]) =>
    mailContactShardOf(device, `机器 ${device}`, contacts)

  it('按地址取并集、同地址取 updatedAt 更大者（改名后写胜出）', () => {
    const local = [
      { name: '张三', address: 'a@b.com', updatedAt: 100, by: 'dev-a' },
      { name: '李四', address: 'c@d.com', updatedAt: 100, by: 'dev-a' },
    ]
    const remote = shard('dev-b', [{ name: '张三新', address: 'a@b.com', updatedAt: 200, by: 'dev-b' }])
    const merged = mergeMailContactShards(local, [remote])
    expect(merged).toEqual([
      { name: '张三新', address: 'a@b.com', updatedAt: 200, by: 'dev-b' },
      { name: '李四', address: 'c@d.com', updatedAt: 100, by: 'dev-a' },
    ])
  })

  it('同一毫秒按设备 id 破平，两端算出同一个结果', () => {
    const one = [{ name: 'A', address: 'a@b.com', updatedAt: 100, by: 'dev-a' }]
    const two = [{ name: 'B', address: 'a@b.com', updatedAt: 100, by: 'dev-b' }]
    const mergedAB = mergeMailContactShards(one, [shard('dev-b', two)])
    const mergedBA = mergeMailContactShards(two, [shard('dev-a', one)])
    expect(mergedAB).toEqual(mergedBA)
    expect(mergedAB[0].name).toBe('B') // by 大者胜
  })

  it('删除留墓碑、不会被远端旧记录复活；更晚的重新添加会生效', () => {
    const tombstone = { name: '张三', address: 'a@b.com', updatedAt: 300, by: 'dev-a', deleted: true }
    const staleRemote = shard('dev-b', [{ name: '张三', address: 'a@b.com', updatedAt: 200, by: 'dev-b' }])
    const merged = mergeMailContactShards([tombstone], [staleRemote])
    expect(merged).toEqual([tombstone])
    expect(projectContacts(merged)).toEqual([])

    const reAdd = shard('dev-b', [{ name: '张三', address: 'a@b.com', updatedAt: 400, by: 'dev-b' }])
    const revived = mergeMailContactShards([tombstone], [reAdd])
    expect(projectContacts(revived)).toEqual([{ name: '张三', address: 'a@b.com', updatedAt: 400, by: 'dev-b' }])
  })

  it('输出按地址排序，与输入顺序无关（不产生假提交）', () => {
    const a = { name: 'A', address: 'a@b.com', updatedAt: 1, by: 'x' }
    const b = { name: 'B', address: 'b@b.com', updatedAt: 1, by: 'x' }
    expect(mergeMailContactShards([b, a], [])).toEqual([a, b])
    expect(sameMailContacts([a, b], [b, a])).toBe(true)
    expect(sameMailContacts([a], [a, b])).toBe(false)
  })

  it('分片收敛：没有设备 id 整份丢掉，坏记录按形状过滤', () => {
    expect(sanitizeMailContactShard({ contacts: [{ address: 'a@b.com' }] })).toBeNull()
    expect(sanitizeMailContactShard('x')).toBeNull()
    const result = sanitizeMailContactShard({
      device: ' dev-b ',
      name: '机器',
      contacts: [
        { name: 'A', address: ' A@B.COM ' },
        { name: '坏', address: 'not-an-address' },
        { name: '重复', address: 'a@b.com', updatedAt: 1, by: 'z' },
      ],
    })
    expect(result?.device).toBe('dev-b')
    // 同地址取较新的那份（updatedAt 1 的那条胜出），坏地址的整条丢掉
    expect(result?.contacts).toEqual([{ name: '重复', address: 'a@b.com', updatedAt: 1, by: 'z' }])
  })

  it('旧数据补时间戳与设备 id，已有的不动', () => {
    const stamped = stampMissingContacts([
      { name: '旧', address: 'a@b.com' },
      { name: '新', address: 'b@b.com', updatedAt: 50, by: 'dev-a' },
    ], 1000, 'dev-b')
    expect(stamped).toEqual([
      { name: '旧', address: 'a@b.com', updatedAt: 1000, by: 'dev-b' },
      { name: '新', address: 'b@b.com', updatedAt: 50, by: 'dev-a' },
    ])
  })
})
