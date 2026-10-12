/**
 * 知识库 store：「这个文件夹像不像知识库」的判定。
 *
 * 这一条决定了整页给不给引导 —— 判宽了会把一个普通文件夹当知识库扫、判窄了用户
 * 明明放对了却一直看引导。判据有三条（有 `kb/`、有库内 `data/raw/`、或配过来源），
 * 三条之间是「或」，任何一条短路成 false 都是静默的界面错误，所以在这里钉死。
 *
 * 跑在 node 环境里：`window.workbench` 用 Proxy 兜底（store 建好就会跟一次设置），
 * `@/notify` 换成假的（底下是 Element Plus）。
 */
import type { KbScanEntry } from '@workbench/kb'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/notify', () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn(),
}))

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false }),
    workbench: new Proxy({} as Record<string, unknown>, {
      get: (_target, key) =>
        key === 'getBootstrap'
          ? () => null
          : () => Promise.resolve({ ok: true, data: {} }),
    }),
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
const { useKbStore } = await import('./kb')
const { useSettingsStore } = await import('./settings')

function scanEntry(rel: string, isDir = false): KbScanEntry {
  return { rel, name: rel.split('/').pop() ?? rel, isDir, mtimeMs: 0 }
}

describe('「这个文件夹像不像知识库」', () => {
  it('什么都没有时不像', () => {
    const store = useKbStore()
    expect(store.looksLikeKb).toBe(false)
  })

  it('有 kb/ 目录就算', () => {
    const store = useKbStore()

    store.scanEntries = [scanEntry('kb', true)]
    expect(store.looksLikeKb).toBe(true)
  })

  it('只有库内 data/raw 里的一份也算（没配来源的兼容摆法）', () => {
    const store = useKbStore()

    store.scanEntries = [scanEntry('data/raw/notes/x.md')]
    expect(store.looksLikeKb).toBe(true)
  })

  it('一个文件都没有、但配过来源也算', () => {
    const settings = useSettingsStore()
    const store = useKbStore()

    settings.settings.kbDir = 'C:\\kb'
    settings.settings.kbRawSources = [{ root: 'C:\\kb', name: '素材', dir: 'C:\\raw' }]
    expect(store.looksLikeKb).toBe(true)
  })
})
