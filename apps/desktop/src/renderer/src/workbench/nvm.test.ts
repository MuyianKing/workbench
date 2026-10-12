/**
 * nvm 适配层的失败收敛。
 *
 * 跑在 node 环境里，没有 window，所以先补一个最小的假 Tauri 桥（与 state.test.ts 同一条路子）：
 * 用例按需给 `nvm_status` / `nvm_node_dir` 挂桩，其余命令一律回 null。
 *
 * 这几条钉的是「签名说不会失败，就得真不失败」：探测在 IPC 层面出问题时，
 * `checkNodeVersion` 不能变成一次未处理异常（它由「启动项目」直接 await，没有 try），
 * 而 `nodeDirFor` 的失败必须留下可查的痕迹（吞成 null 会让命令带着错误的 Node 跑）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 命令名 → 桩实现；没挂的返回 null */
let handlers: Record<string, () => Promise<unknown>>

beforeEach(() => {
  handlers = {}
  ;(globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string): Promise<unknown> => {
        const handler = handlers[command]
        return handler ? handler() : Promise.resolve(null)
      },
    },
  }
})

// 桥必须在 import 之前就位，所以这里用动态导入
const nvm = await import('./nvm')

describe('nvm 探测失败时不往外抛', () => {
  it('checkNodeVersion 回一个「不提示」的结果，而不是 reject', async () => {
    handlers.nvm_status = () => Promise.reject(new Error('IPC 不可用'))

    const result = await nvm.checkNodeVersion('whatever')

    // 「拿不到版本」不该被当成「版本不满足」去弹警告
    expect(result.ok).toBe(true)
    expect(result.actual).toBe('')
    expect(result.source).toBe('system')
  })

  it('拿到 nvm 当前软链版本时，按它算 ok 与来源', async () => {
    handlers.nvm_status = () =>
      Promise.resolve({ available: true, versions: [], current: '20.11.1' })

    const result = await nvm.checkNodeVersion('whatever')

    expect(result.actual).toBe('20.11.1')
    expect(result.source).toBe('system')
    expect(result.ok).toBe(true)
  })
})

describe('nvm 版本目录', () => {
  it('解析失败时回 null，并留下一条警告（不静默吞掉）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    handlers.nvm_node_dir = () => Promise.reject(new Error('挂了'))

    expect(await nvm.nodeDirFor('20.11.1')).toBeNull()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })

  it('没指定版本时不问桥，直接回 null', async () => {
    expect(await nvm.nodeDirFor(undefined)).toBeNull()
    expect(await nvm.nodeDirFor('   ')).toBeNull()
  })

  it('桥给了目录就原样回传', async () => {
    handlers.nvm_node_dir = () => Promise.resolve('C:\\nvm\\v20.11.1')

    expect(await nvm.nodeDirFor('20.11.1')).toBe('C:\\nvm\\v20.11.1')
  })
})
