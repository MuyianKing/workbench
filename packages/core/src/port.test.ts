import { describe, expect, it } from 'vitest'
import { parsePort } from './port'

describe('parsePort', () => {
  it('数字与数字字符串都归一成同一个端口', () => {
    expect(parsePort(5173)).toBe(5173)
    expect(parsePort('5173')).toBe(5173)
    expect(parsePort('  5173  ')).toBe(5173)
    expect(parsePort('08080')).toBe(8080)
  })

  it('边界值有效', () => {
    expect(parsePort(1)).toBe(1)
    expect(parsePort(65535)).toBe(65535)
  })

  it('空值表示「不配置端口」', () => {
    expect(parsePort('')).toBeUndefined()
    expect(parsePort('   ')).toBeUndefined()
    expect(parsePort(null)).toBeUndefined()
    expect(parsePort(undefined)).toBeUndefined()
  })

  it('越界、非整数与非数字往返归 undefined', () => {
    expect(parsePort(0)).toBeUndefined()
    expect(parsePort(-1)).toBeUndefined()
    expect(parsePort(65536)).toBeUndefined()
    expect(parsePort(5173.5)).toBeUndefined()
    expect(parsePort('5173.5')).toBeUndefined()
    expect(parsePort('abc')).toBeUndefined()
    expect(parsePort('80x')).toBeUndefined()
    expect(parsePort({})).toBeUndefined()
    expect(parsePort([])).toBeUndefined()
  })
})
