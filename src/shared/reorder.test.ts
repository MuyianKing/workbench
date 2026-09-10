import { describe, expect, it } from 'vitest'
import { moveToPosition, reorderById } from './reorder'

interface Item {
  id: string
}

const items: Item[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('reorderById', () => {
  it('按给定顺序重排', () => {
    expect(reorderById(items, ['c', 'a', 'b']).map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })

  it('顺序里没提到的条目追加到末尾，不会被丢掉', () => {
    expect(reorderById(items, ['c']).map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })

  it('忽略不存在的 id', () => {
    expect(reorderById(items, ['b', 'ghost', 'a', 'c']).map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })

  it('空顺序时保持原样', () => {
    expect(reorderById(items, []).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('不修改传入的数组', () => {
    const source = [...items]
    reorderById(source, ['c', 'b', 'a'])
    expect(source.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})

const ids = ['a', 'b', 'c', 'd']

describe('moveToPosition', () => {
  it('往后拖：落到目标位置上，中间的被顶到前面', () => {
    expect(moveToPosition(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
  })

  it('往前拖：落到目标位置上，中间的被挤到后面', () => {
    expect(moveToPosition(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('拖到相邻位置', () => {
    expect(moveToPosition(ids, 'b', 'c')).toEqual(['a', 'c', 'b', 'd'])
    expect(moveToPosition(ids, 'c', 'b')).toEqual(['a', 'c', 'b', 'd'])
  })

  it('落回原位时返回 null，调用方据此跳过落盘', () => {
    expect(moveToPosition(ids, 'b', 'b')).toBeNull()
  })

  it('id 不在顺序里时返回 null', () => {
    expect(moveToPosition(ids, 'ghost', 'b')).toBeNull()
    expect(moveToPosition(ids, 'b', 'ghost')).toBeNull()
  })

  it('不修改传入的数组', () => {
    const source = [...ids]
    moveToPosition(source, 'a', 'd')
    expect(source).toEqual(['a', 'b', 'c', 'd'])
  })
})
