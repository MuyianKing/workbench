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

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string): Promise<unknown> =>
        Promise.resolve(command === 'fs_exists' ? true : null)
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
