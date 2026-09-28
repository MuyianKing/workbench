import { describe, expect, it } from 'vitest'
import {
  activeAiModel,
  nodeSatisfiesPi,
  parsePiEvent,
  piLaunch,
  piLaunchForDisplay,
  sanitizeAiApiFormat,
  sanitizeAiBaseUrl,
  sanitizeAiModels,
  sanitizeAiName,
  taskPrompt,
  writtenEntries,
  type AiLogLine
} from './ai'

describe('模型配置的收敛', () => {
  it('提供方名折成小写字母 / 数字 / 连字符，超长截断', () => {
    expect(sanitizeAiName('opencode')).toBe('opencode')
    expect(sanitizeAiName('  My Gateway  ')).toBe('my-gateway')
    expect(sanitizeAiName('a b')).toBe('a-b')
    expect(sanitizeAiName('--x--')).toBe('x')
    expect(sanitizeAiName('中文名字')).toBe('')
    expect(sanitizeAiName('x'.repeat(40))).toHaveLength(32)
    expect(sanitizeAiName(null)).toBe('')
  })

  it('API 形态只认登记过的那两个', () => {
    expect(sanitizeAiApiFormat('openai-completions')).toBe('openai-completions')
    expect(sanitizeAiApiFormat('anthropic-messages')).toBe('anthropic-messages')
    expect(sanitizeAiApiFormat('grpc')).toBe('')
    expect(sanitizeAiApiFormat(undefined)).toBe('')
  })

  it('Base URL 只去空白限长（形状在保存时校验）', () => {
    expect(sanitizeAiBaseUrl('  https://opencode.ai/zen/go/v1 ')).toBe('https://opencode.ai/zen/go/v1')
    expect(sanitizeAiBaseUrl('x'.repeat(400))).toHaveLength(300)
    expect(sanitizeAiBaseUrl(42)).toBe('')
  })

  it('模型清单去重保序、保留启停状态、限量', () => {
    const models = sanitizeAiModels([
      { id: ' deepseek-v4.1-flash ', enabled: true },
      { id: 'mimo-v2.6-flash', enabled: false },
      { id: 'deepseek-v4.1-flash', enabled: false },
      { id: '', enabled: true },
      'not-an-object',
      null
    ])
    expect(models).toEqual([
      { id: 'deepseek-v4.1-flash', enabled: true },
      { id: 'mimo-v2.6-flash', enabled: false }
    ])

    expect(sanitizeAiModels('x')).toEqual([])
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, enabled: true }))
    expect(sanitizeAiModels(many)).toHaveLength(32)
  })

  it('跑的是第一个启用的模型；一个都没启用就是空串', () => {
    expect(
      activeAiModel([
        { id: 'a', enabled: false },
        { id: 'b', enabled: true },
        { id: 'c', enabled: true }
      ])
    ).toBe('b')
    expect(activeAiModel([{ id: 'a', enabled: false }])).toBe('')
    expect(activeAiModel([])).toBe('')
  })
})

describe('命令与提示词', () => {
  it('内置模式用 node 直跑 cli.js，退路是全局 pi；提示词不在参数里（Rust 以 @文件 追加）', () => {
    const cli = 'E:\\app\\resources\\pi\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'
    const bundled = piLaunch(cli)
    expect(bundled.program).toBe('node')
    expect(bundled.args[0]).toBe(cli)
    expect(bundled.args).toContain('--print')
    expect(bundled.args).toContain('--mode')
    expect(bundled.args).toContain('json')
    expect(bundled.args).toContain('--no-session')
    expect(bundled.args).toContain('-xt')
    expect(bundled.args).toContain('bash,powershell')
    expect(bundled.args.join(' ')).not.toContain('提示词')

    const global = piLaunch(null)
    expect(global.program).toBe('pi')
    expect(global.args).toHaveLength(6)
  })

  it('日志那行把含空格的参数引起来，末尾说明提示词以 @文件 附上', () => {
    const shown = piLaunchForDisplay(piLaunch('E:\\has space\\cli.js'))
    expect(shown).toContain('"E:\\has space\\cli.js"')
    expect(shown).toContain('@<提示词文件>')
  })

  it('Node 版本门槛：>= 22.19.0', () => {
    expect(nodeSatisfiesPi('v24.15.0')).toBe(true)
    expect(nodeSatisfiesPi('22.19.0')).toBe(true)
    expect(nodeSatisfiesPi('v22.19')).toBe(true)
    expect(nodeSatisfiesPi('v22.18.9')).toBe(false)
    expect(nodeSatisfiesPi('v20.11.0')).toBe(false)
    expect(nodeSatisfiesPi('')).toBe(false)
    expect(nodeSatisfiesPi('not a version')).toBe(false)
  })

  it('提示词只说清「在哪儿干活」+ 用户的指令原文', () => {
    const prompt = taskPrompt({
      dir: 'E:\\muyian\\agent',
      instruction: '按 kb/00-使用规范/条目格式规范.md 整理 data/raw 下的资料'
    })

    expect(prompt).toContain('E:\\muyian\\agent')
    expect(prompt).toContain('按 kb/00-使用规范/条目格式规范.md 整理 data/raw 下的资料')
    // 不内置任何一类任务的提示词：指令由用户写
    expect(taskPrompt({ dir: 'C:\\x', instruction: '  ' })).toBe('你在下面这个目录里工作：C:\\x')
  })
})

describe('事件流的读法', () => {
  const parse = (value: unknown): AiLogLine | null => parsePiEvent(JSON.stringify(value))

  it('会话头：有模型名就说模型', () => {
    expect(parse({ type: 'session', model: 'claude-sonnet-4-5' })).toEqual({
      kind: 'info',
      text: '已连接模型 claude-sonnet-4-5'
    })
    expect(parse({ type: 'session' })?.text).toBe('已建立会话')
  })

  it('开始与结束', () => {
    expect(parse({ type: 'agent_start' })).toEqual({ kind: 'info', text: '开始执行' })
    expect(parse({ type: 'agent_settled' })).toEqual({ kind: 'done', text: '执行结束' })
  })

  it('工具调用：读只描述，写与改记下文件（用来汇总）', () => {
    expect(parse({ type: 'tool_execution_start', toolName: 'read', args: { path: 'kb/a.md' } })).toEqual({
      kind: 'tool',
      text: '读取 kb/a.md'
    })

    expect(
      parse({ type: 'tool_execution_start', toolName: 'write', args: { path: 'kb/b.md' } })
    ).toEqual({ kind: 'tool', text: '写入 kb/b.md', path: 'kb/b.md' })

    expect(
      parse({ type: 'tool_execution_start', toolName: 'edit', args: { file_path: 'kb/c.md' } })
    ).toEqual({ kind: 'tool', text: '修改 kb/c.md', path: 'kb/c.md' })

    // 认不出的工具也如实说，但不当作「写下的条目」
    expect(parse({ type: 'tool_execution_start', toolName: 'webfetch', args: {} })).toEqual({
      kind: 'tool',
      text: '调用 webfetch'
    })
  })

  it('工具失败留下错误行，成功不留（一次调用画两行没有信息量）', () => {
    expect(parse({ type: 'tool_execution_end', toolName: 'write' })).toBeNull()
    expect(parse({ type: 'tool_execution_end', toolName: 'write', error: '磁盘满了' })).toEqual({
      kind: 'error',
      text: 'write：磁盘满了'
    })
  })

  it('助手正文字符串与内容块两种形状都认；用户消息的回显不画', () => {
    expect(parse({ type: 'message_end', message: '汇总：新建 2 条' })).toEqual({
      kind: 'text',
      text: '汇总：新建 2 条'
    })
    expect(
      parse({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } })
    ).toEqual({ kind: 'text', text: '第一段\n第二段' })
    expect(parse({ type: 'message_end', message: { content: [] } })).toBeNull()
    // @文件 的回显长在用户消息里：整段提示词画进日志只会把有用的几行淹掉
    expect(parse({ type: 'message_end', message: { role: 'user', content: '整段提示词…' } })).toBeNull()
  })

  it('模型侧的失败（errorMessage）落成错误行', () => {
    expect(
      parse({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '403 Request not allowed' } })
    ).toEqual({ kind: 'error', text: '403 Request not allowed' })
  })

  it('逐字增量不画，只有出错才留一行', () => {
    expect(
      parse({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '整' } })
    ).toBeNull()
    expect(
      parse({ type: 'message_update', assistantMessageEvent: { type: 'error', error: '被限流' } })
    ).toEqual({ kind: 'error', text: '被限流' })
  })

  it('重试与顶层错误', () => {
    expect(parse({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 })).toEqual({
      kind: 'info',
      text: '连接不稳，正在重试（1/3）'
    })
    expect(parse({ type: 'error', message: '没有凭据' })).toEqual({ kind: 'error', text: '没有凭据' })
  })

  it('协议里的其余事件丢掉，非 JSON 的行原样留下（还要清控制序列）', () => {
    expect(parse({ type: 'turn_start' })).toBeNull()
    expect(parse({ type: 'queue_update' })).toBeNull()
    expect(parsePiEvent('   ')).toBeNull()

    expect(parsePiEvent('\u001b[31mError: 找不到模型\u001b[0m')).toEqual({
      kind: 'info',
      text: 'Error: 找不到模型'
    })
  })

  it('汇总：写过的文件去重排序', () => {
    const lines: AiLogLine[] = [
      { kind: 'tool', text: '写入 kb/b.md', path: 'kb/b.md' },
      { kind: 'tool', text: '读取 kb/a.md' },
      { kind: 'tool', text: '修改 kb/a.md', path: 'kb/a.md' },
      { kind: 'tool', text: '写入 kb/b.md', path: 'kb/b.md' }
    ]
    expect(writtenEntries(lines)).toEqual(['kb/a.md', 'kb/b.md'])
  })
})
