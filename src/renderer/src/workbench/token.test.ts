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
 * 自动同步在后台跑，断言推送内容前要先 `flushBackgroundSync()`。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_VERSION } from '@shared/theme'

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
/** 假装成远端仓库的 token-usage/ 目录：按仓库地址分开装各台机器推上来的用量分片 */
let remotes: Record<string, unknown[]> = {}
/** 同一个仓库的 config/ 目录：按仓库地址分开装各台机器推上来的配置 */
let remoteConfigs: Record<string, unknown[]> = {}
let published: Array<Record<string, unknown>> = []
let failPublish = false
/** 推送卡住不回（验「同步不挡出数」用） */
let hangPublish = false
/**
 * 本地克隆当前属于哪个仓库。
 *
 * 由 publish 确定（推送这路会顺带把克隆建好 / 拉到最新），但它是**磁盘上的东西**：
 * 上一次运行留下的那份照样在，所以用例可以直接预置它来模拟「第二次启动」。
 * 读分片要核对这个归属，换仓库得等重新克隆 —— 见 sync.rs 的 read_shards_for。
 */
let cloneRepo = ''
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
            if (hangPublish) return new Promise(() => {})
            if (failPublish) return Promise.reject('仓库推不上去')
            published.push(args ?? {})
            const repo = String(args?.repo ?? '')
            // 推送这路会顺带建好 / 拉新克隆（见 sync.rs 的 ensure_clone），克隆从此属于这个仓库
            cloneRepo = repo
            // 仓库里自己那两份被覆盖，别人那份原样留着。config 给 null 表示关掉了外观同步，
            // 对应的文件在仓库里要被删掉（见 sync.rs 的 publish_at）
            const others = (remotes[repo] ?? []).filter(
              (item) => (item as { device?: string }).device !== args?.device
            )
            remotes[repo] = [...others, args?.shard]

            const otherConfigs = (remoteConfigs[repo] ?? []).filter(
              (item) => (item as { device?: string }).device !== args?.device
            )
            remoteConfigs[repo] = args?.config ? [...otherConfigs, args.config] : otherConfigs
            return Promise.resolve({ changed: true, pushed: true, log: '' })
          }
          case 'token_sync_shards': {
            // 克隆是本地目录，上一次运行留下的那份也算数 —— 首屏直接读它，这正是「同步不挡出数」
            // 的前提（见 token.ts 的 readRemoteShards）。但它只认属于当前配置那个仓库的文件：
            // 换仓库时 Rust 会重新克隆，核对 origin 不是这个仓库就返回空表。
            const repo = String((args as { repo?: unknown })?.repo ?? '')
            const owned = cloneRepo === repo
            return Promise.resolve({
              usage: owned ? remotes[repo] ?? [] : [],
              config: owned ? remoteConfigs[repo] ?? [] : []
            })
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
  remoteConfigs = {}
  published = []
  failPublish = false
  hangPublish = false
  cloneRepo = ''
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

/**
 * 每条用例收尾时把后台那轮放过去。
 *
 * 后台同步读的是**同一份模块级状态**（published / remotes 都在本文件里），
 * 留下没跑完的推送会串进下一个用例，表现成「published 莫名多了一条」这种难查的偶发失败。
 */
afterEach(async () => {
  await flushBackgroundSync()
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

/**
 * 等后台那轮自动同步跑完。
 *
 * 自动同步不挡出数（见 token.ts 的 getTokenUsage）：取数在它跑完之前就返回了，
 * 所以想断言推送内容、或想看到别人机器的分片，得先把它放过去。
 * 桩里全是已 resolve 的 promise、不涉及定时器，把微任务队列排空就够 —— 这样在假定时器下也能用。
 */
async function flushBackgroundSync(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
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
    // 上一次运行留下的克隆还属于这个仓库：分片读的是本地目录，首屏就该带上那台机器
    cloneRepo = REPO
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
    expect(saved.version).toBe(6)
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

/**
 * 首屏快照：面板打开时先摆出来的那一份。
 *
 * 盯的是两件只看结果分不清的事：它有没有偷偷做实读（做了就没有意义了，还是会卡一秒），
 * 以及它有没有把实读该做的事揽过来（落盘 / 推送）。另外钉住「它只是先手」——
 * 实读随后必须把数字修正上去，快照不能变成最终结果。
 */
describe('首屏快照(只读本地)', () => {
  it('不实读、不落盘、不推送，摆的是上次那份数据', async () => {
    const day = today()
    // 上次落盘的是 10；这次实读会读到 99，快照不该拿到它
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 99, cacheRead: 0, requests: 1 }]
    addCodebuddyFile('a.log', codebuddyLog(day, 'hy4-preview', 60, 0))
    addDshSession('a.zstd', dshSession())

    const token = await freshToken()
    const saved = localFile
    const result = await token.getTokenUsageSnapshot({ repo: '' })

    // 10 而不是 99：zcode 那条实读一次都没跑（跑了就会经 max 合并变成 99）
    expect(inputOn(result)).toBe(10)
    // 日志与会话文件也一个都没读
    expect(textReads).toEqual([])
    expect(dshDecodes).toEqual([])
    // 不落盘、不推送
    expect(localFile).toBe(saved)
    expect(published).toHaveLength(0)
  })

  it('只是个先手：实读随后把数字修正上去', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 99, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    expect(inputOn(await token.getTokenUsageSnapshot({ repo: '' }))).toBe(10)
    expect(inputOn(await token.getTokenUsage({ repo: '' }))).toBe(99)
  })

  it('也带上克隆里别人的分片，换仓库时不沿用老仓库的', async () => {
    const day = today()
    const OTHER = 'https://gitee.com/me/other.git'
    localFile = shard('dev-local', 10, day)
    remotes[REPO] = [shard('dev-b', 5, day)]
    // 上一次运行留下的克隆属于 REPO
    cloneRepo = REPO

    const token = await freshToken()
    const mine = await token.getTokenUsageSnapshot({ repo: REPO })
    expect(inputOn(mine)).toBe(15)
    expect(mine.sync.devices.map((item) => item.id)).toEqual(['dev-b'])

    // 换了仓库：克隆还指着老仓库，Rust 侧核对 origin 会返回空表，那台机器必须消失
    const other = await token.getTokenUsageSnapshot({ repo: OTHER })
    expect(inputOn(other)).toBe(10)
    expect(other.sync.devices).toEqual([])
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
    await flushBackgroundSync()
    expect(published).toHaveLength(1)

    // 同一地址：节流窗口内不重复推
    await token.getTokenUsage({ repo: REPO })
    await flushBackgroundSync()
    expect(published).toHaveLength(1)

    // 换了地址：下一次刷新就该打到新仓库，而不是等一个小时的间隔
    await token.getTokenUsage({ repo: OTHER })
    await flushBackgroundSync()
    expect(published).toHaveLength(2)
    expect(published[1].repo).toBe(OTHER)
  })

  it('换仓库后不再显示老仓库的别的设备', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]
    // 老仓库里有另一台机器的分片，新仓库是空的
    remotes[REPO] = [shard('dev-old-repo', 999, day)]
    // 上一次运行留下的克隆属于老仓库：首屏读的就是它，所以先把这份数据拿出来
    cloneRepo = REPO

    const token = await freshToken()
    const before = await token.getTokenUsage({ repo: REPO })
    expect(before.sync.devices.map((item) => item.id)).toEqual(['dev-old-repo'])
    expect(inputOn(before)).toBe(1009)

    const after = await token.getTokenUsage({ repo: OTHER })
    // 老仓库那台机器的数据必须从合计里消失，否则面板显示的是一份「不是你要同步的那个仓库」的数字。
    // 这一轮读分片时克隆还指着老仓库，Rust 侧核对 origin 就会返回空表 —— 正是靠它挡住这份数据
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
    await flushBackgroundSync()
    expect(published).toHaveLength(1)

    // 每分钟一次的轮询不该每次都去动 git
    await token.getTokenUsage({ repo })
    await flushBackgroundSync()
    expect(published).toHaveLength(1)

    // 手动同步：自己等结果回来，不用 flush
    await token.syncTokenUsage(repo)
    expect(published).toHaveLength(2)
  })

  it('自动同步最多一小时一次：59 分钟不推，过了 60 分钟才推', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 8, 14, 10, 0, 0))
      const day = today()
      localFile = shard('dev-local', 10, day)
      rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

      const token = await freshToken()
      await token.getTokenUsage({ repo })
      await flushBackgroundSync()
      expect(published).toHaveLength(1)

      // 面板每分钟刷一次，但推送的节奏是按小时计的
      vi.setSystemTime(new Date(2026, 8, 14, 10, 59, 0))
      await token.getTokenUsage({ repo })
      await flushBackgroundSync()
      expect(published).toHaveLength(1)

      vi.setSystemTime(new Date(2026, 8, 14, 11, 1, 0))
      await token.getTokenUsage({ repo })
      await flushBackgroundSync()
      expect(published).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('推送失败也要给出本机数据，失败原因随下一次刷新回来', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    failPublish = true
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo })

    // 出数不等同步：这一轮先把本机数据给出来，失败原因还在后台那轮手上
    expect(inputOn(result)).toBe(10)
    expect(result.sync.enabled).toBe(true)
    expect(result.sync.error).toBe('')

    await flushBackgroundSync()

    // 后台那轮把原因记下了，面板收到广播后重取一次就能看到
    const after = await token.getTokenUsage({ repo })
    expect(after.sync.error).toContain('仓库推不上去')
    expect(inputOn(after)).toBe(10)
  })

  it('推送卡住也不挡出数：本机数据照常先回来', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    hangPublish = true
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    const result = await token.getTokenUsage({ repo })

    // 推送永远不回，取数也不该被它拖住 —— 这是「同步从关键路径上摘下来」的核心
    expect(inputOn(result)).toBe(10)
    expect(published).toHaveLength(0)
  })

  it('后台同步跑完广播一次，手点的那次不广播', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    // 事件模块与适配层必须是同一份实例，所以要在 freshToken() 重置之后再导入
    const token = await freshToken()
    const events = await import('./events')
    const seen: string[] = []
    const unsubscribe = events.subscribe('tokenSynced', () => seen.push('synced'))

    await token.getTokenUsage({ repo })
    await flushBackgroundSync()
    expect(seen).toHaveLength(1)

    // 手点的同步自己等结果，面板不用再取一遍
    await token.syncTokenUsage(repo)
    expect(seen).toHaveLength(1)
    unsubscribe()
  })
})

/**
 * 外观配置作为**单独一个文件**推上去（见 shared/sync-config.ts）。
 *
 * 这里盯的是三件只看结果看不出来的事：推上去的确实是本机 theme.json 的整份内容、
 * 关掉开关之后有没有真的从仓库里删掉、以及时间戳跟不跟着内容走
 * —— 漏了最后一条，外观一动就会在两处之间来回推同一份内容。
 */
describe('外观配置单独同步', () => {
  /** 断言用的那份配置：只看它的 theme */
  function themeIn(index = 0): Record<string, unknown> | null {
    const config = published[index]?.config as { theme?: unknown } | undefined
    return (config?.theme ?? null) as Record<string, unknown> | null
  }

  it('默认把本机 theme.json 整份推上去', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    const token = await freshToken()
    await token.getTokenUsage({ repo: REPO })
    await flushBackgroundSync()

    expect(published).toHaveLength(1)
    const config = published[0].config as { device?: string; name?: string } | null
    expect(config?.device).toBe('dev-local')
    // 外观与布局都在这一份里：它们本来就是同一个文件的两半
    expect(themeIn()?.appearance).toBeTruthy()
    expect(themeIn()?.cards).toBeTruthy()
  })

  it('关掉开关之后不推配置，已经在仓库里的那份也会被删掉', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

    vi.resetModules()
    const state = await import('./state')
    const token = await import('./token')

    // 先开着推一次，仓库里就有了
    await token.getTokenUsage({ repo: REPO })
    await flushBackgroundSync()
    expect(remoteConfigs[REPO]).toHaveLength(1)

    state.updateSettings({ syncAppearance: false })
    await token.syncTokenUsage(REPO)
    expect(published[1].config).toBeNull()
    expect(remoteConfigs[REPO]).toHaveLength(0)

    // 再打开：配置又推上去了（删掉只是「这次不推」，不是把本机的设置一起清掉）
    state.updateSettings({ syncAppearance: true })
    await token.syncTokenUsage(REPO)
    expect(remoteConfigs[REPO]).toHaveLength(1)
  })

  it('改了外观才有新时间戳：内容没变时推上去的还是同一份', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 8, 14, 10, 0, 0))
      const day = today()
      localFile = shard('dev-local', 10, day)
      rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]

      vi.resetModules()
      const state = await import('./state')
      const token = await import('./token')

      await token.getTokenUsage({ repo: REPO })
      await flushBackgroundSync()
      // 从没改过外观（这是默认主题）：时间未知，记 0
      expect(themeIn()?.updatedAt).toBe(0)

      // 什么都没改：还是 0 —— 时间戳不因为「又同步了一轮」而刷新，否则每轮都会推一次新内容
      vi.setSystemTime(new Date(2026, 8, 14, 11, 0, 0))
      await token.syncTokenUsage(REPO)
      expect(themeIn(1)?.updatedAt).toBe(0)

      // 拖一下布局（改栏宽）：真的变了，时间戳记的是**变化**那一刻，不是推送那一刻
      state.updateThemeConfig({
        columns: [
          { id: 'col-1', width: 320 },
          { id: 'col-2', width: null },
          { id: 'col-3', width: 294 }
        ]
      })
      const layoutChangedAt = Date.now()
      vi.setSystemTime(new Date(2026, 8, 14, 12, 0, 0))
      await token.syncTokenUsage(REPO)
      expect((themeIn(2)?.columns as Array<{ width: unknown }>)[0].width).toBe(320)
      expect(themeIn(2)?.updatedAt).toBe(layoutChangedAt)

      // 改外观（主题色）同理：它和布局在同一个文件里，一样刷新时间戳
      state.updateSettings({ accentColor: '#ef4444' })
      const colorChangedAt = Date.now()
      vi.setSystemTime(new Date(2026, 8, 14, 13, 0, 0))
      await token.syncTokenUsage(REPO)
      const appearance = themeIn(3)?.appearance as { accentColor?: string } | undefined
      expect(appearance?.accentColor).toBe('#ef4444')
      expect(themeIn(3)?.updatedAt).toBe(colorChangedAt)
    } finally {
      vi.useRealTimers()
    }
  })

  it('列设备时两个目录按设备 id 配对，排除本机，最近动过的在前', async () => {
    const day = today()
    localFile = shard('dev-local', 10, day)
    rows = [{ day, model: 'glm-5', input: 10, cacheRead: 0, requests: 1 }]
    remotes[REPO] = [
      shard('dev-local', 10, day),
      { ...shard('dev-older', 20, day), name: '办公室', updatedAt: 100 },
      { ...shard('dev-newer', 30, day), name: '笔记本', updatedAt: 200 }
    ]
    // 只有「办公室」推了配置（另一台关掉了外观同步），而且它那份配置比分片新
    remoteConfigs[REPO] = [
      { device: 'dev-local', name: '本机', theme: { version: THEME_VERSION, updatedAt: 1 } },
      {
        device: 'dev-older',
        name: '办公室',
        theme: {
          version: THEME_VERSION,
          cards: {},
          appearance: { accentColor: '#ef4444' },
          updatedAt: 300
        }
      }
    ]

    const token = await freshToken()
    // 列表读的就是「当前这个仓库」的克隆：先同步一次把克隆建起来（见上面的 cloneRepo 说明）
    await token.getTokenUsage({ repo: REPO })
    await flushBackgroundSync()
    const devices = await token.listSyncDevices(REPO)

    // 时间取两份里较新的那个：办公室的配置（300）比它的分片（100）新，所以它排到了最前面
    expect(devices.map((item) => item.id)).toEqual(['dev-older', 'dev-newer'])
    expect(devices[0].updatedAt).toBe(300)
    expect(devices[0].name).toBe('办公室')
    expect(devices[0].theme?.appearance.accentColor).toBe('#ef4444')
    // 没推配置的那台仍然列出来（只有用量分片），只是没有可用的配置
    expect(devices[1].theme).toBeNull()
  })

  it('没填仓库地址时一台设备都不列', async () => {
    const token = await freshToken()
    expect(await token.listSyncDevices('')).toEqual([])
    expect(await token.listSyncDevices('   ')).toEqual([])
  })
})
