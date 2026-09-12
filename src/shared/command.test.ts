import { describe, expect, it } from 'vitest'
import { COMMAND_TEXT_MAX, commandTextError, defaultCommandName, sanitizeCommands } from './command'

describe('commandTextError', () => {
  it('空命令与纯空白都不合法', () => {
    expect(commandTextError('')).toBe('命令不能为空')
    expect(commandTextError('   ')).toBe('命令不能为空')
    expect(commandTextError(undefined)).toBe('命令不能为空')
  })

  it('换行等于偷偷执行多条命令，一律拒绝', () => {
    expect(commandTextError('npm start\r\nrm -rf /')).toBe('命令不能包含换行')
    expect(commandTextError('npm start\nrm -rf /')).toBe('命令不能包含换行')
  })

  it('粘贴进来的首尾空白先去掉，不影响命令本身', () => {
    expect(commandTextError('npm start\n')).toBeNull()
    expect(commandTextError('  npm start  ')).toBeNull()
  })

  it('超长命令拒绝，刚好到上限放行', () => {
    expect(commandTextError('a'.repeat(COMMAND_TEXT_MAX + 1))).toBe(
      `命令过长（上限 ${COMMAND_TEXT_MAX} 字符）`
    )
    expect(commandTextError('a'.repeat(COMMAND_TEXT_MAX))).toBeNull()
  })

  it('一行正常命令通过', () => {
    expect(commandTextError('  npx @deepseek-ai/dsh web  ')).toBeNull()
  })
})

describe('defaultCommandName', () => {
  it('取第一个词，并剥掉包裹的引号', () => {
    expect(defaultCommandName('npx @deepseek-ai/dsh web')).toBe('npx')
    expect(defaultCommandName('"C:\\tools\\tool.exe" --serve')).toBe('C:\\tools\\tool.exe')
  })
})

describe('sanitizeCommands', () => {
  let seq = 0
  const makeId = (): string => `id-${++seq}`

  it('非数组一律当作空列表', () => {
    expect(sanitizeCommands(undefined, makeId)).toEqual([])
    expect(sanitizeCommands({ hack: true }, makeId)).toEqual([])
  })

  it('丢掉没有命令的条目，其余补回缺失字段', () => {
    const list = sanitizeCommands(
      [{ command: '  npx dsh web  ' }, { name: '没有命令' }, null, 'not an object'],
      makeId
    )

    expect(list).toHaveLength(1)
    expect(list[0].command).toBe('npx dsh web')
    expect(list[0].name).toBe('npx')
    expect(list[0].order).toBe(0)
    expect(list[0].createdAt).toBeGreaterThan(0)
  })

  it('含换行与超长的条目一并丢掉', () => {
    const list = sanitizeCommands(
      [{ command: 'a\nb' }, { command: 'a'.repeat(COMMAND_TEXT_MAX + 1) }, { command: 'ok' }],
      makeId
    )
    expect(list.map((item) => item.command)).toEqual(['ok'])
  })

  it('非法端口归到 undefined，合法端口保留', () => {
    const list = sanitizeCommands(
      [
        { command: 'a', port: '5173' },
        { command: 'b', port: 70000 },
        { command: 'c', port: 12.5 }
      ],
      makeId
    )

    expect(list.map((item) => item.port)).toEqual([5173, undefined, undefined])
  })

  it('按 order 排序并重新编号，结果一定是紧凑的', () => {
    const list = sanitizeCommands(
      [
        { id: 'a', command: 'a', order: 9 },
        { id: 'b', command: 'b', order: 2 },
        { id: 'c', command: 'c' }
      ],
      makeId
    )

    expect(list.map((item) => item.id)).toEqual(['b', 'c', 'a'])
    expect(list.map((item) => item.order)).toEqual([0, 1, 2])
  })

  it('保留已有的 id 与创建时间', () => {
    const raw = { id: 'keep', name: '启动', command: 'npx dsh web', port: 3000, order: 0, createdAt: 1 }
    expect(sanitizeCommands([raw], makeId)).toEqual([raw])
  })
})
