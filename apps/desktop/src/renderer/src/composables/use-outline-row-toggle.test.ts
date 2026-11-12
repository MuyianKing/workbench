/**
 * 大纲整行收展的用例。
 *
 * 环境是 node（见 vitest.config.ts），所以这里桩掉全局 `Element`，并给点击目标
 * 一个最小的元素桩：被测代码只用到 `closest`（向上找条目）、`querySelector`
 * （找箭头）、`classList` 与 `nextElementSibling` —— 按 Vditor `outlineRender`
 * 实际生成的结构手工搭出来，不用真 DOM。
 *
 * 这几条钉住的是「接管整行」最容易走偏的三处：叶子条目必须放行（它还要跳标题）、
 * 收展状态要与 Vditor 自己那套 `--close` 口径对齐（箭头转向和列表显隐不打架）、
 * 点在栏的空白处不拦。**列表显隐走 CSSOM**（`style.display`，不写行内 style 属性
 * —— 独立 Markdown 窗口的 CSP nonce 会把行内样式属性整个丢掉），桩里同样用
 * style 对象接。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toggleOutlineRow } from './use-outline-row-toggle'

/** 最小的元素桩：只实现 toggleOutlineRow 用到的那几样（挂上 EventTarget 以过类型收窄） */
class StubElement implements EventTarget {
  parent: StubElement | null = null
  attrs: Record<string, string> = {}
  /** CSSOM 记录：真实实现是 `el.style.display = …`，断言读这里 */
  style: Record<string, string> = {}
  tagName = 'SPAN'
  nextElementSibling: StubElement | null = null
  /** 收起态记在箭头桩自己身上（真实实现是 `classList.contains`） */
  closed = false
  /** 直接子元素里的箭头（真实实现是 `:scope > svg…` 查询），桩里简化成「有/无」 */
  action: StubElement | null = null
  /** closest 用：条目标记 */
  isItem = false

  /* EventTarget 的空实现：只为了让桩能赋给 EventTarget，不参与断言 */
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false
  }

  closest(selector: string): StubElement | null {
    if (selector === 'span[data-target-id]' && this.isItem)
      return this
    return this.parent?.closest(selector) ?? null
  }

  querySelector(selector: string): StubElement | null {
    return selector === ':scope > svg.vditor-outline__action' ? this.action : null
  }

  get classList() {
    return {
      contains: (name: string) => name === 'vditor-outline__action--close' && this.closed,
      add: (name: string) => {
        if (name === 'vditor-outline__action--close')
          this.closed = true
      },
      remove: (name: string) => {
        if (name === 'vditor-outline__action--close')
          this.closed = false
      },
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }
}

/** 搭一条 Vditor outlineRender 生成的条目：条目 span（+箭头）与它旁边的子列表 */
function makeRow(options: { dataTargetId?: string, hasSubList?: boolean, hasAction?: boolean, closed?: boolean }) {
  const subList = options.hasSubList
    ? Object.assign(new StubElement(), { tagName: 'UL' })
    : null
  const item = new StubElement()
  item.isItem = true
  item.tagName = 'SPAN'
  item.nextElementSibling = subList
  if (options.dataTargetId)
    item.attrs['data-target-id'] = options.dataTargetId
  if (options.hasAction) {
    const arrow = new StubElement()
    arrow.closed = options.closed ?? false
    item.action = arrow
    return { item, arrow, subList }
  }
  return { item, arrow: null, subList }
}

describe('toggleOutlineRow', () => {
  beforeEach(() => {
    vi.stubGlobal('Element', StubElement)
    // CSSOM 收窄用的 `HTMLElement`：node 环境没有，桩同一个类（被测代码只做 instanceof）
    vi.stubGlobal('HTMLElement', StubElement)
  })

  it('点在叶子条目上不拦：它还要交给 Vditor 去跳标题', () => {
    const { item } = makeRow({ dataTargetId: 'h1_0', hasSubList: false, hasAction: false })
    expect(toggleOutlineRow(item)).toBe(false)
  })

  it('有子级的条目整行可收：箭头加 --close、子列表走 CSSOM 收起，事件拦下', () => {
    const { item, arrow, subList } = makeRow({ dataTargetId: 'h1_0', hasSubList: true, hasAction: true })
    expect(toggleOutlineRow(item)).toBe(true)
    expect(arrow!.classList.contains('vditor-outline__action--close')).toBe(true)
    expect(subList!.style.display).toBe('none')
  })

  it('收起后再点整行展开：箭头回位、子列表显隐交回样式表', () => {
    const { item, arrow, subList } = makeRow({ dataTargetId: 'h1_0', hasSubList: true, hasAction: true, closed: true })
    expect(toggleOutlineRow(item)).toBe(true)
    expect(arrow!.classList.contains('vditor-outline__action--close')).toBe(false)
    expect(subList!.style.display).toBe('')
  })

  it('点在条目内部的文字 / 箭头上同样生效：closest 向上找到条目', () => {
    const { item, arrow, subList } = makeRow({ dataTargetId: 'h2_1', hasSubList: true, hasAction: true })
    const text = new StubElement()
    text.parent = item
    expect(toggleOutlineRow(text)).toBe(true)
    expect(arrow!.classList.contains('vditor-outline__action--close')).toBe(true)
    expect(subList!.style.display).toBe('none')
  })

  it('条目没有子列表（结构对不上）不放行也不拦', () => {
    const { item } = makeRow({ dataTargetId: 'h1_0', hasSubList: false, hasAction: true })
    expect(toggleOutlineRow(item)).toBe(false)
  })

  it('点在栏的空白处（没落进任何条目）不拦', () => {
    const blank = new StubElement()
    expect(toggleOutlineRow(blank)).toBe(false)
    expect(toggleOutlineRow(null)).toBe(false)
  })
})
