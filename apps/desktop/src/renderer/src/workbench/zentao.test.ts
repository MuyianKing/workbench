import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bugs, login, logout, session } from './zentao'

const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } })
})
afterEach(() => vi.unstubAllGlobals())

describe('禅道适配层', () => {
  it('登录不从渲染层传入凭据，本地会话只传契约字段', async () => {
    const info = { id: '1', baseUrl: 'https://zentao.example/zentao', account: 'alice' }
    invoke.mockResolvedValue(info)
    expect(await login()).toEqual({ ok: true, data: info })
    expect(invoke).toHaveBeenLastCalledWith('zentao_login', undefined)
    expect(await session()).toEqual({ ok: true, data: info })
    expect(invoke).toHaveBeenLastCalledWith('zentao_session', undefined)
    invoke.mockResolvedValue(null)
    expect(await logout('1')).toEqual({ ok: true, data: null })
    expect(invoke).toHaveBeenLastCalledWith('zentao_logout', { sessionId: '1' })
  })

  it('按当前会话读取产品和 Bug，聚合在 TS 完成', async () => {
    invoke.mockImplementation(async (command, args) => {
      expect(args?.sessionId).toBe('session-2')
      if (command === 'zentao_products')
        return { page: 1, total: 1, limit: 1, products: [{ id: 7 }] }
      if (command === 'zentao_product')
        return { id: 7, name: '产品甲' }
      expect(args?.page).toBe(1)
      expect(args?.browse).toBe('assigntome')
      return { bugs: [{ id: 9, title: '测试问题', status: 'resolved' }], page: 1, total: 1, limit: 100 }
    })
    const result = await bugs('session-2', 'assigntome')
    expect(result.ok).toBe(true)
    expect(result.data?.bugs).toEqual([{
      id: 9,
      title: '测试问题',
      status: 'resolved',
      productId: 7,
      productName: '产品甲',
      severity: null,
      pri: null,
      openedDate: '',
      assignedTo: '',
      openedBy: '',
    }])
    expect(invoke.mock.calls).toEqual([
      ['zentao_products', { sessionId: 'session-2' }],
      ['zentao_page', { sessionId: 'session-2', productId: 7, page: 1, browse: 'assigntome' }],
      ['zentao_product', { sessionId: 'session-2', productId: 7 }],
    ])
  })

  it('分页失败不返回部分列表，并保留认证过期标记', async () => {
    const message = 'ZENTAO_AUTH_EXPIRED:请重新登录'
    invoke.mockResolvedValueOnce({ products: [{ id: 7, name: '产品甲' }], page: 1, total: 1, limit: 100 })
      .mockRejectedValueOnce(message)
    const result = await bugs('old-session', 'assigntome')
    expect(result.ok).toBe(false)
    expect(result.error).toBe(message)
    expect(result.data).toBeUndefined()
  })

  it('本地会话读取、登录与退出失败都收敛为 Result', async () => {
    invoke.mockRejectedValue(new Error('mock failure'))
    for (const result of [
      await session(),
      await login(),
      await logout('1'),
    ]) {
      expect(result.ok).toBe(false)
      expect(result.error).toBe('mock failure')
    }
  })

  it('不合法的成功响应也返回失败，而非空列表', async () => {
    invoke.mockResolvedValue({ products: [], page: 1, total: 2, limit: 100 })
    expect((await bugs('1', 'assigntome')).ok).toBe(false)
  })
})
