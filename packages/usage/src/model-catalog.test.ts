import type { ModelCatalogEntry } from './model-catalog'
import { describe, expect, it } from 'vitest'
import { MODEL_SORTS, parseModelRate, sortModels } from './model-catalog'

/** 造一条目录条目；没写的字段给「上游没说」那套缺省 */
function entry(id: string, patch: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id,
    name: id,
    rate: '',
    context: 0,
    maxOutput: 0,
    ...patch,
  }
}

describe('parseModelRate', () => {
  it('前缀 x 与后缀 x 都认，取串里的第一个数', () => {
    expect(parseModelRate('x0.29')).toBe(0.29)
    expect(parseModelRate('0.69x')).toBe(0.69)
    expect(parseModelRate('x1.00')).toBe(1)
    expect(parseModelRate('x0.29 限时')).toBe(0.29)
  })

  it('空串 / 没数 / 非法数一律是未知，不拿 0 冒充免费', () => {
    expect(parseModelRate('')).toBeNull()
    expect(parseModelRate('免费')).toBeNull()
    expect(parseModelRate('xNaN')).toBeNull()
    expect(parseModelRate('-1x')).toBeNull()
  })

  it('明确给过的 0 是已知值，不是未知', () => {
    expect(parseModelRate('x0.00')).toBe(0)
  })
})

describe('sortModels', () => {
  const models = [
    entry('c', { rate: 'x0.52', context: 200_000, maxOutput: 16_000, name: '丙' }),
    entry('a', { rate: '0.11x', context: 1_000_000, maxOutput: 64_000, name: '甲' }),
    entry('unknown', { rate: '', context: 0, maxOutput: 0, name: '未知' }),
    entry('b', { rate: 'x0.00', context: 300_000, maxOutput: 48_000, name: '乙' }),
  ]

  it('默认按倍率从低到高，未知沉底；不改原数组', () => {
    expect(sortModels(models, 'rate').map(item => item.id)).toEqual(['b', 'a', 'c', 'unknown'])
    expect(models.map(item => item.id)).toEqual(['c', 'a', 'unknown', 'b'])
  })

  it('倍率降序时未知仍然沉底，不会翻到最前', () => {
    expect(sortModels(models, 'rateDesc').map(item => item.id)).toEqual(['c', 'a', 'b', 'unknown'])
  })

  it('上下文 / 最大输出从大到小，没给的字段沉底', () => {
    expect(sortModels(models, 'context').map(item => item.id)).toEqual(['a', 'b', 'c', 'unknown'])
    expect(sortModels(models, 'maxOutput').map(item => item.id)).toEqual(['a', 'b', 'c', 'unknown'])
  })

  it('按名称用 zh-CN 拼音序（丙 bing < 甲 jia < 未 wei < 乙 yi）；空名退到 id', () => {
    expect(sortModels(models, 'name').map(item => item.id)).toEqual(['c', 'a', 'unknown', 'b'])
  })

  it('上游顺序那一档原样复制一份', () => {
    const sorted = sortModels(models, 'default')
    expect(sorted.map(item => item.id)).toEqual(models.map(item => item.id))
    expect(sorted).not.toBe(models)
  })

  it('同值退回 id 字典序，顺序稳定', () => {
    const same = [entry('z', { rate: 'x0.29' }), entry('m', { rate: '0.29x' }), entry('a', { rate: 'x0.29' })]
    expect(sortModels(same, 'rate').map(item => item.id)).toEqual(['a', 'm', 'z'])
    expect(sortModels(same, 'rateDesc').map(item => item.id)).toEqual(['a', 'm', 'z'])
  })

  it('未知项之间也按 id 排，换升降序都不乱', () => {
    const unknown = [entry('z'), entry('a'), entry('m')]
    expect(sortModels(unknown, 'rate').map(item => item.id)).toEqual(['a', 'm', 'z'])
    expect(sortModels(unknown, 'rateDesc').map(item => item.id)).toEqual(['a', 'm', 'z'])
  })

  it('空目录与单条不报错', () => {
    expect(sortModels([], 'rate')).toEqual([])
    expect(sortModels([entry('only')], 'rate').map(item => item.id)).toEqual(['only'])
  })

  it('选项表里默认档排第一，且没有重复值', () => {
    expect(MODEL_SORTS[0].value).toBe('rate')
    expect(new Set(MODEL_SORTS.map(item => item.value)).size).toBe(MODEL_SORTS.length)
  })
})
