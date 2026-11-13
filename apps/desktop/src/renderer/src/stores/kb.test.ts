/**
 * 知识库 store：「这个文件夹像不像知识库」的判定。
 *
 * 这一条决定了整页给不给引导 —— 判宽了会把一个普通文件夹当知识库扫、判窄了用户
 * 明明放对了却一直看引导。判据（清单、raw / data 两层、旧结构的 kb/、空文件夹）之间
 * 是「或」，任何一条短路成 false 都是静默的界面错误，所以在这里钉死。
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

function scanEntry(rel: string, isDir = false): KbScanEntry {
  return { rel, name: rel.split('/').pop() ?? rel, isDir, mtimeMs: 0 }
}

describe('「这个文件夹像不像知识库」', () => {
  it('空文件夹算（第一次用，添加知识库就从这儿开始）', () => {
    const store = useKbStore()
    expect(store.looksLikeKb).toBe(true)
  })

  it('有清单条目（列表数据源）就算', () => {
    const store = useKbStore()

    store.manifest = [{ name: 'mu-ui', created: '2026-11-14' }]
    expect(store.looksLikeKb).toBe(true)
  })

  it('raw/ 或 data/ 两层任一在就算', () => {
    const store = useKbStore()

    store.scanEntries = [scanEntry('raw', true)]
    expect(store.looksLikeKb).toBe(true)

    store.scanEntries = [scanEntry('data/mu-ui/a.md')]
    expect(store.looksLikeKb).toBe(true)
  })

  it('旧结构的 kb/ 也在（迁移之前它就是全部条目）', () => {
    const store = useKbStore()

    store.scanEntries = [scanEntry('kb', true)]
    expect(store.looksLikeKb).toBe(true)
  })

  it('塞满别的项目文件的文件夹不像（多半是选错了目录）', () => {
    const store = useKbStore()

    store.scanEntries = [scanEntry('src/main.ts'), scanEntry('package.json'), scanEntry('README.md')]
    expect(store.looksLikeKb).toBe(false)
  })
})

describe('「要不要迁移」', () => {
  it('旧结构的 kb/ 在、清单还没有：要迁移', () => {
    const store = useKbStore()

    store.scanEntries = [scanEntry('kb', true), scanEntry('kb/a.md')]
    expect(store.migrateNeeded).toBe(true)
  })

  it('清单已经有了（或 kb/ 不在）：不用迁移', () => {
    const store = useKbStore()

    store.scanEntries = [scanEntry('kb', true)]
    store.manifest = [{ name: 'mu-ui', created: '' }]
    expect(store.migrateNeeded).toBe(false)

    store.manifest = []
    store.scanEntries = [scanEntry('raw', true)]
    expect(store.migrateNeeded).toBe(false)
  })
})
