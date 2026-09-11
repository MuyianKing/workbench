import { describe, expect, it } from 'vitest'
import { APP_NAME_DEFAULT, APP_NAME_MAX_LENGTH, sanitizeAppName } from './app-name'

describe('sanitizeAppName', () => {
  it('正常名字原样返回', () => {
    expect(sanitizeAppName('WORKBENCH')).toBe('WORKBENCH')
    expect(sanitizeAppName('我的工作台')).toBe('我的工作台')
    expect(sanitizeAppName('My Bench')).toBe('My Bench')
  })

  it('去掉首尾空白，中间的连续空白压成单个空格', () => {
    expect(sanitizeAppName('  WORKBENCH  ')).toBe('WORKBENCH')
    expect(sanitizeAppName('My\t\nBench')).toBe('My Bench')
  })

  it('空串 / 全空白回到默认名', () => {
    expect(sanitizeAppName('')).toBe(APP_NAME_DEFAULT)
    expect(sanitizeAppName('   ')).toBe(APP_NAME_DEFAULT)
    expect(sanitizeAppName('\n\t')).toBe(APP_NAME_DEFAULT)
  })

  it('非字符串回到默认名', () => {
    expect(sanitizeAppName(undefined)).toBe(APP_NAME_DEFAULT)
    expect(sanitizeAppName(null)).toBe(APP_NAME_DEFAULT)
    expect(sanitizeAppName(123)).toBe(APP_NAME_DEFAULT)
    expect(sanitizeAppName({ name: 'x' })).toBe(APP_NAME_DEFAULT)
  })

  it('超长截断到上限', () => {
    const long = 'A'.repeat(APP_NAME_MAX_LENGTH + 10)
    expect(sanitizeAppName(long)).toBe('A'.repeat(APP_NAME_MAX_LENGTH))
  })
})
