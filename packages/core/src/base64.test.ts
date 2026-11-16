import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from './base64'

describe('base64', () => {
  it('字节数组往返', () => {
    const bytes = new TextEncoder().encode('工作台 workbench')
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it('空数组回空串', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('')
  })

  it('坏 base64 返回 null', () => {
    expect(base64ToBytes('%%%not-base64%%%')).toBeNull()
  })

  it('大数组分块拼接不爆栈', () => {
    const big = new Uint8Array(1 << 20)
    expect(base64ToBytes(bytesToBase64(big))?.length).toBe(big.length)
  })
})
