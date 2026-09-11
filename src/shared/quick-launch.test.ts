import { describe, expect, it } from 'vitest'
import { defaultQuickAppName, sanitizeQuickApps } from './quick-launch'
import type { QuickApp } from './types'

describe('defaultQuickAppName', () => {
  it('去掉扩展名，只留文件名', () => {
    expect(defaultQuickAppName('C:\\Program Files\\Microsoft VS Code\\Code.exe')).toBe('Code')
    expect(defaultQuickAppName('D:\\tools\\WeChat.lnk')).toBe('WeChat')
  })

  it('没有扩展名时用整个文件名', () => {
    expect(defaultQuickAppName('D:\\tools\\tool')).toBe('tool')
  })

  it('隐藏文件保留原名（去掉点就什么都不剩了）', () => {
    expect(defaultQuickAppName('D:\\tools\\.exe')).toBe('.exe')
  })

  it('结尾的斜杠不算文件名', () => {
    expect(defaultQuickAppName('D:\\tools\\')).toBe('tools')
  })
})

describe('sanitizeQuickApps', () => {
  let seq = 0
  const makeId = (): string => `id-${++seq}`

  it('非数组一律当作空列表', () => {
    expect(sanitizeQuickApps(undefined, makeId)).toEqual([])
    expect(sanitizeQuickApps({ hack: true }, makeId)).toEqual([])
  })

  it('丢掉没有路径的条目，其余补回缺失字段', () => {
    const list = sanitizeQuickApps(
      [
        { target: '  D:\\tools\\Code.exe  ' },
        { name: '没有路径' },
        null,
        'not an object'
      ],
      makeId
    )

    expect(list).toHaveLength(1)
    expect(list[0].target).toBe('D:\\tools\\Code.exe')
    expect(list[0].name).toBe('Code')
    expect(list[0].order).toBe(0)
    expect(list[0].createdAt).toBeGreaterThan(0)
  })

  it('按 order 排序并重新编号，结果一定是紧凑的', () => {
    const list = sanitizeQuickApps(
      [
        { id: 'a', target: 'D:\\a.exe', order: 9 },
        { id: 'b', target: 'D:\\b.exe', order: 2 },
        { id: 'c', target: 'D:\\c.exe' }
      ],
      makeId
    )

    expect(list.map((app) => app.id)).toEqual(['b', 'c', 'a'])
    expect(list.map((app) => app.order)).toEqual([0, 1, 2])
  })

  it('缺 id 时用注入的工厂补一个', () => {
    const list = sanitizeQuickApps([{ target: 'D:\\a.exe' }], makeId)
    expect(list[0].id).toMatch(/^id-\d+$/)
  })

  it('保留已有的 id / lastUsedAt', () => {
    const raw: QuickApp = {
      id: 'keep',
      name: '代码',
      target: 'D:\\Code.exe',
      order: 0,
      createdAt: 1,
      lastUsedAt: 2
    }
    expect(sanitizeQuickApps([raw], makeId)).toEqual([raw])
  })

  it('旧数据里的启动参数与工作目录被丢掉（这两项已经不再支持）', () => {
    const list = sanitizeQuickApps(
      [{ id: 'a', target: 'D:\\a.exe', args: '--new-window', cwd: 'D:\\work' }],
      makeId
    )
    expect(list[0]).toEqual({
      id: 'a',
      name: 'a',
      target: 'D:\\a.exe',
      order: 0,
      createdAt: expect.any(Number),
      lastUsedAt: undefined
    })
  })
})
