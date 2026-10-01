import { describe, expect, it } from 'vitest'
import {
  AI_IMAGE_TYPES,
  AI_MODEL_MAX,
  AI_PERMISSION_DEFAULT,
  AI_PERMISSION_MODES,
  AI_PROMPT_PREFIX,
  AI_SKILL_COMMAND,
  AI_PROVIDER_PRESETS,
  AI_SESSION_MAX,
  AI_SESSION_TITLE_MAX,
  AI_THINKING_DEFAULT,
  AI_THINKING_LEVELS,
  aiModelChoices,
  aiModelFromId,
  aiImageAccepted,
  aiImagePayload,
  aiPermissionLabel,
  aiProviderPayload,
  aiProviderReady,
  aiSessionGroups,
  aiTurns,
  aiSessionTitle,
  aiThinkingLabel,
  aiThinkingMap,
  builtinModelMeta,
  confirmFrame,
  formatDuration,
  formatTokens,
  formatUsageSummary,
  inferModelMeta,
  nodeSatisfiesPi,
  parsePiConfirm,
  parsePiDelta,
  parsePiEvent,
  parsePiUsage,
  piLaunch,
  piLaunchForDisplay,
  pickAiActiveSession,
  pickAiChoice,
  pickAiThinking,
  rememberAiSession,
  sanitizeAiApiFormat,
  sanitizeAiBaseUrl,
  sanitizeAiContext,
  sanitizeAiLabel,
  sanitizeAiMaxTokens,
  sanitizeAiModelId,
  sanitizeAiModels,
  sanitizeAiName,
  sanitizeAiPermission,
  sanitizeAiPreset,
  sanitizeAiProviders,
  sanitizeAiSessionId,
  sanitizeAiSessions,
  sanitizeAiSessionTitle,
  sanitizeAiThinking,
  sanitizeAiThinkingLevels,
  sessionMessagesToLines,
  skillCommandOf,
  stripSkillCommand,
  taskPrompt,
  uniqueAiName,
  visibleInstruction,
  writtenEntries,
  type AiLogLine,
  type AiProvider,
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

  it('模型清单：去重保序、保留启停、补齐显示名 / 上下文 / 思考那三样、限量', () => {
    const models = sanitizeAiModels([
      { id: ' deepseek-v4.1-flash ', enabled: true },
      { id: 'mimo-v2.6-flash', enabled: false },
      { id: 'deepseek-v4.1-flash', enabled: false },
      { id: '', enabled: true },
      'not-an-object',
      null,
      // 新的两样：最大输出与「能看图」，老数据文件里没有就按「不知道 / 不能」落
      { id: 'glm-5.2', maxTokens: 384_000, imageInput: true, maxTokensBogus: 'x' }
    ])
    // 老数据文件里只有 id 与 enabled：显示名回 id、上下文 0（不知道）、不支持思考
    expect(models).toEqual([
      {
        id: 'deepseek-v4.1-flash',
        enabled: true,
        name: 'deepseek-v4.1-flash',
        contextWindow: 0,
        maxTokens: 0,
        reasoning: false,
        levels: ['off'],
        imageInput: false
      },
      {
        id: 'mimo-v2.6-flash',
        enabled: false,
        name: 'mimo-v2.6-flash',
        contextWindow: 0,
        maxTokens: 0,
        reasoning: false,
        levels: ['off'],
        imageInput: false
      },
      {
        id: 'glm-5.2',
        enabled: true,
        name: 'glm-5.2',
        contextWindow: 0,
        maxTokens: 384_000,
        reasoning: false,
        levels: ['off'],
        imageInput: true
      }
    ])

    expect(sanitizeAiModels('x')).toEqual([])
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, enabled: true }))
    expect(sanitizeAiModels(many)).toHaveLength(AI_MODEL_MAX)
  })

  it('最大输出与上下文同一条口径：非正数、认不出、离谱大都是「不知道」', () => {
    expect(sanitizeAiMaxTokens(384_000)).toBe(384_000)
    expect(sanitizeAiMaxTokens('128000')).toBe(128_000)
    expect(sanitizeAiMaxTokens(0)).toBe(0)
    expect(sanitizeAiMaxTokens(-4)).toBe(0)
    expect(sanitizeAiMaxTokens('128k')).toBe(0)
    expect(sanitizeAiMaxTokens('x')).toBe(0)
    expect(sanitizeAiMaxTokens(1e12)).toBe(20_000_000)
  })

  it('上下文只收正数（认不出的、离谱大的都当「不知道」）', () => {
    expect(sanitizeAiContext(200_000)).toBe(200_000)
    expect(sanitizeAiContext('128000')).toBe(128_000)
    expect(sanitizeAiContext(0)).toBe(0)
    expect(sanitizeAiContext(-1)).toBe(0)
    expect(sanitizeAiContext('')).toBe(0)
    expect(sanitizeAiContext(NaN)).toBe(0)
    expect(sanitizeAiContext(1e12)).toBe(20_000_000)
  })

  it('不支持思考的模型只有 off 一档；支持时默认给 off..high（xhigh / max 要显式打开）', () => {
    expect(sanitizeAiThinkingLevels([], false)).toEqual(['off'])
    expect(sanitizeAiThinkingLevels(['high', 'max'], false)).toEqual(['off'])
    expect(sanitizeAiThinkingLevels(undefined, true)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high'
    ])
    // 按档位表排序、去重、丢掉认不出的
    expect(sanitizeAiThinkingLevels(['max', 'low', 'low', '疯了'], true)).toEqual(['low', 'max'])
  })

  it('支持的档位落成 Pi 的 thinkingLevelMap：只写与它默认不一样的那几档', () => {
    // 全默认（off..high）：与 Pi 自己算出来的一模一样，一个字都不用写
    expect(
      aiThinkingMap({
        id: 'a',
        enabled: true,
        name: 'a',
        contextWindow: 0,
        maxTokens: 0,
        reasoning: true,
        levels: ['off', 'minimal', 'low', 'medium', 'high'],
        imageInput: false
      })
    ).toBeUndefined()
    // 关掉 minimal、打开 xhigh：一个 null（明说不支持）+ 一个显式打开的档位
    expect(
      aiThinkingMap({
        id: 'a',
        enabled: true,
        name: 'a',
        contextWindow: 0,
        maxTokens: 0,
        reasoning: true,
        levels: ['off', 'low', 'medium', 'high', 'xhigh'],
        imageInput: false
      })
    ).toEqual({ minimal: null, xhigh: 'xhigh' })
    // 不支持思考的模型整份都不写（Pi 只看 reasoning: false）
    expect(
      aiThinkingMap({
        id: 'a',
        enabled: true,
        name: 'a',
        contextWindow: 0,
        maxTokens: 0,
        reasoning: false,
        levels: ['off'],
        imageInput: false
      })
    ).toBeUndefined()
  })

  it('思考档位回退：挑的不支持就退默认档，默认档也不支持就退它支持的最高一档', () => {
    const base = ['off', 'minimal', 'low', 'medium', 'high']
    expect(pickAiThinking(base, 'high')).toBe('high')
    expect(pickAiThinking(base, 'max')).toBe('medium')
    expect(pickAiThinking(['off', 'low'], 'high')).toBe('low')
    expect(pickAiThinking(['off'], 'high')).toBe('off')
    expect(pickAiThinking([], 'high')).toBe('off')
  })

  it('认得出的预设与界面上那个名字', () => {
    expect(sanitizeAiPreset('deepseek')).toBe('deepseek')
    expect(sanitizeAiPreset('没这个厂商')).toBe('')
    expect(AI_PROVIDER_PRESETS.every((preset) => /^https:\/\//.test(preset.baseUrl))).toBe(true)
    expect(sanitizeAiLabel('  我的   网关 ')).toBe('我的 网关')
    expect(sanitizeAiLabel('x'.repeat(80))).toHaveLength(40)
  })

  it('服务 id 重名时排一个后缀上去（后加的不该覆盖先加的）', () => {
    expect(uniqueAiName('deepseek', [])).toBe('deepseek')
    expect(uniqueAiName('DeepSeek', ['deepseek'])).toBe('deepseek-2')
    expect(uniqueAiName('deepseek', ['deepseek', 'deepseek-2'])).toBe('deepseek-3')
  })

  it('服务清单收敛：认不出的整条丢掉、同 id 去重、限量、缺清单的不留', () => {
    const providers = sanitizeAiProviders([
      {
        id: 'DeepSeek',
        label: 'DeepSeek',
        baseUrl: ' https://api.deepseek.com/v1 ',
        apiFormat: 'openai-completions',
        preset: 'deepseek',
        models: [{ id: 'deepseek-chat' }]
      },
      { id: 'deepseek', label: '重名的', baseUrl: 'https://x', apiFormat: 'openai-completions', models: [{ id: 'a' }] },
      { id: 'no-models', baseUrl: 'https://x', apiFormat: 'openai-completions', models: [] },
      { id: 'bad-url', baseUrl: 'x', apiFormat: 'openai-completions', models: [{ id: 'a' }] },
      { id: 'bad-api', baseUrl: 'https://x', apiFormat: 'grpc', models: [{ id: 'a' }] },
      null
    ])
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe('deepseek')
    expect(providers[0].baseUrl).toBe('https://api.deepseek.com/v1')
    expect(providers[0].preset).toBe('deepseek')
    expect(providers[0].enabled).toBe(true)
    expect(providers[0].models).toHaveLength(1)

    expect(sanitizeAiProviders('x')).toEqual([])
  })

  it('默认模型：启用的服务下启用的模型才挑得到，挑的没了退回第一个', () => {
    const providers: AiProvider[] = [
      {
        id: 'a',
        label: 'A',
        baseUrl: 'https://a',
        apiFormat: 'openai-completions',
        preset: '',
        enabled: false,
        models: [{ id: 'a1', enabled: true, name: 'a1', contextWindow: 0, maxTokens: 0, reasoning: false, levels: ['off'], imageInput: false }]
      },
      {
        id: 'b',
        label: 'B',
        baseUrl: 'https://b',
        apiFormat: 'openai-completions',
        preset: '',
        enabled: true,
        models: [
          { id: 'b1', enabled: false, name: 'b1', contextWindow: 0, maxTokens: 0, reasoning: false, levels: ['off'], imageInput: false },
          { id: 'b2', enabled: true, name: 'B 二号', contextWindow: 200_000, maxTokens: 0, reasoning: true, levels: ['off', 'high'], imageInput: true }
        ]
      }
    ]
    expect(aiModelChoices(providers).map((choice) => choice.key)).toEqual(['b/b2'])
    expect(aiModelChoices(providers)[0].name).toBe('B 二号')
    const chosen = pickAiChoice(providers, 'b', 'b2')
    expect(chosen?.model).toBe('b2')
    expect(chosen?.providerLabel).toBe('B')
    expect(chosen?.contextWindow).toBe(200_000)
    // 「能不能看图」跟着清单走：贴图那道门槛读的就是它（见 AiModelChoice.imageInput）
    expect(chosen?.imageInput).toBe(true)
    // 停用的服务 / 停用的模型 / 从没挑过：一律退到第一个能挑的
    expect(pickAiChoice(providers, 'a', 'a1')?.key).toBe('b/b2')
    expect(pickAiChoice(providers, 'b', 'b1')?.key).toBe('b/b2')
    expect(pickAiChoice(providers, '', '')?.key).toBe('b/b2')

    const none = providers.map((provider) => ({ ...provider, enabled: false }))
    expect(pickAiChoice(none, '', '')).toBeNull()
  })

  it('一个服务够不够跑：名称 + Base URL + API 形态 + 至少一个启用的模型', () => {
    const base: AiProvider = {
      id: 'a',
      label: 'A',
      baseUrl: 'https://a',
      apiFormat: 'openai-completions',
      preset: '',
      enabled: true,
      models: [{ id: 'a1', enabled: true, name: 'a1', contextWindow: 0, maxTokens: 0, reasoning: false, levels: ['off'], imageInput: false }]
    }
    expect(aiProviderReady(base)).toBe(true)
    expect(aiProviderReady({ ...base, id: '' })).toBe(false)
    expect(aiProviderReady({ ...base, baseUrl: 'a' })).toBe(false)
    expect(aiProviderReady({ ...base, apiFormat: '' })).toBe(false)
    expect(aiProviderReady({ ...base, models: [] })).toBe(false)
    expect(
      aiProviderReady({ ...base, models: [{ ...base.models[0], enabled: false }] })
    ).toBe(false)
  })

  it('交给 Rust 写 models.json 的那份：停用的服务与模型都不进去，思考档位映射在这一步算好', () => {
    const providers: AiProvider[] = [
      {
        id: 'a',
        label: 'A 家',
        baseUrl: 'https://a/v1',
        apiFormat: 'openai-completions',
        preset: 'deepseek',
        enabled: true,
        models: [
          {
            id: 'a1',
            enabled: true,
            name: 'A 一号',
            contextWindow: 128_000,
            maxTokens: 32_768,
            reasoning: true,
            levels: ['off', 'low', 'medium', 'high', 'xhigh'],
            imageInput: true
          },
          {
            id: 'a2',
            enabled: false,
            name: 'a2',
            contextWindow: 0,
            maxTokens: 0,
            reasoning: false,
            levels: ['off'],
            imageInput: false
          }
        ]
      },
      {
        id: 'b',
        label: 'B 家',
        baseUrl: 'https://b/v1',
        apiFormat: 'anthropic-messages',
        preset: '',
        enabled: false,
        models: [
          { id: 'b1', enabled: true, name: 'b1', contextWindow: 0, maxTokens: 0, reasoning: false, levels: ['off'], imageInput: false }
        ]
      },
      // 清单空的服务（不该进 models.json：Pi 那边会当成一个有凭据但没模型的端点）
      {
        id: 'c',
        label: 'C',
        baseUrl: 'https://c/v1',
        apiFormat: 'openai-completions',
        preset: '',
        enabled: true,
        models: []
      }
    ]

    expect(aiProviderPayload(providers)).toEqual([
      {
        id: 'a',
        name: 'A 家',
        baseUrl: 'https://a/v1',
        api: 'openai-completions',
        models: [
          {
            id: 'a1',
            name: 'A 一号',
            contextWindow: 128_000,
            maxTokens: 32_768,
            reasoning: true,
            thinkingLevelMap: { minimal: null, xhigh: 'xhigh' },
            // 能看图：发的是 Rust 认的 imageInput（它再落成 Pi 的 input: ["text","image"]）
            imageInput: true
          }
        ]
      }
    ])
    expect(aiProviderPayload([])).toEqual([])
  })

  it('自动认上下文与思考：只认写法确定的家族，认不出留空', () => {
    expect(inferModelMeta('claude-sonnet-5')).toEqual({ contextWindow: 200_000, reasoning: true })
    expect(inferModelMeta('gpt-4o-mini')).toEqual({ contextWindow: 128_000, reasoning: false })
    expect(inferModelMeta('deepseek-reasoner')).toEqual({ contextWindow: 128_000, reasoning: true })
    expect(inferModelMeta('glm-4.5-air')).toEqual({ contextWindow: 128_000, reasoning: true })
    expect(inferModelMeta('glm-4-air')).toEqual({ contextWindow: 128_000, reasoning: false })
    expect(inferModelMeta('kimi-k2-thinking')).toEqual({ contextWindow: 256_000, reasoning: true })
    expect(inferModelMeta('moonshot-v1-32k')).toEqual({ contextWindow: 32_768, reasoning: false })
    expect(inferModelMeta('某个没听过的模型')).toEqual({ contextWindow: 0, reasoning: false })
  })

  it('内置目录：指定厂商优先，其次任意厂商，再认「厂商/模型」后缀；认不出回 null', () => {
    // deepseek-v4.1-flash 在好几家目录里都有：指定 opencode-go 就认它那份
    expect(builtinModelMeta('deepseek-v4.1-flash', 'opencode-go')).toEqual({
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true,
      imageInput: true
    })
    // 不指定厂商也认得出（按厂商名排序取第一个，结果稳定），大小写不敏感
    expect(builtinModelMeta('DeepSeek-V4.1-Flash')?.imageInput).toBe(true)
    // 目录里是「厂商/模型」前缀键、端点报的是裸 id：认后缀
    const prefixed = builtinModelMeta('deepseek/deepseek-v4.1-flash')
    expect(prefixed).not.toBeNull()
    // 手工填大写也一样认
    expect(builtinModelMeta('  GLM-5.2  ', 'zai')?.contextWindow).toBe(1_000_000)
    expect(builtinModelMeta('某个没听过的模型')).toBeNull()
    expect(builtinModelMeta('')).toBeNull()
  })

  it('预填四层：端点报了的优先，其次内置目录（含图片能力），再次按名字认', () => {
    // 端点没报的 deepseek-v4.1-flash：从内置目录把 1M / 384K / 思考 / 图片整个认出来
    expect(aiModelFromId('deepseek-v4.1-flash', {}, 'opencode-go')).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true,
      imageInput: true
    })
    // 端点报了就以端点为准（目录让位）
    expect(aiModelFromId('没听过的', { contextWindow: 65_536, reasoning: true })).toMatchObject({
      id: '没听过的',
      enabled: true,
      contextWindow: 65_536,
      maxTokens: 0,
      reasoning: true,
      levels: ['off', 'minimal', 'low', 'medium', 'high'],
      imageInput: false
    })
    expect(
      aiModelFromId('没听过的', { contextWindow: 65_536, reasoning: true }, 'opencode-go')
    ).toMatchObject({ contextWindow: 65_536, maxTokens: 0 })
    // 目录里没有的才轮到按名字认（moonshot-v1-32k 只在名字表里）
    expect(aiModelFromId('moonshot-v1-32k')).toMatchObject({
      contextWindow: 32_768,
      maxTokens: 0,
      reasoning: false,
      imageInput: false
    })
    // 用户明确关掉的图片不被迫开（extra 只会传 true，这里防的是「目录说了算」盖过清单）
    expect(aiModelFromId('glm-5.2', {}, 'zai')).toMatchObject({
      contextWindow: 1_000_000,
      reasoning: true,
      imageInput: false
    })
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

  it('会话自带的配置认得出才记：模型 / 档位 / 权限，坏值不写字段', () => {
    const [kept] = sanitizeAiSessions([
      session({
        id: 'a',
        provider: 'OpenCode-Go',
        model: '  deepseek-v4.1-chat  ',
        thinking: 'high',
        permission: 'full'
      })
    ])
    // 服务名折成小写连字符；模型 id 只去空白限长，原样保留
    expect(kept?.provider).toBe('opencode-go')
    expect(kept?.model).toBe('deepseek-v4.1-chat')
    expect(kept?.thinking).toBe('high')
    expect(kept?.permission).toBe('full')

    const [dropped] = sanitizeAiSessions([
      session({ id: 'b', provider: '坏 名 字!', model: '   ', thinking: '最大', permission: '全部' })
    ])
    expect(dropped?.provider).toBeUndefined()
    expect(dropped?.model).toBeUndefined()
    expect(dropped?.thinking).toBeUndefined()
    expect(dropped?.permission).toBeUndefined()

    // 老文件里没有这些字段，原样有效
    const [legacy] = sanitizeAiSessions([session({ id: 'c' })])
    expect(legacy?.provider).toBeUndefined()
    expect(legacy?.thinking).toBeUndefined()
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

describe('对话按轮切（过程 / 答案 / 收据）', () => {
  const line = (kind: AiLogLine['kind'], text: string): AiLogLine => ({ kind, text })

  it('一条都没有就是空的', () => {
    expect(aiTurns([])).toEqual([])
  })

  it('一轮 = 用户那句 + 过程 + 最后那段正文 + 收据：过程把思考、工具、报错、中途旁白都收了', () => {
    const turns = aiTurns([
      line('user', '把资料整理一下'),
      line('info', '在 agent 里工作'),
      line('thinking', '先看目录'),
      line('tool', '读取 kb/a.md'),
      line('text', '我先看看目录里有什么。'),
      line('error', 'read: EISDIR'),
      line('thinking', '换个工具'),
      line('tool', '读取 kb/b.md'),
      line('text', '整理好了，共 3 条。'),
      line('duration', '用时 12 秒')
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0].index).toBe(0)
    expect(turns[0].user?.text).toBe('把资料整理一下')
    // 答案只有最后那段；前面那段正文是过程中的旁白
    expect(turns[0].answer?.text).toBe('整理好了，共 3 条。')
    expect(turns[0].process.map((item) => item.kind)).toEqual([
      'info',
      'thinking',
      'tool',
      'text',
      'error',
      'thinking',
      'tool'
    ])
    // 「用时 …」留在答案外面（它是一轮的句号）
    expect(turns[0].tail.map((item) => item.text)).toEqual(['用时 12 秒'])
  })

  it('没说过话的那一轮（停了一半 / 只读回历史）：整个过程都收着，没有答案', () => {
    const turns = aiTurns([line('thinking', '嗯'), line('tool', '调用 bash')])
    expect(turns).toHaveLength(1)
    expect(turns[0].user).toBeNull()
    expect(turns[0].answer).toBeNull()
    expect(turns[0].process).toHaveLength(2)
    expect(turns[0].tail).toEqual([])
  })

  it('一句一轮：第二句开新的一轮（index 是那一轮第一行的下标，展开态跟着它稳定）', () => {
    const turns = aiTurns([
      line('user', '第一句'),
      line('thinking', '想'),
      line('text', '答一'),
      line('user', '第二句'),
      line('text', '答二')
    ])
    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.index)).toEqual([0, 3])
    expect(turns.map((turn) => turn.user?.text)).toEqual(['第一句', '第二句'])
    expect(turns[0].process.map((item) => item.text)).toEqual(['想'])
    expect(turns[1].process).toEqual([])
    expect(turns[1].answer?.text).toBe('答二')
  })

  it('正文后面跟了工具 / 思考（这轮没跑成，没有再吐正文）：那段正文是旁白，回过程里按序排', () => {
    const turns = aiTurns([
      line('user', '生成脚本'),
      line('thinking', '先分块'),
      line('text', '脚本较长，我分块写入再合并。'),
      line('tool', '写入 c1.js'),
      line('thinking', 'Now chunk2'),
      line('error', '写入失败'),
      line('duration', '用时 30 秒')
    ])
    // 没有答案可摘 ——「最后说了什么」得是后面没再干活的那段正文
    expect(turns[0].answer).toBeNull()
    expect(turns[0].process.map((item) => item.text)).toEqual([
      '先分块',
      '脚本较长，我分块写入再合并。',
      '写入 c1.js',
      'Now chunk2',
      '写入失败'
    ])
    // 收据只有轮尾那串「用时 …」，报错留在过程里（红才丢不了）
    expect(turns[0].tail.map((item) => item.text)).toEqual(['用时 30 秒'])
  })

  it('跑动中（live）不摘答案：整轮都在过程里按时序长，正文落地也不跳出去', () => {
    const turns = aiTurns(
      [
        line('user', '生成脚本'),
        line('thinking', '想'),
        line('text', '我先分块写入。'),
        line('tool', '写入 c1.js')
      ],
      true
    )
    expect(turns[0].answer).toBeNull()
    expect(turns[0].process.map((item) => item.kind)).toEqual(['thinking', 'text', 'tool'])
    expect(turns[0].tail).toEqual([])
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

  it('工具失败的原因从 result 里取（Pi 的事件没有 error 字段）', () => {
    // 这个事件的形状是 { toolCallId, toolName, result, isError }：原文在 result.content[].text 里
    expect(
      parse({
        type: 'tool_execution_end',
        toolName: 'read',
        isError: true,
        result: { content: [{ type: 'text', text: 'EISDIR: illegal operation on a directory, read' }] }
      })
    ).toEqual({ kind: 'error', text: 'read：EISDIR: illegal operation on a directory, read' })

    // 多行原文（「找不到 bash」那种还带一串搜索路径）：窄行只留第一句，全文收进悬停的 detail
    expect(
      parse({
        type: 'tool_execution_end',
        toolName: 'bash',
        isError: true,
        result: {
          content: [
            {
              type: 'text',
              text: 'No bash shell found. Options:\n  1. Install Git for Windows\n  D:\\Git\\bin\\bash.exe'
            }
          ]
        }
      })
    ).toEqual({
      kind: 'error',
      text: 'bash：No bash shell found. Options:',
      detail: 'No bash shell found. Options:\n  1. Install Git for Windows\n  D:\\Git\\bin\\bash.exe'
    })

    // 只看 result 里的 isError 也算失败（扩展能改这一层）；成功的结果照旧不画
    expect(
      parse({
        type: 'tool_execution_end',
        toolName: 'bash',
        result: { content: '没跑起来', isError: true }
      })
    ).toEqual({ kind: 'error', text: 'bash：没跑起来' })
    expect(
      parse({
        type: 'tool_execution_end',
        toolName: 'read',
        result: { content: [{ type: 'text', text: '文件正文' }] }
      })
    ).toBeNull()

    // 失败但结果里一个字都没有：兜底文案还在
    expect(
      parse({ type: 'tool_execution_end', toolName: 'bash', isError: true, result: { content: [] } })
    ).toEqual({ kind: 'error', text: 'bash：工具调用失败' })
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

  it('流式增量：正文、思考、以及一段思考的结束（三种），别的都不认', () => {
    const delta = (event: unknown) =>
      parsePiDelta(JSON.stringify({ type: 'message_update', assistantMessageEvent: event }))

    expect(delta({ type: 'text_delta', contentIndex: 0, delta: '第一段' })).toEqual({
      kind: 'text',
      text: '第一段'
    })
    // 思考增量画在末尾那块「思考中…」里（草稿也要看得见）
    expect(delta({ type: 'thinking_delta', contentIndex: 0, delta: '嗯…' })).toEqual({
      kind: 'thinking',
      text: '嗯…'
    })
    // 一段思考结束：整块的权威内容跟着它到（界面到这儿把它收成一块「思考过程」）
    expect(delta({ type: 'thinking_end', contentIndex: 0, content: '想完了\n两行' })).toEqual({
      kind: 'thinkingEnd',
      text: '想完了\n两行'
    })
    // 被厂商脱敏过的块一个字都没有：也要报一声（调用方靠它把「正在思考」收掉）
    expect(delta({ type: 'thinking_end', contentIndex: 0, content: '' })).toEqual({
      kind: 'thinkingEnd',
      text: ''
    })

    // 正文块的开头与结尾不带新文字（整段的权威版本由 message_end 给）
    expect(delta({ type: 'text_start', contentIndex: 0 })).toBeNull()
    expect(delta({ type: 'text_end', contentIndex: 0, content: '整段' })).toBeNull()
    // 空增量、别的帧、非 JSON 的行都不是增量
    expect(delta({ type: 'text_delta', delta: '' })).toBeNull()
    expect(parsePiDelta(JSON.stringify({ type: 'agent_settled' }))).toBeNull()
    expect(parsePiDelta('npm warn 之类的一行')).toBeNull()
  })

  it('token 消耗：message_end 带的 usage 拆成四个不重叠的桶，别的帧与没报的都不认', () => {
    const usage = (event: unknown) => parsePiUsage(JSON.stringify(event))

    expect(
      usage({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          usage: { input: 12, output: 34, cacheRead: 56, cacheWrite: 7, totalTokens: 109, cost: {} }
        }
      })
    ).toEqual({ input: 12, output: 34, cacheRead: 56, cacheWrite: 7 })
    // @文件 的回显是用户消息，没有消耗
    expect(
      usage({
        type: 'message_end',
        message: { role: 'user', content: '整段提示词', usage: { input: 9, output: 9 } }
      })
    ).toBeNull()
    // 端点没报（缺字段 / 全 0 / 形状不对）：当没有 —— 收据上就不写这段
    expect(usage({ type: 'message_end', message: { role: 'assistant', content: [] } })).toBeNull()
    expect(
      usage({
        type: 'message_end',
        message: { role: 'assistant', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      })
    ).toBeNull()
    expect(
      usage({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: -5, output: 'x' } } })
    ).toBeNull()
    expect(usage({ type: 'agent_settled' })).toBeNull()
    expect(parsePiUsage('npm warn 之类的一行')).toBeNull()
  })

  it('token 数的念法与这一轮的消耗摘要（输入含缓存读写，输出单列）', () => {
    expect(formatTokens(876)).toBe('876')
    expect(formatTokens(1534)).toBe('1.5k')
    expect(formatTokens(45_200)).toBe('45k')
    expect(formatTokens(1_234_567)).toBe('1.2m')

    expect(
      formatUsageSummary({ input: 1000, output: 1534, cacheRead: 56_000, cacheWrite: 6_000 })
    ).toBe('输入 63k · 输出 1.5k')
    // 端点没报：空串 —— 收据上只有「用时」
    expect(formatUsageSummary({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe('')
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
  it('认用户与助手、认工具调用与思考块；系统消息丢掉，没失败的工具结果也丢掉', () => {
    const lines = sessionMessagesToLines([
      // 系统消息是提示词与工具清单那一堆，不是对话
      { role: 'system', content: '', sections: { cwd: '<cwd>C:\\work</cwd>' }, toolsAdded: [{ name: 'read' }] },
      { role: 'user', content: [{ type: 'text', text: '第一条：你好' }] },
      {
        role: 'assistant',
        content: [
          // 想的那一段：界面上是一块收着的「思考过程」
          { type: 'thinking', thinking: '先看看目录里有啥', thinkingSignature: 'opaque' },
          { type: 'text', text: 'pong' }
        ]
      },
      { role: 'toolResult', content: [{ type: 'text', text: '几百行文件原文…' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', name: 'read', arguments: { path: 'kb/a.md' } },
          { type: 'toolCall', name: 'write', arguments: { path: 'kb/b.md' } },
          { type: 'text', text: '读完了，写了 b.md' }
        ]
      },
      // 被厂商脱敏过的思考块一个字都没有：不画
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', redacted: true }] },
      { role: 'user', content: '字符串形状的正文也要认' }
    ])

    expect(lines).toEqual([
      { kind: 'user', text: '第一条：你好' },
      { kind: 'thinking', text: '先看看目录里有啥' },
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

  it('失败的工具结果在历史里也留一行（成功的原文照旧丢掉，与实时那条同一句话）', () => {
    const lines = sessionMessagesToLines([
      { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] },
      {
        role: 'toolResult',
        toolName: 'bash',
        isError: true,
        // 落盘的那一份形状：原文在 content 里、isError 长在消息上（句级没有这个字段）
        content: [{ type: 'text', text: 'No bash shell found. Options:\n  1. Install Git for Windows' }]
      }
    ])
    expect(lines).toEqual([
      { kind: 'tool', text: '调用 bash' },
      {
        kind: 'error',
        text: 'bash：No bash shell found. Options:',
        detail: 'No bash shell found. Options:\n  1. Install Git for Windows'
      }
    ])
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

  it('显式调起技能：命令挪到最前面（Pi 只在开头认它），脚手架退到参数位', () => {
    const prompt = taskPrompt({ dir: 'E:\\work', instruction: '/skill:charts 画个折线图' })
    expect(prompt).toBe('/skill:charts 你在下面这个目录里工作：E:\\work\n\n画个折线图')
    // 命令后面没写字也一样成立（命令仍在最前，脚手架在它的参数位）
    expect(taskPrompt({ dir: 'E:\\work', instruction: '/skill:charts' })).toBe(
      '/skill:charts 你在下面这个目录里工作：E:\\work'
    )
    // 命令不在开头的写法不动它，照老样子拼（Pi 也不认，模型看到的还是原文）
    expect(taskPrompt({ dir: 'E:\\work', instruction: '看看 /skill:charts' })).toBe(
      '你在下面这个目录里工作：E:\\work\n\n看看 /skill:charts'
    )
  })

  it('技能命令的解析与剥离', () => {
    expect(skillCommandOf('/skill:charts 画图')).toBe('charts')
    expect(skillCommandOf('  /skill:通用图表生成器 画图')).toBe('通用图表生成器')
    expect(skillCommandOf('/skill:charts')).toBe('charts')
    expect(skillCommandOf('/skill:')).toBe('')
    expect(skillCommandOf('画图 /skill:charts')).toBe('')

    expect(stripSkillCommand('/skill:charts 画图')).toBe('画图')
    expect(stripSkillCommand('/skill:charts')).toBe('')
    expect(stripSkillCommand('  /skill:charts   画图')).toBe('画图')
    expect(stripSkillCommand('画图')).toBe('画图')
  })

  it('气泡里那条技能消息：留着技能名、去掉脚手架，来回一趟还是原样', () => {
    const prompt = taskPrompt({ dir: 'E:\\work', instruction: '/skill:charts 画个折线图' })
    expect(visibleInstruction(prompt)).toBe('/skill:charts 画个折线图')
    // 只调了技能、没写别的
    expect(visibleInstruction(taskPrompt({ dir: 'E:\\work', instruction: '/skill:charts' }))).toBe(
      '/skill:charts'
    )
    // 会话标题要的是「在聊什么」：命令让给气泡，不进标题
    expect(aiSessionTitle('/skill:charts 画个折线图')).toBe('画个折线图')
    expect(aiSessionTitle('/skill:charts')).toBe('/skill:charts')
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

  it('用户那句里贴的图：落盘的是 base64，界面上换回数据 URL（只有图没有字的那句也画）', () => {
    const lines = sessionMessagesToLines([
      {
        role: 'user',
        content: [
          { type: 'text', text: '这两张哪里不一样？' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
          // 少一半的（data 或 mimeType 缺一个）不是一张能画的图，丢掉
          { type: 'image', data: '', mimeType: 'image/png' }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: taskPrompt({ dir: 'E:\\work', instruction: '' }) },
          { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }
        ]
      }
    ])

    expect(lines).toEqual([
      {
        kind: 'user',
        text: '这两张哪里不一样？',
        images: ['data:image/png;base64,iVBORw0KGgo=']
      },
      // 提示词那行脚手架照剥；剥完没有字，但图在，所以这条还在
      { kind: 'user', text: '', images: ['data:image/jpeg;base64,AAAA'] }
    ])
  })
})

describe('贴在输入框里的图（随这一句发出去）', () => {
  it('只收 png / jpeg / webp / gif 这四种（Pi 能直接内联给模型的那几种）', () => {
    expect(AI_IMAGE_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    expect(aiImageAccepted('image/png')).toBe(true)
    expect(aiImageAccepted('IMAGE/JPEG')).toBe(true)
    // 带参数的 mime（浏览器有时这么报）认前半段
    expect(aiImageAccepted('image/png;charset=utf-8')).toBe(true)
    expect(aiImageAccepted('image/bmp')).toBe(false)
    expect(aiImageAccepted('image/svg+xml')).toBe(false)
    expect(aiImageAccepted('')).toBe(false)
  })

  it('数据 URL → Pi 的 {data, mimeType}：取逗号后面那一段，认不出的丢掉', () => {
    expect(
      aiImagePayload([
        { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' },
        { dataUrl: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg' },
        // 不是数据 URL 的、逗号后面空着的、类型空着的：一律不发（发过去它解析不了）
        { dataUrl: 'http://example.com/a.png', mimeType: 'image/png' },
        { dataUrl: 'data:image/png;base64,', mimeType: 'image/png' },
        { dataUrl: 'data:image/png;base64,AAAA', mimeType: '' }
      ])
    ).toEqual([
      { data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { data: 'AAAA', mimeType: 'image/jpeg' }
    ])
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
