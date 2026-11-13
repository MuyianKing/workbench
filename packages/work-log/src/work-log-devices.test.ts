import type { WorkLogEntry } from './work-log'
import { describe, expect, it } from 'vitest'
import { deviceOfEntry, entriesOfDevice, workLogDeviceLabel, workLogDevices } from './work-log-devices'

function entry(id: string, by?: string): WorkLogEntry {
  return {
    id,
    date: '2026-11-12',
    content: `内容 ${id}`,
    status: 'done',
    createdAt: 100,
    updatedAt: 100,
    ...(by ? { by } : {}),
  }
}

const LOCAL = { id: 'dev-local', name: '本机' }

describe('deviceOfEntry', () => {
  it('没有 by 的老数据算本机', () => {
    expect(deviceOfEntry(entry('a'), LOCAL.id)).toBe('dev-local')
  })

  it('有 by 就是那台设备', () => {
    expect(deviceOfEntry(entry('a', 'dev-remote'), LOCAL.id)).toBe('dev-remote')
  })
})

describe('entriesOfDevice', () => {
  const entries = [entry('old'), entry('local', 'dev-local'), entry('remote', 'dev-remote')]

  it('只留这台设备的条目：老数据跟着本机走', () => {
    expect(entriesOfDevice(entries, 'dev-local', LOCAL.id).map(item => item.id)).toEqual(['old', 'local'])
    expect(entriesOfDevice(entries, 'dev-remote', LOCAL.id).map(item => item.id)).toEqual(['remote'])
  })

  it('设备 id 为空时不筛（本机标识拿不到，不能把整份日志藏起来）', () => {
    expect(entriesOfDevice(entries, '', LOCAL.id).map(item => item.id)).toEqual(['old', 'local', 'remote'])
  })

  it('不改入参', () => {
    const source = [entry('a', 'dev-remote')]
    entriesOfDevice(source, 'dev-local', LOCAL.id)
    expect(source.map(item => item.id)).toEqual(['a'])
  })
})

describe('workLogDeviceLabel', () => {
  it('本机带「（本机）」，名字没取到时就是「本机」', () => {
    expect(workLogDeviceLabel({ id: 'dev-local', name: '我的电脑', self: true })).toBe('我的电脑（本机）')
    expect(workLogDeviceLabel({ id: 'dev-local', name: '', self: true })).toBe('本机')
  })

  it('别的设备直接用它的名字', () => {
    expect(workLogDeviceLabel({ id: 'dev-remote', name: '另一台' })).toBe('另一台')
  })
})

describe('workLogDevices', () => {
  it('本机恒在第一位、带 self 标记，没有条目也一样', () => {
    expect(workLogDevices([], LOCAL, [])).toEqual([
      { id: 'dev-local', name: '本机', self: true },
    ])
    expect(workLogDevices([entry('old')], LOCAL, [])).toHaveLength(1)
  })

  it('本机名字还没取到时留空串（按钮上显示「本机」由界面兜）', () => {
    expect(workLogDevices([], { id: 'dev-local', name: '' }, [])).toEqual([
      { id: 'dev-local', name: '', self: true },
    ])
  })

  it('分片拉到的设备都列出来（没有条目也列），其余按名字排', () => {
    const entries = [
      entry('a', 'dev-b'),
      entry('b', 'dev-a'),
    ]
    const devices = workLogDevices(entries, LOCAL, [
      { id: 'dev-b', name: 'beta' },
      { id: 'dev-a', name: 'alpha' },
      { id: 'dev-empty', name: 'gamma' },
    ])

    expect(devices).toEqual([
      { id: 'dev-local', name: '本机', self: true },
      { id: 'dev-a', name: 'alpha' },
      { id: 'dev-b', name: 'beta' },
      { id: 'dev-empty', name: 'gamma' },
    ])
  })

  it('条目里出现、分片清单里没有的设备也要列（id 前 8 位兜底）', () => {
    const devices = workLogDevices([entry('a', '0123456789abcdef')], LOCAL, [])
    expect(devices[1]).toEqual({ id: '0123456789abcdef', name: '设备 01234567' })
  })
})
