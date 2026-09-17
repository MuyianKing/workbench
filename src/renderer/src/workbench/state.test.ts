/**
 * 适配层是渲染层与后端之间的那条边界 —— 在 Electron 版它是 IPC，值跨进程复制。
 *
 * 这组用例盯的就是这条边界最容易漏掉的一点：交给渲染层的列表必须是快照。
 * 漏掉它的症状不是报错，而是「添加一个程序先出现两个，过一会儿刷新又合成一个」。
 *
 * 跑在 node 环境里，没有 window，所以在导入前先补一个最小的 Tauri 桥：
 * 适配层的 invoke 只认 `__TAURI_INTERNALS__.invoke`，`fs_exists` 一律回 true 就够这几条用例用了。
 */
import { beforeAll, describe, expect, it } from 'vitest'

/** 记下每个通道与它的入参：迁移有没有真的落盘，只能从这里看 */
const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
/** 磁盘上那两份数据（用例直接摆，模拟升级前后的样子） */
let rawData: unknown = null
let rawTheme: unknown = null

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>): Promise<unknown> => {
        calls.push({ command, args })
        if (command === 'fs_exists') return Promise.resolve(true)
        if (command === 'data_load') return Promise.resolve(rawData)
        if (command === 'theme_load') return Promise.resolve(rawTheme)
        return Promise.resolve(null)
      }
    }
  }
})

// 桥必须在 import 之前就位，所以这里用动态导入
const state = await import('./state')

describe('适配层交出去的列表', () => {
  /** 照渲染层的真实动作来一遍：拉列表 → 自己拿着 → 添加 → 把新条目展开追加进去 */
  it('刷新之后紧接着添加，同一条不会出现两次', async () => {
    const rendered = (await state.quickAppList()).apps
    const added = state.addQuickApp({ target: 'C:\\snapshot-test.exe', name: '快照用例' })

    const next = [...rendered, added]

    // 不是快照的话，`rendered` 就是适配层内部那个数组本身：添加时它已经被塞进了新条目，
    // 展开追加之后同一条出现两次，界面上就是「添加上去变成了两个」
    expect(next.map((app) => app.id)).toEqual([added.id])
  })

  /** 反方向同理：渲染层往自己那份列表里塞东西，不能写进适配层的数据（那边是要落盘的） */
  it('渲染层往列表里 push 不会写进适配层的数据', async () => {
    const rendered = (await state.quickAppList()).apps
    const before = state.quickApps().length

    rendered.push({ id: 'ghost', name: '幽灵', target: 'C:\\ghost.exe', order: 99, createdAt: 0 })

    expect(state.quickApps()).toHaveLength(before)
  })
})

/**
 * 外观从数据文件搬进 theme.json 的那一次搬家（见 shared/appearance.ts）。
 *
 * 这是整次改动里最容易静默丢数据的一步：搬晚了（数据文件先按新口径落盘、把那些键摘掉），
 * 用户的主题色、背景、终端高度就再也没处可搬。所以既要断言搬到了，也要断言**立刻落盘**。
 */
describe('老数据的搬家', () => {
  function savedTheme(): { appearance?: { accentColor?: string } } | null {
    const call = calls.find((item) => item.command === 'theme_save')
    return (call?.args?.value ?? null) as { appearance?: { accentColor?: string } } | null
  }

  it('主题文件里还没有外观时，从设置里搬过去并立刻落盘', async () => {
    rawTheme = { version: 2, cardGap: 14, cards: {} }
    rawData = {
      settings: { accentColor: '#ef4444', terminalHeight: 320, hotkey: 'Control+J' },
      projects: []
    }
    calls.length = 0

    await state.initState()

    // 渲染层看到的那份设置是老样子（外观与其余项合在一起，组件不必知道文件怎么分的）
    expect(state.settings().accentColor).toBe('#ef4444')
    expect(state.settings().terminalHeight).toBe(320)
    expect(state.settings().hotkey).toBe('Control+J')
    // 布局不受影响：搬外观不能顺手把摆放清了
    expect(state.themeConfig().cardGap).toBe(14)
    expect(state.themeConfig().appearance.accentColor).toBe('#ef4444')
    // 搬完必须马上写回主题文件：数据文件下一次落盘就会把那些键摘掉
    expect(savedTheme()?.appearance?.accentColor).toBe('#ef4444')
  })

  it('主题文件里已经有外观时以它为准，不再回迁也不需要落盘', async () => {
    rawTheme = { version: 2, appearance: { accentColor: '#22c55e' } }
    rawData = { settings: { accentColor: '#ef4444' }, projects: [] }
    calls.length = 0

    await state.initState()

    expect(state.settings().accentColor).toBe('#22c55e')
    expect(calls.some((item) => item.command === 'theme_save')).toBe(false)
  })
})
