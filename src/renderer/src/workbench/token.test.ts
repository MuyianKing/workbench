/**
 * Token 适配层：本机实读 + 本机分片 + 多机合并。
 *
 * 盯的是「多算一遍 / 少算一台」这两类不会报错、只看数字的错误：
 *  - 仓库里那份**自己**上次推上去的分片被当成别人的，本机用量被计两遍；
 *  - 别人的分片根本没读进来（同步分支挑错就是这个症状，见 sync.rs 的 sync_branch）。
 *
 * 跑在 node 环境里，没有 window，所以在导入前先补一个假的 Tauri 桥：
 * 按命令名回不同的桩数据，`token_sync_publish` 顺手把「仓库」里的分片更新一下。
 * 模块级的同步节流状态要清干净，所以每条用例都用 `vi.resetModules()` 重新导入一次适配层。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** 用例里的同步仓库地址（桩数据按它分仓库存放分片） */
const REPO = 'git@example.com:me/sync.git'

interface UsageRow {
  day: string
  model: string
  input: number
  cacheRead: number
  requests: number
}

let localFile: unknown = null
/** 假装成远端仓库：按仓库地址分开装各台机器推上来的分片 */
let remotes: Record<string, unknown[]> = {}
let published: Array<Record<string, unknown>> = []
let failPublish = false
let rows: UsageRow[] = []
/** CodeBuddy：`token_codebuddy_files` 回的清单，以及按路径取内容的桩文件 */
let codebuddy: { found: boolean; files: Array<{ path: string; mtimeMs: number; size: number }> } = {
  found: false,
  files: []
}
let codebuddyText: Record<string, string> = {}
let textReads: string[] = []
/** DSH：`token_dsh_sessions` 回的清单，以及按路径「解压」出来的文本 */
let dsh: { found: boolean; sessions: Array<{ path: string; mtimeMs: number; size: number }> } = {
  found: false,
  sessions: []
}
let dshFrames: Record<string, string> = {}
let dshDecodes: string[] = []
/** WorkBuddy：`token_workbuddy_sessions` 回的清单，以及按路径取内容的桩会话正文 */
let workbuddy: { found: boolean; sessions: Array<{ path: string; mtimeMs: number; size: number }> } = {
  found: false,
  sessions: []
}
let workbuddyText: Record<string, string> = {}

/** 今天（本地时区）——快照只保留最近一年，用例里的日期必须落在窗口内 */
function today(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function shard(device: string, input: number, day = today()): Record<string, unknown> {
  return {
    version: 4,
    device,
    name: device,
    updatedAt: 1,
    sources: { zcode: { days: { [day]: { 'glm-5': { inputTokens: input, requests: 1 } } } } }
  }
}

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        switch (command) {
          case 'token_device':
            return Promise.resolve({ id: 'dev-local', name: '本机' })
          case 'token_load':
            return Promise.resolve(localFile)
          case 'token_save':
            localFile = args?.value
            return Promise.resolve(null)
          case 'token_zcode_rows':
            return Promise.resolve(rows)
          case 'token_codebuddy_files':
            return Promise.resolve(codebuddy)
          case 'fs_read_text': {
            const path = String((args as { path?: unknown })?.path ?? '')
            textReads.push(path)
            // CodeBuddy 与 WorkBuddy 都是「列清单 + 自己读文件」，共用一个读取桩
            const text = workbuddyText[path] ?? codebuddyText[path]
            if (typeof text !== 'string') return Promise.reject('文件读不了')
            return Promise.resolve(text)
          }
          case 'token_dsh_sessions':
            return Promise.resolve(dsh)
          case 'token_workbuddy_sessions':
            return Promise.resolve(workbuddy)
          case 'token_zstd_decode': {
            const path = String((args as { path?: unknown })?.path ?? '')
            dshDecodes.push(path)
            if (!(path in dshFrames)) return Promise.reject('会话文件坏了')
            return Promise.resolve(dshFrames[path])
          }
          case 'token_sync_publish': {
            if (failPublish) return Promise.reject('仓库推不上去')
            published.push(args ?? {})
            const repo = String(args?.repo ?? '')
            // 仓库里自己的那份被覆盖，别人那份原样留着
            const current = remotes[repo] ?? []
            remotes[repo] = [
              ...current.filter((item) => (item as { device?: string }).device !== args?.device),
              args?.shard
            ]
            return Promise.resolve({ changed: true, pushed: true, log: '' })
          }
          case 'token_sync_shards': {
            // 克隆目录是唯一的：读的就是「当前这个仓库」的分片。换仓库时 Rust 会重新克隆，
            // 所以这里按最后一次 publish 用的地址来回答。
            const repo = String(published.at(-1)?.repo ?? '')
            return Promise.resolve(remotes[repo] ?? [])
          }
          default:
            return Promise.reject(new Error(`用例没打桩的命令: ${command}`))
        }
      }
    }
  }
})

beforeEach(() => {
  localFile = null
  remotes = {}
  published = []
  failPublish = false
  rows = []
  codebuddy = { found: false, files: [] }
  codebuddyText = {}
  textReads = []
  dsh = { found: false, sessions: [] }
  dshFrames = {}
  dshDecodes = []
  workbuddy = { found: false, sessions: [] }
  workbuddyText = {}
})

/** 一条真实形状的扩展日志：模型 → 请求 → 用量 三行，靠 traceId / requestId 串起来 */
function codebuddyLog(day: string, model: string, input: number, cache: number): string {
  const trace = 'abc12345'
  const request = 'deadbeef'
  return [
    `${day} 16:44:19.123 [CraftInvokableAgent] [${trace}] Preparing model: ${model} preview (${model})`,
    `${day} 16:44:20.456 [AgentReporter] [${trace}] onAgentStart: run requestId=${request}`,
    `${day} 16:44:25.789 [BaseAgent:x] [${request}] notifyStepEnd, requestId: ${request}, usage: {"inputTokens":${input},"outputTokens":10,"cacheTokens":${cache},"thinkingTokens":5,"cachedWriteTokens":2}`
  ].join('\n')
}

/** 挂上一个扩展日志文件，并返回它进清单的那一项 */
function addCodebuddyFile(name: string, text: string, mtimeMs = Date.now()): {
  path: string
  mtimeMs: number
  size: number
} {
  const item = { path: `C:\\logs\\${name}`, mtimeMs, size: text.length }
  codebuddy = { found: true, files: [...codebuddy.files, item] }
  codebuddyText[item.path] = text
  return item
}

/** 一条真实形状的 DSH 事件流：先声明模型，再来一条带 usage 的 assistant 消息 */
function dshSession(
  model = 'deepseek-flash',
  usage: Record<string, number> = { inputTokens: 161, outputTokens: 892, cacheReadTokens: 29696 },
  at = Date.now()
): string {
  return [
    JSON.stringify({ type: 'request/header', seq: 15, time: at, data: { header: { config: { model } } } }),
    JSON.stringify({ type: 'assistant/message', seq: 19, time: at, data: { turn: 1, step: 1, usage } })
  ].join('\n')
}

/** 挂上一个会话文件，并返回它进清单的那一项 */
function addDshSession(name: string, text: string, mtimeMs = Date.now()): {
  path: string
  mtimeMs: number
  size: number
} {
  const item = { path: `C:\\.dsh\\${name}`, mtimeMs, size: text.length }
  dsh = { found: true, sessions: [...dsh.sessions, item] }
  dshFrames[item.path] = text
  return item
}

/** 一条真实形状的 WorkBuddy 会话正文：一行一次模型调用，自带时间、模型与用量 */
function workbuddySession(
  model = 'hy3',
  usage: Record<string, unknown> = {
    requests: 1,
    inputTokens: 36775,
    outputTokens: 280,
    totalTokens: 37055,
    inputTokensDetails: [{ cached_tokens: 3520 }],
    outputTokensDetails: [{ reasoning_tokens: 243 }]
  },
  at = Date.now()
): string {
  return JSON.stringify({
    id: 'cafebabe1234',
    timestamp: at,
    type: 'function_call',
    providerData: { model, usage }
  })
}

/** 挂上一个会话正文，并返回它进清单的那一项 */
function addWorkbuddySession(name: string, text: string, mtimeMs = Date.now()): {
  path: string
  mtimeMs: number
  size: number
} {
  const item = { path: `C:\\.workbuddy\\${name}`, mtimeMs, size: text.length }
  workbuddy = { found: true, sessions: [...workbuddy.sessions, item] }
  workbuddyText[item.path] = text
  return item
}

/** 重新导入适配层：模块级的同步节流状态（lastSyncAt / remoteShards）必须归零 */
function freshToken(): Promise<typeof import('./token')> {
  vi.resetModules()
  return import('./token')
}

/** 取某天的某个模型的输入量 */
function inputOn(result: Awaited<ReturnType<typeof import('./token').getTokenUsage>>, day = today()): number {
  return result.data.sources.zcode?.days[day]?.['glm-5']?.inputTokens ?? -1
}

describe('多机合并', () => {
  it('仓库里自己的那份分片不算别人的，本机用量不会计两遍', async () => {
    const day = today()
    // 本机上一轮已经推过一次（内容还是旧的），另一端有一台机器推了自己的
    localFile = {
      version: 3,
      updatedAt: 0,
      sources: { zcode: { days: { [day]: { 'glm-5': { inputTokens: 10, requests: 1 } } } } }
    }
    // 仓库里先放着：自己上一轮推的旧副本 + 另一台机器推的
    remotes[REPO] = [shard('dev-local', 10, day), shard('dev-b', 5, day)]
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: REPO })

    // 10(本机) + 5(另一端)；把仓库里自己那份也算进来就会变成 25
    expect(inputOn(result)).toBe(15)
    expect(result.sync.devices.map((item) => item.id)).toEqual(['dev-b'])
    expect(result.sync.enabled).toBe(true)
    expect(result.sync.error).toBe('')
  })

  it('v3 老快照升级成带设备信息的分片，历史不丢', async () => {
    const day = today()
    localFile = {
      version: 3,
      updatedAt: 5,
      sources: { zcode: { days: { [day]: { 'glm-5': { inputTokens: 10, requests: 1 } } } } }
    }
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    await token.getTokenUsage({ repo: '' })

    const saved = localFile as { version: number; device: string; name: string }
    expect(saved.version).toBe(4)
    expect(saved.device).toBe('dev-local')
    expect(saved.name).toBe('本机')
  })

  it('没开同步就只看本机那份，别的设备不参与', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    remotes[REPO] = [shard('dev-b', 5, day)]
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    expect(inputOn(result)).toBe(10)
    expect(result.sync.enabled).toBe(false)
    expect(result.sync.devices).toEqual([])
    expect(published).toHaveLength(0)
  })
})

describe('CodeBuddy(扩展日志)', () => {
  /** 取某天的模型输入量（CodeBuddy 的 inputTokens 是「减去缓存读取」之后的） */
  function codebuddyOf(
    result: Awaited<ReturnType<typeof import('./token').getTokenUsage>>,
    model: string,
    day = today()
  ): number {
    return result.data.sources.codebuddy?.days[day]?.[model]?.inputTokens ?? -1
  }

  it('日志里的逐步用量会算进 codebuddy 这个来源', async () => {
    const day = today()
    addCodebuddyFile('腾讯云代码助手.log', codebuddyLog(day, 'hy4-preview', 100, 40))

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    // 100 里含 40 的缓存读取，落盘时只记未命中的那部分（与 ZCode 同一口径）
    expect(codebuddyOf(result, 'hy4-preview')).toBe(60)
    const counters = result.data.sources.codebuddy.days[day]['hy4-preview']
    expect(counters.cacheReadTokens).toBe(40)
    expect(counters.outputTokens).toBe(10)
    expect(counters.reasoningTokens).toBe(5)
    expect(counters.requests).toBe(1)
    expect(result.sourceErrors.codebuddy).toBeUndefined()
  })

  it('没装 CodeBuddy 就安静跳过：不算读取失败，也不留空来源', async () => {
    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    expect(result.data.sources.codebuddy).toBeUndefined()
    expect(result.sourceErrors.codebuddy).toBeUndefined()
  })

  it('日志没变化就不重读重解析（签名一致）', async () => {
    const day = today()
    addCodebuddyFile('a.log', codebuddyLog(day, 'hy4-preview', 100, 40))

    const token = await freshToken()
    await token.getTokenUsage({ repo: '' })
    expect(textReads).toHaveLength(1)

    // 每分钟一次的轮询：清单一样就不该再去读那几兆的日志
    await token.getTokenUsage({ repo: '' })
    expect(textReads).toHaveLength(1)
    expect(codebuddyOf(await token.getTokenUsage({ repo: '' }), 'hy4-preview')).toBe(60)
  })

  it('日志变了就整批重读（解析状态跨文件，不能只补新文件）', async () => {
    const day = today()
    const first = addCodebuddyFile('a.log', codebuddyLog(day, 'hy4-preview', 100, 40))
    addCodebuddyFile('b.log', codebuddyLog(day, 'hy4-preview', 20, 0))

    const token = await freshToken()
    await token.getTokenUsage({ repo: '' })
    expect(textReads).toHaveLength(2)

    // a.log 追加了一段（文件变大）——真实场景就是往同一个日志里继续写
    codebuddyText[first.path] = `${codebuddyLog(day, 'hy4-preview', 100, 40)}\n${codebuddyLog(day, 'hy4-preview', 100, 40)}`
    const grown = { ...first, size: codebuddyText[first.path].length }
    // 没变大就说明这条用例是空转的（上面的断言只是碰巧成立）
    expect(grown.size).toBeGreaterThan(first.size)
    codebuddy = { found: true, files: [grown, codebuddy.files[1]] }

    await token.getTokenUsage({ repo: '' })
    expect(textReads).toHaveLength(4)
    // 100-40 两次 + 20
    expect(codebuddyOf(await token.getTokenUsage({ repo: '' }), 'hy4-preview')).toBe(140)
  })

  it('单个文件读不了不影响其余文件', async () => {
    const day = today()
    addCodebuddyFile('good.log', codebuddyLog(day, 'hy4-preview', 100, 40))
    const broken = addCodebuddyFile('broken.log', 'x')
    delete codebuddyText[broken.path]

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    expect(codebuddyOf(result, 'hy4-preview')).toBe(60)
    expect(result.sourceErrors.codebuddy).toBeUndefined()
  })

  it('保留窗口之外的旧日志不再读（快照只留最近一年）', async () => {
    const day = today()
    addCodebuddyFile('old.log', codebuddyLog(day, 'hy4-preview', 100, 40), Date.now() - 400 * 86_400_000)

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    expect(textReads).toHaveLength(0)
    expect(codebuddyOf(result, 'hy4-preview')).toBe(-1)
  })
})

describe('DSH(会话文件)', () => {
  /** 取某天的模型输入量 */
  function dshOf(
    result: Awaited<ReturnType<typeof import('./token').getTokenUsage>>,
    model: string,
    day = today()
  ): number {
    return result.data.sources.dsh?.days[day]?.[model]?.inputTokens ?? -1
  }

  it('会话事件算进 dsh 这个来源，输入不再减缓存', async () => {
    addDshSession('session-1/session.v3.jsonl.zstd', dshSession())

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    // 161 + 892 + 29696 = 30749 就是真实事件里的 totalTokens，说明 input 不含缓存
    expect(dshOf(result, 'deepseek-flash')).toBe(161)
    const counters = result.data.sources.dsh.days[today()]['deepseek-flash']
    expect(counters.cacheReadTokens).toBe(29696)
    expect(counters.outputTokens).toBe(892)
    expect(counters.requests).toBe(1)
    expect(result.sourceErrors.dsh).toBeUndefined()
  })

  it('没装 DSH 就安静跳过', async () => {
    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    expect(result.data.sources.dsh).toBeUndefined()
    expect(result.sourceErrors.dsh).toBeUndefined()
  })

  it('只重解变化的会话，且合计不会把没变的那个算两遍', async () => {
    const first = addDshSession('a/session.v3.jsonl.zstd', dshSession('deepseek-flash', { inputTokens: 100 }))
    addDshSession('b/session.v3.jsonl.zstd', dshSession('deepseek-flash', { inputTokens: 7 }))

    const token = await freshToken()
    expect(dshOf(await token.getTokenUsage({ repo: '' }), 'deepseek-flash')).toBe(107)
    expect(dshDecodes).toHaveLength(2)

    // 每分钟一次的轮询：清单没变就不该再去解压
    expect(dshOf(await token.getTokenUsage({ repo: '' }), 'deepseek-flash')).toBe(107)
    expect(dshDecodes).toHaveLength(2)

    // a 追加了一轮（大小变了）：只重解 a，b 用缓存 —— 合计必须是 100+7 而不是 200+7
    dshFrames[first.path] = `${dshSession('deepseek-flash', { inputTokens: 100 })}\n${dshSession('deepseek-flash', { inputTokens: 100 })}`
    const grown = { ...first, size: dshFrames[first.path].length }
    expect(grown.size).toBeGreaterThan(first.size)
    dsh = { found: true, sessions: [grown, dsh.sessions[1]] }

    expect(dshOf(await token.getTokenUsage({ repo: '' }), 'deepseek-flash')).toBe(207)
    expect(dshDecodes).toHaveLength(3)
  })

  it('会话被删掉后它的量从合计里消失（缓存跟着淘汰）', async () => {
    addDshSession('a/session.v3.jsonl.zstd', dshSession('deepseek-flash', { inputTokens: 100 }))
    const second = addDshSession('b/session.v3.jsonl.zstd', dshSession('deepseek-flash', { inputTokens: 7 }))

    const token = await freshToken()
    expect(dshOf(await token.getTokenUsage({ repo: '' }), 'deepseek-flash')).toBe(107)

    dsh = { found: true, sessions: dsh.sessions.filter((item) => item.path !== second.path) }
    delete dshFrames[second.path]

    // 快照是「取最大值、永不缩水」的，所以本机快照里的 107 会一直在（那是刻意的：
    // 上游清理旧会话不该让历史变小）。要看缓存有没有把删掉的会话继续算进来，
    // 得把快照清掉再看实时读取这一路。
    localFile = null
    expect(dshOf(await token.getTokenUsage({ repo: '' }), 'deepseek-flash')).toBe(100)
  })

  it('单个会话坏掉不影响其余会话', async () => {
    addDshSession('good/session.v3.jsonl.zstd', dshSession('deepseek-flash', { inputTokens: 100 }))
    addDshSession('broken/session.v3.jsonl.zstd', 'x')

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    expect(dshOf(result, 'deepseek-flash')).toBe(100)
    expect(result.sourceErrors.dsh).toBeUndefined()
  })
})

describe('WorkBuddy(会话正文)', () => {
  /** 取某天的模型输入量（WorkBuddy 的 inputTokens 是「减去缓存读取」之后的） */
  function workbuddyOf(
    result: Awaited<ReturnType<typeof import('./token').getTokenUsage>>,
    model: string,
    day = today()
  ): number {
    return result.data.sources.workbuddy?.days[day]?.[model]?.inputTokens ?? -1
  }

  it('会话正文里的用量算进 workbuddy 这个来源，输入里减掉缓存读取', async () => {
    addWorkbuddySession('f-projects-workbench/7cc5feb0.jsonl', workbuddySession())

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    // 36775 里含 3520 的缓存读取，落盘时只记未命中的那部分（与 ZCode 同一口径）
    expect(workbuddyOf(result, 'hy3')).toBe(36775 - 3520)
    const counters = result.data.sources.workbuddy.days[today()]['hy3']
    expect(counters.cacheReadTokens).toBe(3520)
    expect(counters.outputTokens).toBe(280)
    expect(counters.reasoningTokens).toBe(243)
    expect(counters.requests).toBe(1)
    expect(result.sourceErrors.workbuddy).toBeUndefined()
  })

  it('没装 WorkBuddy 就安静跳过：不算读取失败，也不留空来源', async () => {
    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    expect(result.data.sources.workbuddy).toBeUndefined()
    expect(result.sourceErrors.workbuddy).toBeUndefined()
    expect(textReads).toHaveLength(0)
  })

  it('只重解变化的会话，且合计不会把没变的那个算两遍', async () => {
    const first = addWorkbuddySession('a/session.jsonl', workbuddySession('hy3', { inputTokens: 100 }))
    addWorkbuddySession('b/session.jsonl', workbuddySession('hy3', { inputTokens: 7 }))

    const token = await freshToken()
    expect(workbuddyOf(await token.getTokenUsage({ repo: '' }), 'hy3')).toBe(107)
    expect(textReads).toHaveLength(2)

    // 每分钟一次的轮询：清单没变就不该再读那些几兆的会话正文
    expect(workbuddyOf(await token.getTokenUsage({ repo: '' }), 'hy3')).toBe(107)
    expect(textReads).toHaveLength(2)

    // a 追加了一轮（大小变了）：只重读 a，b 用缓存 —— 合计必须是 100+7 而不是 200+7
    workbuddyText[first.path] = `${workbuddySession('hy3', { inputTokens: 100 })}\n${workbuddySession('hy3', { inputTokens: 100 })}`
    const grown = { ...first, size: workbuddyText[first.path].length }
    expect(grown.size).toBeGreaterThan(first.size)
    workbuddy = { found: true, sessions: [grown, workbuddy.sessions[1]] }

    expect(workbuddyOf(await token.getTokenUsage({ repo: '' }), 'hy3')).toBe(207)
    expect(textReads).toHaveLength(3)
  })

  it('单个会话读不了不影响其余会话', async () => {
    addWorkbuddySession('good/session.jsonl', workbuddySession('hy3', { inputTokens: 100 }))
    const broken = addWorkbuddySession('broken/session.jsonl', 'x')
    delete workbuddyText[broken.path]

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo: '' })

    expect(workbuddyOf(result, 'hy3')).toBe(100)
    expect(result.sourceErrors.workbuddy).toBeUndefined()
  })
})

describe('换同步仓库', () => {
  const OTHER = 'https://gitee.com/me/other.git'

  it('换了地址立刻按新地址同步一次，不再等节流窗口', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    await token.getTokenUsage({ repo: REPO })
    expect(published).toHaveLength(1)

    // 同一地址：节流窗口内不重复推
    await token.getTokenUsage({ repo: REPO })
    expect(published).toHaveLength(1)

    // 换了地址：下一次刷新就该打到新仓库，而不是等十分钟
    await token.getTokenUsage({ repo: OTHER })
    expect(published).toHaveLength(2)
    expect(published[1].repo).toBe(OTHER)
  })

  it('换仓库后不再显示老仓库的别的设备', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]
    // 老仓库里有另一台机器的分片，新仓库是空的
    remotes[REPO] = [shard('dev-old-repo', 999, day)]

    const token = await freshToken()
    const before = await token.getTokenUsage({ repo: REPO })
    expect(before.sync.devices.map((item) => item.id)).toEqual(['dev-old-repo'])
    expect(inputOn(before)).toBe(1009)

    const after = await token.getTokenUsage({ repo: OTHER })
    // 老仓库那台机器的数据必须从合计里消失，否则面板显示的是一份「不是你要同步的那个仓库」的数字
    expect(after.sync.devices).toEqual([])
    expect(inputOn(after)).toBe(10)
  })
})

describe('同步节流', () => {
  const repo = REPO

  it('间隔内不重复推，手动同步绕过节流', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    await token.getTokenUsage({ repo })
    expect(published).toHaveLength(1)

    // 每分钟一次的轮询不该每次都去动 git
    await token.getTokenUsage({ repo })
    expect(published).toHaveLength(1)

    await token.syncTokenUsage(repo)
    expect(published).toHaveLength(2)
  })

  it('推送失败也要给出本机数据，并把原因带回来', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    failPublish = true
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo })

    expect(inputOn(result)).toBe(10)
    expect(result.sync.enabled).toBe(true)
    expect(result.sync.error).toContain('仓库推不上去')
  })
})
