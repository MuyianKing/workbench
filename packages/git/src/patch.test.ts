import { describe, expect, it } from 'vitest'
import { parsePatch } from './patch'

const patch = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+two changed',
  '+three',
  ' four',
  '',
].join('\n')

describe('parsePatch', () => {
  it('把增删上下文拆成带行号的行', () => {
    const { rows, truncated } = parsePatch(patch)
    expect(truncated).toBe(false)

    const hunk = rows.find(row => row.type === 'hunk')
    expect(hunk?.text).toBe('@@ -1,3 +1,4 @@')

    const changed = rows.filter(row => row.type === 'add' || row.type === 'del')
    expect(changed.map(row => [row.type, row.text, row.oldNo, row.newNo])).toEqual([
      ['del', 'two', 2, null],
      ['add', 'two changed', null, 2],
      ['add', 'three', null, 3],
    ])

    const context = rows.filter(row => row.type === 'context')
    expect(context.map(row => [row.text, row.oldNo, row.newNo])).toEqual([
      ['one', 1, 1],
      ['four', 3, 4],
    ])
  })

  it('hunk 里以 +++ 开头的内容仍是新增行，不会被当成文件头', () => {
    const { rows } = parsePatch([
      '@@ -1,1 +1,2 @@',
      ' a',
      '+++b',
    ].join('\n'))

    expect(rows.filter(row => row.type === 'add')).toEqual([
      { type: 'add', text: '++b', oldNo: null, newNo: 2 },
    ])
  })

  it('保留「文件末尾没有换行」这类说明行', () => {
    const { rows } = parsePatch([
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file',
    ].join('\n'))

    expect(rows.filter(row => row.type === 'note')).toHaveLength(2)
  })

  it('多个 hunk 各自从自己的起始行号算', () => {
    const { rows } = parsePatch([
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '@@ -8,1 +9,1 @@',
      '-c',
      '+d',
    ].join('\n'))

    const dels = rows.filter(row => row.type === 'del')
    const adds = rows.filter(row => row.type === 'add')
    expect(dels.map(row => row.oldNo)).toEqual([1, 8])
    expect(adds.map(row => row.newNo)).toEqual([1, 9])
  })

  it('二进制补丁没有 hunk，只有可显示的说明行', () => {
    const { rows } = parsePatch([
      'diff --git a/bin.dat b/bin.dat',
      'index 1111111..2222222 100644',
      'Binary files a/bin.dat and b/bin.dat differ',
    ].join('\n'))

    expect(rows.every(row => row.type === 'meta')).toBe(true)
    expect(rows.some(row => row.text.includes('Binary files'))).toBe(true)
  })

  it('超过上限时截断并标记', () => {
    const many = Array.from({ length: 20 }, (_, index) => `+line ${index}`)
    const { rows, truncated } = parsePatch(['@@ -0,0 +1,20 @@', ...many].join('\n'), 5)
    expect(truncated).toBe(true)
    expect(rows).toHaveLength(5)
  })
})
