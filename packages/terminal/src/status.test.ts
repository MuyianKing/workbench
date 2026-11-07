import { describe, expect, it } from 'vitest'
import { describeHolder, RUNNING_STATUS } from './status'

describe('运行状态常量', () => {
  it('三个在途状态都在列，且不含终态', () => {
    expect(RUNNING_STATUS).toContain('running')
    expect(RUNNING_STATUS).toContain('installing')
    expect(RUNNING_STATUS).toContain('building')
    expect(RUNNING_STATUS).not.toContain('idle')
    expect(RUNNING_STATUS).not.toContain('success')
    expect(RUNNING_STATUS).not.toContain('failed')
  })
})

describe('端口占用者的说明', () => {
  it('有进程名给「名字（PID n）」，没有就只给 PID', () => {
    expect(describeHolder({ pid: 4242, processName: 'node.exe' })).toBe('node.exe（PID 4242）')
    expect(describeHolder({ pid: 4242 })).toBe('PID 4242')
    expect(describeHolder({})).toBe('PID 未知')
  })
})
