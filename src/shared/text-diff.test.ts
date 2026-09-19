import { describe, expect, it } from 'vitest'
import { buildDiffRows } from './text-diff'

/** 一侧的纯文本：把段拼回去（不变式 —— 无论如何拼接都得还原这一行） */
const sideText = (side: { segments: { text: string }[] } | null): string =>
  side ? side.segments.map((segment) => segment.text).join('') : ''

describe('buildDiffRows', () => {
  it('相同的文本产出清一色的 equal 行，两边行号一致', () => {
    const rows = buildDiffRows('a\nb\nc', 'a\nb\nc')
    expect(rows.map((row) => row.type)).toEqual(['equal', 'equal', 'equal'])
    expect(rows[1].left?.no).toBe(2)
    expect(rows[1].right?.no).toBe(2)
    expect(sideText(rows[1].left)).toBe('b')
    expect(sideText(rows[1].right)).toBe('b')
  })

  it('一行修改 → 一行 change：左边旧号、右边新号，段拼接还原各自的行', () => {
    const rows = buildDiffRows('const a = 1\n', 'const a = 2\n')
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('change')
    expect(rows[0].left?.no).toBe(1)
    expect(rows[0].right?.no).toBe(1)
    expect(sideText(rows[0].left)).toBe('const a = 1')
    expect(sideText(rows[0].right)).toBe('const a = 2')
    // 变化的那段要标出来（旧值 1 / 新值 2 至少各有一段 changed）
    expect(rows[0].left?.segments.some((segment) => segment.changed)).toBe(true)
    expect(rows[0].right?.segments.some((segment) => segment.changed)).toBe(true)
  })

  it('纯新增 → add 行（左侧空），纯删除 → del 行（右侧空）', () => {
    const added = buildDiffRows('a\n', 'a\nb\n')
    expect(added.map((row) => row.type)).toEqual(['equal', 'add'])
    expect(added[1].left).toBeNull()
    expect(added[1].right?.no).toBe(2)

    const removed = buildDiffRows('a\nb\n', 'a\n')
    expect(removed.map((row) => row.type)).toEqual(['equal', 'del'])
    expect(removed[1].right).toBeNull()
    expect(removed[1].left?.no).toBe(2)
  })

  it('两行删一行加：配对一行 change，剩下一行是纯 del', () => {
    const rows = buildDiffRows('old1\nold2\n', 'new1\n')
    expect(rows.map((row) => row.type)).toEqual(['change', 'del'])
    expect(sideText(rows[0].left)).toBe('old1')
    expect(sideText(rows[0].right)).toBe('new1')
    expect(rows[1].left?.no).toBe(2)
    expect(rows[1].right).toBeNull()
  })

  it('相邻的删除与新增块之间隔着未变内容时，各自独立成行', () => {
    const rows = buildDiffRows('a\nb\nc\nd\n', 'a\nB\nc\nD\n')
    expect(rows.map((row) => row.type)).toEqual(['equal', 'change', 'equal', 'change'])
    expect(rows[1].left?.no).toBe(2)
    expect(rows[3].left?.no).toBe(4)
  })

  it('CRLF 与 LF 的差别不算差异', () => {
    const rows = buildDiffRows('a\r\nb\r\n', 'a\nb\n')
    expect(rows.map((row) => row.type)).toEqual(['equal', 'equal'])
  })

  it('空文本与全新增', () => {
    expect(buildDiffRows('', 'a\nb\n').map((row) => row.type)).toEqual(['add', 'add'])
    expect(buildDiffRows('a\n', '')).toEqual([{ type: 'del', left: { no: 1, segments: [{ text: 'a', changed: false }] }, right: null }])
    expect(buildDiffRows('', '')).toEqual([])
  })

  it('中文内容同样产出 change 行且段拼接不变式成立', () => {
    const rows = buildDiffRows('把静态页面转换', '把静态页面转换为组件')
    expect(rows[0].type).toBe('change')
    expect(sideText(rows[0].left)).toBe('把静态页面转换')
    expect(sideText(rows[0].right)).toBe('把静态页面转换为组件')
  })
})
