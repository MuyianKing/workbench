import { describe, expect, it } from 'vitest'
import { buildSplitRows, parsePatch } from './patch'

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

describe('buildSplitRows', () => {
  it('删除块与新增块按顺序配成左右行，配剩的成单边行', () => {
    const { rows } = parsePatch([
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      '-gone',
    ].join('\n'))

    const split = buildSplitRows(rows)
    expect(split.map(row => [row.type, row.left?.no ?? null, row.right?.no ?? null])).toEqual([
      ['hunk', null, null],
      ['equal', 1, 1],
      ['change', 2, 2],
      ['del', 3, null],
    ])
    expect(split[1].left?.text).toBe('keep')
    expect(split[1].right?.text).toBe('keep')
    expect(split[2].left?.text).toBe('old')
    expect(split[2].right?.text).toBe('new')
  })

  it('新增文件整块落在右侧，左侧留空', () => {
    const { rows } = parsePatch([
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
    ].join('\n'))

    const split = buildSplitRows(rows).filter(row => row.type !== 'hunk')
    expect(split.map(row => [row.type, row.left, row.right?.no, row.right?.text])).toEqual([
      ['add', null, 1, 'first'],
      ['add', null, 2, 'second'],
    ])
  })

  it('删除文件整块落在左侧，右侧留空', () => {
    const { rows } = parsePatch([
      '@@ -1,2 +0,0 @@',
      '-first',
      '-second',
    ].join('\n'))

    const split = buildSplitRows(rows).filter(row => row.type !== 'hunk')
    expect(split.map(row => [row.type, row.left?.no, row.right])).toEqual([
      ['del', 1, null],
      ['del', 2, null],
    ])
  })

  it('meta 行不进并排视图，hunk 与说明行保留成整行', () => {
    const { rows } = parsePatch([
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
    ].join('\n'))

    const split = buildSplitRows(rows)
    expect(split.map(row => row.type)).toEqual(['hunk', 'change', 'note'])
    expect(split[0].text).toBe('@@ -1 +1 @@')
    expect(split[2].text).toBe('\\ No newline at end of file')
  })

  it('多个 hunk 之间的配对互不影响', () => {
    const { rows } = parsePatch([
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '@@ -8,1 +9,2 @@',
      '-c',
      '+d',
      '+e',
    ].join('\n'))

    const split = buildSplitRows(rows)
    expect(split.map(row => [row.type, row.left?.no ?? null, row.right?.no ?? null])).toEqual([
      ['hunk', null, null],
      ['change', 1, 1],
      ['hunk', null, null],
      ['change', 8, 9],
      ['add', null, 10],
    ])
  })
})
