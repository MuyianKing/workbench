import { describe, expect, it } from 'vitest'
import { satisfiesNodeVersion } from './node-version'

describe('satisfiesNodeVersion', () => {
  it('未声明要求时一律通过', () => {
    expect(satisfiesNodeVersion(undefined, '18.0.0')).toBe(true)
    expect(satisfiesNodeVersion('', '18.0.0')).toBe(true)
    expect(satisfiesNodeVersion('   ', '18.0.0')).toBe(true)
  })

  it('比较符', () => {
    expect(satisfiesNodeVersion('>=18', '20.11.1')).toBe(true)
    expect(satisfiesNodeVersion('>=18', '16.20.2')).toBe(false)
    expect(satisfiesNodeVersion('>18', '18.0.0')).toBe(false)
    expect(satisfiesNodeVersion('>18', '18.0.1')).toBe(true)
    expect(satisfiesNodeVersion('<=20', '20.0.0')).toBe(true)
    expect(satisfiesNodeVersion('<=20', '20.0.1')).toBe(false)
    expect(satisfiesNodeVersion('<21', '20.9.0')).toBe(true)
  })

  it('空格分隔的区间', () => {
    expect(satisfiesNodeVersion('>=18 <21', '20.11.1')).toBe(true)
    expect(satisfiesNodeVersion('>=18 <21', '21.0.0')).toBe(false)
    expect(satisfiesNodeVersion('>=18 <21', '17.9.1')).toBe(false)
  })

  it('X 区间与精确版本', () => {
    expect(satisfiesNodeVersion('18', '18.1.0')).toBe(true)
    expect(satisfiesNodeVersion('18', '19.0.0')).toBe(false)
    expect(satisfiesNodeVersion('18.x', '18.9.9')).toBe(true)
    expect(satisfiesNodeVersion('18.x', '19.0.0')).toBe(false)
    expect(satisfiesNodeVersion('18.2', '18.2.7')).toBe(true)
    expect(satisfiesNodeVersion('18.2', '18.3.0')).toBe(false)
    expect(satisfiesNodeVersion('18.2.3', '18.2.3')).toBe(true)
    expect(satisfiesNodeVersion('18.2.3', '18.2.4')).toBe(false)
    // .nvmrc 里常见带 v 前缀
    expect(satisfiesNodeVersion('v18.16.0', '18.16.0')).toBe(true)
  })

  it('插入号与波浪号', () => {
    expect(satisfiesNodeVersion('^18.2.0', '18.5.0')).toBe(true)
    expect(satisfiesNodeVersion('^18.2.0', '19.0.0')).toBe(false)
    expect(satisfiesNodeVersion('^18.2.0', '18.1.0')).toBe(false)
    expect(satisfiesNodeVersion('^0.2.3', '0.2.9')).toBe(true)
    expect(satisfiesNodeVersion('^0.2.3', '0.3.0')).toBe(false)

    expect(satisfiesNodeVersion('~18.2.0', '18.2.9')).toBe(true)
    expect(satisfiesNodeVersion('~18.2.0', '18.3.0')).toBe(false)
    expect(satisfiesNodeVersion('~18.2', '18.2.0')).toBe(true)
  })

  it('并集', () => {
    expect(satisfiesNodeVersion('>=18 || >=20', '21.0.0')).toBe(true)
    expect(satisfiesNodeVersion('18 || 20', '19.0.0')).toBe(false)
    expect(satisfiesNodeVersion('18 || 20', '20.5.0')).toBe(true)
  })

  it('读不懂的写法不误报', () => {
    expect(satisfiesNodeVersion('lts/*', '18.0.0')).toBe(true)
    expect(satisfiesNodeVersion('latest', '18.0.0')).toBe(true)
  })
})
