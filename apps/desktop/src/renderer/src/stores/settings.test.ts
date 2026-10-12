/**
 * 设置 / 布局 store 的几条约定。
 *
 * 挑的都是「落盘只送该送的那几个字段」「先在本地夹到区间内」这类**改坏了不报错**、
 * 只会在下次启动时才露馅的东西。
 *
 * 跑在 node 环境里，桩分三处：
 *  - `window.workbench` 用 Proxy 兜底 —— store 一建好就会立刻推一次程序名、跟一次背景图，
 *    用例只关心其中两条通道，其余给个空实现即可；
 *  - `document` 给最小桩（主题落在 `documentElement` 上）；
 *  - `@/notify` 换成假的：它底下是 Element Plus，node 里没必要真加载。
 */
import { clampNoteTreeWidth, DEFAULT_THEME } from '@workbench/appearance'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/notify', () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
}))

/** updateThemeConfig 收到的补丁：用来钉「只送了该送的字段」 */
let themePatches: Array<Record<string, unknown>>

beforeEach(() => {
  themePatches = []
  const workbench = new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === 'getBootstrap')
        return () => null
      if (key === 'updateThemeConfig') {
        return (patch: Record<string, unknown>) => {
          themePatches.push(patch)
          // 真适配层回的是合并后的整份 theme.json；这里把补丁铺在默认主题上凑一份
          return Promise.resolve({ ok: true, data: { ...DEFAULT_THEME, ...patch } })
        }
      }
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
const { useSettingsStore } = await import('./settings')

describe('布局落盘只送该送的字段', () => {
  it('笔记树宽度先在本地夹到区间内，落盘只带这一个字段', async () => {
    const store = useSettingsStore()

    store.setNoteTreeWidth(-100)
    expect(store.themeConfig.noteTreeWidth).toBe(clampNoteTreeWidth(-100))

    await store.commitNoteTreeWidth()
    expect(themePatches).toEqual([{ noteTreeWidth: clampNoteTreeWidth(-100) }])
  })

  it('视频树收起状态没变时直接回 true，不写盘', async () => {
    const store = useSettingsStore()
    const before = store.themeConfig.videoTreeCollapsed

    expect(await store.setVideoTreeCollapsed(before)).toBe(true)
    expect(themePatches).toEqual([])

    expect(await store.setVideoTreeCollapsed(!before)).toBe(true)
    expect(themePatches).toEqual([{ videoTreeCollapsed: !before }])
  })

  it('aI 页的名字跟着设置里的程序名走', () => {
    const store = useSettingsStore()

    store.settings.appName = '小助手'
    expect(store.viewLabelOf('ai')).toBe('小助手')
  })
})
