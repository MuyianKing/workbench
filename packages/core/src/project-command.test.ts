import { describe, expect, it } from 'vitest'
import { commandLabel, customRef, customRefIndex } from './project-command'
import { isValidScriptName } from './scanner'

describe('customRef / customRefIndex', () => {
  it('编码后能解回原来的下标', () => {
    for (const index of [0, 1, 12]) {
      const ref = customRef(index)
      expect(ref).toBe(`@custom:${index}`)
      expect(customRefIndex(ref)).toBe(index)
    }
  })

  it('普通脚本名不是自定义引用', () => {
    expect(customRefIndex('dev')).toBeNull()
    expect(customRefIndex('build:prod')).toBeNull()
    expect(customRefIndex(undefined)).toBeNull()
  })

  it('畸形引用不当成自定义命令', () => {
    expect(customRefIndex('@custom:x')).toBeNull()
    expect(customRefIndex('@custom:-1')).toBeNull()
    expect(customRefIndex('@custom:1.5')).toBeNull()
  })

  it('自定义引用不会被当成合法脚本名，因此不会拼成 <pm> run', () => {
    expect(isValidScriptName(customRef(0))).toBe(false)
  })
})

describe('commandLabel', () => {
  it('自定义引用显示成命令名称', () => {
    expect(commandLabel(customRef(0), [{ name: '启动打印服务' }])).toBe('自定义：启动打印服务')
  })

  it('越界的自定义引用退回原样，暴露失效配置', () => {
    expect(commandLabel(customRef(3), [{ name: 'dev' }])).toBe('@custom:3')
  })

  it('普通脚本名原样显示', () => {
    expect(commandLabel('dev', [])).toBe('dev')
  })
})
