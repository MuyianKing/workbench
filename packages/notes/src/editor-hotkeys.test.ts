import { describe, expect, it } from 'vitest'
import { EDITOR_HOTKEY_ACTIONS, EDITOR_HOTKEY_DEFAULTS, mergeEditorHotkeys, resolveEditorHotkeyConflict, sanitizeEditorHotkeys } from './editor-hotkeys'

describe('sanitizeEditorHotkeys', () => {
  it('非对象一律回空表', () => {
    expect(sanitizeEditorHotkeys(undefined)).toEqual({})
    expect(sanitizeEditorHotkeys(null)).toEqual({})
    expect(sanitizeEditorHotkeys('Control+3')).toEqual({})
    expect(sanitizeEditorHotkeys(['bold'])).toEqual({})
  })

  it('不在清单里的动作名丢掉，值去空白', () => {
    const map = sanitizeEditorHotkeys({
      bold: '  Control+3  ',
      heading3: 'Control+Alt+3',
      // undo / redo / outline / fullscreen 不开放自定义
      undo: 'Control+Z',
      fakeAction: 'Control+9',
      // 值不是字符串的丢掉
      italic: 42,
    })
    expect(map).toEqual({ bold: 'Control+3', heading3: 'Control+Alt+3' })
  })

  it('空串是合法取值（= 禁用），保留在表里', () => {
    expect(sanitizeEditorHotkeys({ bold: '', italic: '   ' })).toEqual({ bold: '', italic: '' })
  })

  it('输出按动作清单顺序排列，与写入顺序无关', () => {
    const map = sanitizeEditorHotkeys({ table: 'Control+T', bold: 'Control+B', heading1: 'Control+1' })
    expect(Object.keys(map)).toEqual(['heading1', 'bold', 'table'])
  })

  it('清单本身没有重名、没有清单外的项', () => {
    const names = EDITOR_HOTKEY_ACTIONS.map(action => action.name)
    expect(new Set(names).size).toBe(names.length)
    // 不开放的四个动作一个都不许出现在清单里
    for (const banned of ['undo', 'redo', 'outline', 'fullscreen'])
      expect(names).not.toContain(banned)
  })
})

describe('resolveEditorHotkeyConflict', () => {
  const existing = { bold: 'Control+B', heading3: 'Control+3', italic: '' }

  it('没撞键：只写这一项，别人不动', () => {
    const { next, cleared } = resolveEditorHotkeyConflict(existing, 'strike', 'Control+D')
    expect(cleared).toEqual([])
    expect(next.strike).toBe('Control+D')
    expect(next.bold).toBe('Control+B')
    expect(next.heading3).toBe('Control+3')
  })

  it('撞了别的动作：那些腾成空串（禁用），后配的保留', () => {
    const { next, cleared } = resolveEditorHotkeyConflict(existing, 'strike', 'control+b')
    expect(cleared).toEqual(['bold'])
    expect(next.strike).toBe('control+b')
    expect(next.bold).toBe('')
    // 禁用项（空串）不占键位，不参与撞键
    expect(next.italic).toBe('')
    expect(next.heading3).toBe('Control+3')
  })

  it('重配自己已有的键：不把自己腾掉', () => {
    const { next, cleared } = resolveEditorHotkeyConflict(existing, 'bold', 'Control+U')
    expect(cleared).toEqual([])
    expect(next.bold).toBe('Control+U')
  })

  it('自己当前的键就是新键：别人也不受影响', () => {
    const { next, cleared } = resolveEditorHotkeyConflict(existing, 'bold', 'Control+B')
    expect(cleared).toEqual([])
    expect(next.bold).toBe('Control+B')
    expect(next.heading3).toBe('Control+3')
  })

  it('空串 = 恢复默认：把这项从表里删掉，不涉及其它动作', () => {
    const { next, cleared } = resolveEditorHotkeyConflict(existing, 'bold', '')
    expect(cleared).toEqual([])
    expect('bold' in next).toBe(false)
    expect(next.heading3).toBe('Control+3')
  })
})

describe('eDITOR_HOTKEY_DEFAULTS / mergeEditorHotkeys', () => {
  it('默认表覆盖清单里全部 18 项、键串互不重复', () => {
    const names = EDITOR_HOTKEY_ACTIONS.map(action => action.name)
    for (const name of names)
      expect(EDITOR_HOTKEY_DEFAULTS[name], name).toBeTruthy()

    const keys = Object.values(EDITOR_HOTKEY_DEFAULTS).map(key => key.toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
    // 标题六档是贴身的 Ctrl+1~6（不是原厂的 Ctrl+Alt+N）
    expect(EDITOR_HOTKEY_DEFAULTS.heading3).toBe('Control+3')
    expect(EDITOR_HOTKEY_DEFAULTS.heading1).toBe('Control+1')
  })

  it('合并：默认垫底，用户非空项覆盖，未碰的动作保持默认', () => {
    const merged = mergeEditorHotkeys({ bold: 'Control+3', strike: 'Control+Alt+D' })
    expect(merged.heading3).toBe('Control+3')
    expect(merged.bold).toBe('Control+3')
    expect(merged.strike).toBe('Control+Alt+D')
    expect(merged.italic).toBe('Control+I')
  })

  it('合并：用户空串 = 禁用，该动作从生效表里消失（不吃默认键）', () => {
    const merged = mergeEditorHotkeys({ bold: '' })
    expect('bold' in merged).toBe(false)
    expect(merged.italic).toBe('Control+I')
  })

  it('合并：custom 缺省 / 为空时就是默认表', () => {
    expect(mergeEditorHotkeys(undefined)).toEqual(EDITOR_HOTKEY_DEFAULTS)
    expect(mergeEditorHotkeys({})).toEqual(EDITOR_HOTKEY_DEFAULTS)
  })
})
