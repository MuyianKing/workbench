import type { Project } from '@/types'
import { DEFAULT_THEME } from '@workbench/appearance'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@/types'

/**
 * 项目 store 的边界用例。
 *
 * 重点是「配置变更自动落盘」那条 watch：原先它 `deep: true`，主进程推回来的 `history` /
 * `lastUsedAt` 也会触发，然后对全部项目重算一遍并逐个发 IPC。这里钉住两件事 ——
 * 真改字段会推、只改运行期字段不推；顺带钉住目录检查失败时保留旧值。
 */
vi.mock('@/notify', () => ({
  confirmAction: vi.fn(async () => true),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
}))

function makeProject(): Project {
  return {
    id: 'p1',
    name: '项目甲',
    path: 'E:/work/a',
    color: 'primary',
    packageManager: 'auto',
    detectedPackageManager: 'pnpm',
    framework: 'Vue',
    version: '1.0.0',
    scripts: { serve: 'dev', build: ['build'], defaultBuild: 'build' },
    outputDir: 'dist',
    autoOpenExplorer: true,
    home: true,
    order: 0,
    createdAt: 1,
    lastUsedAt: 1,
  }
}

let updateProjectSpy: ReturnType<typeof vi.fn>
let checkProjectPathsImpl: () => Promise<unknown>

beforeEach(() => {
  vi.useFakeTimers()

  updateProjectSpy = vi.fn(async () => ({ ok: true, data: makeProject() }))
  checkProjectPathsImpl = async () => ({ ok: true, data: { p1: true } })

  const workbench = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === 'getBootstrap')
        return () => null
      if (key === 'listProjects')
        return async () => ({ ok: true, data: { projects: [makeProject()], groups: [] } })
      if (key === 'getSettings')
        return async () => ({ ok: true, data: DEFAULT_SETTINGS })
      if (key === 'getThemeConfig')
        return async () => ({ ok: true, data: DEFAULT_THEME })
      if (key === 'updateSettings')
        return async (patch: Record<string, unknown>) => ({ ok: true, data: { ...DEFAULT_SETTINGS, ...patch } })
      if (key === 'getDataDir')
        return async () => ({ ok: true, data: 'C:/data' })
      if (key === 'getActivity')
        return async () => ({ ok: true, data: { total: 0, days: {} } })
      if (key === 'listQuickApps')
        return async () => ({ ok: true, data: { apps: [], missing: {} } })
      if (key === 'listCommands')
        return async () => ({ ok: true, data: [] })
      if (key === 'checkPackageManagers')
        return async () => ({ ok: true, data: { npm: true, yarn: false, pnpm: true, node: '22.19.0' } })
      if (key === 'getNvmStatus')
        return async () => ({ ok: true, data: { available: false, versions: [] } })
      if (key === 'getNrmStatus')
        return async () => ({ ok: true, data: { available: false, registries: [] } })
      if (key === 'authStatus')
        return async () => ({ ok: true, data: { configured: false, providers: [], account: null } })
      if (key === 'checkProjectPaths')
        return () => checkProjectPathsImpl()
      if (key === 'updateProject')
        return updateProjectSpy
      if (key === 'checkPort')
        return async () => ({ ok: true, data: { inUse: false } })
      return () => Promise.resolve({ ok: true, data: {} })
    },
  })

  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    workbench,
    addEventListener: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
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

afterEach(() => {
  vi.useRealTimers()
})

// 桩必须在 import 之前就位，所以这里用动态导入
const { useProjectsStore } = await import('./projects')

async function initStore() {
  const store = useProjectsStore()
  await store.init()
  // 等 init 里那几条 void 的异步收尾（目录检查 / 端口探测 / 补标识色）跑完，
  // 补色那一条会排一次 400ms 的落盘 —— 在这里冲掉，免得算进用例自己的账
  await vi.advanceTimersByTimeAsync(500)
  return store
}

describe('配置变更自动落盘', () => {
  it('改了会落盘的字段：推出该字段，且不带运行期字段', async () => {
    const store = await initStore()
    updateProjectSpy.mockClear()

    store.projects[0].name = '项目乙'
    await vi.advanceTimersByTimeAsync(500)

    expect(updateProjectSpy).toHaveBeenCalledTimes(1)
    const patch = updateProjectSpy.mock.calls[0][1] as Record<string, unknown>
    expect(patch.name).toBe('项目乙')
    expect('history' in patch).toBe(false)
    expect('lastUsedAt' in patch).toBe(false)
  })

  it('只改 lastUsedAt / history 这类运行期字段：一次 IPC 都不发', async () => {
    const store = await initStore()
    updateProjectSpy.mockClear()

    store.projects[0].lastUsedAt = Date.now() + 10_000
    store.projects[0].history = [{
      id: 'r1',
      kind: 'start',
      command: 'dev',
      startedAt: 1,
      durationMs: 2,
      result: 'success',
    }]
    await vi.advanceTimersByTimeAsync(500)

    expect(updateProjectSpy).not.toHaveBeenCalled()
  })
})

describe('目录有效性', () => {
  it('检查失败时保留上一次的结论', async () => {
    const store = await initStore()
    const before = store.isPathValid('p1')

    checkProjectPathsImpl = async () => ({ ok: false, error: '通道失败' })
    await store.refreshPaths()
    expect(store.isPathValid('p1')).toBe(before)
  })

  it('检查成功时按结果更新', async () => {
    const store = await initStore()

    checkProjectPathsImpl = async () => ({ ok: true, data: { p1: false } })
    await store.refreshPaths()
    expect(store.isPathValid('p1')).toBe(false)
  })
})
