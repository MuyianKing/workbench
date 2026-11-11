/**
 * 右键菜单「同一时刻只开一个」的用例。
 *
 * 被测代码不碰 DOM，只认 el-dropdown 暴露的 `handleClose`；这里用最小的桩替它 ——
 * 桩关闭时也照真实实现发一次 `visible-change(false)`（模板里接的是 onChange），
 * 「先关旧的、再把键落到新的」那段串行逻辑才被真正走到。
 */
import { describe, expect, it, vi } from 'vitest'
import { useExclusiveDropdown } from './use-exclusive-dropdown'

describe('useExclusiveDropdown', () => {
  /** 一条菜单的桩：关的时候像 el-dropdown 一样回发一次 visible-change(false) */
  function stub(key: string, onChange: (key: string, visible: boolean) => void) {
    return { handleClose: vi.fn(() => onChange(key, false)) }
  }

  it('开第二个时先把第一个关掉，两个菜单不会并排挂着', () => {
    const { register, onChange } = useExclusiveDropdown()
    const a = stub('a', onChange)
    const b = stub('b', onChange)
    register('a', a)
    register('b', b)

    onChange('a', true)
    expect(a.handleClose).not.toHaveBeenCalled()

    onChange('b', true)
    expect(a.handleClose).toHaveBeenCalledTimes(1)
    expect(b.handleClose).not.toHaveBeenCalled()
  })

  it('连着开三个：只留最后一个，前面的各关一次', () => {
    const { register, onChange } = useExclusiveDropdown()
    const a = stub('a', onChange)
    const b = stub('b', onChange)
    const c = stub('c', onChange)
    register('a', a)
    register('b', b)
    register('c', c)

    onChange('a', true)
    onChange('b', true)
    onChange('c', true)

    expect(a.handleClose).toHaveBeenCalledTimes(1)
    expect(b.handleClose).toHaveBeenCalledTimes(1)
    expect(c.handleClose).not.toHaveBeenCalled()
  })

  /** 同一行再发一次「开」不是「换一个」：不能把自己的菜单关掉 */
  it('同一行重复收到「开」不会关自己', () => {
    const { register, onChange } = useExclusiveDropdown()
    const a = stub('a', onChange)
    register('a', a)

    onChange('a', true)
    onChange('a', true)
    expect(a.handleClose).not.toHaveBeenCalled()
  })

  it('收起之后键就清掉：再开别的不会再回头关那个已经收起的', () => {
    const { register, onChange } = useExclusiveDropdown()
    const a = stub('a', onChange)
    const b = stub('b', onChange)
    register('a', a)
    register('b', b)

    onChange('a', true)
    onChange('a', false)
    onChange('b', true)

    expect(a.handleClose).not.toHaveBeenCalled()
  })

  /** 行被卸载时函数式 ref 会传 null：登记表里那条要消失，之后也不能再拿它去关 */
  it('注销过的那一行不会再被关一次，也不报错', () => {
    const { register, onChange } = useExclusiveDropdown()
    const a = stub('a', onChange)
    const b = stub('b', onChange)
    register('a', a)
    register('b', b)

    onChange('a', true)
    register('a', null)

    expect(() => onChange('b', true)).not.toThrow()
    expect(a.handleClose).not.toHaveBeenCalled()
  })
})
