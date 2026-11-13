import type { AiProvider } from '@workbench/ai'
import type { AppSettings } from '@/types'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@/types'

/**
 * AI 助手 store 的边界用例。
 *
 * 挑的都是「改坏了不报错、只会在界面上悄悄退化」的几条：环境缺哪一样的级联顺序、
 * 流式 / 思考两段收尾时要不要留字、配置变了之后进程是等这轮完还是当场收、以及服务保存前
 * 的四道校验（不通过时一个字节都不该落盘）。
 *
 * 跑在 node 环境里：`window.workbench` 用 Proxy 兜底（只关心 updateSettings 与 setAppName），
 * `document` 给最小桩（主题落在 documentElement 上），`@/notify` 换成假的。
 */
vi.mock('@/notify', () => ({
  confirmAction: vi.fn(async () => true),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
}))

/** 假设置文件：updateSettings 合并进来再原样回，store 的本地那份才跟得上 */
let settingsData: AppSettings
let updateSettingsSpy: ReturnType<typeof vi.fn>

function fakeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'p',
    label: '测试服务',
    baseUrl: 'https://example.com/v1',
    apiFormat: 'openai',
    preset: '',
    enabled: true,
    models: [{
      id: 'm',
      enabled: true,
      name: '测试模型',
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      levels: ['off'],
      imageInput: false,
    }],
    ...overrides,
  }
}

beforeEach(() => {
  settingsData = structuredClone(DEFAULT_SETTINGS)
  updateSettingsSpy = vi.fn(async (patch: Partial<AppSettings>) => {
    settingsData = { ...settingsData, ...patch }
    return { ok: true, data: settingsData }
  })

  const workbench = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === 'getBootstrap')
        return () => null
      if (key === 'updateSettings')
        return updateSettingsSpy
      if (key === 'setAppName')
        return () => {}
      return () => Promise.resolve({ ok: true, data: {} })
    },
  })

  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false }),
    workbench,
  }
  ;(globalThis as { document?: unknown }).document = {
    documentElement: {
      dataset: {},
      classList: { toggle: () => {} },
      style: { setProperty: () => {}, removeProperty: () => {} },
    },
  }

  setActivePinia(createPinia())
})

// 桩必须在 import 之前就位，所以这里用动态导入
const { useAiStore } = await import('./ai')
const { useSettingsStore } = await import('./settings')
const { configChangeAction, useAiRunState } = await import('./ai-run-state')

describe('环境缺哪一样：级联顺序固定为 Node → Pi → 模型 → 密钥', () => {
  it('按这个顺序报第一个缺的，四样齐了就是 null', () => {
    const store = useAiStore()
    const settingsStore = useSettingsStore()
    settingsStore.settings.aiProviders = [fakeProvider()]
    settingsStore.settings.aiDefaultProvider = 'p'
    settingsStore.settings.aiDefaultModel = 'm'
    store.nodeVersion = '22.19.0'
    store.runtimeSource = 'bundled'

    // 模型有了、密钥还没配
    expect(store.envGap()).toBe('key')

    store.keyStates.p = true
    expect(store.envGap()).toBe(null)

    // Node 优先于其余三样
    store.nodeVersion = '20.0.0'
    expect(store.envGap()).toBe('node')

    // Node 够了但运行时不在
    store.nodeVersion = '22.19.0'
    store.runtimeSource = 'none'
    expect(store.envGap()).toBe('pi')

    // 运行时在、一个能挑的模型都没有
    store.runtimeSource = 'bundled'
    settingsStore.settings.aiProviders = []
    expect(store.envGap()).toBe('model')
  })
})

describe('流式 / 思考两段收尾', () => {
  it('endStream(keep) 把已吐出来的字落成一行，不留就丢掉', () => {
    const state = useAiRunState()
    const run = state.runOf('s1')
    run.lines = []

    run.streamBuffer = '已经吐出来的半句'
    run.streamText = '已经吐出来的半句'
    state.endStream(run, true)
    expect(run.lines).toEqual([{ kind: 'text', text: '已经吐出来的半句' }])
    expect(run.streamText).toBe('')
    expect(run.streamBuffer).toBe('')

    run.streamBuffer = '不要了'
    state.endStream(run, false)
    expect(run.lines).toEqual([{ kind: 'text', text: '已经吐出来的半句' }])
  })

  it('endThink 以 thinking_end 给的整块为准，并清掉 thinking 标记', () => {
    const state = useAiRunState()
    const run = state.runOf('s2')
    run.lines = []
    run.thinking = true
    run.thinkBuffer = '过程版'

    state.endThink(run, '权威版', true)
    expect(run.lines).toEqual([{ kind: 'thinking', text: '权威版' }])
    expect(run.thinking).toBe(false)
    expect(run.thinkText).toBe('')
  })

  it('没有权威内容时用攒下来的增量，空的不落行', () => {
    const state = useAiRunState()
    const run = state.runOf('s3')
    run.lines = []

    state.endThink(run, '', true)
    expect(run.lines).toEqual([])

    run.thinkBuffer = '   '
    state.endThink(run, '', true)
    expect(run.lines).toEqual([])
  })
})

describe('配置变了之后进程怎么收', () => {
  const live = { live: true, running: false }
  const busy = { live: true, running: true }

  it('刚出现的会话、配置没变、进程没活着都不动', () => {
    expect(configChangeAction(undefined, 'a', live)).toBe('none')
    expect(configChangeAction('a', 'a', live)).toBe('none')
    expect(configChangeAction('a', 'b', { live: false, running: false })).toBe('none')
    expect(configChangeAction('a', 'b', undefined)).toBe('none')
  })

  it('跑着的等这轮完（stale），闲着的当场收（recycle）', () => {
    expect(configChangeAction('a', 'b', busy)).toBe('stale')
    expect(configChangeAction('a', 'b', live)).toBe('recycle')
  })
})

describe('保存服务：四道校验不过时一个字节都不落盘', () => {
  it('名字不合法 / 地址不是 http(s) / 没选形态 / 没有启用的模型', async () => {
    const store = useAiStore()
    const settingsStore = useSettingsStore()
    settingsStore.settings.aiProviders = []

    const base = fakeProvider()
    expect(await store.saveProvider({ ...base, id: '不合法 名字' })).toBe(false)
    expect(await store.saveProvider({ ...base, baseUrl: 'ftp://example.com' })).toBe(false)
    expect(await store.saveProvider({ ...base, apiFormat: '' })).toBe(false)
    expect(await store.saveProvider({
      ...base,
      models: [{ ...base.models[0], enabled: false }],
    })).toBe(false)

    expect(updateSettingsSpy).not.toHaveBeenCalled()
  })
})

describe('起始屏上的选择写进设置默认', () => {
  it('没有会话时挑权限档直接写 aiPermission', async () => {
    const store = useAiStore()
    const settingsStore = useSettingsStore()
    settingsStore.settings.aiSessions = []

    expect(await store.setPermission('full')).toBe(true)
    expect(updateSettingsSpy).toHaveBeenCalledWith({ aiPermission: 'full' })
  })

  it('挑一个不在清单里的模型：返回 false，不写设置', async () => {
    const store = useAiStore()
    const settingsStore = useSettingsStore()
    settingsStore.settings.aiProviders = [fakeProvider()]

    expect(await store.setChoice('不存在/模型')).toBe(false)
    expect(updateSettingsSpy).not.toHaveBeenCalled()
  })
})
