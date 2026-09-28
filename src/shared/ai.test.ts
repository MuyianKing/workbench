import { describe, expect, it } from 'vitest'
import {
  AI_HISTORY_MAX,
  AI_INSTRUCTION_MAX,
  AI_PERMISSION_DEFAULT,
  AI_PERMISSION_MODES,
  AI_PROMPT_PREFIX,
  AI_SESSION_MAX,
  AI_SESSION_TITLE_MAX,
  AI_THINKING_DEFAULT,
  AI_THINKING_LEVELS,
  aiPermissionLabel,
  aiSessionGroups,
  aiSessionTitle,
  aiThinkingLabel,
  confirmFrame,
  formatDuration,
  nodeSatisfiesPi,
  parsePiConfirm,
  parsePiDelta,
  parsePiEvent,
  piLaunch,
  piLaunchForDisplay,
  pickAiActiveSession,
  pickAiModel,
  rememberAiInstruction,
  rememberAiSession,
  sanitizeAiApiFormat,
  sanitizeAiBaseUrl,
  sanitizeAiHistory,
  sanitizeAiModelId,
  sanitizeAiModels,
  sanitizeAiName,
  sanitizeAiPermission,
  sanitizeAiSessionId,
  sanitizeAiSessions,
  sanitizeAiSessionTitle,
  sanitizeAiThinking,
  sessionMessagesToLines,
  taskPrompt,
  visibleInstruction,
  writtenEntries,
  type AiLogLine,
  type AiSession
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

  it('挑的模型在清单里还启用着就用它，没了退回第一个启用的；一个都没启用就是空串', () => {
    const models = [
      { id: 'a', enabled: false },
      { id: 'b', enabled: true },
      { id: 'c', enabled: true }
    ]
    expect(pickAiModel(models, 'c')).toBe('c')
    // 挑的那个被关掉 / 删掉 / 从没挑过：退回第一个启用的
    expect(pickAiModel(models, 'a')).toBe('b')
    expect(pickAiModel(models, 'gone')).toBe('b')
    expect(pickAiModel(models, '')).toBe('b')
    expect(pickAiModel([{ id: 'a', enabled: false }], 'a')).toBe('')
    expect(pickAiModel([], 'a')).toBe('')
  })

  it('挑的模型 id 与清单里每一条同一条收敛（去空白、限长）', () => {
    expect(sanitizeAiModelId('  deepseek-v4.1-flash ')).toBe('deepseek-v4.1-flash')
    expect(sanitizeAiModelId('x'.repeat(200))).toHaveLength(120)
    expect(sanitizeAiModelId(42)).toBe('')
  })

  it('思考档位只认 Pi 认的那七档，认不出的回默认档（medium）', () => {
    expect(AI_THINKING_LEVELS.map((level) => level.id)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(sanitizeAiThinking('max')).toBe('max')
    expect(sanitizeAiThinking('off')).toBe('off')
    expect(sanitizeAiThinking('最高')).toBe(AI_THINKING_DEFAULT)
    expect(sanitizeAiThinking('')).toBe(AI_THINKING_DEFAULT)
    expect(sanitizeAiThinking(null)).toBe(AI_THINKING_DEFAULT)
    expect(aiThinkingLabel('xhigh')).toBe('极高')
  })

  it('用过的指令：去空白、按原文去重、去掉过长的，限 20 条', () => {
    expect(sanitizeAiHistory('x')).toEqual([])
    expect(sanitizeAiHistory([null, 42, '  ', '整理条目', ' 整理条目 ', '写周报'])).toEqual([
      '整理条目',
      '写周报'
    ])
    const long = 'x'.repeat(AI_INSTRUCTION_MAX + 1)
    expect(sanitizeAiHistory([long, '短的'])).toEqual(['短的'])
    const many = Array.from({ length: 30 }, (_, index) => `第 ${index} 条`)
    expect(sanitizeAiHistory(many)).toHaveLength(AI_HISTORY_MAX)
  })

  it('新记一条指令放在最前面；同一条再跑一次不会多出一条', () => {
    expect(rememberAiInstruction([], ' 整理条目 ')).toEqual(['整理条目'])
    expect(rememberAiInstruction(['写周报', '整理条目'], '整理条目')).toEqual(['整理条目', '写周报'])
    expect(rememberAiInstruction(['写周报'], '  ')).toEqual(['写周报'])
    // 往回填的那条也得收敛：超长的进不去（照样能跑，只是不留档）
    expect(rememberAiInstruction([], 'x'.repeat(AI_INSTRUCTION_MAX + 1))).toEqual([])
  })
})

describe('会话（一个目录里的一段连续对话）', () => {
  const session = (over: Partial<AiSession> = {}): AiSession => ({
    id: 's1',
    dir: 'E:\\work\\kb',
    title: '整理条目',
    createdAt: 1000,
    updatedAt: 2000,
    ...over
  })

  it('会话 id 按 Pi 的字符规则收敛（它拿去当 session-id）', () => {
    expect(sanitizeAiSessionId('6f5a1c2e-1111-2222-3333-444455556666')).toBe(
      '6f5a1c2e-1111-2222-3333-444455556666'
    )
    expect(sanitizeAiSessionId('  probe.1_2-3 ')).toBe('probe.1_2-3')
    // 单个字符也认（首尾同一位，Pi 的规则就是这样）
    expect(sanitizeAiSessionId('a')).toBe('a')
    // 首尾必须是字母数字（Pi 的规则）、里面不许有别的字符
    expect(sanitizeAiSessionId('-abc')).toBe('')
    expect(sanitizeAiSessionId('abc-')).toBe('')
    expect(sanitizeAiSessionId('a b')).toBe('')
    expect(sanitizeAiSessionId('中文')).toBe('')
    expect(sanitizeAiSessionId('x'.repeat(80))).toBe('')
    expect(sanitizeAiSessionId(null)).toBe('')
  })

  it('标题压成一行、限长；第一条指令就是标题', () => {
    expect(sanitizeAiSessionTitle('  整理  data/raw  下的资料  ')).toBe('整理 data/raw 下的资料')
    expect(sanitizeAiSessionTitle('第一行\n第二行')).toBe('第一行 第二行')
    expect(sanitizeAiSessionTitle('x'.repeat(200))).toHaveLength(AI_SESSION_TITLE_MAX + 1)
    expect(aiSessionTitle('把 kb/ 里过期的条目清掉')).toBe('把 kb/ 里过期的条目清掉')
  })

  it('清单收敛：认不出的丢掉、同 id 去重、目录按路径那一套收敛、限量', () => {
    const sessions = sanitizeAiSessions([
      session({ id: 'a' }),
      session({ id: 'a' }), // 重复的丢掉（留前面那条）
      session({ id: 'bad id' }), // id 不合 Pi 的规则
      session({ id: 'c', dir: '  ' }), // 没有目录的没法起进程
      { id: 'd', dir: 'E:\\x\\', createdAt: 5 }, // 老文件里可能没有 updatedAt
      'not-an-object',
      null
    ])
    expect(sessions.map((item) => item.id)).toEqual(['a', 'd'])
    // 目录与笔记 / 技能同一条收敛：去掉末尾分隔符
    expect(sessions[1].dir).toBe('E:\\x')
    expect(sessions[1].updatedAt).toBe(5)

    const many = Array.from({ length: AI_SESSION_MAX + 20 }, (_, index) =>
      session({ id: `s${index}` })
    )
    expect(sanitizeAiSessions(many)).toHaveLength(AI_SESSION_MAX)
  })

  it('记一条会话：同 id 的换到最前面（标题与时间跟着更新），超上限从末尾丢', () => {
    const list = [session({ id: 'a' }), session({ id: 'b' })]
    const updated = rememberAiSession(list, session({ id: 'b', title: '新标题', updatedAt: 3000 }))
    expect(updated.map((item) => item.id)).toEqual(['b', 'a'])
    expect(updated[0].title).toBe('新标题')
  })

  it('打开哪个会话：点过的那个还在就用它，被删了回最近说过话的，一个都没有是空串', () => {
    const list = [session({ id: 'a', updatedAt: 1000 }), session({ id: 'b', updatedAt: 5000 })]
    expect(pickAiActiveSession(list, 'a')).toBe('a')
    expect(pickAiActiveSession(list, 'gone')).toBe('b')
    expect(pickAiActiveSession(list, '')).toBe('b')
    expect(pickAiActiveSession([], 'a')).toBe('')
  })

  it('分组：按目录归拢（第一层是项目），组内与组间都按最近说过话的排', () => {
    const groups = aiSessionGroups([
      session({ id: 'kb-old', dir: 'E:\\work\\kb', updatedAt: 100 }),
      session({ id: 'kb-new', dir: 'E:\\work\\kb', updatedAt: 300 }),
      session({ id: 'app', dir: 'E:\\work\\app', updatedAt: 200 })
    ])
    // 组间：kb 这一组最新的 300 > app 的 200，所以 kb 在前
    expect(groups.map((group) => group.name)).toEqual(['kb', 'app'])
    expect(groups[0].sessions.map((item) => item.id)).toEqual(['kb-new', 'kb-old'])
    // 目录名只是显示用的：认身份的是全路径
    expect(groups[0].dir).toBe('E:\\work\\kb')
  })
})

describe('命令与提示词', () => {
  const selection = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', thinking: 'max' }
  const sessionId = '6f5a1c2e-1111-2222-3333-444455556666'

  it('内置模式用 node 直跑 cli.js，退路是全局 pi；跑的是 RPC（提示词与答复走 stdin）', () => {
    const cli = 'E:\\app\\resources\\pi\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'
    const bundled = piLaunch(cli, selection, sessionId)
    expect(bundled.program).toBe('node')
    expect(bundled.args[0]).toBe(cli)
    expect(bundled.args).toContain('--mode')
    expect(bundled.args).toContain('rpc')
    // print 模式下的那两个开关都不该在：print 是一次性输出，RPC 才能把答复写回去
    expect(bundled.args).not.toContain('--print')
    expect(bundled.args).not.toContain('json')
    // 命令不再是「一律关掉」：问不问由权限模式定（自动编辑时 Rust 追加 -e 那份扩展）
    expect(bundled.args).not.toContain('-xt')
    expect(bundled.args.join(' ')).not.toContain('bash,powershell')
    expect(bundled.args.join(' ')).not.toContain('提示词')

    const global = piLaunch(null, selection, sessionId)
    expect(global.program).toBe('pi')
    expect(global.args).toHaveLength(10)
  })

  it('会话：挂上 Pi 认的那个 session-id，且不再「跑完即弃」', () => {
    const args = piLaunch(null, selection, sessionId).args
    expect(args[args.indexOf('--session-id') + 1]).toBe(sessionId)
    // `--no-session` 是「跑完即弃」的写法：去掉它才有连续多轮与重启续聊
    expect(args).not.toContain('--no-session')
    // 落点（--session-dir）由 Rust 追加（它在应用的数据目录下），不在这串里
    expect(args).not.toContain('--session-dir')
  })

  it('用哪个模型只由 --provider / --model 说了算（Pi 不读 PI_MODEL 环境变量）', () => {
    const args = piLaunch(null, selection, sessionId).args
    expect(args[args.indexOf('--provider') + 1]).toBe('opencode-go')
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek-v4.1-flash')
    // 模型 id 按提供方的叫法原样传：带斜杠的也不拆（直启、不经 shell）
    const slashed = piLaunch(null, { provider: 'wb', model: 'moonshotai/kimi-k2.6', thinking: 'high' }, sessionId).args
    expect(slashed[slashed.indexOf('--model') + 1]).toBe('moonshotai/kimi-k2.6')
  })

  it('思考档位显式传给 Pi（--thinking），界面上挑了什么就是什么', () => {
    const args = piLaunch(null, selection, sessionId).args
    expect(args[args.indexOf('--thinking') + 1]).toBe('max')
    const off = piLaunch(null, { provider: 'wb', model: 'm', thinking: 'off' }, sessionId).args
    expect(off[off.indexOf('--thinking') + 1]).toBe('off')
  })

  it('日志那行把含空格的参数引起来（提示词与权限扩展由 Rust 追加，不在这串里）', () => {
    const shown = piLaunchForDisplay(piLaunch('E:\\has space\\cli.js', selection, sessionId))
    expect(shown).toContain('"E:\\has space\\cli.js"')
    expect(shown).not.toContain('提示词')
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

  it('Pi 那句「没找到这个 id 的会话、就用它建一份」不画（那是我们自己要的，不是故障）', () => {
    expect(
      parsePiEvent(
        "Warning: No project session found with id 'bcb75b75-899f-4f9d-a064-7327bd9fcbd6'; creating a new session with that id."
      )
    ).toBeNull()
    // 其余非 JSON 的行照旧原样留下（那是它真的在说什么）
    expect(parsePiEvent('Error: 找不到模型')).toEqual({ kind: 'info', text: 'Error: 找不到模型' })
  })

  it('流式增量：认文本增量（界面按它把回话一段段接出来），别的都不认', () => {
    expect(
      parsePiDelta(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '第一段' } }))
    ).toBe('第一段')
    // 块的开头与结尾不带新文字（整段的权威版本由 message_end 给）
    expect(
      parsePiDelta(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } }))
    ).toBeNull()
    expect(
      parsePiDelta(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '整段' } }))
    ).toBeNull()
    // 思考增量不画（与读历史那条路同一条口径）
    expect(
      parsePiDelta(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '嗯…' } }))
    ).toBeNull()
    // 空增量、别的帧、非 JSON 的行都不是增量
    expect(
      parsePiDelta(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } }))
    ).toBeNull()
    expect(parsePiDelta(JSON.stringify({ type: 'agent_settled' }))).toBeNull()
    expect(parsePiDelta('npm warn 之类的一行')).toBeNull()
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

  it('RPC 的应答：成功的不画（每一条命令都有一条，画出来全是噪音），失败的留一句', () => {
    expect(parse({ type: 'response', command: 'prompt', success: true })).toBeNull()
    expect(parse({ type: 'response', command: 'prompt', success: false, error: '会话忙不过来' })).toEqual(
      { kind: 'error', text: '会话忙不过来' }
    )
    expect(parse({ type: 'response', command: 'get_state', success: false })).toEqual({
      kind: 'error',
      text: 'get_state 没有成功'
    })
  })
})

describe('打开旧会话：历史消息 → 日志行（续聊的界面从这儿接上）', () => {
  it('认用户与助手、认工具调用；系统消息与工具结果整条丢掉', () => {
    const lines = sessionMessagesToLines([
      // 系统消息是提示词与工具清单那一堆，不是对话
      { role: 'system', content: '', sections: { cwd: '<cwd>C:\\work</cwd>' }, toolsAdded: [{ name: 'read' }] },
      { role: 'user', content: [{ type: 'text', text: '第一条：你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
      { role: 'toolResult', content: [{ type: 'text', text: '几百行文件原文…' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'read', arguments: { path: 'kb/a.md' } },
          { type: 'toolCall', name: 'write', arguments: { path: 'kb/b.md' } },
          { type: 'text', text: '读完了，写了 b.md' }
        ]
      },
      { role: 'user', content: '字符串形状的正文也要认' }
    ])

    expect(lines).toEqual([
      { kind: 'user', text: '第一条：你好' },
      { kind: 'text', text: 'pong' },
      { kind: 'tool', text: '读取 kb/a.md' },
      { kind: 'tool', text: '写入 kb/b.md' },
      { kind: 'text', text: '读完了，写了 b.md' },
      { kind: 'user', text: '字符串形状的正文也要认' }
    ])
  })

  it('认不出的形状当成没有消息（读不回历史不该把界面弄崩）', () => {
    expect(sessionMessagesToLines(null)).toEqual([])
    expect(sessionMessagesToLines({ messages: [] })).toEqual([])
    expect(sessionMessagesToLines([null, 42, { role: 'user' }, { role: 'assistant', content: [] }])).toEqual([])
  })

  it('历史里那条用户消息要剥掉提示词脚手架（气泡里只显示用户自己写的那段）', () => {
    const prompt = taskPrompt({ dir: 'E:\\work\\kb', instruction: '你好' })
    expect(visibleInstruction(prompt)).toBe('你好')

    // 没有那行就原样给（用户手写的、别处粘来的都不动）
    expect(visibleInstruction('你好')).toBe('你好')
    expect(visibleInstruction('  你好  ')).toBe('  你好  ')
    // 只剩脚手架（老数据里可能有这种）就是空串，调用方据此不画那一行
    expect(visibleInstruction(`${AI_PROMPT_PREFIX}E:\\work\\kb`)).toBe('')
  })

  it('打开旧会话：用户那条消息（完整提示词）在对话里只显示原文那一段', () => {
    const lines = sessionMessagesToLines([
      { role: 'user', content: [{ type: 'text', text: taskPrompt({ dir: 'E:\\work\\kb', instruction: '你好' }) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'pong' }] }
    ])
    expect(lines).toEqual([
      { kind: 'user', text: '你好' },
      { kind: 'text', text: 'pong' }
    ])
  })

  it('助手那段正文里的控制序列要清掉（与实时那条同一条清理）', () => {
    const lines = sessionMessagesToLines([
      { role: 'assistant', content: [{ type: 'text', text: '\u001b[31m红字\u001b[0m' }] }
    ])
    expect(lines).toEqual([{ kind: 'text', text: '红字' }])
  })
})

describe('一轮的用时怎么念（跑完在对话末尾补的那一行）', () => {
  it('10 秒以内给一位小数，再长取整；满一分钟换成「x 分 yy 秒」', () => {
    expect(formatDuration(3400)).toBe('3.4 秒')
    expect(formatDuration(980)).toBe('1.0 秒')
    expect(formatDuration(12_400)).toBe('12 秒')
    expect(formatDuration(59_600)).toBe('60 秒')
    expect(formatDuration(65_000)).toBe('1 分 05 秒')
    expect(formatDuration(3_725_000)).toBe('62 分 05 秒')
    // 时钟倒退之类的怪值不该念成负数
    expect(formatDuration(-5)).toBe('0.0 秒')
  })
})

describe('工具权限', () => {
  it('两档：自动编辑（命令先问）与完全访问（不问）；默认自动编辑', () => {
    expect(AI_PERMISSION_MODES.map((mode) => mode.id)).toEqual(['auto-edit', 'full'])
    expect(AI_PERMISSION_DEFAULT).toBe('auto-edit')
    // 每一档都得有一句说明（下拉里挂在名字下面那一行）
    expect(AI_PERMISSION_MODES.every((mode) => mode.label && mode.hint)).toBe(true)
  })

  it('收敛：认不出的（含空串、手工改坏的值）回默认档', () => {
    expect(sanitizeAiPermission('full')).toBe('full')
    expect(sanitizeAiPermission('auto-edit')).toBe('auto-edit')
    expect(sanitizeAiPermission('')).toBe(AI_PERMISSION_DEFAULT)
    expect(sanitizeAiPermission('yolo')).toBe(AI_PERMISSION_DEFAULT)
    expect(sanitizeAiPermission(undefined)).toBe(AI_PERMISSION_DEFAULT)
    expect(sanitizeAiPermission(2)).toBe(AI_PERMISSION_DEFAULT)
  })

  it('界面上那一档怎么叫：认不出的照原样给（存坏了也别显示成空白）', () => {
    expect(aiPermissionLabel('auto-edit')).toBe('自动编辑')
    expect(aiPermissionLabel('full')).toBe('完全访问')
    expect(aiPermissionLabel('yolo')).toBe('yolo')
  })
})

describe('确认帧（扩展问「这条命令让不让跑」）', () => {
  const confirm = (value: unknown): ReturnType<typeof parsePiConfirm> =>
    parsePiConfirm(JSON.stringify(value))

  it('认 confirm：id 与命令原文都带出来', () => {
    expect(
      confirm({
        type: 'extension_ui_request',
        id: 'c1',
        method: 'confirm',
        title: '执行命令前先确认',
        message: 'rm -rf build && npm run build'
      })
    ).toEqual({
      id: 'c1',
      title: '执行命令前先确认',
      message: 'rm -rf build && npm run build'
    })
  })

  it('标题缺了就用手写的这一句（列表还在，但顶上那句话不该是空的）', () => {
    expect(confirm({ type: 'extension_ui_request', id: 'c1', method: 'confirm' })?.title).toBe(
      '执行命令前先确认'
    )
  })

  it('别的 UI 方法、别的帧、不是帧的行一律不认', () => {
    expect(confirm({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: '嗨' })).toBeNull()
    expect(confirm({ type: 'extension_ui_request', id: 's1', method: 'setStatus' })).toBeNull()
    expect(confirm({ type: 'agent_settled' })).toBeNull()
    // 没有 id 就答不回去（RPC 靠它配对），当成不认
    expect(confirm({ type: 'extension_ui_request', method: 'confirm', message: 'x' })).toBeNull()
    expect(parsePiConfirm('不是 JSON')).toBeNull()
    expect(parsePiConfirm('')).toBeNull()
  })

  it('答复：一行 JSON，形状是 Pi 的 extension_ui_response', () => {
    expect(JSON.parse(confirmFrame('c1', true))).toEqual({
      type: 'extension_ui_response',
      id: 'c1',
      confirmed: true
    })
    expect(JSON.parse(confirmFrame('c1', false)).confirmed).toBe(false)
    expect(confirmFrame('c1', true)).not.toContain('\n')
  })
})
