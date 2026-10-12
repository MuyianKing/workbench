import { describe, expect, it } from 'vitest'
import { defaultCaptureName, splitPath, uniqueName } from './naming'

describe('defaultCaptureName', () => {
  it('本地时间、不含冒号、秒级', () => {
    expect(defaultCaptureName(new Date(2026, 9, 12, 14, 30, 12))).toBe('截图-2026-10-12-143012.png')
  })

  it('月 / 日 / 时 / 分 / 秒都补零', () => {
    expect(defaultCaptureName(new Date(2026, 0, 5, 3, 4, 5))).toBe('截图-2026-01-05-030405.png')
  })
})

describe('uniqueName', () => {
  it('不撞就原样返回', () => {
    expect(uniqueName('截图.png', () => false)).toBe('截图.png')
  })

  it('撞了就加序号，加在主名与后缀之间', () => {
    const taken = new Set(['截图.png', '截图-2.png'])
    expect(uniqueName('截图.png', name => taken.has(name))).toBe('截图-3.png')
  })

  it('没有后缀的也成立', () => {
    const taken = new Set(['a'])
    expect(uniqueName('a', name => taken.has(name))).toBe('a-2')
  })

  it('连点开头的隐藏文件不当作后缀', () => {
    expect(uniqueName('.gitignore', name => name === '.gitignore')).toBe('.gitignore-2')
  })
})

describe('splitPath', () => {
  it('反斜杠路径', () => {
    expect(splitPath('D:\\shots\\截图-1.png')).toEqual({ dir: 'D:\\shots\\', name: '截图-1.png' })
  })

  it('正斜杠路径也认', () => {
    expect(splitPath('D:/shots/a.png')).toEqual({ dir: 'D:/shots/', name: 'a.png' })
  })

  it('盘根留住分隔符', () => {
    expect(splitPath('C:\\a.png')).toEqual({ dir: 'C:\\', name: 'a.png' })
  })

  it('没有目录时目录是空串', () => {
    expect(splitPath('a.png')).toEqual({ dir: '', name: 'a.png' })
  })
})
